/**
 * The coverage run: every package's suite once, with no mutant active. It says which tests reach
 * which sites, which sites run while modules load (static mutants), what each test's import
 * closure is, and which tests cannot be trusted warm.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { MutantDescriptor, PackageModel } from '@tzap/model';
import { normPath, type RunnerSession, type RunResult } from '@tzap/protocol';
import { relativeTo } from '../files.js';
import type { ImportGraph } from '../graph.js';
import { addTo, type EngineRun, type TestRecord } from './run.js';

/** What the coverage phase needs from the analysis. */
export interface CoverageInput {
  run: Pick<EngineRun, 'options' | 'emit' | 'root' | 'runnerPackages' | 'warm' | 'sessionFor' | 'nextRunId'>;
  graph: ImportGraph;
  placed: MutantDescriptor[];
  /** Every package's source files. */
  packageFiles: Map<string, string[]>;
  /** Packages that must run in their own pool: `sessionFor` reads it. */
  ownPool: Set<string>;
  packages: readonly PackageModel[];
}

export type CoverageFacts = Pick<EngineRun, 'tests' | 'green' | 'siteTests' | 'staticSites' | 'staticRan' | 'noisyUnhandled' | 'isolatesFiles' | 'staticPerFile' | 'loadLoops'> & {
  red: TestRecord[];
  /** Import-closure hash per green test key. */
  closures: Map<string, string>;
};

export async function coveragePhase(input: CoverageInput): Promise<CoverageFacts> {
  const { run, graph, placed } = input;
  const { emit, root, options } = run;
  // A diff run's coverage phase runs only the test files that can reach a file with mutants.
  const mutatedFiles = new Set(placed.map((d) => normPath(path.resolve(root, d.file))));
  const reachesMutated = (testFile: string) => {
    const c = graph.closure(testFile);
    return c.dynamic || c.files.some((f) => mutatedFiles.has(normPath(f)));
  };
  const facts: CoverageFacts = {
    tests: new Map(),
    green: [],
    red: [],
    siteTests: new Map(),
    staticSites: new Map(),
    staticRan: () => [],
    noisyUnhandled: new Set(),
    isolatesFiles: new Set(),
    staticPerFile: new Set(),
    loadLoops: new Map(),
    closures: new Map(),
  };

  for (const pkg of run.runnerPackages) {
    // Registered before it starts, so a start that fails after forking is still closed.
    let s = run.sessionFor(pkg);
    run.warm.set(pkg.id, s);
    let info = await s.start();
    let files: string[] | undefined;
    if (options.lines && s.listFiles) {
      const all = await s.listFiles();
      files = all.filter(reachesMutated);
      emit({ type: 'narrowed', pkg: pkg.id, files: files.length, of: all.length });
    }
    const coverage = (session: RunnerSession): Promise<RunResult> =>
      files && files.length === 0 ? Promise.resolve({ id: 0, tests: [], files: [], durationMs: 0 }) : session.run({ id: run.nextRunId(), mode: 'coverage', files });
    // Threads are tzap's choice, not the project's: if anything in the baseline fails in them —
    // or the run dies, as a native addon can take a thread's whole process down — that may be the
    // threads, and the project's own setting is used instead. Whatever still fails there is the
    // suite's own.
    let res: RunResult | undefined;
    try {
      res = await coverage(s);
    } catch (e) {
      if (!info.threads) throw e;
    }
    if (info.threads && (!res || res.unhandledErrors?.length || res.files.some((f) => f.error) || res.tests.some((t) => t.state === 'fail'))) {
      await s.close().catch(() => {});
      input.ownPool.add(pkg.id);
      emit({ type: 'info', message: `${pkg.id}: the baseline is not clean in worker threads; using the project's own pool` });
      s = run.sessionFor(pkg);
      run.warm.set(pkg.id, s);
      info = await s.start();
      res = await coverage(s);
    }
    if (!res) throw new Error(`${pkg.id}: the coverage run did not complete`);
    if (info.isolatesFiles) facts.isolatesFiles.add(pkg.id);
    if (info.staticPerFile) facts.staticPerFile.add(pkg.id);
    record(input, facts, pkg.id, res);
  }

  const all = [...facts.tests.values()];
  facts.red = all.filter((t) => t.red !== undefined);
  facts.green = all.filter((t) => t.red === undefined);
  const { green } = facts;
  emit({ type: 'coverage', tests: green.length, red: facts.red.length });
  const sensitive = green.filter((t) => t.stateSensitive);
  if (sensitive.length) {
    emit({ type: 'warning', message: `${sensitive.length} of ${green.length} tests behave differently when repeated; mutants only they cover are decided in isolation (${sensitive.slice(0, 3).map((t) => t.name).join('; ')}${sensitive.length > 3 ? '; ...' : ''})` });
  }
  closuresOf(input, facts);
  warnBuiltOutput(input, facts);

  for (const t of green) {
    for (const site of t.hits.keys()) {
      let list = facts.siteTests.get(site);
      if (!list) facts.siteTests.set(site, (list = []));
      list.push(t);
    }
  }
  facts.staticRan = (d) => {
    const files = new Set<string>();
    for (const key of facts.staticSites.get(d.site) ?? []) files.add(normPath(key.split('\0')[1]!));
    for (const t of facts.siteTests.get(d.site) ?? []) files.add(normPath(path.resolve(root, t.file)));
    return green.filter((t) => files.has(normPath(path.resolve(root, t.file)))).map((t) => t.key).sort();
  };
  return facts;
}

/** Records one package's coverage run. */
function record({ run }: CoverageInput, facts: CoverageFacts, pkgId: string, res: RunResult): void {
  const { emit, root } = run;
  if (res.unhandledErrors?.length) {
    facts.noisyUnhandled.add(pkgId);
    emit({ type: 'warning', message: `${pkgId}: the suite reports ${res.unhandledErrors.length} unhandled error(s) with no mutant active (${res.unhandledErrors[0]}); unhandled errors cannot count against mutants there` });
  }
  for (const f of res.files) {
    for (const [site] of f.staticHits ?? []) addTo(facts.staticSites, site, `${pkgId}\0${f.file}`);
    if (f.error) emit({ type: 'warning', message: `${relativeTo(root, f.file)}: ${f.error}` });
    if (f.loadLoops !== undefined) facts.loadLoops.set(normPath(f.file), f.loadLoops);
  }
  for (const t of res.tests) {
    if (t.state === 'skip') continue;
    const key = `${pkgId}::${t.id}`;
    const rec: TestRecord = {
      key,
      id: t.id,
      pkg: pkgId,
      runnerId: t.id,
      name: t.name,
      file: relativeTo(root, t.file),
      duration: Math.round(t.duration * 100) / 100,
      hits: new Map(t.hits ?? []),
      loops: t.loops ?? 0,
    };
    if (t.state === 'fail') rec.red = t.message ?? 'failed';
    if (t.stateSensitive) rec.stateSensitive = t.stateSensitive;
    facts.tests.set(key, rec);
  }
}

/**
 * Import closures, the cache's key for "nothing this test can reach has changed", and whether a
 * test can reach module state at all.
 */
function closuresOf({ run, graph, packageFiles }: CoverageInput, facts: CoverageFacts): void {
  const { root } = run;
  let everything: string | undefined;
  // A test with a dynamic import can reach anything: its key is the whole project.
  const everythingHash = () => {
    if (everything) return everything;
    const h = createHash('sha256');
    for (const t of [...facts.tests.values()].map((x) => x.file).sort()) h.update(t).update(graph.node(path.resolve(root, t)).hash);
    for (const [, fs] of [...packageFiles].sort(([a], [b]) => (a < b ? -1 : 1))) for (const f of fs) h.update(relativeTo(root, f)).update(graph.node(f).hash);
    return (everything = `all:${h.digest('hex').slice(0, 16)}`);
  };
  const byFile = new Map<string, { closure: string; stateful: boolean }>();
  for (const t of facts.green) {
    let known = byFile.get(t.file);
    if (!known) {
      const abs = path.resolve(root, t.file);
      const cl = graph.closure(abs);
      known = {
        closure: cl.dynamic ? everythingHash() : graph.closureHash(abs),
        // Project files only: state inside third-party packages is outside what this checks.
        stateful: cl.dynamic || cl.files.some((f) => !/[\\/]node_modules[\\/]/.test(f) && graph.node(f).stateful),
      };
      byFile.set(t.file, known);
    }
    t.closure = known.closure;
    t.stateful = known.stateful;
    facts.closures.set(t.key, known.closure);
  }
}

/**
 * A workspace package the tests import but whose source they never reach is almost always being
 * resolved to its built output: every mutant in it would look uncovered.
 */
function warnBuiltOutput({ run, graph, placed, packages }: CoverageInput, facts: CoverageFacts): void {
  const { root } = run;
  const reachedFiles = new Set<string>();
  for (const d of placed) {
    if (facts.green.some((t) => t.hits.has(d.site)) || facts.staticSites.has(d.site)) reachedFiles.add(d.file);
  }
  const imported = new Set<string>();
  for (const t of facts.green) for (const p of graph.closure(path.resolve(root, t.file)).packages) imported.add(p);
  for (const pkg of packages) {
    if (!imported.has(pkg.id)) continue;
    const dir = relativeTo(root, path.resolve(root, pkg.root));
    const own = placed.filter((d) => dir === '' || d.file.startsWith(`${dir}/`));
    if (own.length > 0 && !own.some((d) => reachedFiles.has(d.file))) {
      run.emit({
        type: 'warning',
        message: `tests import ${pkg.id} but never reach its source: they probably load its built output (check its package.json "exports"/"main", or alias it to src/ in the Vitest config); its ${own.length} mutants will be reported uncovered`,
      });
    }
  }
}
