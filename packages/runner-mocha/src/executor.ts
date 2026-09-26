/**
 * Runs Mocha suites inside the current process, warm, many mutants per run.
 *
 * How (measured in the package tests; see the final notes in docs/spikes/C-bun-deno.md):
 *
 * - Mocha is loaded from the user's project and driven through its programmatic API, configured
 *   from the project's own `.mocharc.*` / `package.json` the way the `mocha` CLI reads them
 *   (`loadOptions`, `collectFiles`, `handleRequires` for `--require` and root-hook plugins).
 * - Test files are loaded once, the first time a run names them, with `loadFilesAsync` (CommonJS,
 *   ESM and TypeScript alike: Mocha picks `require` or `import`). An ES module cannot be unloaded,
 *   so nothing is: the one Mocha instance keeps its suite tree (`cleanReferencesAfterRun(false)`)
 *   and every run runs it again. The modules under test stay loaded too: warm.
 * - Before a run, each suite's `tests` array is narrowed to the tests with something planned, so
 *   a suite with nothing planned is skipped outright, its `before`/`after` hooks included.
 * - Every try of a test runs back to back through Mocha's own retry loop, as runner-jest drives
 *   jest-circus's: the test's `retries` is set to its number of tries minus one, and a try that
 *   passed but is not the last fails with a marker, so Mocha runs the full
 *   beforeEach -> body -> afterEach cycle again on a fresh clone (`currentRetry()` numbers the
 *   tries). Mocha re-queues the clone at the front of a queue that holds only the suite's
 *   planned tests; one clone per try in one long queue instead measured O(n) per `shift()` once
 *   it held tens of thousands.
 * - The runner's `test` event (emitted before any beforeEach hook) activates the try's mutant; a
 *   root `afterEach` kept last records the outcome after every user hook has run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as nodeModule from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FileOutcome, RunMode, RunRequest, RunResult, SessionOptions, TestOutcome, Try, TryOutcome } from '@tzap/protocol';
import { beginTry, drainHits, endTry, install, type TzapRuntime } from '@tzap/runtime';

// --- the parts of Mocha the executor uses -----------------------------------------------------

interface MochaRunnable {
  type: 'test' | 'hook';
  title: string;
  originalTitle?: string;
  file?: string;
  parent?: MochaSuite;
  err?: unknown;
  ctx?: { currentTest?: MochaTest };
}
interface MochaTest extends MochaRunnable {
  type: 'test';
  fn?: unknown;
  state?: 'passed' | 'failed' | 'pending';
  pending: boolean;
  titlePath(): string[];
  fullTitle(): string;
  isPending(): boolean;
  clone(): MochaTest;
  retries(n: number): unknown;
  currentRetry(): number;
  retriedTest(): MochaTest | undefined;
}
interface MochaHook extends MochaRunnable {
  type: 'hook';
  fn?: unknown;
}
interface MochaSuite {
  title: string;
  file?: string;
  root: boolean;
  parent?: MochaSuite;
  tests: MochaTest[];
  suites: MochaSuite[];
  _beforeEach: MochaHook[];
  _afterEach: MochaHook[];
  _bail: boolean;
  _onlyTests: MochaTest[];
  _onlySuites: MochaSuite[];
  afterEach(title: string, fn: (this: { currentTest?: MochaTest }) => void): unknown;
}
interface MochaRunner {
  on(event: string, f: (...args: any[]) => void): unknown;
  _eventListeners?: Map<object, Map<string, Set<(...args: any[]) => void>>>;
}
interface MochaInstance {
  suite: MochaSuite;
  files: string[];
  version: string;
  cleanReferencesAfterRun(b: boolean): unknown;
  loadFilesAsync(): Promise<void>;
  run(fn: (failures: number) => void): MochaRunner;
  hasGlobalSetupFixtures(): boolean;
  hasGlobalTeardownFixtures(): boolean;
  runGlobalSetup(context: object): Promise<object>;
  runGlobalTeardown(context: object): Promise<object>;
}
type MochaCtor = (new (options: object) => MochaInstance) & { interfaces: Record<string, unknown> };
type Options = Record<string, unknown> & { _?: unknown[] };
interface MochaCli {
  loadOptions(argv: string[]): Options;
  collectFiles(o: { ignore: string[]; extension: string[]; file: string[]; recursive: boolean; sort: boolean; spec: string[] }): string[] | { files: string[]; unmatchedFiles: unknown[] };
  handleRequires(requires: string[], o?: object): Promise<Record<string, unknown>>;
  validateLegacyPlugin?(o: Options, type: string, map: Record<string, unknown>): void;
}

// --- helpers ------------------------------------------------------------------------------------

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

const ANSI = /\u001b\[[0-9;]*m/g;
const firstMessage = (err: unknown): string | undefined => {
  if (err === undefined || err === null) return undefined;
  const m = (typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err)).replace(ANSI, '');
  return m.length > 300 ? `${m.slice(0, 297)}...` : m;
};

function sameHits(a: Array<[number, number]>, b: Array<[number, number]>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]![0] !== b[i]![0] || a[i]![1] !== b[i]![1]) return false;
  return true;
}

const list = (v: unknown): string[] =>
  v === undefined || v === null || v === false ? [] : (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(/ *, */)).filter((x) => x !== '');

/** Mocha's `this.skip()` signal: PendingError in Mocha 12, a plain Pending object before. */
const isPendingSignal = (e: unknown) => {
  const name = (e as { constructor?: { name?: string } } | null)?.constructor?.name;
  return name === 'PendingError' || name === 'Pending';
};

type AnyFn = (this: unknown, ...args: unknown[]) => unknown;

/**
 * Fails a try that is not its test's last, so Mocha's retry loop runs the next. Made once: a new
 * Error per try would capture a stack every time.
 */
const NEXT = Object.assign(new Error('tzap: next try'), { stack: 'tzap: next try' });
const WRAPPED = Symbol.for('tzap.mocha.wrapped');

/** A function standing in for `orig`: same arity (Mocha reads it to tell callback style) and source. */
function standIn(orig: AnyFn, w: AnyFn): AnyFn {
  Object.defineProperty(w, 'length', { value: orig.length });
  Object.defineProperty(w, 'toString', { value: () => orig.toString() });
  (w as unknown as Record<symbol, boolean>)[WRAPPED] = true;
  return w;
}

/** `"before each" hook: name for "test"` -> 'each' / 'all', or undefined. */
const hookKind = (h: MochaRunnable): 'each' | 'all' | undefined => {
  const m = /^"(?:before|after) (each|all)" hook/.exec(h.originalTitle ?? h.title);
  return m ? (m[1] as 'each' | 'all') : undefined;
};

// --- per-run state ------------------------------------------------------------------------------

interface Registered {
  id: string;
  name: string;
  file: string;
}

interface TestInfo extends Registered {
  skip: boolean;
  tries?: Try[];
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

/** A planned test in a run: its record and the number of times it runs. */
interface Entry {
  info: TestInfo;
  total: number;
}

/** One try of a test: the original test object first, then Mocha's retry clones. */
interface Copy {
  info: TestInfo;
  index: number;
  total: number;
  test: MochaTest;
  started: number;
  /** The mutant was already killed in this run: nothing of the user's runs. */
  skipped: boolean;
  error: unknown;
  /** A beforeEach/afterEach hook failed around this try: the try failed, its body is not run. */
  hookFailed: boolean;
  done: boolean;
}

interface RunState {
  req: RunRequest;
  mode: RunMode;
  staticMutant: number;
  entries: Map<MochaTest, Entry>;
  current: Copy | undefined;
  killed: Set<number>;
  outside: Map<number, number>;
  fileErrors: Map<string, string>;
  files: Set<string>;
}

export interface ExecutorOptions {
  session: SessionOptions;
  pkgRoot: string;
  /** Called as each try starts and ends, synchronously: a hung try must already be on record. */
  onProgress?: (runId: number, test: string, mutant: number, done: boolean) => void;
}

export class Executor {
  readonly rt: TzapRuntime;
  readonly version: string;
  readonly allFiles: string[];
  running = false;
  private readonly pkgRoot: string;
  private readonly mochaDir: string;
  private readonly cli: MochaCli;
  private readonly options: Options;
  private readonly instrumented = new Map<string, string>();
  /** Sites per instrumented module (normalised path). */
  private readonly sitesOf = new Map<string, number[]>();
  /** Import edges seen by the resolve hook, normalised paths. */
  private readonly edges = new Map<string, Set<string>>();
  private mocha: MochaInstance | undefined;
  private globalContext: object | undefined;
  private tzapAfterEach: MochaHook | undefined;
  /** Loaded test files (normalised) -> load error, if the file failed to load. */
  private readonly loaded = new Map<string, string | undefined>();
  /** Registered (original) tests -> identity, rebuilt after every load. */
  private registry = new Map<MochaTest, Registered>();
  /** Hits outside any test while files and `--require` modules loaded: module evaluation. */
  private readonly loadOutside = new Map<number, number>();
  private state: RunState | undefined;

  constructor(private readonly o: ExecutorOptions) {
    this.pkgRoot = o.pkgRoot;
    this.rt = install();
    const map = JSON.parse(readFileSync(o.session.instrumented, 'utf8')) as Record<string, { code: string; map: unknown }>;
    for (const [file, v] of Object.entries(map)) {
      const key = norm(path.resolve(file));
      this.instrumented.set(key, v.code);
      const sites = new Set<number>();
      for (const m of v.code.matchAll(/__tzap\.c\[(\d+)\]/g)) sites.add(Number(m[1]));
      this.sitesOf.set(key, [...sites]);
    }
    this.installHooks();

    // Mocha from the user's project, never one of tzap's own.
    const req = createRequire(path.join(this.pkgRoot, 'package.json'));
    let pkgJson: string;
    try {
      pkgJson = req.resolve('mocha/package.json');
    } catch {
      throw new Error(`mocha is not installed where Node resolves it from ${this.pkgRoot}`);
    }
    this.mochaDir = path.dirname(pkgJson);
    this.version = (JSON.parse(readFileSync(pkgJson, 'utf8')) as { version: string }).version;
    // Mocha 12 names its CommonJS files .cjs; Mocha 11 names them .js.
    const lib = (name: string) => {
      const base = path.join(this.mochaDir, 'lib', name);
      return req(existsSync(`${base}.cjs`) ? `${base}.cjs` : `${base}.js`);
    };
    const options = lib('cli/options') as { loadOptions: MochaCli['loadOptions'] };
    const helpers = lib('cli/run-helpers') as Pick<MochaCli, 'handleRequires' | 'validateLegacyPlugin'>;
    this.cli = {
      loadOptions: options.loadOptions,
      collectFiles: lib('cli/collect-files') as MochaCli['collectFiles'],
      handleRequires: helpers.handleRequires,
      validateLegacyPlugin: helpers.validateLegacyPlugin,
    };
    const config = o.session.pkg.runner?.config;
    const opts = this.cli.loadOptions(config ? ['--config', path.resolve(o.session.root, config)] : []);
    for (const k of Object.keys(opts)) {
      if (!k.includes('-')) continue;
      const camel = k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      if (!(camel in opts)) opts[camel] = opts[k];
    }
    this.options = opts;
    this.allFiles = this.findTestFiles();
  }

  /** The test files `mocha` would run, in its order; the model's `tests` globs replace its spec. */
  private findTestFiles(): string[] {
    const o = this.options;
    const tests = this.o.session.pkg.tests;
    if (tests && tests.length === 0) return [];
    const spec = tests && tests.length > 0 ? tests : (o._ ?? []).map(String);
    const r = this.cli.collectFiles({
      ignore: list(o.ignore),
      extension: list(o.extension),
      file: tests && tests.length > 0 ? [] : list(o.file),
      recursive: o.recursive === true,
      sort: o.sort === true,
      spec: spec.length > 0 ? spec : ['./test'],
    });
    const files = Array.isArray(r) ? r : r.files;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const f of files) {
      const abs = path.resolve(this.pkgRoot, f);
      if (/(^|[\\/])node_modules[\\/]/.test(path.relative(this.pkgRoot, abs))) continue;
      if (seen.has(norm(abs))) continue;
      seen.add(norm(abs));
      out.push(abs);
    }
    return out;
  }

  // --- module hooks --------------------------------------------------------------------------

  private installHooks(): void {
    const registerHooks = (nodeModule as unknown as { registerHooks?: (h: object) => unknown }).registerHooks;
    if (typeof registerHooks !== 'function') {
      throw new Error(`module.registerHooks is not available in Node ${process.version}; the Mocha adapter needs Node >= 22.15`);
    }
    type Ctx = { parentURL?: string };
    type Res = { url: string; format?: string };
    registerHooks({
      resolve: (specifier: string, context: Ctx, next: (s: string, c: Ctx) => Res): Res => {
        const r = next(specifier, context);
        const parent = context.parentURL;
        if (parent?.startsWith('file:') && r.url.startsWith('file:')) {
          const p = urlToNorm(parent);
          const c = urlToNorm(r.url);
          if (p && c) {
            let set = this.edges.get(p);
            if (!set) this.edges.set(p, (set = new Set()));
            set.add(c);
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

  // --- Mocha ---------------------------------------------------------------------------------

  /** Creates the Mocha instance on first use: `--require` modules may evaluate code under test. */
  private async ensureMocha(): Promise<MochaInstance> {
    if (this.mocha) return this.mocha;
    const req = createRequire(path.join(this.pkgRoot, 'package.json'));
    // The package main, as a test file's `require('mocha')` / `import 'mocha'` gets it: the
    // `describe`/`it` it exports must be the ones this instance sets up.
    const main = req.resolve('mocha');
    const mod = (await import(pathToFileURL(main).href)) as { default?: MochaCtor } & MochaCtor;
    const Mocha = (mod.default ?? mod) as MochaCtor;
    const o = this.options;
    const plugins = await this.cli.handleRequires(list(o.require));
    this.collectLoad();
    try {
      this.cli.validateLegacyPlugin?.(o, 'ui', Mocha.interfaces);
    } catch (e) {
      throw new Error(`mocha: ${firstMessage(e)}`);
    }
    const self = this;
    // The reporter is handed each run's runner before the run starts: the place to listen.
    function TzapReporter(this: unknown, runner: MochaRunner) {
      self.attach(runner);
    }
    const mocha = new Mocha({
      ui: o.ui,
      timeout: o.timeout,
      slow: o.slow,
      grep: o.grep,
      fgrep: o.fgrep,
      invert: o.invert,
      checkLeaks: o.checkLeaks,
      global: o.global,
      asyncOnly: o.asyncOnly,
      fullTrace: o.fullTrace,
      diff: false,
      color: false,
      ...plugins,
      reporter: TzapReporter,
      // Global fixtures run once per session (below), not once per run.
      enableGlobalSetup: false,
      enableGlobalTeardown: false,
      // Never: bail (stops at the first kill), retries (tzap sets them per test, for its tries),
      // parallel, delay, forbidPending, forbidOnly, dryRun.
    });
    mocha.cleanReferencesAfterRun(false);
    const root = mocha.suite;
    root.afterEach('tzap', function () {
      const c = self.state?.current;
      if (c && this.currentTest === c.test && !c.done) self.finish(c);
    });
    this.tzapAfterEach = root._afterEach[root._afterEach.length - 1];
    this.mocha = mocha;
    this.globalContext = mocha.hasGlobalSetupFixtures() ? await mocha.runGlobalSetup({}) : {};
    this.collectLoad();
    return mocha;
  }

  /** Loads the test files not loaded yet, one at a time so that one failing names itself. */
  private async load(mocha: MochaInstance, files: string[]): Promise<void> {
    const fresh = files.filter((f) => !this.loaded.has(norm(f)));
    if (fresh.length === 0) return;
    for (const f of fresh) {
      mocha.files = [f];
      try {
        await mocha.loadFilesAsync();
        this.loaded.set(norm(f), undefined);
      } catch (e) {
        this.loaded.set(norm(f), firstMessage(e) ?? 'failed to load');
        this.dropFile(mocha.suite, norm(f));
      }
      this.collectLoad();
    }
    mocha.files = this.allFiles.filter((f) => this.loaded.has(norm(f)));
    this.registry = this.register(mocha.suite);
  }

  private collectLoad(): void {
    for (const [site, n] of drainHits(this.rt)) this.loadOutside.set(site, (this.loadOutside.get(site) ?? 0) + n);
  }

  /** Removes what a file that failed to load had registered before it failed. */
  private dropFile(suite: MochaSuite, file: string): void {
    suite.tests = suite.tests.filter((t) => norm(t.file ?? '') !== file);
    suite.suites = suite.suites.filter((s) => norm(s.file ?? '') !== file);
    for (const s of suite.suites) this.dropFile(s, file);
  }

  /** Stable ids: file :: suite titles > test title, with ` #n` for the nth duplicate in a file. */
  private register(root: MochaSuite): Map<MochaTest, Registered> {
    const out = new Map<MochaTest, Registered>();
    const ordinals = new Map<string, number>();
    const walk = (suite: MochaSuite) => {
      // `.only` is ignored: tzap runs every test (see the package notes).
      suite._onlyTests = [];
      suite._onlySuites = [];
      for (const t of suite.tests) {
        this.wrapTest(t);
        const file = t.file ? path.resolve(this.pkgRoot, t.file) : '';
        const name = t.titlePath().join(' > ');
        const key = `${norm(file)}\0${name}`;
        const n = ordinals.get(key) ?? 0;
        ordinals.set(key, n + 1);
        const rel = path.relative(this.pkgRoot, file).replace(/\\/g, '/');
        out.set(t, { id: `${rel}::${name}${n > 0 ? ` #${n + 1}` : ''}`, name, file });
      }
      for (const s of suite.suites) walk(s);
    };
    walk(root);
    return out;
  }

  // --- the user's functions, wrapped once ------------------------------------------------------
  //
  // Mocha treats a failed beforeEach/afterEach hook as a failure of the hook and skips the rest of
  // its suite, which here would be every later try of every test in it. tzap keeps it to the try,
  // as Vitest and Jest do for a failing hook: the error is the try's, the remaining beforeEach
  // hooks and the body are not run, the afterEach hooks are, and the next try runs as usual.
  // A try whose mutant is already killed in this run (X) runs none of the user's hooks or body.

  private wrapHook(h: MochaHook, kind: 'before' | 'after'): void {
    const orig = h.fn as AnyFn | undefined;
    if (h === this.tzapAfterEach || typeof orig !== 'function' || (orig as unknown as Record<symbol, boolean>)[WRAPPED]) return;
    const self = this;
    const skip = () => {
      const c = self.state?.current;
      return c !== undefined && !c.done && (c.skipped || (kind === 'before' && c.hookFailed));
    };
    const fail = (e: unknown): boolean => {
      const c = self.state?.current;
      if (!c || c.done || isPendingSignal(e)) return false;
      if (c.error === undefined) c.error = e ?? new Error('hook failed');
      c.hookFailed = true;
      return true;
    };
    h.fn =
      orig.length > 0
        ? standIn(orig, function (this: unknown, done: unknown, ...rest: unknown[]) {
            const cb = done as (e?: unknown) => void;
            if (skip()) return cb();
            try {
              return orig.call(this, (e?: unknown) => (e && fail(e) ? cb() : cb(e)), ...rest);
            } catch (e) {
              if (fail(e)) return cb();
              throw e;
            }
          })
        : standIn(orig, function (this: unknown) {
            if (skip()) return undefined;
            let r: unknown;
            try {
              r = orig.call(this);
            } catch (e) {
              if (fail(e)) return undefined;
              throw e;
            }
            if (r && typeof (r as Promise<unknown>).then === 'function') {
              return (r as Promise<unknown>).then(
                () => undefined,
                (e: unknown) => {
                  if (!fail(e)) throw e;
                },
              );
            }
            return r;
          });
  }

  /**
   * The test body: records a failure as the try's, and fails a try that is not the test's last
   * with the NEXT marker, so that Mocha's retry loop runs the next one. The last try reports its
   * real result. Not run at all behind a failed beforeEach (the hook's error is the try's) or for
   * an already-killed mutant.
   */
  private wrapTest(t: MochaTest): void {
    const orig = t.fn as AnyFn | undefined;
    if (typeof orig !== 'function' || (orig as unknown as Record<symbol, boolean>)[WRAPPED]) return;
    const self = this;
    t.fn = standIn(orig, function (this: unknown, ...args: unknown[]) {
      const c = self.state?.current;
      if (!c || c.done) return orig.apply(this, args);
      const last = c.index >= c.total - 1;
      /** What the body reports to Mocha: the marker while tries remain, else its own result. */
      const settle = (failed: boolean, e?: unknown): unknown => {
        if (failed && !c.done && c.error === undefined) c.error = e ?? new Error('failed with no reason');
        return last ? (failed ? (e ?? new Error('failed with no reason')) : undefined) : NEXT;
      };
      const callback = orig.length > 0;
      const cb = args[0] as (e?: unknown) => void;
      if (c.skipped || c.hookFailed) {
        const out = settle(c.hookFailed, c.error);
        if (callback) return cb(out);
        if (out !== undefined) throw out;
        return undefined;
      }
      let r: unknown;
      try {
        r = callback ? orig.call(this, (e?: unknown) => cb(e ? settle(true, e) : settle(false)), ...args.slice(1)) : orig.apply(this, args);
      } catch (e) {
        if (isPendingSignal(e)) throw e;
        throw settle(true, e);
      }
      if (callback) return r;
      if (r && typeof (r as Promise<unknown>).then === 'function') {
        return (r as Promise<unknown>).then(
          () => {
            const out = settle(false);
            if (out !== undefined) throw out;
          },
          (e: unknown) => {
            if (isPendingSignal(e)) throw e;
            throw settle(true, e);
          },
        );
      }
      const out = settle(false);
      if (out !== undefined) throw out;
      return r;
    });
  }

  // --- per try ----------------------------------------------------------------------------------

  private runner: MochaRunner | undefined;

  private attach(runner: MochaRunner): void {
    this.runner = runner;
    runner.on('test', (t: MochaTest) => this.beforeTest(t));
    runner.on('fail', (r: MochaRunnable, err: unknown) => this.onFail(r, err));
    // A try that is not the last failed in a way the body wrapper did not see (Mocha's timeout,
    // an uncaught error): Mocha retries it, reporting the error only here.
    runner.on('retry', (t: MochaTest, err: unknown) => {
      const c = this.state?.current;
      if (c && !c.done && c.test === t && err !== NEXT && c.error === undefined) c.error = err ?? new Error('failed');
    });
  }

  private collectOutside(): void {
    const st = this.state;
    const hits = drainHits(this.rt);
    if (!st || st.mode !== 'coverage') return;
    for (const [site, n] of hits) st.outside.set(site, (st.outside.get(site) ?? 0) + n);
  }

  /** Mocha's `test` event: before any beforeEach hook of the try. */
  private beforeTest(t: MochaTest): void {
    const st = this.state;
    if (!st) return;
    const entry = st.entries.get(t.retriedTest() ?? t);
    if (!entry) return;
    this.finishPending();
    const copy: Copy = { info: entry.info, index: t.currentRetry(), total: entry.total, test: t, started: performance.now(), skipped: false, error: undefined, hookFailed: false, done: false };
    if (copy.index >= copy.total) return; // a retry the user asked for inside the test: not a try
    st.current = copy;
    if (st.mode === 'coverage') {
      this.o.onProgress?.(st.req.id, copy.info.id, -1, false);
      this.collectOutside();
      endTry(this.rt);
      return;
    }
    const tr = copy.info.tries![copy.index]!;
    // m === -1 is a control try: the test unmutated, bracketing the mutant tries so the engine can
    // tell a test that fails because of its context from one that fails because of a mutant.
    if (st.mode === 'mutate' && tr.m >= 0 && st.killed.has(tr.m)) {
      this.rt.a = -1;
      copy.skipped = true;
      return;
    }
    this.o.onProgress?.(st.req.id, copy.info.id, tr.m, false);
    beginTry(this.rt, st.mode === 'static' ? st.staticMutant : tr.m, tr.N, tr.L);
  }

  private onFail(r: MochaRunnable, err: unknown): void {
    const st = this.state;
    if (!st) return;
    const c = st.current;
    if (r.type === 'test') {
      if (c && !c.done && c.test === r && c.error === undefined) c.error = err ?? new Error('failed');
      return;
    }
    const kind = hookKind(r);
    if (kind === 'each') {
      // A hook failure the wrapper could not keep inside the try (the hook timed out): the try
      // failed, and Mocha skips the rest of the hook's suite. Those tries are not reported; the
      // engine decides them again in isolation.
      if (c && !c.done && c.error === undefined) c.error = err ?? new Error('hook failed');
      return;
    }
    // A before/after all hook: an error of the file it belongs to (of every file, at the root).
    let s: MochaSuite | undefined = r.parent;
    while (s && !s.file && !s.root) s = s.parent;
    const message = `${r.title}: ${firstMessage(err) ?? 'failed'}`;
    const files = s?.file ? [norm(path.resolve(this.pkgRoot, s.file))] : [...st.files];
    for (const f of files) if (!st.fileErrors.has(f)) st.fileErrors.set(f, message);
  }

  /** A try whose root afterEach never ran (a root afterEach before it threw) is finished late. */
  private finishPending(): void {
    const c = this.state?.current;
    if (c && !c.done) this.finish(c);
  }

  private finish(copy: Copy): void {
    const st = this.state!;
    copy.done = true;
    st.current = undefined;
    const t = copy.test;
    const failed = copy.error !== undefined || t.state === 'failed';
    const message = failed ? (firstMessage(copy.error ?? t.err) ?? 'failed') : undefined;
    const info = copy.info;
    info.ran = true;
    const elapsed = performance.now() - copy.started;
    if (st.mode === 'coverage') {
      this.o.onProgress?.(st.req.id, info.id, -1, true);
      const hits = drainHits(this.rt);
      if (copy.index === 0) {
        info.hits = hits;
        info.loops = this.rt.l;
        info.duration = elapsed;
        // A test that skipped itself (`this.skip()`) decides nothing.
        info.state = failed ? 'fail' : t.isPending() ? 'skip' : 'pass';
        if (failed) info.message = message;
      } else {
        info.hits2 = hits;
        // Passed once, failed when repeated: the test is not repeatable. Not a red test.
        if (failed && info.state !== 'fail') info.repeatFail = message;
      }
      endTry(this.rt);
      this.release(t);
      return;
    }
    const tr = info.tries![copy.index]!;
    this.o.onProgress?.(st.req.id, info.id, tr.m, true);
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
    this.release(t);
  }

  /**
   * The runner keeps the `error` listener it put on every test it ran until the run ends: tens of
   * thousands of retry clones in one run, which measured as a per-try cost growing with the run
   * (GC). A finished clone's listener is dropped at once.
   */
  private release(t: MochaTest): void {
    if (!t.retriedTest()) return;
    const map = this.runner?._eventListeners;
    const byEvent = map?.get(t);
    if (!byEvent) return;
    for (const [event, listeners] of byEvent) for (const l of listeners) (t as unknown as NodeJS.EventEmitter).removeListener(event, l);
    map!.delete(t);
  }

  // --- a run ------------------------------------------------------------------------------------

  async run(req: RunRequest): Promise<RunResult> {
    const started = performance.now();
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
    if (files.length === 0) return { id: req.id, tests: [], files: [], durationMs: performance.now() - started };

    const staticMutant = req.staticMutant ?? -1;
    endTry(this.rt);
    // Static: active before anything this run loads evaluates (in an isolated host, everything).
    if (req.mode === 'static') this.rt.a = staticMutant;
    this.collectLoad();
    const mocha = await this.ensureMocha();
    await this.load(mocha, files);
    this.rt.a = req.mode === 'static' ? staticMutant : -1;

    const st: RunState = {
      req,
      mode: req.mode,
      staticMutant,
      entries: new Map(),
      current: undefined,
      killed: new Set(),
      outside: new Map(),
      fileErrors: new Map(),
      files: new Set(files.map(norm)),
    };
    for (const f of files) {
      const err = this.loaded.get(norm(f));
      if (err !== undefined) st.fileErrors.set(norm(f), err);
    }
    const infos = this.expand(mocha.suite, st, plan);
    const root = mocha.suite;
    // tzap's afterEach runs after every other root afterEach, those of plugins and test files.
    root._afterEach = [...root._afterEach.filter((h) => h !== this.tzapAfterEach), this.tzapAfterEach!];

    this.state = st;
    this.running = true;
    try {
      await new Promise<void>((resolve) => mocha.run(() => resolve()));
    } finally {
      this.finishPending();
      this.collectOutside();
      endTry(this.rt);
      this.restore(mocha.suite);
      this.state = undefined;
      this.running = false;
    }
    return this.result(st, infos, files, performance.now() - started);
  }

  private readonly originals = new Map<MochaSuite, MochaTest[]>();

  /** Narrows every suite to this run's planned tests; returns them in file order. */
  private expand(root: MochaSuite, st: RunState, plan: Record<string, Try[]>): TestInfo[] {
    const infos: TestInfo[] = [];
    const walk = (suite: MochaSuite) => {
      // A kill must not stop the run, and neither may a red test in coverage.
      suite._bail = false;
      for (const h of suite._beforeEach) this.wrapHook(h, 'before');
      for (const h of suite._afterEach) this.wrapHook(h, 'after');
      const tests = suite.tests;
      this.originals.set(suite, tests);
      const run: MochaTest[] = [];
      for (const t of tests) {
        const reg = this.registry.get(t);
        if (!reg || !st.files.has(norm(reg.file))) continue;
        const info: TestInfo = { ...reg, skip: false, ran: false, state: 'skip', duration: 0, outcomes: [] };
        if (t.isPending()) {
          if (st.mode === 'coverage') infos.push(info);
          continue;
        }
        let n: number;
        if (st.mode === 'coverage') n = 2;
        else {
          info.tries = plan[reg.id];
          n = info.tries?.length ?? 0;
        }
        if (n === 0) continue;
        infos.push(info);
        st.entries.set(t, { info, total: n });
        t.retries(n - 1);
        run.push(t);
      }
      suite.tests = run;
      for (const s of suite.suites) walk(s);
    };
    walk(root);
    const order = new Map(this.allFiles.map((f, i) => [norm(f), i]));
    return infos.map((info, i) => ({ info, i })).sort((a, b) => (order.get(norm(a.info.file)) ?? 0) - (order.get(norm(b.info.file)) ?? 0) || a.i - b.i).map((x) => x.info);
  }

  private restore(root: MochaSuite): void {
    const walk = (suite: MochaSuite) => {
      const orig = this.originals.get(suite);
      if (orig) suite.tests = orig;
      for (const s of suite.suites) walk(s);
    };
    walk(root);
    this.originals.clear();
  }

  private result(st: RunState, infos: TestInfo[], files: string[], durationMs: number): RunResult {
    const tests: TestOutcome[] = [];
    for (const info of infos) {
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
    let outside: Map<number, number> | undefined;
    if (st.mode === 'coverage') {
      outside = new Map(this.loadOutside);
      for (const [site, n] of st.outside) outside.set(site, (outside.get(site) ?? 0) + n);
    }
    const fileOutcomes: FileOutcome[] = files.map((f) => {
      const fo: FileOutcome = { file: f };
      const err = st.fileErrors.get(norm(f));
      if (err !== undefined) fo.error = err;
      if (outside) fo.staticHits = this.staticHitsFor(f, outside);
      return fo;
    });
    return { id: st.req.id, tests, files: fileOutcomes, durationMs };
  }

  /**
   * Hits outside any test (module evaluation, suite hooks) attributed to a test file. A module
   * evaluates once per process, while the first file that imports it loads, so the hits are
   * attributed to every test file whose import closure reaches the module: each of them would
   * evaluate it on its own.
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

  /** Global teardown fixtures, once, as `mocha` runs them after its one run. */
  async close(): Promise<void> {
    const mocha = this.mocha;
    if (mocha && this.globalContext && mocha.hasGlobalTeardownFixtures()) await mocha.runGlobalTeardown(this.globalContext);
  }
}
