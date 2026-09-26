/**
 * The command line: the composition root, and the only package that knows every other one.
 *
 *   tzap run           [-m model.json] [--from REF --to REF | --patch FILE] [--scope line|function|file]
 *                      [-r console,html,...] [-o DIR] [--threshold PCT] [--fail-on-survivors]
 *                      [--engine warm|reference] [--mutators A,B] [--workers N] [--cache-dir DIR] [--dry-run]
 *   tzap model         [-o model.json] [--filter PKG]
 *   tzap list-mutants  [-m model.json] [--filter PKG] [--from REF --to REF | --patch FILE] [--format json|table]
 *   tzap mutators
 *
 * Exit codes: 0 met the bar, 1 did not (threshold or survivors), 2 usage error, 3 analysis failed.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { analyse, loadCache, relativeTo, saveCache, sourceFiles, type EngineEvent } from '@tzap/core';
import { discover, DiscoveryError } from '@tzap/discover';
import { gitChangedLines, parseUnifiedDiff, repositoryPrefix, type ChangedLines, type LineRange } from '@tzap/git';
import { ALL_MUTATORS, EXTRA_MUTATORS, aridFilters, instrument, type MutantFilter } from '@tzap/instrument';
import { meetsThreshold, ModelValidationError, parseModel, score, serialiseModel, type Granularity, type ProjectModel, type ScopeSpec } from '@tzap/model';
import { reporters as reporterRegistry, writeReports } from '@tzap/report';
import { createJestSession } from '@tzap/runner-jest';
import { createMochaSession } from '@tzap/runner-mocha';
import { createNodeTestSession } from '@tzap/runner-node';
import { createVitestSession } from '@tzap/runner-vitest';
import { createTypeChecker, typeFilters, type TypeChecker } from '@tzap/typecheck';
import { widenScope } from './scope.js';

const reporterNames = Object.keys(reporterRegistry);

export const VERSION = '0.1.0';

class UsageError extends Error {}

const RUN_OPTIONS = {
  model: { type: 'string', short: 'm' },
  from: { type: 'string' },
  to: { type: 'string' },
  patch: { type: 'string' },
  scope: { type: 'string' },
  reporters: { type: 'string', short: 'r' },
  'out-dir': { type: 'string', short: 'o' },
  threshold: { type: 'string' },
  'fail-on-survivors': { type: 'boolean' },
  engine: { type: 'string' },
  mutators: { type: 'string' },
  workers: { type: 'string' },
  concurrency: { type: 'string' },
  'cache-dir': { type: 'string' },
  'no-arid': { type: 'boolean' },
  'one-per-line': { type: 'boolean' },
  dedup: { type: 'boolean' },
  extreme: { type: 'boolean' },
  'verify-survivors': { type: 'string' },
  'keep-pool': { type: 'boolean' },
  typecheck: { type: 'string' },
  tsconfig: { type: 'string' },
  'dry-run': { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  filter: { type: 'string' },
  format: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

/** The options each command takes; any other is a usage error rather than silently ignored. */
const INVENTORY_OPTIONS = ['model', 'filter', 'from', 'to', 'patch', 'scope', 'mutators', 'no-arid', 'one-per-line', 'dedup', 'extreme', 'typecheck', 'tsconfig'];
const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  run: Object.keys(RUN_OPTIONS).filter((o) => o !== 'format'),
  'list-mutants': [...INVENTORY_OPTIONS, 'format'],
  model: ['filter', 'out-dir'],
  mutators: [],
};

const HELP = `tzap ${VERSION} — fast, diff-aware mutation testing for TypeScript and JavaScript

Usage:
  tzap run [options]            analyse, and report surviving mutants
  tzap model [-o model.json]    print the discovered project model
  tzap list-mutants [options]   the inventory, without running a test (--format json|table)
  tzap mutators                 the available mutators

Run options:
  -m, --model FILE              project model (default: discovered from the current directory)
      --filter LIST             analyse only these workspace packages (names or directories)
      --from REF --to REF       analyse only lines changed between two refs; -Local- is the
                                working tree, -Empty- the empty tree (default HEAD..-Local-)
      --patch FILE              analyse only lines a unified diff changes (no git needed)
      --scope line|function|file   widen a diff scope (default line)
  -r, --reporters LIST          ${'console'} (default), agent, json, elements, html, github, sarif, markdown
  -o, --out-dir DIR             where report files go (default reports/tzap)
      --threshold PCT           exit 1 when the mutation score is below PCT
      --fail-on-survivors       exit 1 when any mutant survives
      --engine warm|reference   reference runs one fresh process per mutant: slow, and the oracle
      --mutators LIST           restrict to these mutators
      --workers N               worker count for the test runner's pool
      --concurrency N           sessions deciding isolated mutants at once (default: from the cores)
      --cache-dir DIR           reuse verdicts that are provably still valid
      --no-arid                 also mutate logging and similar code (arid rules are on by default)
      --one-per-line            keep one mutant per line (faster; stops reporting some gaps)
      --dedup                   drop mutants that compile to the original or to each other
      --extreme                 one mutant per function: its body removed (Descartes-style)
      --typecheck off|survivors|all
                                type-check undetected mutants (survivors, the default when the
                                project has TypeScript and a tsconfig) or every mutant before it
                                runs (all); rejected ones are CompileError, outside the score
      --tsconfig FILE           the tsconfig to type-check against (default: the nearest one)
      --verify-survivors auto|all|off
                                confirm warm survivors in isolation: those whose tests reach
                                module state (auto, the default), all of them, or none
                                (off, the fastest: state a test leaves behind can hide a kill)
      --keep-pool               run Vitest in the project's default pool (forks) even when its
                                config leaves the pool unset; by default tzap uses worker threads
                                there, and falls back if the baseline is not clean in them
      --dry-run                 print what would be analysed, and stop
  -q, --quiet                   no progress output

Exit codes: 0 met the bar, 1 did not, 2 usage error, 3 the analysis failed.`;

function list(v: string | undefined): string[] | undefined {
  return v === undefined ? undefined : v.split(',').map((s) => s.trim()).filter(Boolean);
}

/** A whole number of at least 1: a worker or lane count. */
function count(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (v.trim() === '' || !Number.isInteger(n) || n < 1) throw new UsageError(`--${name}: expected a whole number of at least 1, got "${v}"`);
  return n;
}

/** A percentage, 0 to 100. */
function percent(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (v.trim() === '' || !Number.isFinite(n) || n < 0 || n > 100) throw new UsageError(`--${name}: expected a percentage from 0 to 100, got "${v}"`);
  return n;
}

/** What decides the inventory of mutants: the same for `run` and `list-mutants`. */
interface Inventory {
  mutators: string[] | undefined;
  filters: Array<{ name: string; filter: MutantFilter }>;
  reduce: { onePerLine: boolean; equivalence: boolean };
  /** Type checking, when the project has TypeScript and a tsconfig; the caller closes it. */
  checker?: TypeChecker;
  typecheck?: 'survivors' | 'all';
}

/** Rejects bad inventory option values before anything is discovered or run. */
function checkInventoryOptions(values: Record<string, unknown>): void {
  const mutators = list(values.mutators as string | undefined);
  if (mutators) {
    const known = new Set([...ALL_MUTATORS, ...EXTRA_MUTATORS].map((m) => m.name));
    const unknown = mutators.filter((m) => !known.has(m));
    if (unknown.length) throw new UsageError(`--mutators: unknown ${unknown.join(', ')}; known: ${[...known].join(', ')}`);
  }
  const requested = values.typecheck as string | undefined;
  if (requested !== undefined && !['off', 'survivors', 'all'].includes(requested)) throw new UsageError(`--typecheck: expected off, survivors or all, got "${requested}"`);
  const scope = values.scope as string | undefined;
  if (scope !== undefined && !GRANULARITIES.includes(scope as Granularity)) throw new UsageError(`--scope: expected line, function or file, got "${scope}"`);
}

async function inventorySettings(model: ProjectModel, values: Record<string, unknown>, cwd: string, quiet: boolean): Promise<Inventory> {
  checkInventoryOptions(values);
  const mutators = values.extreme ? ['FunctionBody'] : list(values.mutators as string | undefined);
  const filters = values['no-arid'] ? [] : aridFilters();
  const reduce = { onePerLine: values['one-per-line'] === true, equivalence: values.dedup === true };

  // Type checking: explicit modes must work; the default quietly steps aside for a project with
  // no TypeScript or no tsconfig.
  const requested = values.typecheck as string | undefined;
  if (requested === 'off') return { mutators, filters, reduce };
  let checker: TypeChecker | undefined;
  try {
    checker = createTypeChecker({ root: model.root, ...(values.tsconfig ? { tsconfig: path.resolve(cwd, values.tsconfig as string) } : {}) });
    // Asked of a file being mutated: the tsconfig that governs it, not the workspace root's.
    const probe = model.packages.map((p) => sourceFiles(model.root, p)[0]).find((f) => f !== undefined);
    const strict = await checker.strictNullChecks(probe ? relativeTo(model.root, probe) : undefined);
    if (strict === undefined) throw new Error('no tsconfig applies to the project');
    // Syntactic rules that need no checker; they assume strictNullChecks. Their mutants are
    // CompileError, like the checker's.
    if (strict) filters.push(...typeFilters());
    return { mutators, filters, reduce, checker, typecheck: (requested as 'survivors' | 'all' | undefined) ?? 'survivors' };
  } catch (e) {
    await checker?.close();
    if (requested) throw new UsageError(`--typecheck ${requested}: cannot type-check this project: ${(e as Error).message}`);
    if (!quiet) process.stderr.write(`tzap: type checking off: ${(e as Error).message}\n`);
    return { mutators, filters, reduce };
  }
}

async function loadModel(file: string | undefined, cwd: string, filter?: string[]): Promise<{ model: ProjectModel; notes: string[] }> {
  if (file) {
    const text = readInput(path.resolve(cwd, file), '--model');
    const { model, warnings } = parseModel(text);
    if (!path.isAbsolute(model.root)) model.root = path.resolve(path.dirname(path.resolve(cwd, file)), model.root);
    return { model, notes: warnings };
  }
  const d = await discover({ cwd, filter });
  if (!filter && d.model.packages.length > 1) {
    // Run from inside one package of a workspace: analyse that package. Run from the root (or
    // name packages with --filter) to analyse several in one run.
    const here = path.resolve(cwd);
    const inside = d.model.packages.find((p) => p.root !== '.' && (here + path.sep).startsWith(path.resolve(d.model.root, p.root) + path.sep));
    if (inside) {
      d.model.packages = [inside];
      return { model: d.model, notes: [`analysing package ${inside.id} (the one the current directory is in; use --filter or run from the workspace root for more)`] };
    }
  }
  return { model: d.model, notes: d.notes };
}

/** A file the user named: one that cannot be read is a usage error, not a failed analysis. */
function readInput(file: string, what: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    throw new UsageError(`${what}: cannot read ${file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
}

async function resolveScope(model: ProjectModel, values: Record<string, unknown>, cwd: string): Promise<ChangedLines | undefined> {
  const from = values.from as string | undefined;
  const to = values.to as string | undefined;
  const patch = values.patch as string | undefined;
  const scope: ScopeSpec | undefined = patch || from || to ? { kind: 'diff', from, to, patch } : model.scope;
  const granularity = (values.scope as string | undefined) ?? (scope?.kind === 'diff' ? scope.granularity : undefined) ?? 'line';
  if (!scope || scope.kind === 'full') {
    if (values.scope !== undefined) throw new UsageError('--scope widens a diff scope: give --from/--to or --patch too');
    return undefined;
  }
  // A patch named on the command line is relative to the current directory; one in the model file,
  // like every path there, to the model root.
  const base = patch ? cwd : model.root;
  const changed = await changedLines(model, scope, base);
  if (granularity === 'line') return changed;
  return { ...changed, files: widenScope(model.root, changed.files, granularity as Granularity), description: `${changed.description}, widened to whole ${granularity === 'file' ? 'files' : 'functions'}` };
}

const GRANULARITIES: readonly Granularity[] = ['line', 'function', 'file'];

async function changedLines(model: ProjectModel, scope: Extract<ScopeSpec, { kind: 'diff' }>, base: string): Promise<ChangedLines> {
  if (scope.patch) {
    // Paths in a patch are relative to wherever it was made: usually the repository root, as git
    // writes them, sometimes the model root or the current directory. Take the first of those —
    // the model root, the directory the patch was named from, then each directory above the model
    // root — under which the path names a real file.
    const parsed = parseUnifiedDiff(readInput(path.resolve(base, scope.patch), '--patch'));
    const bases = [model.root, base];
    for (let d = path.dirname(model.root); d !== bases[bases.length - 1]; d = path.dirname(d)) bases.push(d);
    const files = new Map<string, LineRange[]>();
    for (const [p, ranges] of parsed.files) {
      const abs = bases.map((b) => path.resolve(b, p)).find((f) => existsSync(f)) ?? path.resolve(model.root, p);
      files.set(relativeTo(model.root, abs), ranges as LineRange[]);
    }
    return { ...parsed, files };
  }
  return gitChangedLines({ cwd: model.root, root: model.root, from: scope.from, to: scope.to });
}

function progress(quiet: boolean) {
  let last = '';
  return (e: EngineEvent) => {
    if (quiet) return;
    let line = '';
    switch (e.type) {
      case 'inventory':
        line = `tzap: ${e.mutants} mutants in ${e.files} files (${e.placed} to run)`;
        break;
      case 'narrowed':
        line = `tzap: coverage narrowed to ${e.files} of ${e.of} test files in ${e.pkg}: only those that can import a changed file`;
        break;
      case 'coverage':
        line = `tzap: coverage from ${e.tests} tests${e.red ? `, ${e.red} failing without any mutant (excluded)` : ''}`;
        break;
      case 'round':
        line = `tzap: round ${e.round}: ${e.tries} tries in ${e.ms} ms`;
        break;
      case 'warning':
        line = `tzap: warning: ${e.message}`;
        break;
      case 'info':
        line = `tzap: ${e.message}`;
        break;
      default:
        return;
    }
    if (line !== last) process.stderr.write(`${line}\n`);
    last = line;
  };
}

async function run(values: Record<string, unknown>, cwd: string): Promise<number> {
  const quiet = values.quiet === true;
  // Every flag is checked before anything is read or run.
  const engine = (values.engine as string | undefined) ?? 'warm';
  if (engine !== 'warm' && engine !== 'reference') throw new UsageError(`--engine: expected warm or reference, got "${engine}"`);
  const reporterFlag = list(values.reporters as string | undefined);
  const unknownReporters = (reporterFlag ?? []).filter((r) => !reporterNames.includes(r));
  if (unknownReporters.length) throw new UsageError(`--reporters: unknown ${unknownReporters.join(', ')}; known: ${reporterNames.join(', ')}`);
  const outDir = path.resolve(cwd, (values['out-dir'] as string | undefined) ?? 'reports/tzap');
  const threshold = percent(values.threshold as string | undefined, 'threshold');
  const workers = count(values.workers as string | undefined, 'workers');
  const concurrency = count(values.concurrency as string | undefined, 'concurrency');
  const verifyMode = (values['verify-survivors'] as string | undefined) ?? 'auto';
  if (!['auto', 'all', 'off'].includes(verifyMode)) throw new UsageError(`--verify-survivors: expected auto, all or off, got "${verifyMode}"`);
  checkInventoryOptions(values);
  const { model, notes } = await loadModel(values.model as string | undefined, cwd, list(values.filter as string | undefined));
  if (!quiet) for (const n of notes) process.stderr.write(`tzap: ${n}\n`);
  const changed = await resolveScope(model, values, cwd);
  if (changed && !quiet) {
    process.stderr.write(`tzap: scope: ${changed.description}\n`);
    process.stderr.write('tzap: the range only selects what to analyse; the analysis runs against the working tree\n');
  }

  const reporters = reporterFlag ?? model.reporters ?? ['console'];
  const unknownInModel = reporters.filter((r) => !reporterNames.includes(r));
  if (unknownInModel.length) throw new UsageError(`model reporters: unknown ${unknownInModel.join(', ')}; known: ${reporterNames.join(', ')}`);

  if (values['dry-run']) {
    const lines = [`root: ${model.root}`];
    for (const pkg of model.packages) {
      const files = sourceFiles(model.root, pkg).map((f) => relativeTo(model.root, f));
      const inScope = changed ? files.filter((f) => changed.files.has(f)) : files;
      lines.push(`package ${pkg.id} (${pkg.root}): runner ${pkg.runner ? `${pkg.runner.kind}${pkg.runner.version ? ` ${pkg.runner.version}` : ''}` : 'none'}, ${inScope.length} of ${files.length} source files in scope`);
      for (const f of inScope) lines.push(`  ${f}${changed ? ` lines ${changed.files.get(f)!.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(',')}` : ''}`);
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }

  // A cache directory on the command line is relative to the current directory; the model's, to the model root.
  const cacheFlag = values['cache-dir'] as string | undefined;
  const cacheDir = cacheFlag !== undefined ? path.resolve(cwd, cacheFlag) : model.cache?.dir !== undefined ? path.resolve(model.root, model.cache.dir) : undefined;
  const inv = await inventorySettings(model, values, cwd, quiet);
  const { mutators, filters, checker, typecheck: tcMode } = inv;
  const cache = cacheDir
    ? loadCache(cacheDir, model, { tzapVersion: VERSION, mutators, filters: filters.map((f) => f.name), typecheck: checker && tcMode ? tcMode : 'off', verifySurvivors: verifyMode })
    : undefined;
  if (cache?.note && !quiet) process.stderr.write(`tzap: ${cache.note}\n`);

  const result = await analyse(model, {
    engine,
    mutators,
    filters,
    reduce: inv.reduce,
    verifySurvivors: verifyMode === 'all' ? true : verifyMode === 'off' ? false : 'auto',
    ...(checker && tcMode ? { typecheck: { mode: tcMode, check: (m, root) => checker!.check(m, root) } } : {}),
    lines: changed?.files,
    runners: { vitest: createVitestSession, jest: createJestSession, node: createNodeTestSession, mocha: createMochaSession },
    workers,
    ...(values['keep-pool'] ? { preferThreads: false } : {}),
    concurrency,
    tzapVersion: VERSION,
    previousKillers: cache?.killers,
    reuse: cache ? (m, c) => cache.reuse(m, c) : undefined,
    unchanged: cache?.lookupUnchanged,
    onEvent: progress(quiet),
  });
  await checker?.close();
  if (cache) saveCache(cache, result);

  // GitHub places annotations, and code scanning results, by repository-relative path.
  const prefix = reporters.some((r) => r === 'github' || r === 'sarif') ? await repositoryPrefix(model.root) : undefined;
  const stdout = writeReports(result, reporters, { outDir, color: process.stdout.isTTY === true, threshold, ...(prefix ? { repositoryPrefix: prefix } : {}) });
  if (stdout) process.stdout.write(stdout.endsWith('\n') ? stdout : `${stdout}\n`);

  const s = score(result.mutants);
  if (s.runtimeError > 0) return 3;
  if (threshold !== undefined && !meetsThreshold(s.mutationScore, threshold)) return 1;
  if (values['fail-on-survivors'] && s.survived > 0) return 1;
  return 0;
}

async function listMutants(values: Record<string, unknown>, cwd: string): Promise<number> {
  const format = (values.format as string | undefined) ?? 'json';
  if (format !== 'json' && format !== 'table') throw new UsageError(`--format: expected json or table, got "${format}"`);
  checkInventoryOptions(values);
  const { model } = await loadModel(values.model as string | undefined, cwd, list(values.filter as string | undefined));
  const changed = await resolveScope(model, values, cwd);
  // The inventory `run` would analyse: the same mutators, filters and reductions.
  const inv = await inventorySettings(model, values, cwd, true);
  await inv.checker?.close();
  const all = [];
  for (const pkg of model.packages) {
    for (const abs of sourceFiles(model.root, pkg)) {
      const rel = relativeTo(model.root, abs);
      const lines = changed ? changed.files.get(rel) : undefined;
      if (changed && !lines) continue;
      const out = instrument({ file: rel, source: readFileSync(abs, 'utf8'), mutators: inv.mutators, lines, filters: inv.filters, reduce: inv.reduce, firstMutant: 0, firstSite: 0 });
      all.push(...out.mutants.map(({ num: _n, site: _s, ...m }) => m));
    }
  }
  if (format === 'table') {
    for (const m of all) process.stdout.write(`${m.file}:${m.location.start.line}:${m.location.start.column}\t${m.mutatorName}\t${m.replacement}${m.ignoredBy ? `\t(ignored: ${m.ignoredBy})` : ''}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(all, null, 2)}\n`);
  }
  return 0;
}

export async function main(argv: string[], cwd = process.cwd()): Promise<number> {
  try {
    const [command, ...rest] = argv;
    if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
      process.stdout.write(`${HELP}\n`);
      return command === undefined ? 2 : 0;
    }
    if (command === '--version' || command === '-v') {
      process.stdout.write(`${VERSION}\n`);
      return 0;
    }
    const { values } = parseArgs({ args: rest, options: RUN_OPTIONS, allowPositionals: false, strict: true });
    if (values.help) {
      process.stdout.write(`${HELP}\n`);
      return 0;
    }
    if (values.version) {
      process.stdout.write(`${VERSION}\n`);
      return 0;
    }
    const allowed = COMMAND_OPTIONS[command];
    if (!allowed) throw new UsageError(`unknown command "${command}"; expected run, model, list-mutants or mutators`);
    const stray = Object.keys(values).filter((o) => !allowed.includes(o) && o !== 'help' && o !== 'version' && o !== 'quiet');
    if (stray.length) throw new UsageError(`${command} does not take ${stray.map((o) => `--${o}`).join(', ')}`);
    switch (command) {
      case 'run':
        return await run(values, cwd);
      case 'model': {
        const { model, notes } = await loadModel(undefined, cwd, list(values.filter));
        for (const n of notes) process.stderr.write(`tzap: ${n}\n`);
        // Written inside the project, the root is relative to the file, so the file works in any
        // clone; written elsewhere, it stays absolute.
        const out = values['out-dir'] ? path.resolve(cwd, values['out-dir']) : undefined;
        const from = out ? path.dirname(out) : path.resolve(cwd);
        const rel = path.relative(model.root, from);
        const inside = !rel.startsWith('..') && !path.isAbsolute(rel);
        const root = inside ? path.relative(from, model.root).replace(/\\/g, '/') || '.' : model.root;
        const text = serialiseModel({ ...model, root });
        if (out) writeFileSync(out, text);
        else process.stdout.write(text);
        return 0;
      }
      case 'list-mutants':
        return await listMutants(values, cwd);
      case 'mutators':
        for (const m of ALL_MUTATORS) process.stdout.write(`${m.name}\n`);
        for (const m of EXTRA_MUTATORS) process.stdout.write(`${m.name}  (opt-in: --mutators ${m.name}, or --extreme)\n`);
        return 0;
      default:
        throw new UsageError(`unknown command "${command}"; expected run, model, list-mutants or mutators`);
    }
  } catch (e) {
    if (e instanceof UsageError || e instanceof ModelValidationError || (e as { code?: string }).code?.startsWith?.('ERR_PARSE_ARGS')) {
      process.stderr.write(`tzap: ${(e as Error).message}\n`);
      return 2;
    }
    if (e instanceof DiscoveryError || (e as Error).name === 'GitScopeError') {
      process.stderr.write(`tzap: ${(e as Error).message}\n`);
      return 2;
    }
    process.stderr.write(`tzap: the analysis failed: ${(e as Error).stack ?? String(e)}\n`);
    return 3;
  }
}
