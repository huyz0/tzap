/**
 * The Jest host: a child process that runs the package's Jest in band, once per engine request,
 * and talks to the engine over IPC. A separate process so that a mutant which blocks the event
 * loop forever can be dealt with by killing it.
 *
 * One request is one `runCLI({ runInBand: true })` call. Its fixed cost is paid per round, not
 * per mutant: the tzap test environment runs every planned try of a test inside the one run
 * (see environment.cts and docs/spikes/B-jest-warm.md). With `runInBand` the test files execute
 * in this process, so the environment reads the plan from, and writes outcomes to, a global here.
 */
import { createRequire } from 'node:module';
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FileOutcome, HostRequest, HostResponse, RunRequest, RunResult, SessionOptions, TestOutcome } from '@tzap/protocol';
import type { RunState, StateKey } from './shared.cjs';

const STATE_KEY: StateKey = '__tzapJestRun';

const send = (m: HostResponse) => process.send?.(m);
const slash = (p: string) => p.replace(/\\/g, '/');
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A regex source matching any path under `dir`, with either separator. */
const under = (dir: string) => slash(dir).split('/').map(escape).join('[\\\\/]') + '[\\\\/]';

type RunCLI = (argv: Record<string, unknown>, projects: string[]) => Promise<{ globalConfig: { updateSnapshot: string }; results: AggregatedResult }>;
interface AggregatedResult {
  testResults: Array<{ testFilePath: string; testExecError?: { message?: string }; failureMessage?: string | null; numFailingTests: number }>;
}
interface ProjectConfig {
  rootDir: string;
  transform: Array<[string, string, unknown]>;
  transformIgnorePatterns: string[];
  testEnvironment: string;
}

let runCLI: RunCLI;
let config: string;
let pkgRoot: string;
let rootDir: string;
let envShim = '';
let jestMajor = 0;

async function init(o: SessionOptions): Promise<void> {
  pkgRoot = path.resolve(o.root, o.pkg.root);
  process.chdir(pkgRoot);
  for (const [k, v] of Object.entries(o.pkg.env ?? {})) process.env[k] = v;
  process.env.TZAP = '1';

  const require = createRequire(path.join(pkgRoot, 'package.json'));
  let jestPath: string;
  try {
    jestPath = require.resolve('jest');
  } catch {
    throw new Error(`jest is not installed in ${pkgRoot} (could not resolve "jest" from there)`);
  }
  const fromJest = createRequire(jestPath);
  const version = (JSON.parse(readFileSync(require.resolve('jest/package.json'), 'utf8')) as { version: string }).version;
  const major = (jestMajor = Number(version.split('.')[0]));
  if (major !== 29 && major !== 30) throw new Error(`tzap supports Jest 29 and 30; ${pkgRoot} has Jest ${version}`);
  const corePath = fromJest.resolve('@jest/core');
  const core = fromJest(corePath) as { runCLI: RunCLI };
  const jestConfig = createRequire(corePath)('jest-config') as {
    readConfigs(argv: object, projects: string[]): Promise<{ configs: ProjectConfig[] }>;
    readInitialOptions(configPath?: string, opts?: object): Promise<{ config: Record<string, unknown>; configPath: string | null }>;
  };
  runCLI = core.runCLI;

  const configPath = o.pkg.runner?.config ? path.resolve(o.root, o.pkg.runner.config) : undefined;
  const baseArgv = { _: [], $0: 'tzap', ...(configPath ? { config: configPath } : {}) };
  const { configs } = await jestConfig.readConfigs(baseArgv, [pkgRoot]);
  if (configs.length !== 1) throw new Error(`tzap supports a single Jest project per package; ${pkgRoot} has ${configs.length} (the "projects" option)`);
  const project = configs[0]!;
  const initial = await jestConfig.readInitialOptions(configPath, { packageRootOrConfig: pkgRoot });
  rootDir = project.rootDir;

  // The environment: the project's own, extended by tzap, through a shim that lives in
  // node_modules so Jest does not transform it.
  const dist = import.meta.dirname;
  const shimDir = path.join(pkgRoot, 'node_modules', '.tzap');
  mkdirSync(shimDir, { recursive: true });
  // Shims of hosts that were killed (the hang backstop) are left behind; remove those.
  for (const f of readdirSync(shimDir)) {
    const pid = /^jest-environment-(\d+)\.cjs$/.exec(f)?.[1];
    if (pid === undefined || Number(pid) === process.pid) continue;
    let alive = true;
    try {
      process.kill(Number(pid), 0);
    } catch {
      alive = false;
    }
    if (!alive) rmSync(path.join(shimDir, f), { force: true });
  }
  envShim =path.join(shimDir, `jest-environment-${process.pid}.cjs`);
  writeFileSync(
    envShim,
    `const m = require(${JSON.stringify(project.testEnvironment)});\n` +
      `module.exports = require(${JSON.stringify(path.join(dist, 'environment.cjs'))}).extend(m && m.__esModule ? m.default : m);\n`,
  );
  // Loaded once here, so Jest's require hook never sees (and never transforms) tzap's own code.
  createRequire(import.meta.url)(path.join(dist, 'environment.cjs'));

  const transformer = path.join(dist, 'transformer.cjs');
  const transform: Record<string, [string, object]> = {};
  for (const [pattern, delegate, delegateOptions] of project.transform) {
    transform[pattern] = [transformer, { delegate, delegateOptions, instrumented: o.instrumented }];
  }
  // Jest must not transform the runtime. In the published package it is bundled into this
  // directory rather than installed as @tzap/runtime.
  let runtimeDir = dist;
  try {
    runtimeDir = path.dirname(createRequire(import.meta.url).resolve('@tzap/runtime'));
  } catch {
    // bundled
  }
  const raw: Record<string, unknown> = {
    ...initial.config,
    rootDir,
    transform,
    transformIgnorePatterns: [...project.transformIgnorePatterns, under(realpathSync(dist)), under(realpathSync(runtimeDir))],
    testEnvironment: envShim,
    // Instrumented outputs never land in the project's own cache.
    cacheDirectory: path.join(os.tmpdir(), 'tzap-jest-cache'),
    collectCoverage: false,
  };
  delete raw.projects;
  config = JSON.stringify(raw);

  send({ type: 'ready', runnerVersion: version });
}

async function run(req: RunRequest): Promise<RunResult> {
  const started = performance.now();
  const state: RunState = {
    runId: req.id,
    mode: req.mode,
    plan: req.plan ?? {},
    staticMutant: req.staticMutant ?? -1,
    ...(req.staticLimit !== undefined ? { staticLimit: req.staticLimit } : {}),
    jestMajor,
    killed: new Set(),
    rootDir,
    tests: [],
    staticHits: new Map(),
    progress: (test, mutant) => send({ type: 'progress', runId: req.id, test, mutant }),
  };
  (globalThis as unknown as Record<string, unknown>)[STATE_KEY] = state;
  const tests: TestOutcome[] = [];
  const files: FileOutcome[] = [];
  let paths: string[] = [];
  if (req.files) {
    // The engine may hand paths lower-cased; Jest matches them case-sensitively.
    for (const f of req.files) {
      try {
        paths.push(realpathSync.native(f));
      } catch {
        // A test file that no longer exists runs nothing.
      }
    }
    if (paths.length === 0) return { id: req.id, tests, files, durationMs: performance.now() - started };
  }
  const argv: Record<string, unknown> = {
    _: paths,
    $0: 'tzap',
    config,
    runInBand: true,
    runTestsByPath: req.files !== undefined,
    ci: true,
    silent: true,
    reporters: [],
    watch: false,
    watchAll: false,
    watchman: false,
    cache: true,
    coverage: false,
    passWithNoTests: true,
    detectOpenHandles: false,
    useStderr: true,
  };
  try {
    const { globalConfig, results } = await runCLI(argv, [pkgRoot]);
    // Snapshots are never written in a mutation run: `ci` without `-u` means `none`.
    if (globalConfig.updateSnapshot !== 'none') throw new Error(`Jest would write snapshots (updateSnapshot: ${globalConfig.updateSnapshot})`);
    for (const tr of results.testResults) {
      const file = slash(tr.testFilePath);
      const fo: FileOutcome = { file };
      if (tr.testExecError) fo.error = tr.testExecError.message ?? 'test file failed';
      else if (tr.failureMessage && tr.numFailingTests === 0 && req.mode !== 'coverage') fo.error = tr.failureMessage.replace(/\u001b\[[0-9;]*m/g, '').slice(0, 300);
      const sh = state.staticHits.get(file);
      if (sh) fo.staticHits = sh;
      files.push(fo);
    }
    tests.push(...state.tests);
    if (req.mode === 'mutate') {
      // A planned test that never reported (its file failed to load, say) decided nothing.
      const seen = new Set(tests.map((t) => t.id));
      for (const [id, tries] of Object.entries(state.plan)) {
        if (seen.has(id)) continue;
        tests.push({ id, name: id, file: '', state: 'skip', duration: 0, tries: tries.map((t) => (t.m >= 0 ? [t.m, 'U'] : [t.m, 'K', 'tzap: test did not run'])) });
      }
    }
  } finally {
    delete (globalThis as unknown as Record<string, unknown>)[STATE_KEY];
  }
  return { id: req.id, tests, files, durationMs: performance.now() - started };
}

process.on('message', (msg: HostRequest) => {
  void (async () => {
    try {
      if (msg.type === 'init') await init(msg.options);
      else if (msg.type === 'run') send({ type: 'result', result: await run(msg.request) });
      else if (msg.type === 'close') {
        try {
          rmSync(envShim, { force: true });
        } catch {
          // best effort
        }
        process.exit(0);
      }
    } catch (e) {
      const err = e as Error;
      send({ type: 'error', message: `${err.message}\n${err.stack ?? ''}`, during: msg.type === 'init' ? 'init' : 'run' });
    }
  })();
});

process.on('unhandledRejection', (e) => {
  send({ type: 'error', message: `unhandled rejection in the Jest host: ${String((e as Error)?.stack ?? e)}`, during: 'background' });
});
