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
import type { RunnerFactory, RunnerSession, RunResult, Try } from '@tzap/protocol';
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
  const sessionFor = (pkg: PackageModel, isolate?: boolean): RunnerSession => {
    const factory = options.runners[pkg.runner!.kind];
    if (!factory) throw new Error(`no runner adapter for "${pkg.runner!.kind}" (package ${pkg.id})`);
    return factory({ root, pkg, instrumented: instrumentedPath, isolate, workers: options.workers, tmpDir });
  };

  let runId = 1;
  const warm = new Map<string, RunnerSession>();
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
  const allTestFiles = new Map<string, Set<string>>(); // pkg id -> test files
  try {
    for (const pkg of runnerPackages) {
      const s = sessionFor(pkg);
      await s.start();
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
        let budget = 10_000;
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
            budget += 3 * (t.duration ?? 0) + 25;
          }
          p.cursor = upto;
        }
        for (const [pkgId, plan] of byPkg) {
          for (const [id, list] of plan) {
            const t = tests.get(`${pkgId}::${id}`)!;
            list.push(control(t));
            budget += 6 * (t.duration ?? 0);
          }
        }
        const started = performance.now();
        const outcomes = new Map<number, Outcome>();
        const suspect = new Set<number>();
        for (const [pkgId, plan] of byPkg) {
          const res = await runWithRecovery(pkgId, Object.fromEntries(plan), budget);
          collect(pkgId, res, outcomes, suspect);
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
        if (hung.size === 0) throw new Error('a test run exceeded its wall-clock budget with no mutant in flight');
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
     * no test is deprived of the tests it follows. Killed when any of them fails. With `fresh`,
     * each mutant gets a new session: the reference engine, which reuses nothing.
     */
    async function isolatedRuns(list: Array<{ d: MutantDescriptor; tests: string[] }>, fresh: boolean): Promise<void> {
      if (list.length === 0) return;
      const shared = new Map<string, RunnerSession>();
      const concurrency = fresh ? Math.max(1, options.concurrency ?? 1) : 1;
      let next = 0;
      const one = async (item: { d: MutantDescriptor; tests: string[] }) => {
        const { d } = item;
        const isStatic = staticSites.has(d.site);
        const perPkg = new Map<string, Set<string>>();
        const add = (pkgId: string, file: string) => {
          let set = perPkg.get(pkgId);
          if (!set) perPkg.set(pkgId, (set = new Set()));
          set.add(toPosix(file).toLowerCase());
        };
        for (const key of item.tests) {
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
        let killedBy: string | undefined;
        let message: string | undefined;
        let timeout = false;
        let tested = 0;
        const coveredBy = new Set<string>(item.tests);
        for (const t of siteTests.get(d.site) ?? []) coveredBy.add(t.key);
        for (const [pkgId, fileSet] of perPkg) {
          if (killedBy) break;
          const pkg = runnerPackages.find((p) => p.id === pkgId)!;
          const plan: Record<string, Try[]> = {};
          const fileList: string[] = [];
          for (const t of green) {
            if (t.pkg !== pkgId) continue;
            const abs = path.resolve(root, t.file);
            if (!fileSet.has(toPosix(abs).toLowerCase())) continue;
            plan[t.runnerId] = [{ m: d.num, ...limitsFor(t, d.site) }];
            if (!fileList.includes(abs)) fileList.push(abs);
          }
          if (fileList.length === 0) continue;
          let s = fresh ? undefined : shared.get(pkgId);
          if (!s) {
            s = sessionFor(pkg, true);
            await s.start();
            if (!fresh) shared.set(pkgId, s);
          }
          try {
            const budget = 15_000 + Object.keys(plan).reduce((a, id) => a + 5 * (tests.get(`${pkgId}::${id}`)?.duration ?? 0) + 50, 0);
            const res = await s.run({ id: runId++, mode: 'static', staticMutant: d.num, plan, files: fileList, budgetMs: budget });
            if (res.timedOut) {
              timeout = true;
              killedBy = 'wall-clock backstop';
              message = 'wall-clock backstop';
              shared.delete(pkgId);
              continue;
            }
            for (const f of res.files) {
              if (f.error && !killedBy) {
                killedBy = `${pkgId}::${relativeTo(root, f.file)}`;
                message = `test file failed to load: ${f.error}`;
              }
            }
            for (const t of res.tests) {
              for (const [, outcome, msg] of t.tries ?? []) {
                tested++;
                if ((outcome === 'K' || outcome === 'T') && !killedBy) {
                  killedBy = `${pkgId}::${t.id}`;
                  timeout = outcome === 'T';
                  message = msg;
                }
              }
            }
          } finally {
            if (fresh) await s.close();
          }
        }
        const base: MutantResult = { ...d, status: 'Survived', coveredBy: [...coveredBy].sort(), testsCompleted: tested, ...(isStatic ? { static: true } : {}) };
        if (timeout) results.set(d.num, { ...base, status: 'Timeout', statusReason: message ?? 'declared hung', killedBy: killedBy ? [killedBy] : [] });
        else if (killedBy) results.set(d.num, { ...base, status: 'Killed', statusReason: message, killedBy: [killedBy] });
        else if (coveredBy.size === 0 && !isStatic) results.set(d.num, { ...base, status: 'NoCoverage' });
        else results.set(d.num, base);
        emit({ type: 'progress', decided: decidedCount(), total });
      };
      try {
        const sorted = list.slice().sort((a, b) => a.d.num - b.d.num);
        await Promise.all(
          Array.from({ length: concurrency }, async () => {
            while (next < sorted.length) await one(sorted[next++]!);
          }),
        );
      } finally {
        await Promise.all([...shared.values()].map((s) => s.close()));
      }
    }
  } finally {
    await Promise.all([...warm.values()].map((s) => s.close()));
  }
}
