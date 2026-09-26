import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  compareMutants,
  languageOf,
  type AnalysisResult,
  type MutantDescriptor,
  type MutantResult,
  type PackageModel,
  type ProjectModel,
  type SourceFile,
  type TestInfo,
} from '@tzap/model';
import { instrument, type LineRange, type MutantFilter } from '@tzap/instrument';
import { normPath, type RunnerFactory, type RunnerSession, type RunResult, type Try } from '@tzap/protocol';
import { createHash } from 'node:crypto';
import { relativeTo, sourceFiles, toPosix } from './files.js';
import { ImportGraph, realPath } from './graph.js';

export type EngineKind = 'warm' | 'reference';

export interface EngineOptions {
  engine?: EngineKind;
  /** Enabled mutator names; default all. */
  mutators?: readonly string[];
  filters?: ReadonlyArray<{ name: string; filter: MutantFilter }>;
  /**
   * Re-decide warm survivors in isolation before reporting them. A warm try can be masked by
   * state an earlier run of the same test left behind: a mutant that removes a registration
   * survives because the registration is still there from the run before. Kills need no second
   * look — a test failed with the mutant active — but a survivor is what people act on.
   * `'auto'` (the default) confirms the survivors whose tests can reach module state, `true`
   * every survivor, `false` none (faster, and a masked kill can then pass as a survivor).
   */
  verifySurvivors?: boolean | 'auto';
  /** Opt-in reductions: see InstrumentInput.reduce. */
  reduce?: { onePerLine?: boolean; equivalence?: boolean };
  /** Changed lines per root-relative file. Undefined: everything is in scope. Files absent from the map are out of scope. */
  lines?: ReadonlyMap<string, readonly LineRange[]>;
  /** Runner factories by runner kind. */
  runners: Readonly<Record<string, RunnerFactory>>;
  /** Worker count passed to each runner. */
  workers?: number;
  /**
   * Let runners use worker threads where the project has not chosen how its tests run (default
   * true). A package whose baseline is not clean in threads falls back to its own setting.
   */
  preferThreads?: boolean;
  /** Concurrent sessions for the reference engine. */
  concurrency?: number;
  /** Previously killing test per mutant id, from the cache: tried first. */
  previousKillers?: ReadonlyMap<string, string>;
  /** Verdicts to reuse, keyed by mutant id (decided by the cache). */
  reuse?: (m: MutantDescriptor, coverage: MutantCoverage) => MutantResult | undefined;
  /**
   * Set when nothing that could change a verdict has changed since the cache was written: if
   * every mutant is found, no test runs at all.
   */
  unchanged?: { lookup(m: MutantDescriptor): MutantResult | undefined; tests: TestInfo[]; red: AnalysisResult['redTests'] };
  onEvent?: (e: EngineEvent) => void;
  /**
   * Type-checks mutants: returns, per mutant number, the first diagnostic for each mutant the
   * checker rejects. `survivors` checks mutants the tests did not detect; `all` checks every
   * placed mutant before any test runs, so type-invalid ones never run.
   */
  typecheck?: { mode: 'survivors' | 'all'; check: (mutants: readonly MutantDescriptor[], root: string) => Promise<Map<number, string>> };
  tzapVersion: string;
  /** Scratch directory for instrumented sources and runner files. Default: a new one, removed at the end. */
  tmpDir?: string;
}

export type EngineEvent =
  | { type: 'phase'; phase: string }
  | { type: 'inventory'; files: number; mutants: number; placed: number }
  | { type: 'coverage'; tests: number; red: number }
  | { type: 'narrowed'; pkg: string; files: number; of: number }
  | { type: 'round'; round: number; tries: number; ms: number }
  | { type: 'progress'; decided: number; total: number }
  | { type: 'warning'; message: string }
  | { type: 'info'; message: string };

/** What the coverage run says about one mutant, handed to the cache so it can decide reuse. */
export interface MutantCoverage {
  static: boolean;
  /** Global test keys that reach the mutant. */
  tests: string[];
  /** Import-closure hash per global test key. */
  closures: ReadonlyMap<string, string>;
  /**
   * Static mutants: every test an isolated run would run against it (all green tests of every
   * file that reached it). Its verdict holds while exactly these run and none of them changed.
   */
  ran?: string[];
}

interface TestRecord extends TestInfo {
  key: string;
  closure?: string;
  pkg: string;
  runnerId: string;
  hits: Map<number, number>;
  loops: number;
  red?: string;
  /**
   * Something the test can reach may keep mutable state between runs, so a warm survival could be
   * a masked kill and is confirmed in isolation (`verifySurvivors: auto`).
   */
  stateful?: boolean;
  /** Behaves differently when repeated warm: warm tries it decides cannot be trusted. */
  stateSensitive?: string;
}

interface Pending {
  d: MutantDescriptor;
  /** Every covering test, in the order they are tried. */
  tests: string[];
  /** The covering tests the warm engine may try: those that are not state-sensitive. */
  warm: string[];
  cursor: number;
  completed: number;
}

class Timer {
  readonly timings: Record<string, number> = {};
  private phase: string | undefined;
  private t = performance.now();
  start(phase: string) {
    this.stop();
    this.phase = phase;
    this.t = performance.now();
  }
  stop() {
    if (this.phase) this.timings[this.phase] = Math.round((this.timings[this.phase] ?? 0) + performance.now() - this.t);
    this.phase = undefined;
  }
}

/**
 * Fastest-first ordering by measured duration, coarsely: durations jitter from run to run, and an
 * order that follows the jitter changes which test is credited with a kill. Everything under 50 ms
 * is one class; above that, one class per factor of ten. Finer classes (5 ms, then per doubling)
 * still reordered millisecond tests on a loaded machine: a garbage collection or a busy neighbour
 * lifts a 1 ms test past 5 ms, never past 50.
 */
function speedClass(ms: number | undefined): number {
  return ms === undefined || ms < 50 ? 0 : 1 + Math.floor(Math.log10(ms / 50));
}

/**
 * How many times one round may be restarted after the wall-clock backstop: each restart drops the
 * mutants that hung, so this bounds a round only when mutants keep hanging one after another.
 */
const MAX_BACKSTOP_RESTARTS = 50;
const HIT_FACTOR = 100;
const HIT_FLOOR = 1000;
const LOOP_FACTOR = 10;
const LOOP_FLOOR = 100_000;

export async function analyse(model: ProjectModel, options: EngineOptions): Promise<AnalysisResult> {
  // A scratch directory of the engine's own is removed however the analysis ends; one the caller
  // gave is the caller's.
  const own = options.tmpDir === undefined;
  const tmpDir = options.tmpDir ?? path.join(os.tmpdir(), `tzap-${process.pid}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  try {
    return await analyseIn(model, options, tmpDir);
  } finally {
    if (own) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // A leftover scratch directory is not worth failing an analysis over.
      }
    }
  }
}

async function analyseIn(model: ProjectModel, options: EngineOptions, tmpDir: string): Promise<AnalysisResult> {
  const emit = options.onEvent ?? (() => {});
  const timer = new Timer();
  const root = path.resolve(model.root);

  // --- inventory and instrumentation -------------------------------------------------------
  timer.start('instrument');
  emit({ type: 'phase', phase: 'instrument' });
  const files: Record<string, SourceFile> = {};
  const instrumented: Record<string, { code: string; map: unknown }> = {};
  const descriptors: MutantDescriptor[] = [];
  let nextMutant = 0;
  let nextSite = 0;
  let fileCount = 0;
  for (const pkg of model.packages) {
    for (const abs of sourceFiles(root, pkg)) {
      const rel = relativeTo(root, abs);
      const lines = options.lines ? options.lines.get(rel) : undefined;
      if (options.lines && !lines) continue;
      const source = readFileSync(abs, 'utf8');
      const out = instrument({
        file: rel,
        source,
        mutators: options.mutators,
        lines,
        filters: options.filters,
        reduce: options.reduce,
        firstMutant: nextMutant,
        firstSite: nextSite,
      });
      fileCount++;
      if (out.errors.length > 0) {
        emit({ type: 'warning', message: `${rel}: could not be parsed, not mutated: ${out.errors[0]}` });
        continue;
      }
      nextMutant = out.nextMutant;
      nextSite = out.nextSite;
      if (out.mutants.length === 0) continue;
      files[rel] = { language: languageOf(rel), source };
      descriptors.push(...out.mutants);
      if (out.code !== undefined) instrumented[abs] = { code: out.code, map: out.map };
    }
  }
  const instrumentedPath = path.join(tmpDir, 'instrumented.json');
  writeFileSync(instrumentedPath, JSON.stringify(instrumented));
  const placed = descriptors.filter((d) => d.num >= 0);
  emit({ type: 'inventory', files: fileCount, mutants: descriptors.length, placed: placed.length });

  const results = new Map<number, MutantResult>();

  // --typecheck=all: type-invalid mutants never run.
  if (options.typecheck?.mode === 'all') {
    timer.start('typecheck');
    emit({ type: 'phase', phase: 'typecheck' });
    const rejected = await options.typecheck.check(placed, root);
    for (const d of placed) {
      const diag = rejected.get(d.num);
      if (diag !== undefined) results.set(d.num, { ...d, status: 'CompileError', statusReason: diag });
    }
  }
  // A mutant a type rule dropped is not ignored by choice: the type system rules it out, as the
  // checker would. CompileError, outside the score, with the rule's reason.
  const ignored: MutantResult[] = descriptors
    .filter((d) => d.num < 0)
    .map((d) => ({ ...d, status: d.ignoredBy?.startsWith('type:') ? ('CompileError' as const) : ('Ignored' as const), statusReason: d.description ?? d.ignoredBy }));

  const finish = (tests: Array<TestInfo & { key?: string }>, red: Array<Pick<TestRecord, 'key' | 'name' | 'file' | 'red'>>): AnalysisResult => {
    timer.stop();
    const mutants = [...ignored, ...results.values()].sort(compareMutants);
    return {
      tzapVersion: options.tzapVersion,
      root,
      files,
      mutants,
      tests: tests
        .map((t) => ({ id: t.key ?? t.id, name: t.name, file: t.file, duration: t.duration, ...(t.closure ? { closure: t.closure } : {}) }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      redTests: red.map((t) => ({ id: t.key, name: t.name, file: t.file, message: t.red ?? '' })),
      config: {
        engine: options.engine ?? 'warm',
        typecheck: options.typecheck?.mode ?? 'off',
        mutators: options.mutators ? [...options.mutators] : ['all'],
        filters: [...(options.filters ?? []).map((f) => f.name), ...(options.reduce?.onePerLine ? ['one-per-line'] : []), ...(options.reduce?.equivalence ? ['equivalence'] : [])],
        scope: options.lines ? 'diff' : 'full',
      },
      timings: timer.timings,
    };
  };

  /**
   * --typecheck=survivors: a mutant the tests did not detect but the type checker rejects is not
   * a gap in the tests; the types already rule it out. It is reported CompileError, outside the
   * score.
   */
  const typecheckSurvivors = async () => {
    if (options.typecheck?.mode !== 'survivors') return;
    const undetected = [...results.values()].filter((r) => r.status === 'Survived' || r.status === 'NoCoverage');
    if (undetected.length === 0) return;
    timer.start('typecheck');
    emit({ type: 'phase', phase: 'typecheck' });
    const rejected = await options.typecheck.check(undetected, root);
    for (const r of undetected) {
      const diag = rejected.get(r.num);
      if (diag !== undefined) results.set(r.num, { ...r, status: 'CompileError', statusReason: diag });
    }
  };

  const runnerPackages = model.packages.filter((p) => p.runner);

  // Nothing changed since the cache was written: answer from it without starting a runner.
  if (options.unchanged && placed.length > 0) {
    const found = placed.map((d) => options.unchanged!.lookup(d));
    if (found.every((r) => r !== undefined)) {
      for (const r of found) results.set(r!.num, { ...r!, cached: true });
      emit({ type: 'progress', decided: results.size, total: placed.length });
      return finish(options.unchanged.tests, options.unchanged.red.map((t) => ({ key: t.id, name: t.name, file: t.file, red: t.message })));
    }
  }
  if (placed.length === 0 || runnerPackages.length === 0) {
    for (const d of placed) if (!results.has(d.num)) results.set(d.num, { ...d, status: 'NoCoverage', statusReason: 'no package with a test runner' });
    await typecheckSurvivors();
    return finish([], []);
  }

  // --- sessions and coverage ---------------------------------------------------------------
  timer.start('coverage');
  emit({ type: 'phase', phase: 'coverage' });
  const sessionFor = (pkg: PackageModel, isolate?: boolean, workers = options.workers): RunnerSession => {
    const factory = options.runners[pkg.runner!.kind];
    if (!factory) throw new Error(`no runner adapter for "${pkg.runner!.kind}" (package ${pkg.id})`);
    const preferThreads = options.preferThreads !== false && !ownPool.has(pkg.id);
    return factory({ root, pkg, instrumented: instrumentedPath, isolate, workers, tmpDir, ...(preferThreads ? { preferThreads } : {}) });
  };
  /** Packages that run in their own pool: threads changed what their baseline did. */
  const ownPool = new Set<string>();

  let runId = 1;
  const warm = new Map<string, RunnerSession>();
  const isolatesFiles = new Set<string>();
  const staticPerFile = new Set<string>();
  const packageFiles = new Map(model.packages.map((p) => [p.id, sourceFiles(root, p)]));
  const allSources = [...new Set([...packageFiles.values()].flat().map((f) => path.resolve(f)))].map((f) => ({ f, real: realPath(f) }));
  const graph = new ImportGraph({
    workspacePackages: new Map(model.packages.map((p) => [p.id, path.resolve(root, p.root)])),
    root,
    filesUnder: (dir) => allSources.filter((s) => s.real.startsWith(dir + path.sep)).map((s) => s.f),
  });
  // A diff run's coverage phase runs only the test files that can reach a file with mutants.
  const mutatedFiles = new Set(placed.map((d) => toPosix(path.resolve(root, d.file)).toLowerCase()));
  const reachesMutated = (testFile: string) => {
    const c = graph.closure(testFile);
    return c.dynamic || c.files.some((f) => mutatedFiles.has(toPosix(f).toLowerCase()));
  };
  const tests = new Map<string, TestRecord>();
  const staticSites = new Map<number, Set<string>>(); // site -> test files (absolute) that reached it outside tests
  /** Packages whose suite reports unhandled errors with no mutant active: there they carry no signal. */
  const noisyUnhandled = new Set<string>();
  const loadLoops = new Map<string, number>(); // normPath'd test file -> loop back-edges while loading
  const allTestFiles = new Map<string, Set<string>>(); // pkg id -> test files
  try {
    for (const pkg of runnerPackages) {
      let s = sessionFor(pkg);
      let info = await s.start();
      warm.set(pkg.id, s);
      let files: string[] | undefined;
      if (options.lines && s.listFiles) {
        const all = await s.listFiles();
        files = all.filter(reachesMutated);
        emit({ type: 'narrowed', pkg: pkg.id, files: files.length, of: all.length });
      }
      const coverage = () => (files && files.length === 0 ? Promise.resolve({ id: 0, tests: [], files: [], durationMs: 0 } as RunResult) : s.run({ id: runId++, mode: 'coverage', files }));
      // Threads are tzap's choice, not the project's: if anything in the baseline fails in them —
      // or the run dies, as a native addon can take a thread's whole process down — that may be
      // the threads, and the project's own setting is used instead. Whatever still fails there is
      // the suite's own.
      let res: RunResult | undefined;
      try {
        res = await coverage();
      } catch (e) {
        if (!info.threads) throw e;
      }
      if (info.threads && (!res || res.unhandledErrors?.length || res.files.some((f) => f.error) || res.tests.some((t) => t.state === 'fail'))) {
        await s.close().catch(() => {});
        ownPool.add(pkg.id);
        emit({ type: 'info', message: `${pkg.id}: the baseline is not clean in worker threads; using the project's own pool` });
        s = sessionFor(pkg);
        info = await s.start();
        warm.set(pkg.id, s);
        res = await coverage();
      }
      if (!res) throw new Error(`${pkg.id}: the coverage run did not complete`);
      if (info.isolatesFiles) isolatesFiles.add(pkg.id);
      if (info.staticPerFile) staticPerFile.add(pkg.id);
      if (res.unhandledErrors?.length) {
        noisyUnhandled.add(pkg.id);
        emit({ type: 'warning', message: `${pkg.id}: the suite reports ${res.unhandledErrors.length} unhandled error(s) with no mutant active (${res.unhandledErrors[0]}); unhandled errors cannot count against mutants there` });
      }
      const filesOfPkg = new Set<string>();
      for (const f of res.files) {
        filesOfPkg.add(f.file);
        for (const [site] of f.staticHits ?? []) {
          let set = staticSites.get(site);
          if (!set) staticSites.set(site, (set = new Set()));
          set.add(`${pkg.id}\0${f.file}`);
        }
        if (f.error) emit({ type: 'warning', message: `${relativeTo(root, f.file)}: ${f.error}` });
        if (f.loadLoops !== undefined) loadLoops.set(normPath(f.file), f.loadLoops);
      }
      allTestFiles.set(pkg.id, filesOfPkg);
      for (const t of res.tests) {
        if (t.state === 'skip') continue;
        const key = `${pkg.id}::${t.id}`;
        const rec: TestRecord = {
          key,
          id: t.id,
          pkg: pkg.id,
          runnerId: t.id,
          name: t.name,
          file: relativeTo(root, t.file),
          duration: Math.round(t.duration * 100) / 100,
          hits: new Map(t.hits ?? []),
          loops: t.loops ?? 0,
        };
        if (t.state === 'fail') rec.red = t.message ?? 'failed';
        if (t.stateSensitive) rec.stateSensitive = t.stateSensitive;
        tests.set(key, rec);
      }
    }
    const red = [...tests.values()].filter((t) => t.red !== undefined);
    const green = [...tests.values()].filter((t) => t.red === undefined);
    emit({ type: 'coverage', tests: green.length, red: red.length });
    const sensitive = green.filter((t) => t.stateSensitive);
    if (sensitive.length) {
      emit({ type: 'warning', message: `${sensitive.length} of ${green.length} tests behave differently when repeated; mutants only they cover are decided in isolation (${sensitive.slice(0, 3).map((t) => t.name).join('; ')}${sensitive.length > 3 ? '; ...' : ''})` });
    }

    // Import closures: the cache's key for "nothing this test can reach has changed".
    let everything: string | undefined;
    const everythingHash = () => {
      if (everything) return everything;
      const h = createHash('sha256');
      for (const t of [...tests.values()].map((x) => x.file).sort()) h.update(t).update(graph.node(path.resolve(root, t)).hash);
      for (const [, fs] of [...packageFiles].sort(([a], [b]) => (a < b ? -1 : 1))) for (const f of fs) h.update(relativeTo(root, f)).update(graph.node(f).hash);
      return (everything = `all:${h.digest('hex').slice(0, 16)}`);
    };
    const closureByFile = new Map<string, string>();
    const statefulByFile = new Map<string, boolean>();
    for (const t of green) {
      let c = closureByFile.get(t.file);
      if (c === undefined) {
        const abs = path.resolve(root, t.file);
        c = graph.closure(abs).dynamic ? everythingHash() : graph.closureHash(abs);
        closureByFile.set(t.file, c);
      }
      t.closure = c;
      let st = statefulByFile.get(t.file);
      if (st === undefined) {
        const cl = graph.closure(path.resolve(root, t.file));
        // Project files only: state inside third-party packages is outside what this checks.
        st = cl.dynamic || cl.files.some((f) => !/[\\/]node_modules[\\/]/.test(f) && graph.node(f).stateful);
        statefulByFile.set(t.file, st);
      }
      t.stateful = st;
    }
    const closures = new Map(green.map((t) => [t.key, t.closure!]));

    // A workspace package the tests import but whose source they never reach is almost always
    // being resolved to its built output: every mutant in it would look uncovered.
    {
      const reachedFiles = new Set<string>();
      for (const d of placed) {
        if (green.some((t) => t.hits.has(d.site)) || staticSites.has(d.site)) reachedFiles.add(d.file);
      }
      const imported = new Set<string>();
      for (const t of green) for (const p of graph.closure(path.resolve(root, t.file)).packages) imported.add(p);
      for (const pkg of model.packages) {
        if (!imported.has(pkg.id)) continue;
        const own = placed.filter((d) => d.file.startsWith(`${relativeTo(root, path.resolve(root, pkg.root))}/`));
        if (own.length > 0 && !own.some((d) => reachedFiles.has(d.file))) {
          emit({
            type: 'warning',
            message: `tests import ${pkg.id} but never reach its source: they probably load its built output (check its package.json "exports"/"main", or alias it to src/ in the Vitest config); its ${own.length} mutants will be reported uncovered`,
          });
        }
      }
    }

    const siteTests = new Map<number, TestRecord[]>();
    for (const t of green) {
      for (const site of t.hits.keys()) {
        let list = siteTests.get(site);
        if (!list) siteTests.set(site, (list = []));
        list.push(t);
      }
    }

    /** The keys of the green tests an isolated run of a static mutant runs: its files' tests. */
    const staticRan = (d: MutantDescriptor): string[] => {
      const files = new Set<string>();
      for (const key of staticSites.get(d.site) ?? []) files.add(normPath(key.split('\0')[1]!));
      for (const t of siteTests.get(d.site) ?? []) files.add(normPath(path.resolve(root, t.file)));
      return green.filter((t) => files.has(normPath(path.resolve(root, t.file)))).map((t) => t.key).sort();
    };

    // --- classify ----------------------------------------------------------------------------
    const covered: Pending[] = [];
    const statics: MutantDescriptor[] = [];
    for (const d of placed) {
      if (results.has(d.num)) continue;
      const isStatic = staticSites.has(d.site);
      const reaching = (siteTests.get(d.site) ?? []).map((t) => t.key);
      const reused = options.reuse?.(d, { static: isStatic, tests: reaching, closures, ...(isStatic ? { ran: staticRan(d) } : {}) });
      if (reused) {
        results.set(d.num, { ...reused, ...d, status: reused.status, cached: true });
        continue;
      }
      // Reached while modules load, whether or not tests reach it too: only a run with the mutant
      // active from the start can decide it. A warm run would activate it inside tests only, and a
      // test that compares against a value computed at load time (`const expected = f(x)` at the
      // top of the file) would then see two different programs where the mutated program has one:
      // a false kill. The hazards fixture holds that case.
      if (isStatic) {
        statics.push(d);
        continue;
      }
      if (reaching.length === 0) {
        results.set(d.num, { ...d, status: 'NoCoverage', coveredBy: [] });
        continue;
      }
      const killer = options.previousKillers?.get(d.id);
      const ordered = (siteTests.get(d.site) ?? [])
        .slice()
        .sort((a, b) => {
          if (killer) {
            if (a.key === killer) return -1;
            if (b.key === killer) return 1;
          }
          return speedClass(a.duration) - speedClass(b.duration) || (a.key < b.key ? -1 : 1);
        })
        .map((t) => t.key);
      const warmTests = ordered.filter((k) => !tests.get(k)!.stateSensitive);
      covered.push({ d, tests: ordered, warm: warmTests, cursor: 0, completed: 0 });
    }
    const total = placed.length;
    /** Mutants with a verdict; one waiting for its isolated run is not decided yet. */
    const decidedCount = () => {
      let n = 0;
      for (const r of results.values()) if (r.status !== 'Pending') n++;
      return n;
    };
    emit({ type: 'progress', decided: decidedCount(), total });

    const limitsFor = (t: TestRecord, site: number): Pick<Try, 'N' | 'L'> => ({
      N: Math.max(HIT_FLOOR, HIT_FACTOR * (t.hits.get(site) ?? 1)),
      L: Math.max(LOOP_FLOOR, LOOP_FACTOR * t.loops),
    });
    /**
     * The backstop's silence window: how long no worker may start or finish a try before one is
     * declared stuck. Loops and repeated evaluation are caught long before by counting; this is
     * for a mutant that blocks outside instrumented code.
     */
    const silenceMs = Math.max(15_000, 10 * Math.max(0, ...green.map((t) => t.duration ?? 0)) + 5_000);
    /** An unmutated try. Two bracket each test's mutant tries in a round. */
    const control = (t: TestRecord): Try => ({ m: -1, N: Infinity, L: Math.max(LOOP_FLOOR, LOOP_FACTOR * t.loops) });

    timer.start('execute');
    emit({ type: 'phase', phase: 'execute' });
    if (options.engine === 'reference') {
      // Everything through the isolated path, one fresh session per mutant.
      await isolatedRuns([...covered.map((p) => ({ d: p.d, tests: p.tests })), ...statics.map((d) => ({ d, tests: [] as string[] }))], true);
    } else {
      const fallback = await warmEngine();
      timer.start('isolated');
      emit({ type: 'phase', phase: 'isolated' });
      await isolatedRuns([...fallback, ...statics.map((d) => ({ d, tests: [] as string[] }))], false);
    }
    await typecheckSurvivors();
    return finish([...tests.values()].filter((t) => t.red === undefined), red);

    // --- the warm engine: rounds of many mutants per runner invocation ----------------------
    /**
     * Returns the mutants whose warm verdict could not be trusted, for the isolated path.
     *
     * Controls — the test run unmutated — decide which mutant tries count. In an ordinary round
     * each test's tries are bracketed, `[control, m1, ..., mk, control]`: when both controls pass,
     * every try in between ran from state the unmutated test is happy with. When one fails — a
     * mutant corrupted state its module keeps, a registry or a cache — those tries are tried again
     * with a control before each, `[control, m1, control, m2, ...]`, where a try counts only if the
     * control just before it passed. The corrupting mutant is then measured cleanly, and so is
     * everything after it. Only the pairs that ran dirty are tried again, never a whole set.
     */
    async function warmEngine(): Promise<Array<{ d: MutantDescriptor; tests: string[] }>> {
      const fallback: Array<{ d: MutantDescriptor; tests: string[] }> = [];
      let round = 0;
      let verifying = 0;
      const toFallback = (p: Pending) => {
        fallback.push({ d: p.d, tests: p.tests });
        results.set(p.d.num, { ...p.d, status: 'Pending' });
      };
      for (const p of covered) if (p.warm.length === 0) toFallback(p);

      /** Tries each mutant against the given tests; `interleave` puts a control before every try. */
      const runRound = async (entries: Array<{ p: Pending; tests: string[] }>, interleave: boolean) => {
        round++;
        const byPkg = new Map<string, Map<string, Try[]>>();
        let tries = 0;
        for (const { p, tests: keys } of entries) {
          for (const key of keys) {
            const t = tests.get(key)!;
            let plan = byPkg.get(t.pkg);
            if (!plan) byPkg.set(t.pkg, (plan = new Map()));
            let list = plan.get(t.runnerId);
            if (!list) plan.set(t.runnerId, (list = [control(t)]));
            list.push({ m: p.d.num, ...limitsFor(t, p.d.site) });
            if (interleave) list.push(control(t));
            tries++;
          }
        }
        if (!interleave) for (const [pkgId, plan] of byPkg) for (const [id, list] of plan) list.push(control(tests.get(`${pkgId}::${id}`)!));
        const started = performance.now();
        const verdicts = new Map<number, Outcome>();
        /** (mutant, test key) pairs whose try ran in state that could not be trusted. */
        const dirty = new Map<number, Set<string>>();
        const unreached = new Set<number>();
        for (const [pkgId, plan] of byPkg) {
          const res = await runWithRecovery(pkgId, Object.fromEntries(plan), silenceMs);
          collect(pkgId, res, verdicts, dirty, unreached, interleave);
          // An unhandled error failed the run, and no try owns it: every mutant tried here that no
          // test killed is decided on its own, in isolation, where the error is attributable.
          if (res.unhandledErrors?.length && !noisyUnhandled.has(pkgId)) {
            for (const list of plan.values()) for (const tr of list) if (tr.m >= 0 && !verdicts.get(tr.m)?.kills.length) unreached.add(tr.m);
          }
          // A planned try the runner never reported on decided nothing: try it again.
          const reported = new Set(res.tests.flatMap((t) => (t.tries ?? []).map(([m]) => `${t.id}\0${m}`)));
          for (const [id, list] of plan) {
            for (const tr of list) {
              if (tr.m < 0 || reported.has(`${id}\0${tr.m}`)) continue;
              let set = dirty.get(tr.m);
              if (!set) dirty.set(tr.m, (set = new Set()));
              set.add(`${pkgId}::${id}`);
            }
          }
        }
        emit({ type: 'round', round, tries, ms: Math.round(performance.now() - started) });
        return { verdicts, dirty, unreached };
      };

      const decide = (p: Pending, o: Outcome | undefined) => {
        p.completed += o?.tested ?? 0;
        if (!o?.kills.length) return false;
        // Several tests can kill a mutant in one round; which of them reports first depends on
        // scheduling. The one credited is the earliest in the mutant's own test order.
        const rank = (k: string) => {
          const i = p.tests.indexOf(k);
          return i === -1 ? Number.MAX_SAFE_INTEGER : i;
        };
        const kill = o.kills.reduce((a, b) => (rank(b.key) < rank(a.key) || (rank(b.key) === rank(a.key) && b.key < a.key) ? b : a));
        if (kill.timeout) results.set(p.d.num, { ...p.d, status: 'Timeout', statusReason: kill.message ?? 'declared hung', coveredBy: p.tests, killedBy: [kill.key] });
        else results.set(p.d.num, { ...p.d, status: 'Killed', statusReason: kill.message, killedBy: [kill.key], coveredBy: p.tests, testsCompleted: p.completed });
        return true;
      };
      const survive = (p: Pending) => {
        // Survived every test the warm engine could trust. Confirmed in isolation unless told not
        // to; covered by state-sensitive tests too, it always is.
        const verify = options.verifySurvivors === true || (options.verifySurvivors !== false && p.tests.some((k) => tests.get(k)?.stateful !== false));
        if (p.warm.length < p.tests.length || verify) {
          verifying++;
          toFallback(p);
        }
        else results.set(p.d.num, { ...p.d, status: 'Survived', coveredBy: p.tests, testsCompleted: p.completed });
      };
      const redo = new Map<number, { p: Pending; tests: Set<string> }>();
      const settle = (p: Pending, round: { verdicts: Map<number, Outcome>; dirty: Map<number, Set<string>>; unreached: Set<number> }, done: boolean) => {
        if (decide(p, round.verdicts.get(p.d.num))) {
          redo.delete(p.d.num);
          return;
        }
        if (round.unreached.has(p.d.num)) {
          redo.delete(p.d.num);
          toFallback(p);
          return;
        }
        const d = round.dirty.get(p.d.num);
        if (d?.size) {
          const r = redo.get(p.d.num) ?? { p, tests: new Set<string>() };
          for (const k of d) r.tests.add(k);
          redo.set(p.d.num, r);
        }
        if (done && !redo.has(p.d.num)) survive(p);
        else if (done) results.set(p.d.num, { ...p.d, status: 'Pending' });
      };

      // Round 1 tries each mutant against its most likely killer only; round 2 every remaining
      // covering test, with in-worker skipping once a mutant dies.
      let active = covered.filter((p) => p.warm.length > 0);
      let first = true;
      while (active.length > 0) {
        const entries = active.map((p) => {
          const to = first ? p.cursor + 1 : p.warm.length;
          const e = { p, tests: p.warm.slice(p.cursor, to) };
          p.cursor = to;
          return e;
        });
        first = false;
        const r = await runRound(entries, false);
        for (const p of active) settle(p, r, p.cursor >= p.warm.length);
        emit({ type: 'progress', decided: decidedCount(), total });
        active = active.filter((p) => !results.has(p.d.num) && p.cursor < p.warm.length);
      }

      // The pairs that ran in untrusted state, again, each behind its own control, until a round
      // resolves none of them.
      while (redo.size > 0) {
        const before = [...redo.values()].reduce((n, r) => n + r.tests.size, 0);
        const entries = [...redo.values()].map((r) => ({ p: r.p, tests: [...r.tests] }));
        for (const e of entries) results.delete(e.p.d.num);
        redo.clear();
        const r = await runRound(entries, true);
        for (const { p } of entries) settle(p, r, true);
        const after = [...redo.values()].reduce((n, x) => n + x.tests.size, 0);
        emit({ type: 'progress', decided: decidedCount(), total });
        if (after >= before) {
          // No progress: the state these tests start from is itself broken (a test that depends
          // on another it no longer follows). Decide them in isolation.
          for (const { p } of redo.values()) toFallback(p);
          redo.clear();
        }
      }

      for (const f of fallback) results.delete(f.d.num);
      if (verifying) emit({ type: 'info', message: `confirming ${verifying} warm survivors in isolation` });
      if (fallback.length > verifying) emit({ type: 'warning', message: `${fallback.length - verifying} mutants re-decided in isolation: never reached in the warm run, or covered by tests whose warm runs could not be trusted` });
      return fallback;
    }

    interface Outcome {
      /** Every try that killed the mutant this round. */
      kills: Array<{ key: string; timeout: boolean; message?: string }>;
      tested: number;
    }

    /**
     * Folds one run's tries into verdicts. Bracketed (`interleave` false): a test's tries count
     * only if both controls around them passed. Interleaved: a try counts if the control just
     * before it passed. A try that does not count makes its (mutant, test) pair dirty; one that
     * counts but never reached the mutant makes the mutant unreached.
     */
    function collect(pkgId: string, res: RunResult, verdicts: Map<number, Outcome>, dirty: Map<number, Set<string>>, unreached: Set<number>, interleave: boolean) {
      for (const t of res.tests) {
        const tries = t.tries ?? [];
        const key = `${pkgId}::${t.id}`;
        const bracketFailed = !interleave && tries.some(([m, outcome]) => m < 0 && outcome !== 'S');
        let clean = true;
        for (const [m, outcome, message] of tries) {
          if (m < 0) {
            clean = outcome === 'S';
            continue;
          }
          let o = verdicts.get(m);
          if (!o) verdicts.set(m, (o = { kills: [], tested: 0 }));
          if (outcome === 'X') continue;
          if (bracketFailed || (interleave && !clean)) {
            let set = dirty.get(m);
            if (!set) dirty.set(m, (set = new Set()));
            set.add(key);
            continue;
          }
          if (outcome === 'U') {
            unreached.add(m);
            continue;
          }
          o.tested++;
          if (outcome === 'K' || outcome === 'T') o.kills.push({ key, timeout: outcome === 'T', ...(message !== undefined ? { message } : {}) });
        }
      }
    }

    /** Runs a plan; if a hang outlives the budget, marks what was in flight as Timeout and retries the rest. */
    async function runWithRecovery(pkgId: string, plan: Record<string, Try[]>, budgetMs: number): Promise<RunResult> {
      const merged: RunResult = { id: 0, tests: [], files: [], durationMs: 0 };
      let remaining = plan;
      for (let attempt = 0; attempt < MAX_BACKSTOP_RESTARTS; attempt++) {
        let s = warm.get(pkgId)!;
        // Only the files that hold a planned test: every other file would be loaded and collected
        // for nothing, a fixed cost per round that dwarfs the tries on a small diff.
        const files = [...new Set(Object.keys(remaining).map((id) => path.resolve(root, tests.get(`${pkgId}::${id}`)!.file)))];
        const res = await s.run({ id: runId++, mode: 'mutate', plan: remaining, files, budgetMs });
        if (!res.timedOut) {
          merged.tests.push(...res.tests);
          merged.files.push(...res.files);
          if (res.unhandledErrors?.length) {
            merged.unhandledErrors = [...(merged.unhandledErrors ?? []), ...res.unhandledErrors];
            merged.unhandledErrorFiles = [...(merged.unhandledErrorFiles ?? []), ...res.unhandledErrors.map((_, i) => res.unhandledErrorFiles?.[i] ?? null)];
          }
          return merged;
        }
        const inFlight = (res.inFlight ?? []).filter((x) => x.mutant >= 0);
        const hung = new Set(inFlight.map((x) => x.mutant));
        if (hung.size === 0) throw new Error(`a test run went silent for ${Math.round(budgetMs / 1000)} s with no mutant try in flight: a hook outside any test (beforeAll/afterAll, a global setup) is blocking; it does so without any mutant, so check the suite on its own`);
        emit({ type: 'warning', message: `wall-clock backstop: mutants ${[...hung].join(', ')} declared hung` });
        // Each hung try is credited to the test it was running.
        for (const { test, mutant } of inFlight) {
          const t = tests.get(`${pkgId}::${test}`);
          merged.tests.push({ id: test, name: t?.name ?? test, file: t?.file ?? '', state: 'fail', duration: budgetMs, tries: [[mutant, 'T', 'wall-clock backstop']] });
        }
        const pkg = runnerPackages.find((p) => p.id === pkgId)!;
        s = sessionFor(pkg);
        await s.start();
        warm.set(pkgId, s);
        const next: Record<string, Try[]> = {};
        for (const [test, list] of Object.entries(remaining)) {
          const kept = list.filter((t) => !hung.has(t.m));
          if (kept.some((t) => t.m >= 0)) next[test] = kept;
        }
        remaining = next;
      }
      throw new Error('too many hung runs in one round');
    }

    // --- the isolated path: static mutants, suspect ones, and the whole reference engine -------
    /**
     * Each mutant is active before any module evaluates, in a session that isolates test files,
     * and every green test of every file that could reach it runs, in the file's own order, so
     * no test is deprived of the tests it follows. Killed when any of them fails.
     *
     * With `fresh` (the reference engine) each mutant gets a session of its own and nothing is
     * shared. Otherwise mutants are packed: every test file has its own module graph, so one run
     * can activate a different mutant in each file, and mutants whose files do not overlap share a
     * run. Runs go out to several sessions at once.
     */
    async function isolatedRuns(list: Array<{ d: MutantDescriptor; tests: string[] }>, fresh: boolean): Promise<void> {
      if (list.length === 0) return;
      interface Item {
        d: MutantDescriptor;
        isStatic: boolean;
        files: Map<string, Set<string>>; // package id -> normPath'd test files
        coveredBy: Set<string>;
        killedBy?: string;
        message?: string;
        timeout: boolean;
        tested: number;
        /** Tests a run was asked to try this mutant against. */
        planned: number;
      }
      const items: Item[] = list
        .slice()
        .sort((a, b) => a.d.num - b.d.num)
        .map(({ d, tests: keys }) => {
          const isStatic = staticSites.has(d.site);
          const files = new Map<string, Set<string>>();
          const add = (pkgId: string, file: string) => {
            let set = files.get(pkgId);
            if (!set) files.set(pkgId, (set = new Set()));
            set.add(normPath(file));
          };
          for (const key of keys) {
            const t = tests.get(key)!;
            add(t.pkg, path.resolve(root, t.file));
          }
          for (const t of siteTests.get(d.site) ?? []) add(t.pkg, path.resolve(root, t.file));
          if (isStatic) {
            for (const key of staticSites.get(d.site)!) {
              const [pkgId, file] = key.split('\0') as [string, string];
              add(pkgId, file);
            }
          }
          const coveredBy = new Set<string>(keys);
          for (const t of siteTests.get(d.site) ?? []) coveredBy.add(t.key);
          // A static mutant is judged by every test of the files that load it.
          if (isStatic) for (const k of staticRan(d)) coveredBy.add(k);
          return { d, isStatic, files, coveredBy, timeout: false, tested: 0, planned: 0 };
        });

      // Green tests by package and normalised file, in discovery order.
      const testsByFile = new Map<string, TestRecord[]>();
      for (const t of green) {
        const k = `${t.pkg}\0${normPath(path.resolve(root, t.file))}`;
        let l = testsByFile.get(k);
        if (!l) testsByFile.set(k, (l = []));
        l.push(t);
      }

      // Jobs: one run of one package, assigning each of its test files at most one mutant.
      interface Job {
        pkgId: string;
        assign: Map<string, Item>;
      }
      type Parts = Array<{ it: Item; files: Map<string, Set<string>> }>;
      const buildJobs = (parts: Parts): Job[] => {
        const jobs: Job[] = [];
        for (const pkg of runnerPackages) {
          const mine = parts.filter((p) => (p.files.get(pkg.id)?.size ?? 0) > 0);
          const packs = !fresh && staticPerFile.has(pkg.id);
          const open: Job[] = [];
          for (const { it, files } of mine) {
            const fs = files.get(pkg.id)!;
            let job = packs ? open.find((j) => ![...fs].some((f) => j.assign.has(f))) : undefined;
            if (!job) {
              job = { pkgId: pkg.id, assign: new Map() };
              open.push(job);
            }
            for (const f of fs) job.assign.set(f, it);
          }
          jobs.push(...open);
        }
        return jobs;
      };

      /**
       * A static mutant is live in every file that loads its module, and any one of them failing
       * kills it; most static mutants break loading outright. So in a warm run each is first tried
       * in one file, its likeliest killer, and only the survivors in the rest. Different mutants
       * take different files where they can, so the first pass packs into few runs; the second
       * pass is the old single pass, for the survivors only. The reference engine keeps one pass.
       */
      const passes: Parts[] = [[], []];
      {
        const fileClass = new Map<string, number>();
        for (const [k, ts] of testsByFile) fileClass.set(k, speedClass(ts.reduce((a, t) => a + (t.duration ?? 0), 0)));
        const used = new Set<string>();
        for (const it of items) {
          const all = [...it.files].flatMap(([pkgId, fs]) => [...fs].map((f) => ({ pkgId, f, k: `${pkgId}\0${f}` })));
          if (fresh || !it.isStatic || all.length < 2 || !all.every((x) => staticPerFile.has(x.pkgId))) {
            passes[0]!.push({ it, files: it.files });
            continue;
          }
          const inBody = new Set((siteTests.get(it.d.site) ?? []).map((t) => `${t.pkg}\0${normPath(path.resolve(root, t.file))}`));
          const rank = (x: { k: string }) => [inBody.has(x.k) ? 0 : 1, fileClass.get(x.k) ?? 0] as const;
          all.sort((a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1] - rank(b)[1] || (a.k < b.k ? -1 : 1));
          const first = all.find((x) => !used.has(x.k)) ?? all[0]!;
          used.add(first.k);
          const rest = new Map<string, Set<string>>();
          for (const x of all) {
            if (x === first) continue;
            let set = rest.get(x.pkgId);
            if (!set) rest.set(x.pkgId, (set = new Set()));
            set.add(x.f);
          }
          passes[0]!.push({ it, files: new Map([[first.pkgId, new Set([first.f])]]) });
          passes[1]!.push({ it, files: rest });
        }
      }
      const jobs = buildJobs(passes[0]!);


      const runJob = async (job: Job, session: () => Promise<RunnerSession>, retire: () => void): Promise<void> => {
        // A mutant killed by an earlier job needs no more runs.
        for (const [f, it] of [...job.assign]) if (it.killedBy) job.assign.delete(f);
        if (job.assign.size === 0) return;
        const plan: Record<string, Try[]> = {};
        const staticPlan: Record<string, number> = {};
        const files: string[] = [];
        for (const [f, it] of job.assign) {
          // A static mutant is live from the moment the file loads: every test of the file judges
          // it. Any other mutant is judged by the tests that reach it, and the worker skips the
          // tests after the last of those.
          const all = testsByFile.get(`${job.pkgId}\0${f}`) ?? [];
          const ts = it.isStatic ? all : all.filter((t) => it.coveredBy.has(t.key));
          if (ts.length === 0) continue;
          staticPlan[f] = it.d.num;
          files.push(path.resolve(root, ts[0]!.file));
          for (const t of ts) plan[t.runnerId] = [{ m: it.d.num, ...limitsFor(t, it.d.site) }];
          it.planned += ts.length;
        }
        if (files.length === 0) return;
        const byNum = new Map([...job.assign.values()].map((it) => [it.d.num, it]));
        const single = byNum.size === 1 ? [...byNum.keys()][0] : undefined;
        const s = await session();
        const res = await s.run({
          id: runId++,
          mode: 'static',
          plan,
          files,
          ...(staticPerFile.has(job.pkgId) ? { staticPlan } : {}),
          ...(single !== undefined ? { staticMutant: single } : {}),
          // Ten times what the unmutated files needed while loading, with a floor.
          staticLimit: Math.max(1_000_000, 10 * Math.max(0, ...Object.keys(staticPlan).map((f) => loadLoops.get(f) ?? 0))),
          budgetMs: silenceMs,
        });
        if (res.timedOut) {
          retire();
          const hung = new Set((res.inFlight ?? []).map((x) => x.mutant));
          if (hung.size === 0 && byNum.size > 1) {
            // Stuck before any try began — a mutant looping while a module loads — in a run shared
            // by several mutants: nothing says which. Decide each on its own.
            for (const it of byNum.values()) {
              const files = new Map([...job.assign].filter(([, x]) => x === it));
              await runJob({ pkgId: job.pkgId, assign: files }, session, retire);
            }
            return;
          }
          for (const it of byNum.values()) {
            if (hung.has(it.d.num) || byNum.size === 1) {
              it.timeout = true;
              it.killedBy = 'wall-clock backstop';
              it.message = 'wall-clock backstop';
            }
          }
          // The rest of the job is decided again, without the hung mutants.
          const rest: Job = { pkgId: job.pkgId, assign: new Map([...job.assign].filter(([, it]) => !it.killedBy)) };
          if (rest.assign.size > 0 && rest.assign.size < job.assign.size) await runJob(rest, session, retire);
          return;
        }
        if (res.unhandledErrors?.length && !noisyUnhandled.has(job.pkgId)) {
          // Each file of the run has its own mutant and its own modules: an error the runner
          // attributes to a file is that file's mutant's, as `vitest run` would report it.
          const owners = res.unhandledErrors.map((_, i) => {
            const f = res.unhandledErrorFiles?.[i];
            return f ? byNum.get(Number(staticPlan[normPath(f)] ?? NaN)) : undefined;
          });
          if (byNum.size > 1 && owners.every((o) => o !== undefined)) {
            owners.forEach((it, i) => {
              if (it!.killedBy) return;
              it!.killedBy = `${job.pkgId}::unhandled error`;
              it!.message = `unhandled error during the run: ${res.unhandledErrors![i]}`;
            });
          } else if (byNum.size > 1) {
            // Several mutants shared the run: decide each alone to see whose error it is.
            for (const it of byNum.values()) await runJob({ pkgId: job.pkgId, assign: new Map([...job.assign].filter(([, x]) => x === it)) }, session, retire);
            return;
          } else {
            // The suite fails with this mutant: `vitest run` would exit non-zero. Detected.
            const it = [...byNum.values()][0]!;
            if (!it.killedBy) {
              it.killedBy = `${job.pkgId}::unhandled error`;
              it.message = `unhandled error during the run: ${res.unhandledErrors[0]}`;
            }
          }
        }
        const fileMutant = new Map(Object.entries(staticPlan));
        for (const f of res.files) {
          if (!f.error) continue;
          const it = byNum.get(fileMutant.get(normPath(f.file)) ?? single ?? -1);
          if (it && !it.killedBy) {
            it.killedBy = `${job.pkgId}::${relativeTo(root, f.file)}`;
            it.message = `test file failed to load: ${f.error}`;
            // The loop guard stopped a mutant that never finished loading the module.
            if (/declared hung/.test(f.error)) it.timeout = true;
          }
        }
        // Of the tests that killed a mutant in this run, the lowest id is credited: the order
        // they report in depends on scheduling.
        const decided = new Set([...byNum.values()].filter((it) => it.killedBy));
        for (const t of res.tests) {
          for (const [m, outcome, msg] of t.tries ?? []) {
            const it = byNum.get(m);
            if (!it) continue;
            it.tested++;
            const key = `${job.pkgId}::${t.id}`;
            if ((outcome === 'K' || outcome === 'T') && !decided.has(it) && (!it.killedBy || key < it.killedBy)) {
              it.killedBy = key;
              it.timeout = outcome === 'T';
              it.message = msg;
            }
          }
        }
        // Isolated verdicts enter the results at the end: until then, count the kills so far.
        emit({ type: 'progress', decided: decidedCount() + items.filter((it) => it.killedBy).length, total });
      };

      const pkgById = new Map(runnerPackages.map((p) => [p.id, p]));
      const runJobs = async (jobs: Job[]) => {
        const cores = os.availableParallelism();
        // The first lane reuses the warm session when that already isolates files.
        // A run keeps about one worker busy per test file it holds, so the lanes that fill the
        // machine are the cores over the average files per run: few when runs are wide, more when
        // each run holds a file or two. Another lane costs a runner boot, so there is one only for
        // every six runs, and never more than half the cores.
        const autoLanes = (jobs: Job[]) => {
          const avgFiles = jobs.reduce((a, j) => a + j.assign.size, 0) / Math.max(1, jobs.length);
          return Math.max(1, Math.min(Math.round(cores / Math.max(1, avgFiles)), Math.floor(cores / 2), Math.ceil(jobs.length / 6)));
        };
        const lanes = fresh
          ? Math.max(1, options.concurrency ?? 1)
          : Math.max(1, options.concurrency ?? autoLanes(jobs));
        const workersPerSession = Math.max(1, Math.floor(cores / lanes));
        const queue = jobs.slice();
        const lane = async (laneIndex: number) => {
          const sessions = new Map<string, RunnerSession>();
          try {
            for (;;) {
              const job = queue.shift();
              if (!job) return;
              const pkg = pkgById.get(job.pkgId)!;
              const reuseWarm = !fresh && laneIndex === 0 && isolatesFiles.has(job.pkgId);
              const session = async () => {
                if (reuseWarm) {
                  let w = warm.get(job.pkgId);
                  if (!w) {
                    w = sessionFor(pkg);
                    await w.start();
                    warm.set(job.pkgId, w);
                  }
                  return w;
                }
                let s = sessions.get(job.pkgId);
                if (!s) {
                  s = sessionFor(pkg, true, workersPerSession);
                  await s.start();
                  sessions.set(job.pkgId, s);
                }
                return s;
              };
              const retire = () => {
                if (reuseWarm) warm.delete(job.pkgId);
                sessions.delete(job.pkgId);
              };
              const tj = performance.now();
              await runJob(job, session, retire);
              if (process.env.TZAP_DEBUG) process.stderr.write(`tzap debug: lane ${laneIndex} job ${[...new Set(job.assign.values())].map((it) => `${it.d.num}${it.isStatic ? 's' : 'v'}:${it.killedBy ? 'K' : it.tested}/${it.planned}`).join(',')} files=${job.assign.size} ${Math.round(performance.now() - tj)} ms
`);
              if (fresh) {
                await Promise.all([...sessions.values()].map((s) => s.close()));
                sessions.clear();
              }
            }
          } finally {
            await Promise.all([...sessions.values()].map((s) => s.close()));
          }
        };
        const isoStart = performance.now();
        await Promise.all(Array.from({ length: lanes }, (_, i) => lane(i)));
        if (process.env.TZAP_DEBUG) process.stderr.write(`tzap debug: isolated ${items.length} mutants in ${jobs.length} runs on ${lanes} lanes, ${Math.round(performance.now() - isoStart)} ms; files per run ${jobs.map((j) => j.assign.size).join(",")}
`);
      };
      /**
       * One package's jobs at a time, in package order. A mutant has at most one job per package,
       * so within a package no two lanes race over it; a mutant killed in an earlier package is
       * skipped in a later one whatever the timing, and the test credited never depends on it.
       */
      const runByPackage = async (all: Job[]) => {
        for (const pkg of runnerPackages) {
          const mine = all.filter((j) => j.pkgId === pkg.id);
          if (mine.length > 0) await runJobs(mine);
        }
      };
      await runByPackage(jobs);
      // The second pass: the static mutants the first did not kill, in the rest of their files.
      const survivors = passes[1]!.filter((p) => !p.it.killedBy);
      if (survivors.length > 0) await runByPackage(buildJobs(survivors));

      for (const it of items) {
        const base: MutantResult = { ...it.d, status: 'Survived', coveredBy: [...it.coveredBy].sort(), testsCompleted: it.tested, ...(it.isStatic ? { static: true } : {}) };
        if (it.timeout) results.set(it.d.num, { ...base, status: 'Timeout', statusReason: it.message ?? 'declared hung', killedBy: it.killedBy ? [it.killedBy] : [] });
        else if (it.killedBy) results.set(it.d.num, { ...base, status: 'Killed', statusReason: it.message, killedBy: [it.killedBy] });
        else if (it.planned === 0) results.set(it.d.num, { ...base, status: 'NoCoverage', statusReason: 'no passing test reaches it' });
        // Asked to run and never reported: nothing decided this mutant. Never call that a survival.
        else if (it.tested === 0) results.set(it.d.num, { ...base, status: 'RuntimeError', statusReason: 'the mutant was planned against tests that never reported a result' });
        else results.set(it.d.num, base);
      }
      emit({ type: 'progress', decided: decidedCount(), total });
    }
  } finally {
    await Promise.all([...warm.values()].map((s) => s.close()));
  }
}
