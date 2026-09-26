/**
 * End to end, on the Vitest fixtures: the standing gates every speed feature must pass.
 * - the warm engine agrees with the reference engine on every mutant;
 * - hand-derived verdicts hold;
 * - reports are byte-identical across worker counts (outside timings);
 * - a warm cache changes nothing but the time taken;
 * - a diff scope selects exactly the changed lines.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyse, loadCache, saveCache } from '@tzap/core';
import { aridFilters } from '@tzap/instrument';
import type { AnalysisResult, MutantResult, ProjectModel } from '@tzap/model';
import { jsonReport } from '@tzap/report';
import { createVitestSession } from '@tzap/runner-vitest';
import { main } from '../src/cli.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const fixture = (name: string) => path.join(repo, 'fixtures', name);
const scratch = path.join(repo, '.tzap-test-tmp');

const model = (root: string, sources = ['src/**/*.ts']): ProjectModel => ({
  schemaVersion: 1,
  root,
  packages: [{ id: 'fixture', root: '.', sources, runner: { kind: 'vitest' } }],
});

const run = (m: ProjectModel, extra: Partial<Parameters<typeof analyse>[1]> = {}) =>
  analyse(m, { runners: { vitest: createVitestSession }, tzapVersion: 'test', ...extra });

const key = (m: MutantResult) => `${m.file}:${m.location.start.line}:${m.location.start.column} ${m.mutatorName} ${m.replacement}`;
const verdicts = (r: AnalysisResult) => Object.fromEntries(r.mutants.map((m) => [key(m), m.status]));
const withoutTimings = (r: AnalysisResult) => jsonReport(r).replace(/"(duration|timings)":\s*(\{[^}]*\}|[\d.]+),?/g, '');

beforeAll(() => mkdirSync(scratch, { recursive: true }));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('sample-vitest', () => {
  let warm: AnalysisResult;
  beforeAll(async () => {
    warm = await run(model(fixture('sample-vitest')));
  });

  it('finds exactly the hand-derived gaps', () => {
    const survived = warm.mutants.filter((m) => m.status === 'Survived').map((m) => `${m.file.split('/').pop()}:${m.location.start.line} ${m.mutatorName} ${m.replacement}`);
    expect(survived.sort()).toEqual(
      [
        'discount.ts:2 EqualityOperator percent <= 0',
        'discount.ts:2 ConditionalExpression false',
        'discount.ts:2 EqualityOperator percent >= 100',
        'discount.ts:3 StringLiteral ""',
        'discount.ts:5 EqualityOperator percent >= 50',
        'discount.ts:12 ConditionalExpression true',
      ].sort(),
    );
    const uncovered = warm.mutants.filter((m) => m.status === 'NoCoverage').map((m) => m.location.start.line);
    expect(uncovered).toEqual([7, 8, 8]);
    expect(warm.mutants.filter((m) => m.status === 'Killed')).toHaveLength(28);
  });

  it('agrees with the reference engine on every mutant', async () => {
    const reference = await run(model(fixture('sample-vitest')), { engine: 'reference', concurrency: 4 });
    expect(verdicts(reference)).toEqual(verdicts(warm));
  });

  it('writes byte-identical reports whatever the worker count', async () => {
    const one = await run(model(fixture('sample-vitest')), { workers: 1 });
    const four = await run(model(fixture('sample-vitest')), { workers: 4 });
    expect(withoutTimings(four)).toBe(withoutTimings(one));
    expect(withoutTimings(one)).toBe(withoutTimings(warm));
  });

  it('drops logging mutants with the arid rules and keeps everything else', async () => {
    const arid = await run(model(fixture('sample-vitest')), { filters: aridFilters() });
    // The fixture has no logging: the rules must not touch it.
    expect(verdicts(arid)).toEqual(verdicts(warm));
  });
});

describe('hazards-vitest', () => {
  it('agrees with the reference engine despite module state, hangs and order-dependent tests', async () => {
    const m = model(fixture('hazards-vitest'));
    const warm = await run(m);
    const reference = await run(m, { engine: 'reference', concurrency: 6 });
    expect(verdicts(warm)).toEqual(verdicts(reference));
    // The for-loop increment flipped, and the while-loop decrement removed, both never end.
    const timeouts = warm.mutants.filter((x) => x.status === 'Timeout').map((x) => `${x.file.split('/').pop()}:${x.location.start.line} ${x.replacement}`);
    expect(timeouts).toEqual(expect.arrayContaining(['loops.ts:3 i--']));
    // Static: RATE is computed once, as the module loads.
    const rate = warm.mutants.find((x) => x.file.endsWith('constants.ts') && x.location.start.line === 2 && x.mutatorName === 'ArithmeticOperator');
    expect(rate?.status).toBe('Killed');
    expect(rate?.static).toBe(true);
  }, 240_000);
});

describe('frontend components', () => {
  // TSX under jsdom with Testing Library, and single-file components whose <script> blocks are
  // mutated in place while their templates are left alone.
  for (const [name, sources, expected] of [
    ['react-vitest', ['src/**/*.tsx'], { Killed: 14, Survived: 6 }],
    ['vue-vitest', ['src/**/*.vue'], { Killed: 13, Survived: 2 }],
    ['svelte-vitest', ['src/**/*.svelte'], { Killed: 5 }],
  ] as const) {
    it(`${name}: agrees with the reference engine`, async () => {
      const m = model(fixture(name), [...sources]);
      const warm = await run(m);
      const counts = warm.mutants.reduce<Record<string, number>>((c, x) => ((c[x.status] = (c[x.status] ?? 0) + 1), c), {});
      expect(counts).toEqual(expected);
      const reference = await run(m, { engine: 'reference', concurrency: 6 });
      expect(verdicts(reference)).toEqual(verdicts(warm));
    }, 240_000);
  }
});

describe('the cache', () => {
  it('reuses every verdict when nothing changed, without running a test', async () => {
    const dir = path.join(scratch, 'cache-a');
    const root = fixture('sample-vitest');
    const m = model(root);
    const settings = { tzapVersion: 'test', mutators: undefined, filters: [] };
    const c1 = loadCache(dir, m, settings);
    const first = await run(m, { reuse: (d, cov) => c1.reuse(d, cov) });
    saveCache(c1, first);
    const c2 = loadCache(dir, m, settings);
    expect(c2.unchanged).toBe(true);
    const second = await run(m, { unchanged: c2.lookupUnchanged, reuse: (d, cov) => c2.reuse(d, cov) });
    expect(verdicts(second)).toEqual(verdicts(first));
    expect(second.timings.coverage).toBeUndefined();
    expect(second.mutants.filter((x) => x.status !== 'Ignored').every((x) => x.cached)).toBe(true);
  });

  it('re-runs only what an edit can affect', async () => {
    const root = path.join(scratch, 'sample-edit');
    cpSync(fixture('sample-vitest'), root, { recursive: true, filter: (s) => !s.includes('node_modules') });
    const m = model(root);
    const dir = path.join(scratch, 'cache-b');
    const settings = { tzapVersion: 'test', mutators: undefined, filters: [] };
    const c1 = loadCache(dir, m, settings);
    const first = await run(m, { reuse: (d, cov) => c1.reuse(d, cov) });
    saveCache(c1, first);
    // Edit strings.ts: discount.ts's tests cannot reach it, so their verdicts stand.
    const file = path.join(root, 'src/strings.ts');
    writeFileSync(file, readFileSync(file, 'utf8').replace("'!'", "'!!'"));
    const c2 = loadCache(dir, m, settings);
    expect(c2.unchanged).toBe(false);
    const second = await run(m, { reuse: (d, cov) => c2.reuse(d, cov) });
    const cachedFiles = new Set(second.mutants.filter((x) => x.cached).map((x) => x.file.split('/').pop()));
    expect(cachedFiles.has('discount.ts')).toBe(true);
    expect(cachedFiles.has('strings.ts')).toBe(false);
    // And the verdicts are what an uncached run says.
    const fresh = await run(m);
    expect(verdicts(second)).toEqual(verdicts(fresh));
  }, 180_000);
});

describe('diff scoping', () => {
  it('analyses only mutants on the changed lines', async () => {
    const lines = new Map([['fixtures/sample-vitest/src/discount.ts', [[5, 5]] as const]]);
    const m: ProjectModel = { ...model(repo), packages: [{ id: 'fixture', root: 'fixtures/sample-vitest', sources: ['src/**/*.ts'], runner: { kind: 'vitest' } }] };
    const r = await run(m, { lines });
    expect(r.mutants.map((x) => x.location.start.line)).toEqual([5, 5, 5, 5, 5]);
    expect(r.config.scope).toBe('diff');
  });

  it('narrows the coverage phase to tests that can reach the change, without changing a verdict', async () => {
    const m: ProjectModel = { ...model(repo), packages: [{ id: 'fixture', root: 'fixtures/hazards-vitest', sources: ['src/**/*.ts'], runner: { kind: 'vitest' } }] };
    const full = await run(m);
    const lines = new Map([['fixtures/hazards-vitest/src/math.ts', [[1, 11]] as const]]);
    const events: string[] = [];
    const narrowed = await run(m, { lines, onEvent: (e) => e.type === 'narrowed' && events.push(`${e.files}/${e.of}`) });
    // math.ts is imported by two of the six test files.
    expect(events).toEqual(['2/6']);
    const inScope = Object.fromEntries(Object.entries(verdicts(full)).filter(([k]) => k.includes('/math.ts:')));
    expect(verdicts(narrowed)).toEqual(inScope);
  }, 240_000);
});

describe('the command line', () => {
  it('exits 1 below the threshold and 0 above it', async () => {
    const cwd = fixture('sample-vitest');
    const out = path.join(scratch, 'cli');
    expect(await main(['run', '-q', '-r', 'json', '-o', out, '--threshold', '90'], cwd)).toBe(1);
    expect(await main(['run', '-q', '-r', 'json', '-o', out, '--threshold', '50'], cwd)).toBe(0);
    const report = JSON.parse(readFileSync(path.join(out, 'tzap.json'), 'utf8'));
    expect(report.score.mutationScore).toBeCloseTo(75.68, 1);
  });

  it('exits 2 on a usage error', async () => {
    expect(await main(['run', '--engine', 'fast'], fixture('sample-vitest'))).toBe(2);
    expect(await main(['nonsense'], fixture('sample-vitest'))).toBe(2);
  });
});
