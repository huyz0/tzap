/**
 * Runs node:test suites inside the current process, warm, many mutants per run.
 *
 * How (see the package README section in docs and the measurements in the final report):
 *
 * - `run()` from `node:test` with `isolation: 'none'` imports the test files into this process.
 *   An ES module evaluates once per process, so a second `run()` with the same files would find
 *   no tests. A `resolve` hook gives every test file (and every module that imports `node:test`,
 *   i.e. helpers that register tests or hooks) a fresh URL per run (`?tzap=<n>`), so test files
 *   re-evaluate and register their tests again, while the modules under test keep their URL and
 *   stay warm, as they do in a Vitest worker with `isolate: false`.
 * - `node:test` itself is redirected, for user code, to a shim whose `test`/`it`/`describe`
 *   wrap the real ones. At registration the wrapper knows the test's identity (file, suite path,
 *   ordinal) and registers it once per planned try, so node:test runs the full
 *   beforeEach -> body -> afterEach cycle per try, exactly as Vitest's `repeats` does. Tests
 *   with nothing planned are registered as skipped.
 * - Two synthetic files bracket the user's: a prelude that registers the first root
 *   `beforeEach` (activates the try's mutant before any user hook runs) and a sentinel that
 *   registers the last root `afterEach` (records the outcome after every user hook) and a final
 *   test whose completion ends the run. `run()` with `isolation: 'none'` never ends its stream on
 *   its own in a long-lived process (it waits for `beforeExit`), so the executor calls the
 *   run's own teardown once the sentinel has reported, which also removes the process listeners
 *   and async hook the run installed.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as nodeModule from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FileOutcome, RunMode, RunRequest, RunResult, SessionOptions, TestOutcome, Try, TryOutcome } from '@tzap/protocol';
import { beginTry, drainHits, endTry, install, type TzapRuntime } from '@tzap/runtime';

const require = createRequire(import.meta.url);

/** The subset of a node:test TestContext the executor reads. */
interface Ctx {
  name: string;
  fullName: string;
  filePath?: string;
  passed: boolean;
  error: unknown;
}
type Fn = (...args: unknown[]) => unknown;
type Register = ((name?: unknown, options?: unknown, fn?: unknown) => unknown) & Record<string, unknown>;
interface NodeTest extends Register {
  test: Register;
  describe: Register;
  before: (fn: Fn, options?: object) => void;
  beforeEach: (fn: Fn, options?: object) => void;
  afterEach: (fn: Fn, options?: object) => void;
  run: (options: object) => NodeJS.ReadableStream & { on(ev: string, f: (e: unknown) => void): unknown; resume(): unknown };
}

const real = require('node:test') as NodeTest;

export const norm = (p: string) => {
  const s = p.replace(/\\/g, '/');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};
const cleanUrl = (u: string) => {
  const q = u.search(/[?#]/);
  return q === -1 ? u : u.slice(0, q);
};
const urlToNorm = (u: string) => {
  try {
    return norm(fileURLToPath(cleanUrl(u)));
  } catch {
    return undefined;
  }
};

/** node:test's default patterns (`--test` with no arguments), with type stripping's extensions. */
const EXT = '{js,mjs,cjs,ts,mts,cts}';
export const NODE_TEST_PATTERNS = [
  `**/*.test.${EXT}`,
  `**/*-test.${EXT}`,
  `**/*_test.${EXT}`,
  `**/test-*.${EXT}`,
  `**/test.${EXT}`,
  `**/test/**/*.${EXT}`,
];

export function findTestFiles(pkgRoot: string, patterns: readonly string[] | undefined): string[] {
  const globs = patterns && patterns.length > 0 ? patterns : NODE_TEST_PATTERNS;
  const found = new Set<string>();
  for (const g of globs) {
    for (const f of globSync(g, { cwd: pkgRoot, exclude: (p: string) => /(^|[\\/])node_modules([\\/]|$)/.test(p) || /(^|[\\/])\.tzap([\\/]|$)/.test(p) })) {
      if (/(^|[\\/])node_modules[\\/]/.test(f)) continue;
      if (!/\.(c|m)?[jt]s$/.test(f)) continue;
      found.add(path.resolve(pkgRoot, f));
    }
  }
  return [...found].sort();
}

const selfUrl = import.meta.url;

/** Normalised path of the first stack frame outside this module. */
function callerFile(): string | undefined {
  const orig = Error.prepareStackTrace;
  let sites: NodeJS.CallSite[] = [];
  Error.prepareStackTrace = (_e, cs) => cs;
  try {
    sites = (new Error().stack as unknown as NodeJS.CallSite[]) ?? [];
  } finally {
    Error.prepareStackTrace = orig;
  }
  for (const s of sites) {
    const f = s.getFileName();
    if (!f || cleanUrl(f) === selfUrl || f.startsWith('node:')) continue;
    return f.startsWith('file:') ? urlToNorm(f) : norm(f);
  }
  return undefined;
}

const SKIP = 'tzap: skipped, mutant already killed in this run';
export const DEFAULT_TEST_TIMEOUT = 5000;

interface TestInfo {
  id: string;
  name: string;
  file: string;
  skip: boolean;
  tries?: Try[];
  /** Filled while running. */
  ran: boolean;
  state: 'pass' | 'fail' | 'skip';
  duration: number;
  message?: string;
  hits?: Array<[number, number]>;
  hits2?: Array<[number, number]>;
  loops?: number;
  repeatFail?: string;
  outcomes: Array<[number, TryOutcome, string?]>;
}

interface Copy {
  info: TestInfo;
  index: number;
  ctx?: Ctx;
  started: number;
  skipped: boolean;
  done: boolean;
}

interface RunState {
  req: RunRequest;
  n: number;
  mode: RunMode;
  plan: Record<string, Try[]>;
  staticMutant: number;
  phase: 'register' | 'execute';
  /** norm(abs) -> abs for this run's user test files. */
  files: Map<string, string>;
  currentFile: string | undefined;
  ordinals: Map<string, number>;
  infos: TestInfo[];
  queues: Map<string, Copy[]>;
  current: Copy | undefined;
  killed: Set<number>;
  outside: Map<number, number>;
  fileErrors: Map<string, string>;
  sentinelName: string;
}

export interface ExecutorOptions {
  session: SessionOptions;
  pkgRoot: string;
  /** Scratch directory for the generated shim, prelude and sentinel modules. */
  dir: string;
  testTimeout?: number;
  /** Called as each try starts and ends, synchronously: a hung try must already be on record. */
  onProgress?: (runId: number, test: string, mutant: number, done: boolean) => void;
}

const firstMessage = (err: unknown): string | undefined => {
  if (err === undefined || err === null) return undefined;
  const e = err as { code?: string; cause?: unknown; message?: string };
  const inner = e.code === 'ERR_TEST_FAILURE' && e.cause !== undefined && e.cause !== null ? e.cause : e;
  const m = (inner as { message?: string }).message ?? String(inner);
  return m.length > 300 ? `${m.slice(0, 297)}...` : m;
};

function sameHits(a: Array<[number, number]>, b: Array<[number, number]>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]![0] !== b[i]![0] || a[i]![1] !== b[i]![1]) return false;
  return true;
}

export class Executor {
  readonly rt: TzapRuntime;
  private readonly pkgRoot: string;
  private readonly instrumented = new Map<string, string>();
  /** Sites per instrumented module (normalised path). */
  private readonly sitesOf = new Map<string, number[]>();
  private readonly shimDir: string;
  private readonly shimDirUrl: string;
  private readonly shimMjs: string;
  private readonly shimCjs: string;
  private readonly prelude: string;
  private readonly sentinel: string;
  /** Modules (normalised path) re-evaluated every run: test files and whatever imports node:test. */
  private readonly reEval = new Set<string>();
  /** Import edges seen by the resolve hook, normalised paths. */
  private readonly edges = new Map<string, Set<string>>();
  private readonly als = new AsyncLocalStorage<string[]>();
  private readonly testTimeout: number;
  private runCount = 0;
  private state: RunState | undefined;
  private endRun: (() => void) | undefined;
  readonly allFiles: string[];

  constructor(private readonly o: ExecutorOptions) {
    this.pkgRoot = o.pkgRoot;
    this.testTimeout = o.testTimeout ?? DEFAULT_TEST_TIMEOUT;
    this.rt = install();
    const map = JSON.parse(readFileSync(o.session.instrumented, 'utf8')) as Record<string, { code: string; map: unknown }>;
    for (const [file, v] of Object.entries(map)) {
      const key = norm(path.resolve(file));
      this.instrumented.set(key, v.code);
      const sites = new Set<number>();
      for (const m of v.code.matchAll(/__tzap\.c\[(\d+)\]/g)) sites.add(Number(m[1]));
      this.sitesOf.set(key, [...sites]);
    }
    this.allFiles = findTestFiles(this.pkgRoot, o.session.pkg.tests);

    this.shimDir = o.dir;
    mkdirSync(this.shimDir, { recursive: true });
    this.shimDirUrl = pathToFileURL(this.shimDir + path.sep).href;
    this.shimMjs = path.join(this.shimDir, 'node-test.mjs');
    this.shimCjs = path.join(this.shimDir, 'node-test.cjs');
    this.prelude = path.join(this.shimDir, 'prelude.mjs');
    this.sentinel = path.join(this.shimDir, 'sentinel.mjs');
    const names = Object.keys(real).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== 'default');
    writeFileSync(
      this.shimMjs,
      `const a = globalThis.__tzapNodeTest.api;\nexport default a;\n${names.map((k) => `export const ${k} = a.${k};`).join('\n')}\n`,
    );
    writeFileSync(this.shimCjs, `module.exports = globalThis.__tzapNodeTest.api;\n`);
    writeFileSync(this.prelude, `globalThis.__tzapNodeTest.prelude();\n`);
    writeFileSync(this.sentinel, `globalThis.__tzapNodeTest.sentinel();\n`);

    (globalThis as unknown as { __tzapNodeTest: object }).__tzapNodeTest = {
      api: this.buildApi(),
      prelude: () => this.registerPrelude(),
      sentinel: () => this.registerSentinel(),
    };
    this.installHooks();
  }

  // --- module hooks --------------------------------------------------------------------------

  private installHooks(): void {
    const registerHooks = (nodeModule as unknown as { registerHooks?: (h: object) => unknown }).registerHooks;
    if (typeof registerHooks !== 'function') {
      throw new Error(`module.registerHooks is not available in Node ${process.version}; the node:test adapter needs Node >= 22.15`);
    }
    type Ctx = { parentURL?: string; conditions?: string[] };
    type Res = { url: string; format?: string; shortCircuit?: boolean };
    registerHooks({
      resolve: (specifier: string, context: Ctx, next: (s: string, c: Ctx) => Res): Res => {
        const parent = context.parentURL;
        if (specifier === 'node:test' && parent && !parent.startsWith(this.shimDirUrl)) {
          const p = urlToNorm(parent);
          if (p && !this.reEval.has(p) && this.state) this.reEval.add(p);
          const cjs = context.conditions?.includes('require') && !context.conditions.includes('import');
          return { url: pathToFileURL(cjs ? this.shimCjs : this.shimMjs).href, format: cjs ? 'commonjs' : 'module', shortCircuit: true };
        }
        const r = next(specifier, context);
        if (!r.url.startsWith('file:')) return r;
        const child = urlToNorm(r.url);
        if (!child) return r;
        const st = this.state;
        if (st) {
          if (parent?.startsWith('file:')) {
            const p = urlToNorm(parent);
            if (p) {
              let set = this.edges.get(p);
              if (!set) this.edges.set(p, (set = new Set()));
              set.add(child);
            }
          }
          const entry = st.files.get(child);
          if (entry !== undefined && (parent === undefined || parent.endsWith('/'))) {
            // run() importing the next test file: module evaluation of the previous one is over.
            this.collectOutside();
            st.currentFile = entry;
          }
          if (this.reEval.has(child) || entry !== undefined || child === norm(this.prelude) || child === norm(this.sentinel)) {
            return { ...r, url: `${cleanUrl(r.url)}?tzap=${st.n}` };
          }
        }
        return r;
      },
      load: (url: string, context: object, next: (u: string, c: object) => { format?: string; source?: unknown }) => {
        const r = next(url, context);
        if (!url.startsWith('file:')) return r;
        const key = urlToNorm(url);
        const code = key === undefined ? undefined : this.instrumented.get(key);
        if (code === undefined) return r;
        // For .ts files the format is module-typescript / commonjs-typescript and Node strips the
        // (still TypeScript) instrumented source exactly as it would have stripped the original.
        return { ...r, format: r.format ?? 'module', source: code, shortCircuit: true };
      },
    });
  }

  // --- the node:test shim ---------------------------------------------------------------------

  private normalize(name: unknown, options: unknown, fn: unknown): [unknown, Record<string, unknown>, unknown] {
    if (typeof name === 'function') {
      fn = name;
      options = undefined;
    } else if (name !== null && typeof name === 'object') {
      fn = options;
      options = name;
    } else if (typeof options === 'function') {
      fn = options;
      options = undefined;
    }
    const opts = options !== null && typeof options === 'object' ? { ...(options as Record<string, unknown>) } : {};
    return [name, opts, fn];
  }

  private buildApi(): Register {
    const self = this;
    const variant = (kind: 'suite' | 'test', extra: Record<string, unknown>) =>
      function (this: unknown, name?: unknown, options?: unknown, fn?: unknown) {
        return kind === 'suite' ? self.registerSuite(name, options, fn, extra) : self.registerTest(name, options, fn, extra);
      };
    const decorate = (kind: 'suite' | 'test') => {
      const f = variant(kind, {}) as Register;
      f.skip = variant(kind, { skip: true });
      f.todo = variant(kind, { todo: true });
      // `only` is ignored, as `node --test` ignores it without --test-only; with
      // isolation 'none' node:test would otherwise filter every other test out.
      f.only = variant(kind, {});
      f.expectFailure = variant(kind, { expectFailure: true });
      return f;
    };
    const test = decorate('test');
    const describe = decorate('suite');
    const api = test;
    for (const k of Object.keys(real)) if (!(k in api)) api[k] = real[k];
    api.test = test;
    api.it = test;
    api.describe = describe;
    api.suite = describe;
    api.beforeEach = this.scopedHook(real.beforeEach);
    api.afterEach = this.scopedHook(real.afterEach);
    return api;
  }

  /**
   * With isolation 'none' every file's top-level `beforeEach`/`afterEach` lands on the one root
   * and would run for every file's tests; `node --test` runs each file in its own process, where
   * it runs only for that file's. A hook called from the test file itself is scoped back to it.
   * One called from a shared helper module stays global: the helper evaluates once per run, where
   * under process isolation it would evaluate, and register, in every file.
   */
  private scopedHook(realHook: (fn: Fn, options?: object) => void): (fn: unknown, options?: object) => void {
    return (fn, options) => {
      const st = this.state;
      if (!st || st.phase !== 'register' || this.als.getStore() !== undefined || typeof fn !== 'function' || !st.currentFile) {
        return realHook(fn as Fn, options);
      }
      const target = norm(st.currentFile);
      if (callerFile() !== target) return realHook(fn as Fn, options);
      const user = fn as Fn;
      const scoped = function (this: unknown, ...args: unknown[]) {
        const t = args[0] as Ctx | undefined;
        if (norm(t?.filePath ?? '') === target) return user.apply(this, args);
        // A callback-style hook: node:test waits for the callback.
        if (user.length > 1 && args.length >= user.length) (args[user.length - 1] as () => void)();
        return undefined;
      };
      Object.defineProperty(scoped, 'length', { value: user.length });
      return realHook(scoped, options);
    };
  }

  private registerTest(name0: unknown, options0: unknown, fn0: unknown, extra: Record<string, unknown>): unknown {
    const st = this.state;
    let [name, opts, fn] = this.normalize(name0, options0, fn0);
    Object.assign(opts, extra);
    delete opts.only;
    if (!st || st.phase !== 'register') {
      // A test registered while tests run (not a t.test() subtest): part of whatever runs it.
      return real.test(name, opts, fn);
    }
    if (typeof name !== 'string' || name === '') name = (typeof fn === 'function' && (fn as Fn).name) || '<anonymous>';
    const suitePath = this.als.getStore() ?? [];
    const fullName = [...suitePath, name as string].join(' > ');
    const file = st.currentFile ?? '';
    const key = `${norm(file)}\0${fullName}`;
    const ordinal = st.ordinals.get(key) ?? 0;
    st.ordinals.set(key, ordinal + 1);
    const rel = path.relative(this.pkgRoot, file).replace(/\\/g, '/');
    const id = `${rel}::${fullName}${ordinal > 0 ? ` #${ordinal + 1}` : ''}`;
    const skip = !!opts.skip || !!opts.todo || typeof fn !== 'function';
    const info: TestInfo = { id, name: fullName, file, skip, ran: false, state: 'skip', duration: 0, outcomes: [] };
    if (opts.todo) {
      // A todo test's result never counts; its body is not run.
      delete opts.todo;
      opts.skip = true;
    }
    if (skip) {
      if (st.mode === 'coverage') st.infos.push(info);
      return real.test(name, opts, fn);
    }
    let copies: number;
    if (st.mode === 'coverage') copies = 2;
    else {
      const tries = st.plan[id];
      copies = tries?.length ?? 0;
      info.tries = tries;
    }
    if (copies === 0) return real.test(name, { ...opts, skip: 'tzap: not planned' }, fn);
    st.infos.push(info);
    if (opts.timeout === undefined) opts.timeout = this.testTimeout;
    let q = st.queues.get(key);
    if (!q) st.queues.set(key, (q = []));
    let ret: unknown;
    for (let i = 0; i < copies; i++) {
      q.push({ info, index: i, started: 0, skipped: false, done: false });
      ret = real.test(name, opts, fn);
    }
    return ret;
  }

  private registerSuite(name0: unknown, options0: unknown, fn0: unknown, extra: Record<string, unknown>): unknown {
    const st = this.state;
    let [name, opts, fn] = this.normalize(name0, options0, fn0);
    Object.assign(opts, extra);
    delete opts.only;
    if (!st || st.phase !== 'register') return real.describe(name, opts, fn);
    if (opts.todo) {
      delete opts.todo;
      opts.skip = true;
    }
    // Hit counters and the active mutant are global: tests must not run concurrently. A suite's
    // own timeout would also cover every try of every test in it; tests get their own.
    opts.concurrency = 1;
    delete opts.timeout;
    if (typeof name !== 'string' || name === '') name = (typeof fn === 'function' && (fn as Fn).name) || '<anonymous>';
    const suitePath = [...(this.als.getStore() ?? []), name as string];
    const als = this.als;
    const wrapped =
      typeof fn === 'function'
        ? function (this: unknown, ...args: unknown[]) {
            return als.run(suitePath, () => (fn as Fn).apply(this, args));
          }
        : fn;
    return real.describe(name, opts, wrapped);
  }

  /** First file of every run: the first root beforeEach, so the mutant is active before any user hook. */
  private registerPrelude(): void {
    real.beforeEach((t) => this.beforeTest(t as Ctx));
  }

  /** Last file of every run: the last root afterEach, and the test whose end ends the run. */
  private registerSentinel(): void {
    const st = this.state!;
    this.collectOutside();
    st.currentFile = undefined;
    st.phase = 'execute';
    real.afterEach((t) => this.afterTest(t as Ctx));
    real.test(st.sentinelName, { timeout: Infinity }, () => {
      this.finishPending();
      this.collectOutside();
    });
  }

  // --- per-test ---------------------------------------------------------------------------------

  private collectOutside(): void {
    const st = this.state;
    const hits = drainHits(this.rt);
    if (!st || st.mode !== 'coverage') return;
    for (const [site, n] of hits) st.outside.set(site, (st.outside.get(site) ?? 0) + n);
  }

  private beforeTest(t: Ctx): void {
    const st = this.state;
    if (!st) return;
    // Root hooks are inherited by subtests (t.test) too: those belong to the running try.
    const key = `${norm(t.filePath ?? '')}\0${t.fullName}`;
    const copy = st.queues.get(key)?.shift();
    if (!copy) return;
    this.finishPending();
    copy.ctx = t;
    st.current = copy;
    if (st.mode === 'coverage') {
      this.o.onProgress?.(st.req.id, copy.info.id, -1, false);
      this.collectOutside();
      endTry(this.rt);
      copy.started = performance.now();
      return;
    }
    const tr = copy.info.tries![copy.index]!;
    // m === -1 is a control try: the test unmutated, bracketing the mutant tries so the engine can
    // tell a test that fails because of its context from one that fails because of a mutant.
    if (st.mode === 'mutate' && tr.m >= 0 && st.killed.has(tr.m)) {
      this.rt.a = -1;
      copy.skipped = true;
      throw new Error(SKIP);
    }
    this.o.onProgress?.(st.req.id, copy.info.id, tr.m, false);
    beginTry(this.rt, st.mode === 'static' ? st.staticMutant : tr.m, tr.N, tr.L);
    copy.started = performance.now();
  }

  private afterTest(t: Ctx): void {
    const copy = this.state?.current;
    if (!copy || copy.ctx !== t) return;
    this.finish(copy);
  }

  /** A copy whose afterEach never reached ours (a user afterEach threw) is finished late. */
  private finishPending(): void {
    const c = this.state?.current;
    if (c && !c.done) this.finish(c);
  }

  private finish(copy: Copy): void {
    const st = this.state!;
    copy.done = true;
    st.current = undefined;
    const t = copy.ctx!;
    const failed = !t.passed;
    const message = failed ? (firstMessage(t.error) ?? 'failed') : undefined;
    const info = copy.info;
    info.ran = true;
    this.o.onProgress?.(st.req.id, info.id, st.mode === 'coverage' ? -1 : info.tries![copy.index]!.m, true);
    const elapsed = performance.now() - copy.started;
    if (st.mode === 'coverage') {
      const hits = drainHits(this.rt);
      if (copy.index === 0) {
        info.hits = hits;
        info.loops = this.rt.l;
        info.duration = elapsed;
        info.state = failed ? 'fail' : 'pass';
        if (failed) info.message = message;
      } else {
        info.hits2 = hits;
        // Passed once, failed when repeated: the test is not repeatable. Not a red test.
        if (failed && info.state !== 'fail') info.repeatFail = message;
      }
      endTry(this.rt);
      return;
    }
    const tr = info.tries![copy.index]!;
    const reached = this.rt.n > 0;
    const { hung } = endTry(this.rt);
    if (st.mode === 'static') this.rt.a = st.staticMutant;
    let outcome: TryOutcome;
    if (copy.skipped) outcome = 'X';
    else if (hung) outcome = 'T';
    else if (st.mode === 'mutate' && tr.m >= 0 && !reached) outcome = 'U';
    else outcome = failed ? 'K' : 'S';
    if ((outcome === 'K' || outcome === 'T') && tr.m >= 0) st.killed.add(tr.m);
    info.outcomes.push(outcome === 'K' && message !== undefined ? [tr.m, outcome, message] : [tr.m, outcome]);
    info.state = 'pass';
    info.duration += elapsed;
  }

  // --- a run ------------------------------------------------------------------------------------

  async run(req: RunRequest): Promise<RunResult> {
    const started = performance.now();
    const n = ++this.runCount;
    const plan = req.plan ?? {};
    let files: string[];
    if (req.files) {
      const wanted = new Set(req.files.map((f) => norm(path.resolve(f))));
      files = this.allFiles.filter((f) => wanted.has(norm(f)));
    } else if (req.mode === 'coverage') {
      files = this.allFiles;
    } else {
      // Only the files that hold a planned test.
      const wanted = new Set(Object.keys(plan).map((id) => norm(path.resolve(this.pkgRoot, id.slice(0, id.indexOf('::'))))));
      files = this.allFiles.filter((f) => wanted.has(norm(f)));
    }
    const st: RunState = {
      req,
      n,
      mode: req.mode,
      plan,
      staticMutant: req.staticMutant ?? -1,
      phase: 'register',
      files: new Map(files.map((f) => [norm(f), f])),
      currentFile: undefined,
      ordinals: new Map(),
      infos: [],
      queues: new Map(),
      current: undefined,
      killed: new Set(),
      outside: new Map(),
      fileErrors: new Map(),
      sentinelName: `tzap:end:${n}`,
    };
    if (files.length === 0) return { id: req.id, tests: [], files: [], durationMs: performance.now() - started };

    // CommonJS test files and helpers are cached by file name, whatever the URL says.
    const cache = require.cache;
    for (const k of Object.keys(cache)) if (this.reEval.has(norm(k)) || st.files.has(norm(k))) delete cache[k];

    this.state = st;
    endTry(this.rt);
    if (req.mode === 'static') this.rt.a = st.staticMutant;
    drainHits(this.rt);
    try {
      await this.runNodeTest([this.prelude, ...files, this.sentinel]);
    } finally {
      this.finishPending();
      this.collectOutside();
      endTry(this.rt);
      this.state = undefined;
    }
    return this.result(st, files, performance.now() - started);
  }

  private async runNodeTest(files: string[]): Promise<void> {
    const st = this.state!;
    const exitListeners = new Set(process.listeners('beforeExit'));
    const stream = real.run({ files, isolation: 'none', concurrency: 1, cwd: this.pkgRoot });
    const teardown = process.listeners('beforeExit').find((l) => !exitListeners.has(l)) as ((kill?: boolean) => unknown) | undefined;
    const fileSet = new Set(files.map(norm));
    let finished!: () => void;
    const done = new Promise<void>((r) => (finished = r));
    const ended = new Promise<void>((r) => stream.on('end', () => r()));
    stream.on('data', (ev: unknown) => {
      const e = ev as { type: string; data: { name: string; nesting: number; file?: string; details?: { type?: string; error?: unknown } } };
      if (e.type !== 'test:fail' && e.type !== 'test:pass') return;
      const d = e.data;
      if (d.nesting === 0 && d.name === st.sentinelName) {
        finished();
        return;
      }
      if (e.type !== 'test:fail') return;
      const err = d.details?.error as { failureType?: string } | undefined;
      // A file that failed to load: run() adds a placeholder test named after the file.
      if (d.nesting === 0 && fileSet.has(norm(d.name))) {
        st.fileErrors.set(norm(d.name), firstMessage(err) ?? 'failed to load');
        return;
      }
      // A suite whose body threw while its tests were being collected.
      if (d.details?.type === 'suite' && err && err.failureType !== 'subtestsFailed' && err.failureType !== 'cancelledByParent' && d.file) {
        if (!st.fileErrors.has(norm(d.file))) st.fileErrors.set(norm(d.file), firstMessage(err) ?? 'suite failed');
      }
    });
    await done;
    // Let the reporter flush, then end the run as a process exit would, which also removes
    // the listeners and async hook this run() installed.
    await new Promise((r) => setImmediate(r));
    await teardown?.(true);
    await ended;
  }

  private result(st: RunState, files: string[], durationMs: number): RunResult {
    const tests: TestOutcome[] = [];
    for (const info of st.infos) {
      const out: TestOutcome = { id: info.id, name: info.name, file: info.file, state: info.ran ? info.state : 'skip', duration: info.duration };
      if (st.mode === 'coverage') {
        if (info.ran) {
          out.hits = info.hits ?? [];
          out.loops = info.loops ?? 0;
          if (info.message !== undefined) out.message = info.message;
          if (info.repeatFail !== undefined) out.stateSensitive = `fails when repeated: ${info.repeatFail}`;
          else if (info.hits2 && !sameHits(info.hits ?? [], info.hits2)) out.stateSensitive = 'takes a different path when repeated';
        }
      } else {
        out.state = 'pass';
        out.tries = info.outcomes;
      }
      tests.push(out);
    }
    const fileOutcomes: FileOutcome[] = files.map((f) => {
      const fo: FileOutcome = { file: f };
      const err = st.fileErrors.get(norm(f));
      if (err !== undefined) fo.error = err;
      if (st.mode === 'coverage') fo.staticHits = this.staticHitsFor(f, st.outside);
      return fo;
    });
    return { id: st.req.id, tests, files: fileOutcomes, durationMs };
  }

  /**
   * Hits outside any test (module evaluation, suite hooks) attributed to a test file. With
   * isolation 'none' a module evaluates once, while the first file that imports it loads, so
   * the hits are attributed to every test file whose import closure reaches the module: each of
   * them would evaluate it in a fresh process.
   */
  private staticHitsFor(file: string, outside: Map<number, number>): Array<[number, number]> {
    if (outside.size === 0) return [];
    const seen = new Set<string>();
    const stack = [norm(file)];
    while (stack.length) {
      const m = stack.pop()!;
      if (seen.has(m)) continue;
      seen.add(m);
      for (const c of this.edges.get(m) ?? []) stack.push(c);
    }
    const out: Array<[number, number]> = [];
    for (const m of seen) {
      for (const site of this.sitesOf.get(m) ?? []) {
        const n = outside.get(site);
        if (n !== undefined) out.push([site, n]);
      }
    }
    return out.sort((a, b) => a[0] - b[0]);
  }
}
