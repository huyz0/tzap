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
import { ImportGraph } from './graph.js';

export type EngineKind = 'warm' | 'reference';

export interface EngineOptions {
  engine?: EngineKind;
  /** Enabled mutator names; default all. */
  mutators?: readonly string[];
  filters?: ReadonlyArray<{ name: string; filter: MutantFilter }>;
  /** Opt-in reductions: see InstrumentInput.reduce. */
  reduce?: { onePerLine?: boolean; equivalence?: boolean };
  /** Changed lines per root-relative file. Undefined: everything is in scope. Files absent from the map are out of scope. */
  lines?: ReadonlyMap<string, readonly LineRange[]>;
  /** Runner factories by runner kind. */
  runners: Readonly<Record<string, RunnerFactory>>;
  /** Worker count passed to each runner. */
  workers?: number;
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
  unchanged?: { lookup(m: MutantDescriptor): MutantResult | undefined; tests: TestInfo[] };
  onEvent?: (e: EngineEvent) => void;
  /**
   * Type-checks mutants: returns, per mutant number, the first diagnostic for each mutant the
   * checker rejects. `survivors` checks mutants the tests did not detect; `all` checks every
   * placed mutant before any test runs, so type-invalid ones never run.
   */
  typecheck?: { mode: 'survivors' | 'all'; check: (mutants: readonly MutantDescriptor[], root: string) => Promise<Map<number, string>> };
  tzapVersion: string;
  tmpDir?: string;
}

export type EngineEvent =
  | { type: 'phase'; phase: string }
  | { type: 'inventory'; files: number; mutants: number; placed: number }
  | { type: 'coverage'; tests: number; red: number }
  | { type: 'narrowed'; pkg: string; files: number; of: number }
  | { type: 'round'; round: number; tries: number; ms: number }
  | { type: 'progress'; decided: number; total: number }
  | { type: 'warning'; message: string };

/** What the coverage run says about one mutant, handed to the cache so it can decide reuse. */
export interface MutantCoverage {
  static: boolean;
  /** Global test keys that reach the mutant. */
  tests: string[];
  /** Import-closure hash per global test key. */
  closures: ReadonlyMap<string, string>;
}

interface TestRecord extends TestInfo {
  key: string;
  closure?: string;
  pkg: string;
  runnerId: string;
  hits: Map<number, number>;
  loops: number;
  red?: string;
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

const HIT_FACTOR = 100;
const HIT_FLOOR = 1000;
const LOOP_FACTOR = 10;
const LOOP_FLOOR = 100_000;

export async function analyse(model: ProjectModel, options: EngineOptions): Promise<AnalysisResult> {
  const emit = options.onEvent ?? (() => {});
  const timer = new Timer();
  const root = path.resolve(model.root);
  const tmpDir = options.tmpDir ?? path.join(os.tmpdir(), `tzap-${process.pid}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

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
  const ignored: MutantResult[] = descriptors
    .filter((d) => d.num < 0)
    .map((d) => ({ ...d, status: 'Ignored' as const, statusReason: d.description ?? d.ignoredBy }));

  const finish = (tests: Array<TestInfo & { key?: string }>, red: TestRecord[]): AnalysisResult => {
    timer.stop();
    const mutants = [...ignored, ...results.values()].sort(compareMutants);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // A leftover scratch directory is not worth failing an analysis over.
    }
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
      return finish(options.unchanged.tests, []);
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
    return factory({ root, pkg, instrumented: instrumentedPath, isolate, workers, tmpDir });
  };

  let runId = 1;
  const warm = new Map<string, RunnerSession>();
  const isolatesFiles = new Set<string>();
  const staticPerFile = new Set<string>();
  const graph = new ImportGraph({
    workspacePackages: new Map(model.packages.map((p) => [p.id, path.resolve(root, p.root)])),
  });
  const packageFiles = new Map(model.packages.map((p) => [p.id, sourceFiles(root, p)]));
  // A diff run's coverage phase runs only the test files that can reach a file with mutants.
  const mutatedFiles = new Set(placed.map((d) => toPosix(path.resolve(root, d.file)).toLowerCase()));
  const reachesMutated = (testFile: string) => {
    const c = graph.closure(testFile);
    if (c.dynamic) return true;
    if (c.files.some((f) => mutatedFiles.has(toPosix(f).toLowerCase()))) return true;
    return c.packages.some((pkg) => (packageFiles.get(pkg) ?? []).some((f) => mutatedFiles.has(toPosix(f).toLowerCase())));
  };
  const tests = new Map<string, TestRecord>();
  const staticSites = new Map<number, Set<string>>(); // site -> test files (absolute) that reached it outside tests
  const loadLoops = new Map<string, number>(); // normPath'd test file -> loop back-edges while loading
  const allTestFiles = new Map<string, Set<string>>(); // pkg id -> test files
  try {
    for (const pkg of runnerPackages) {
      const s = sessionFor(pkg);
      const info = await s.start();
      if (info.isolatesFiles) isolatesFiles.add(pkg.id);
      if (info.staticPerFile) staticPerFile.add(pkg.id);
      warm.set(pkg.id, s);
      let files: string[] | undefined;
      if (options.lines && s.listFiles) {
        const all = await s.listFiles();
        files = all.filter(reachesMutated);
        emit({ type: 'narrowed', pkg: pkg.id, files: files.length, of: all.length });
      }
      const res = files && files.length === 0 ? { id: 0, tests: [], files: [], durationMs: 0 } : await s.run({ id: runId++, mode: 'coverage', files });
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
      for (const [, fs] of [...packageFiles].sort(([a], [b]) => (a < b ? -1 : 1))) for (const f of fs) h.update(f).update(graph.node(f).hash);
      return (everything = `all:${h.digest('hex').slice(0, 16)}`);
    };
    const closureByFile = new Map<string, string>();
    for (const t of green) {
      let c = closureByFile.get(t.file);
      if (c === undefined) {
        const abs = path.resolve(root, t.file);
        c = graph.closure(abs).dynamic ? everythingHash() : graph.closureHash(abs, (pkg) => packageFiles.get(pkg) ?? []);
        closureByFile.set(t.file, c);
      }
      t.closure = c;
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

    // --- classify ----------------------------------------------------------------------------
    const covered: Pending[] = [];
    const statics: MutantDescriptor[] = [];
    for (const d of placed) {
      if (results.has(d.num)) continue;
      const isStatic = staticSites.has(d.site);
      const reaching = (siteTests.get(d.site) ?? []).map((t) => t.key);
      const reused = options.reuse?.(d, { static: isStatic, tests: reaching, closures });
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
          return (a.duration ?? 0) - (b.duration ?? 0) || (a.key < b.key ? -1 : 1);
        })
        .map((t) => t.key);
      const warmTests = ordered.filter((k) => !tests.get(k)!.stateSensitive);
      covered.push({ d, tests: ordered, warm: warmTests, cursor: 0, completed: 0 });
    }
    const total = placed.length;
    const decidedCount = () => results.size;
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
    /** Returns the mutants whose warm verdict could not be trusted, for the isolated path. */
    async function warmEngine(): Promise<Array<{ d: MutantDescriptor; tests: string[] }>> {
      const fallback: Array<{ d: MutantDescriptor; tests: string[] }> = [];
      let round = 0;
      for (const p of covered) {
        if (p.warm.length === 0) {
          fallback.push({ d: p.d, tests: p.tests });
          results.set(p.d.num, { ...p.d, status: 'Pending' });
        }
      }
      let active = covered.filter((p) => p.cursor < p.warm.length);
      while (active.length > 0) {
        round++;
        // Round 1 tries each mutant against its most likely killer only; later rounds try
        // every remaining covering test, with in-worker skipping once a mutant dies.
        const firstRound = round === 1;
        const byPkg = new Map<string, Map<string, Try[]>>();
        let tries = 0;
        for (const p of active) {
          const upto = firstRound ? p.cursor + 1 : p.warm.length;
          for (let i = p.cursor; i < upto; i++) {
            const t = tests.get(p.warm[i]!)!;
            let plan = byPkg.get(t.pkg);
            if (!plan) byPkg.set(t.pkg, (plan = new Map()));
            let list = plan.get(t.runnerId);
            if (!list) plan.set(t.runnerId, (list = [control(t)]));
            list.push({ m: p.d.num, ...limitsFor(t, p.d.site) });
            tries++;
          }
          p.cursor = upto;
        }
        for (const [pkgId, plan] of byPkg) {
          for (const [id, list] of plan) {
            const t = tests.get(`${pkgId}::${id}`)!;
            list.push(control(t));
          }
        }
        const started = performance.now();
        const outcomes = new Map<number, Outcome>();
        const suspect = new Set<number>();
        for (const [pkgId, plan] of byPkg) {
          const res = await runWithRecovery(pkgId, Object.fromEntries(plan), silenceMs);
          collect(pkgId, res, outcomes, suspect);
          // A planned try the runner never reported on decided nothing: re-decide it in isolation.
          const reported = new Set(res.tests.flatMap((t) => (t.tries ?? []).map(([m]) => `${t.id}\0${m}`)));
          for (const [id, list] of plan) for (const tr of list) if (tr.m >= 0 && !reported.has(`${id}\0${tr.m}`)) suspect.add(tr.m);
        }
        for (const p of active) {
          const o = outcomes.get(p.d.num);
          p.completed += o?.tested ?? 0;
          if (o?.timeout) {
            results.set(p.d.num, { ...p.d, status: 'Timeout', statusReason: o.message ?? 'declared hung', coveredBy: p.tests, killedBy: o.killedBy ? [o.killedBy] : [] });
          } else if (o?.killedBy) {
            results.set(p.d.num, { ...p.d, status: 'Killed', statusReason: o.message, killedBy: [o.killedBy], coveredBy: p.tests, testsCompleted: p.completed });
          } else if (suspect.has(p.d.num)) {
            // A control try around this mutant's tries failed: the context, not the mutant, may
            // have decided them. It is decided again in isolation.
            fallback.push({ d: p.d, tests: p.tests });
            results.set(p.d.num, { ...p.d, status: 'Pending' });
          } else if (p.cursor >= p.warm.length) {
            if (p.warm.length < p.tests.length) {
              // Survived every test the warm engine could trust; the state-sensitive ones get
              // their say in isolation.
              fallback.push({ d: p.d, tests: p.tests });
              results.set(p.d.num, { ...p.d, status: 'Pending' });
            } else {
              results.set(p.d.num, { ...p.d, status: 'Survived', coveredBy: p.tests, testsCompleted: p.completed });
            }
          }
        }
        emit({ type: 'round', round, tries, ms: Math.round(performance.now() - started) });
        emit({ type: 'progress', decided: decidedCount(), total });
        active = active.filter((p) => !results.has(p.d.num));
      }
      for (const f of fallback) results.delete(f.d.num);
      if (fallback.length) emit({ type: 'warning', message: `${fallback.length} mutants re-decided in isolation: a control try failed around them, or the test never reached them in the warm run` });
      return fallback;
    }

    interface Outcome {
      killedBy?: string;
      timeout?: boolean;
      message?: string;
      tested: number;
    }

    function collect(pkgId: string, res: RunResult, outcomes: Map<number, Outcome>, suspect: Set<number>) {
      for (const t of res.tests) {
        const tries = t.tries ?? [];
        const first = tries[0];
        const last = tries[tries.length - 1];
        const controlFailed =
          (first !== undefined && first[0] === -1 && first[1] !== 'S') || (last !== undefined && tries.length > 1 && last[0] === -1 && last[1] !== 'S');
        for (const [m, outcome, message] of tries) {
          if (m < 0) continue;
          let o = outcomes.get(m);
          if (!o) outcomes.set(m, (o = { tested: 0 }));
          if (outcome === 'X') continue;
          if (controlFailed || outcome === 'U') {
            suspect.add(m);
            continue;
          }
          o.tested++;
          if ((outcome === 'K' || outcome === 'T') && o.killedBy === undefined) {
            o.killedBy = `${pkgId}::${t.id}`;
            o.timeout = outcome === 'T';
            o.message = message;
          }
        }
      }
    }

    /** Runs a plan; if a hang outlives the budget, marks what was in flight as Timeout and retries the rest. */
    async function runWithRecovery(pkgId: string, plan: Record<string, Try[]>, budgetMs: number): Promise<RunResult> {
      const merged: RunResult = { id: 0, tests: [], files: [], durationMs: 0 };
      let remaining = plan;
      for (let attempt = 0; attempt < 50; attempt++) {
        let s = warm.get(pkgId)!;
        const res = await s.run({ id: runId++, mode: 'mutate', plan: remaining, budgetMs });
        if (!res.timedOut) {
          merged.tests.push(...res.tests);
          merged.files.push(...res.files);
          return merged;
        }
        const hung = new Set((res.inFlight ?? []).map((x) => x.mutant).filter((m) => m >= 0));
        if (hung.size === 0) throw new Error(`a test run went silent for ${Math.round(budgetMs / 1000)} s with no mutant try in flight: a hook outside any test (beforeAll/afterAll, a global setup) is blocking; it does so without any mutant, so check the suite on its own`);
        emit({ type: 'warning', message: `wall-clock backstop: mutants ${[...hung].join(', ')} declared hung` });
        for (const m of hung) {
          merged.tests.push({ id: '__backstop__', name: 'backstop', file: '', state: 'fail', duration: budgetMs, tries: [[m, 'T', 'wall-clock backstop']] });
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
      const jobs: Job[] = [];
      for (const pkg of runnerPackages) {
        const parts = items.filter((it) => (it.files.get(pkg.id)?.size ?? 0) > 0);
        const packs = !fresh && staticPerFile.has(pkg.id);
        const open: Job[] = [];
        for (const it of parts) {
          const fs = it.files.get(pkg.id)!;
          let job = packs ? open.find((j) => ![...fs].some((f) => j.assign.has(f))) : undefined;
          if (!job) {
            job = { pkgId: pkg.id, assign: new Map() };
            open.push(job);
          }
          for (const f of fs) job.assign.set(f, it);
        }
        jobs.push(...open);
      }

      const cores = os.availableParallelism();
      const lanes = fresh ? Math.max(1, options.concurrency ?? 1) : Math.max(1, options.concurrency ?? Math.min(4, Math.floor(cores / 4)));
      const workersPerSession = Math.max(1, Math.floor(cores / lanes));

      const runJob = async (job: Job, session: () => Promise<RunnerSession>, retire: () => void): Promise<void> => {
        // A mutant killed by an earlier job needs no more runs.
        for (const [f, it] of [...job.assign]) if (it.killedBy) job.assign.delete(f);
        if (job.assign.size === 0) return;
        const plan: Record<string, Try[]> = {};
        const staticPlan: Record<string, number> = {};
        const files: string[] = [];
        for (const [f, it] of job.assign) {
          const ts = testsByFile.get(`${job.pkgId}\0${f}`) ?? [];
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
        for (const t of res.tests) {
          for (const [m, outcome, msg] of t.tries ?? []) {
            const it = byNum.get(m);
            if (!it) continue;
            it.tested++;
            if ((outcome === 'K' || outcome === 'T') && !it.killedBy) {
              it.killedBy = `${job.pkgId}::${t.id}`;
              it.timeout = outcome === 'T';
              it.message = msg;
            }
          }
        }
        for (const it of byNum.values()) emit({ type: 'progress', decided: decidedCount() + (it.killedBy ? 1 : 0), total });
      };

      const pkgById = new Map(runnerPackages.map((p) => [p.id, p]));
      const queue = jobs.slice();
      const lane = async () => {
        const sessions = new Map<string, RunnerSession>();
        try {
          for (;;) {
            const job = queue.shift();
            if (!job) return;
            const pkg = pkgById.get(job.pkgId)!;
            const reuseWarm = !fresh && isolatesFiles.has(job.pkgId) && lanes === 1;
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
            await runJob(job, session, retire);
            if (fresh) {
              await Promise.all([...sessions.values()].map((s) => s.close()));
              sessions.clear();
            }
          }
        } finally {
          await Promise.all([...sessions.values()].map((s) => s.close()));
        }
      };
      await Promise.all(Array.from({ length: lanes }, lane));

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
