/**
 * The Vitest host: a child process that owns one Vitest instance for one package and runs
 * whatever the engine asks, over the IPC channel. A separate process so that a mutant which
 * blocks a worker forever can be dealt with by killing the process, which is the only thing
 * that reliably stops synchronous JavaScript.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FileOutcome, HostRequest, HostResponse, RunRequest, RunResult, SessionOptions, TestOutcome } from '@tzap/protocol';
import { PROGRESS_DIR_ENV } from '@tzap/protocol';

const send = (m: HostResponse) => process.send?.(m);

const norm = (p: string) => {
  const s = p.replace(/\\/g, '/');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};

interface Instrumented {
  [absPath: string]: { code: string; map: unknown };
}

type Vitest = {
  version?: string;
  provide(key: string, value: unknown): void;
  globTestSpecifications(): Promise<Spec[]>;
  runTestSpecifications(specs: Spec[]): Promise<{ testModules: TestModule[]; unhandledErrors: unknown[] }>;
  close(): Promise<void>;
  config: { root: string };
};
type Spec = { moduleId: string };
type TestModule = {
  moduleId: string;
  meta(): Record<string, unknown>;
  errors(): Array<{ message?: string }>;
  state(): string;
  children: { allTests(): Iterable<TestCase> };
};
type TestCase = {
  id: string;
  name: string;
  fullName: string;
  module: TestModule;
  meta(): Record<string, unknown>;
  result(): { state: string; errors?: Array<{ message?: string }> };
  diagnostic(): { duration: number } | undefined;
};

let vitest: Vitest | undefined;
let options: SessionOptions;

async function init(o: SessionOptions): Promise<void> {
  options = o;
  const pkgRoot = path.resolve(o.root, o.pkg.root);
  process.chdir(pkgRoot);
  for (const [k, v] of Object.entries(o.pkg.env ?? {})) process.env[k] = v;
  process.env.TZAP = '1';
  // Workers, threads or forks, inherit this and write their progress files there.
  process.env[PROGRESS_DIR_ENV] = path.join(o.tmpDir, `progress-${process.pid}`);
  // What the vitest CLI sets before it loads a config; plugins read these in their config hooks
  // (@testing-library/svelte adds the `browser` condition only when VITEST is set).
  process.env.TEST = 'true';
  process.env.VITEST = 'true';
  process.env.NODE_ENV ??= 'test';

  const require = createRequire(path.join(pkgRoot, 'package.json'));
  let vitestNodePath: string;
  try {
    vitestNodePath = require.resolve('vitest/node');
  } catch {
    throw new Error(`vitest is not installed in ${pkgRoot} (could not resolve "vitest/node" from there)`);
  }
  const vitestPkg = JSON.parse(readFileSync(require.resolve('vitest/package.json'), 'utf8')) as { version: string };
  const { createVitest } = (await import(pathToFileURL(vitestNodePath).href)) as {
    createVitest: (mode: string, options: object, viteOverrides: object) => Promise<Vitest>;
  };

  const instrumented = JSON.parse(readFileSync(o.instrumented, 'utf8')) as Instrumented;
  const byId = new Map<string, { code: string; map: unknown }>();
  for (const [file, value] of Object.entries(instrumented)) byId.set(norm(file), value);

  // The setup shim lives inside the package's node_modules so that its `import 'vitest'`
  // resolves exactly as the user's test files do, to the same Vitest instance.
  const shimDir = path.join(pkgRoot, 'node_modules', '.tzap');
  mkdirSync(shimDir, { recursive: true });
  const shim = path.join(shimDir, `setup-${process.pid}.mjs`);
  const setupUrl = pathToFileURL(path.join(import.meta.dirname, 'worker-setup.js')).href;
  writeFileSync(shim, `import * as vitest from 'vitest';\nimport { setup } from ${JSON.stringify(setupUrl)};\nsetup(vitest);\n`);

  const plugin = {
    name: 'tzap:instrument',
    enforce: 'pre' as const,
    config(cfg: { root?: string; test?: { setupFiles?: string | string[]; projects?: unknown[]; fsModuleCache?: boolean } }) {
      cfg.test ??= {};
      const s = cfg.test.setupFiles;
      cfg.test.setupFiles = [shim, ...(s === undefined ? [] : Array.isArray(s) ? s : [s])];
      // Instrumented code must never reach Vitest's persistent transform cache, where a later
      // ordinary run could find it.
      cfg.test.fsModuleCache = false;
      // Projects have their own Vite servers and do not inherit the root's plugins: give each
      // one this plugin, so its modules are instrumented and its tests get the setup file.
      if (Array.isArray(cfg.test.projects)) cfg.test.projects = expandProjects(cfg.test.projects, cfg.root ? path.resolve(pkgRoot, cfg.root) : pkgRoot, plugin);
    },
    load(id: string) {
      const q = id.indexOf('?');
      const clean = norm(q === -1 ? id : id.slice(0, q));
      const hit = byId.get(clean);
      if (hit) return { code: hit.code, map: hit.map };
      return undefined;
    },
  };

  const config = o.pkg.runner?.config ? path.resolve(o.root, o.pkg.runner.config) : undefined;
  const cliOptions: Record<string, unknown> = {
    watch: false,
    reporters: [],
    passWithNoTests: true,
    silent: true,
    update: false,
    coverage: { enabled: false },
    ui: false,
    api: false,
  };
  if (config) cliOptions.config = config;
  if (o.isolate !== undefined) cliOptions.isolate = o.isolate;
  if (o.workers !== undefined) cliOptions.maxWorkers = o.workers;
  vitest = await createVitest('test', cliOptions, { plugins: [plugin] });
  (vitest as { version?: string }).version = vitestPkg.version;


  send({ type: 'ready', runnerVersion: vitestPkg.version });
}

const CONFIG_NAMES = ['vitest.config', 'vite.config'].flatMap((b) => ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].map((e) => `${b}.${e}`));

function findConfig(dir: string): string | undefined {
  for (const name of CONFIG_NAMES) {
    const p = path.join(dir, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** Minimal glob for project entries: `*` within one path segment, as Vitest's own examples use. */
function expandGlob(root: string, pattern: string): string[] {
  const parts = pattern.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
  let current = [root];
  for (const part of parts) {
    const next: string[] = [];
    const escaped = part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
    const re = new RegExp(`^${escaped}$`);
    for (const dir of current) {
      if (!part.includes('*') && !part.includes('?')) {
        const p = path.join(dir, part);
        if (existsSync(p)) next.push(p);
        continue;
      }
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        entries = [];
      }
      for (const e of entries) if (e !== 'node_modules' && re.test(e)) next.push(path.join(dir, e));
    }
    current = next;
  }
  return current;
}

/**
 * Rewrites `test.projects` so every project carries tzap's plugin. A string entry (a directory or
 * config-file glob) becomes `{ extends: <its config>, test: { root: <its dir> }, plugins: [tzap] }`;
 * an inline object gains the plugin.
 */
function expandProjects(projects: unknown[], root: string, plugin: object): unknown[] {
  const out: unknown[] = [];
  for (const entry of projects) {
    if (typeof entry === 'string') {
      for (const target of expandGlob(root, entry)) {
        let dir = target;
        let config: string | undefined;
        try {
          if (statSync(target).isFile()) {
            config = target;
            dir = path.dirname(target);
          } else config = findConfig(target);
        } catch {
          continue;
        }
        out.push(config ? { extends: config, test: { root: dir }, plugins: [plugin] } : { test: { root: dir }, plugins: [plugin] });
      }
    } else if (entry && typeof entry === 'object') {
      const e = entry as { plugins?: unknown[] };
      out.push({ ...e, plugins: [...(e.plugins ?? []), plugin] });
    } else {
      out.push(entry);
    }
  }
  return out;
}

function sameHits(a: Array<[number, number]>, b: Array<[number, number]>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]![0] !== b[i]![0] || a[i]![1] !== b[i]![1]) return false;
  return true;
}

function toArray(v: unknown): Array<[number, number]> | undefined {
  return Array.isArray(v) ? (v as Array<[number, number]>) : undefined;
}

async function run(req: RunRequest): Promise<RunResult> {
  const v = vitest!;
  const started = performance.now();
  v.provide('tzap', { runId: req.id, mode: req.mode, plan: req.plan, staticMutant: req.staticMutant, staticPlan: req.staticPlan, staticLimit: req.staticLimit });
  let specs = await v.globTestSpecifications();
  if (req.files) {
    const wanted = new Set(req.files.map(norm));
    specs = specs.filter((s) => wanted.has(norm(s.moduleId)));
  }
  const tests: TestOutcome[] = [];
  const files: FileOutcome[] = [];
  if (specs.length > 0) {
    const res = await v.runTestSpecifications(specs);
    // The result lists every module Vitest has ever run in this instance, not only this run's.
    const ran = new Set(specs.map((s) => norm(s.moduleId)));
    for (const mod of res.testModules) {
      if (!ran.has(norm(mod.moduleId))) continue;
      const meta = mod.meta();
      const errs = mod.errors();
      const fo: FileOutcome = { file: mod.moduleId };
      if (errs.length > 0) fo.error = errs[0]?.message ?? 'test file failed';
      const sh = toArray(meta.tzapStatic);
      if (sh) fo.staticHits = sh;
      if (typeof meta.tzapLoadLoops === 'number') fo.loadLoops = meta.tzapLoadLoops;
      files.push(fo);
      for (const t of mod.children.allTests()) {
        const r = t.result();
        const state = r.state === 'passed' ? 'pass' : r.state === 'failed' ? 'fail' : 'skip';
        const m = t.meta();
        const out: TestOutcome = {
          id: t.id,
          name: t.fullName,
          file: mod.moduleId,
          state,
          duration: typeof m.tzapDuration === 'number' ? m.tzapDuration : (t.diagnostic()?.duration ?? 0),
        };
        if (req.mode === 'coverage') {
          const h1 = toArray(m.tzapHits) ?? [];
          const h2 = toArray(m.tzapHits2);
          if (typeof m.tzapRepeatFail === 'string') out.stateSensitive = `fails when repeated: ${m.tzapRepeatFail}`;
          else if (h2 && !sameHits(h1, h2)) out.stateSensitive = 'takes a different path when repeated';
        }
        if (state === 'fail') out.message = r.errors?.[0]?.message ?? 'failed';
        const hits = toArray(m.tzapHits);
        if (hits) out.hits = hits;
        if (typeof m.tzapLoops === 'number') out.loops = m.tzapLoops;
        if (Array.isArray(m.tzap)) out.tries = m.tzap as TestOutcome['tries'];
        tests.push(out);
      }
    }
  }
  return { id: req.id, tests, files, durationMs: performance.now() - started };
}

process.on('message', (msg: HostRequest) => {
  void (async () => {
    try {
      if (msg.type === 'init') await init(msg.options);
      else if (msg.type === 'run') send({ type: 'result', result: await run(msg.request) });
      else if (msg.type === 'list') send({ type: 'files', files: [...new Set((await vitest!.globTestSpecifications()).map((s) => s.moduleId))] });
      else if (msg.type === 'close') {
        await vitest?.close();
        process.exit(0);
      }
    } catch (e) {
      const err = e as Error;
      send({ type: 'error', message: `${err.message}\n${err.stack ?? ''}`, during: msg.type === 'init' ? 'init' : 'run' });
    }
  })();
});

process.on('unhandledRejection', (e) => {
  send({ type: 'error', message: `unhandled rejection in the Vitest host: ${String((e as Error)?.stack ?? e)}`, during: 'background' });
});
