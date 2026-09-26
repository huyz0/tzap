/**
 * One analysis, end to end: place mutants, run the suites once for coverage, classify each
 * mutant, and decide the covered ones warm or in isolation.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareMutants, languageOf, type AnalysisResult, type MutantDescriptor, type MutantResult, type PackageModel, type ProjectModel, type SourceFile, type TestInfo } from '@tzap/model';
import { instrument } from '@tzap/instrument';
import type { RunnerSession } from '@tzap/protocol';
import { relativeTo, sourceFiles } from '../files.js';
import { ImportGraph, realPath } from '../graph.js';
import { coveragePhase, type CoverageFacts } from './coverage.js';
import { isolatedRuns } from './isolated.js';
import type { EngineOptions } from './options.js';
import { decidedCount, speedClass, Timer, type EngineRun, type Pending } from './run.js';
import { warmEngine } from './warm.js';

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

interface Inventory {
  files: Record<string, SourceFile>;
  descriptors: MutantDescriptor[];
  /** Where the instrumented sources were written, for the runners. */
  instrumentedPath: string;
}

/** Instruments every in-scope source file and writes the instrumented code for the runners. */
function inventory(model: ProjectModel, options: EngineOptions, root: string, tmpDir: string, emit: EngineRun['emit']): Inventory {
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
      const out = instrument({ file: rel, source, mutators: options.mutators, lines, filters: options.filters, reduce: options.reduce, firstMutant: nextMutant, firstSite: nextSite });
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
  emit({ type: 'inventory', files: fileCount, mutants: descriptors.length, placed: descriptors.filter((d) => d.num >= 0).length });
  return { files, descriptors, instrumentedPath };
}

async function analyseIn(model: ProjectModel, options: EngineOptions, tmpDir: string): Promise<AnalysisResult> {
  const emit = options.onEvent ?? (() => {});
  const timer = new Timer();
  const root = path.resolve(model.root);
  const phase = (name: string) => {
    timer.start(name);
    emit({ type: 'phase', phase: name });
  };

  phase('instrument');
  const { files, descriptors, instrumentedPath } = inventory(model, options, root, tmpDir, emit);
  const placed = descriptors.filter((d) => d.num >= 0);
  const results = new Map<number, MutantResult>();
  const typecheck = options.typecheck;

  // --typecheck=all: type-invalid mutants never run.
  if (typecheck?.mode === 'all') {
    phase('typecheck');
    const rejected = await typecheck.check(placed, root);
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

  const finish = (tests: Array<TestInfo & { key?: string }>, red: AnalysisResult['redTests']): AnalysisResult => {
    timer.stop();
    return {
      tzapVersion: options.tzapVersion,
      root,
      files,
      mutants: [...ignored, ...results.values()].sort(compareMutants),
      tests: tests
        .map((t) => ({ id: t.key ?? t.id, name: t.name, file: t.file, duration: t.duration, ...(t.closure ? { closure: t.closure } : {}) }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      redTests: red,
      config: {
        engine: options.engine ?? 'warm',
        typecheck: typecheck?.mode ?? 'off',
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
    if (typecheck?.mode !== 'survivors') return;
    const undetected = [...results.values()].filter((r) => r.status === 'Survived' || r.status === 'NoCoverage');
    if (undetected.length === 0) return;
    phase('typecheck');
    const rejected = await typecheck.check(undetected, root);
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
      return finish(options.unchanged.tests, options.unchanged.red);
    }
  }
  if (placed.length === 0 || runnerPackages.length === 0) {
    for (const d of placed) if (!results.has(d.num)) results.set(d.num, { ...d, status: 'NoCoverage', statusReason: 'no package with a test runner' });
    await typecheckSurvivors();
    return finish([], []);
  }

  phase('coverage');
  /** Packages that run in their own pool: threads changed what their baseline did. */
  const ownPool = new Set<string>();
  const sessionFor = (pkg: PackageModel, isolate?: boolean, workers = options.workers): RunnerSession => {
    const factory = options.runners[pkg.runner!.kind];
    if (!factory) throw new Error(`no runner adapter for "${pkg.runner!.kind}" (package ${pkg.id})`);
    const preferThreads = options.preferThreads !== false && !ownPool.has(pkg.id);
    return factory({ root, pkg, instrumented: instrumentedPath, isolate, workers, tmpDir, ...(preferThreads ? { preferThreads } : {}) });
  };
  let runId = 1;
  const base = { options, emit, root, runnerPackages, results, warm: new Map<string, RunnerSession>(), sessionFor, nextRunId: () => runId++ };
  const packageFiles = new Map(model.packages.map((p) => [p.id, sourceFiles(root, p)]));
  const allSources = [...new Set([...packageFiles.values()].flat().map((f) => path.resolve(f)))].map((f) => ({ f, real: realPath(f) }));
  const graph = new ImportGraph({
    workspacePackages: new Map(model.packages.map((p) => [p.id, path.resolve(root, p.root)])),
    root,
    filesUnder: (dir) => allSources.filter((s) => s.real.startsWith(dir + path.sep)).map((s) => s.f),
  });
  try {
    const facts = await coveragePhase({ run: base, graph, placed, packageFiles, ownPool, packages: model.packages });
    const run: EngineRun = {
      ...base,
      ...facts,
      silenceMs: Math.max(15_000, 10 * Math.max(0, ...facts.green.map((t) => t.duration ?? 0)) + 5_000),
      total: placed.length,
    };
    const { covered, statics } = classify(run, placed, facts);
    emit({ type: 'progress', decided: decidedCount(run), total: run.total });

    phase('execute');
    const asStatic = statics.map((d) => ({ d, tests: [] as string[] }));
    if (options.engine === 'reference') {
      // Everything through the isolated path, one fresh session per mutant.
      await isolatedRuns(run, [...covered.map((p) => ({ d: p.d, tests: p.tests })), ...asStatic], true);
    } else {
      const fallback = await warmEngine(run, covered);
      phase('isolated');
      await isolatedRuns(run, [...fallback, ...asStatic], false);
    }
    await typecheckSurvivors();
    return finish(facts.green, facts.red.map((t) => ({ id: t.key, name: t.name, file: t.file, message: t.red ?? '' })));
  } finally {
    await Promise.all([...base.warm.values()].map((s) => s.close()));
  }
}

/**
 * Sorts the placed mutants: reused from the cache, static (isolated only), uncovered, or covered
 * and waiting for the warm engine with their tests in the order to try them.
 */
function classify(run: EngineRun, placed: MutantDescriptor[], facts: CoverageFacts): { covered: Pending[]; statics: MutantDescriptor[] } {
  const { options, results, siteTests, tests } = run;
  const covered: Pending[] = [];
  const statics: MutantDescriptor[] = [];
  for (const d of placed) {
    if (results.has(d.num)) continue;
    const isStatic = run.staticSites.has(d.site);
    const reaching = (siteTests.get(d.site) ?? []).map((t) => t.key);
    const reused = options.reuse?.(d, { static: isStatic, tests: reaching, closures: facts.closures, ...(isStatic ? { ran: run.staticRan(d) } : {}) });
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
    covered.push({ d, tests: ordered, warm: ordered.filter((k) => !tests.get(k)!.stateSensitive), cursor: 0, completed: 0 });
  }
  return { covered, statics };
}
