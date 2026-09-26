/**
 * The Vitest host: a child process that owns one Vitest instance for one package and runs
 * whatever the engine asks, over the IPC channel. A separate process so that a mutant which
 * blocks a worker forever can be dealt with by killing the process, which is the only thing
 * that reliably stops synchronous JavaScript.
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FileOutcome, HostRequest, HostResponse, RunRequest, RunResult, SessionOptions, TestOutcome } from '@tzap/protocol';
import { PROGRESS_CHANNEL } from '@tzap/protocol';

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
    config(cfg: { test?: { setupFiles?: string | string[] } }) {
      cfg.test ??= {};
      const s = cfg.test.setupFiles;
      cfg.test.setupFiles = [shim, ...(s === undefined ? [] : Array.isArray(s) ? s : [s])];
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

  const channel = new BroadcastChannel(PROGRESS_CHANNEL);
  channel.onmessage = (e: MessageEvent) => {
    const [runId, test, mutant] = e.data as [number, string, number];
    send({ type: 'progress', runId, test, mutant });
  };
  (channel as unknown as { unref?: () => void }).unref?.();

  send({ type: 'ready', runnerVersion: vitestPkg.version });
}

function toArray(v: unknown): Array<[number, number]> | undefined {
  return Array.isArray(v) ? (v as Array<[number, number]>) : undefined;
}

async function run(req: RunRequest): Promise<RunResult> {
  const v = vitest!;
  const started = performance.now();
  v.provide('tzap', { runId: req.id, mode: req.mode, plan: req.plan, staticMutant: req.staticMutant });
  let specs = await v.globTestSpecifications();
  if (req.files) {
    const wanted = new Set(req.files.map(norm));
    specs = specs.filter((s) => wanted.has(norm(s.moduleId)));
  }
  const tests: TestOutcome[] = [];
  const files: FileOutcome[] = [];
  if (specs.length > 0) {
    const res = await v.runTestSpecifications(specs);
    for (const mod of res.testModules) {
      const meta = mod.meta();
      const errs = mod.errors();
      const fo: FileOutcome = { file: mod.moduleId };
      if (errs.length > 0) fo.error = errs[0]?.message ?? 'test file failed';
      const sh = toArray(meta.tzapStatic);
      if (sh) fo.staticHits = sh;
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
          duration: t.diagnostic()?.duration ?? 0,
        };
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
