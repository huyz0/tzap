/**
 * The command line: the composition root, and the only package that knows every other one.
 *
 *   tzap run           [-m model.json] [--from REF --to REF | --patch FILE] [--scope line|function|file]
 *                      [-r console,html,...] [-o DIR] [--threshold PCT] [--fail-on-survivors]
 *                      [--engine warm|reference] [--mutators A,B] [--workers N] [--cache-dir DIR] [--dry-run]
 *   tzap model         [-o model.json] [--filter PKG]
 *   tzap list-mutants  [-m model.json] [--format json|table]
 *   tzap mutators
 *
 * Exit codes: 0 met the bar, 1 did not (threshold or survivors), 2 usage error, 3 analysis failed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { analyse, type EngineEvent } from '@tzap/core';
import { discover } from '@tzap/discover';
import { gitChangedLines, parseUnifiedDiff, type ChangedLines } from '@tzap/git';
import { ALL_MUTATORS, aridFilters, instrument } from '@tzap/instrument';
import { ModelValidationError, parseModel, score, serialiseModel, type ProjectModel, type ScopeSpec } from '@tzap/model';
import { reporters as reporterRegistry, writeReports } from '@tzap/report';

const reporterNames = Object.keys(reporterRegistry);
import { createVitestSession } from '@tzap/runner-vitest';
import { loadCache, saveCache } from '@tzap/core';

import { sourceFiles, relativeTo } from '@tzap/core';

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
  'dry-run': { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  filter: { type: 'string' },
  format: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

const HELP = `tzap ${VERSION} — fast, diff-aware mutation testing for TypeScript and JavaScript

Usage:
  tzap run [options]            analyse, and report surviving mutants
  tzap model [-o model.json]    print the discovered project model
  tzap list-mutants [options]   the inventory, without running a test
  tzap mutators                 the available mutators

Run options:
  -m, --model FILE              project model (default: discovered from the current directory)
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
      --cache-dir DIR           reuse verdicts that are provably still valid
      --no-arid                 also mutate logging and similar code (arid rules are on by default)
      --dry-run                 print what would be analysed, and stop
  -q, --quiet                   no progress output

Exit codes: 0 met the bar, 1 did not, 2 usage error, 3 the analysis failed.`;

function list(v: string | undefined): string[] | undefined {
  return v === undefined ? undefined : v.split(',').map((s) => s.trim()).filter(Boolean);
}

function num(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`--${name}: expected a number, got "${v}"`);
  return n;
}

async function loadModel(file: string | undefined, cwd: string, filter?: string[]): Promise<{ model: ProjectModel; notes: string[] }> {
  if (file) {
    const text = readFileSync(path.resolve(cwd, file), 'utf8');
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

async function resolveScope(model: ProjectModel, values: Record<string, unknown>, cwd: string): Promise<ChangedLines | undefined> {
  const from = values.from as string | undefined;
  const to = values.to as string | undefined;
  const patch = values.patch as string | undefined;
  const scope: ScopeSpec | undefined = patch || from || to ? { kind: 'diff', from, to, patch } : model.scope;
  if (!scope || scope.kind === 'full') return undefined;
  if (scope.patch) return parseUnifiedDiff(readFileSync(path.resolve(cwd, scope.patch), 'utf8'), { root: model.root, stripPrefix: 1 });
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
      case 'coverage':
        line = `tzap: coverage from ${e.tests} tests${e.red ? `, ${e.red} failing without any mutant (excluded)` : ''}`;
        break;
      case 'round':
        line = `tzap: round ${e.round}: ${e.tries} tries in ${e.ms} ms`;
        break;
      case 'warning':
        line = `tzap: warning: ${e.message}`;
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
  const { model, notes } = await loadModel(values.model as string | undefined, cwd, list(values.filter as string | undefined));
  if (!quiet) for (const n of notes) process.stderr.write(`tzap: ${n}\n`);
  const changed = await resolveScope(model, values, cwd);
  if (changed && !quiet) {
    process.stderr.write(`tzap: scope: ${changed.description}\n`);
    process.stderr.write('tzap: the range only selects what to analyse; the analysis runs against the working tree\n');
  }
  const mutators = list(values.mutators as string | undefined);
  if (mutators) {
    const known = new Set(ALL_MUTATORS.map((m) => m.name));
    const unknown = mutators.filter((m) => !known.has(m));
    if (unknown.length) throw new UsageError(`--mutators: unknown ${unknown.join(', ')}; known: ${[...known].join(', ')}`);
  }
  const engine = (values.engine as string | undefined) ?? 'warm';
  if (engine !== 'warm' && engine !== 'reference') throw new UsageError(`--engine: expected warm or reference, got "${engine}"`);
  const reporters = list(values.reporters as string | undefined) ?? model.reporters ?? ['console'];
  const unknownReporters = reporters.filter((r) => !reporterNames.includes(r));
  if (unknownReporters.length) throw new UsageError(`--reporters: unknown ${unknownReporters.join(', ')}; known: ${reporterNames.join(', ')}`);
  const outDir = path.resolve(cwd, (values['out-dir'] as string | undefined) ?? 'reports/tzap');
  const threshold = num(values.threshold as string | undefined, 'threshold');
  const workers = num(values.workers as string | undefined, 'workers');
  const concurrency = num(values.concurrency as string | undefined, 'concurrency');

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

  const cacheDir = (values['cache-dir'] as string | undefined) ?? model.cache?.dir;
  const filters = values['no-arid'] ? [] : aridFilters();
  const cache = cacheDir ? loadCache(path.resolve(cwd, cacheDir), model, { tzapVersion: VERSION, mutators, filters: filters.map((f) => f.name) }) : undefined;
  if (cache?.note && !quiet) process.stderr.write(`tzap: ${cache.note}\n`);

  const result = await analyse(model, {
    engine,
    mutators,
    filters,
    lines: changed?.files,
    runners: { vitest: createVitestSession },
    workers,
    concurrency,
    tzapVersion: VERSION,
    previousKillers: cache?.killers,
    reuse: cache ? (m, c) => cache.reuse(m, c) : undefined,
    unchanged: cache?.lookupUnchanged,
    onEvent: progress(quiet),
  });
  if (cache) saveCache(cache, result);

  mkdirSync(outDir, { recursive: true });
  const stdout = writeReports(result, reporters, { outDir, color: process.stdout.isTTY === true, threshold });
  if (stdout) process.stdout.write(stdout.endsWith('\n') ? stdout : `${stdout}\n`);

  const s = score(result.mutants);
  if (s.runtimeError > 0) return 3;
  if (threshold !== undefined && !(s.mutationScore >= threshold)) return 1;
  if (values['fail-on-survivors'] && s.survived > 0) return 1;
  return 0;
}

async function listMutants(values: Record<string, unknown>, cwd: string): Promise<number> {
  const { model } = await loadModel(values.model as string | undefined, cwd);
  const changed = await resolveScope(model, values, cwd);
  const mutators = list(values.mutators as string | undefined);
  const all = [];
  for (const pkg of model.packages) {
    for (const abs of sourceFiles(model.root, pkg)) {
      const rel = relativeTo(model.root, abs);
      const lines = changed ? changed.files.get(rel) : undefined;
      if (changed && !lines) continue;
      const out = instrument({ file: rel, source: readFileSync(abs, 'utf8'), mutators, lines, filters: values['no-arid'] ? [] : aridFilters(), firstMutant: 0, firstSite: 0 });
      all.push(...out.mutants.map(({ num: _n, site: _s, ...m }) => m));
    }
  }
  if (values.format === 'table') {
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
    switch (command) {
      case 'run':
        return await run(values, cwd);
      case 'model': {
        const { model, notes } = await loadModel(undefined, cwd, list(values.filter));
        for (const n of notes) process.stderr.write(`tzap: ${n}\n`);
        const text = serialiseModel(model);
        if (values['out-dir']) writeFileSync(path.resolve(cwd, values['out-dir']), text);
        else process.stdout.write(text);
        return 0;
      }
      case 'list-mutants':
        return await listMutants(values, cwd);
      case 'mutators':
        for (const m of ALL_MUTATORS) process.stdout.write(`${m.name}\n`);
        return 0;
      default:
        throw new UsageError(`unknown command "${command}"; expected run, model, list-mutants or mutators`);
    }
  } catch (e) {
    if (e instanceof UsageError || e instanceof ModelValidationError || (e as { code?: string }).code?.startsWith?.('ERR_PARSE_ARGS')) {
      process.stderr.write(`tzap: ${(e as Error).message}\n`);
      return 2;
    }
    if ((e as Error).name === 'GitScopeError') {
      process.stderr.write(`tzap: ${(e as Error).message}\n`);
      return 2;
    }
    process.stderr.write(`tzap: the analysis failed: ${(e as Error).stack ?? String(e)}\n`);
    return 3;
  }
}
