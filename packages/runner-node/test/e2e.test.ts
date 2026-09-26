import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyse, type EngineKind } from '@tzap/core';
import type { AnalysisResult, ProjectModel } from '@tzap/model';
import { createNodeTestSession } from '../dist/index.js';

const sample = path.resolve(import.meta.dirname, '../../../fixtures/sample-node');

const model: ProjectModel = {
  schemaVersion: 1,
  root: sample,
  packages: [{ id: 'fixture-sample-node', root: '.', sources: ['src/**/*.ts'], runner: { kind: 'node' } }],
};

const run = (engine: EngineKind): Promise<AnalysisResult> =>
  analyse(model, { engine, runners: { node: createNodeTestSession }, tzapVersion: '0.0.0-test', concurrency: 2 });

const key = (m: AnalysisResult['mutants'][number]) => `${m.file}:${m.location.start.line}:${m.location.start.column} ${m.mutatorName} ${m.replacement}`;

describe('analyse() on fixtures/sample-node', () => {
  it('gives the same verdicts warm and in reference mode, and the hand-derived survivors', async () => {
    const t0 = performance.now();
    const warm = await run('warm');
    const t1 = performance.now();
    const reference = await run('reference');
    const t2 = performance.now();
    console.log(`warm ${Math.round(t1 - t0)} ms, reference ${Math.round(t2 - t1)} ms, ${warm.mutants.length} mutants; warm timings ${JSON.stringify(warm.timings)}`);

    expect(warm.redTests).toEqual([]);
    expect(warm.tests.map((t) => t.id)).toEqual([
      'fixture-sample-node::test/discount.test.ts::discountedPrice > applies a small discount',
      'fixture-sample-node::test/discount.test.ts::discountedPrice > caps large discounts at half price',
      'fixture-sample-node::test/discount.test.ts::discountedPrice > rejects negative percentages',
      'fixture-sample-node::test/discount.test.ts::isFree > is free at zero',
      'fixture-sample-node::test/strings.test.ts::joins non-blank names',
    ]);

    const verdicts = (r: AnalysisResult) => Object.fromEntries(r.mutants.map((m) => [key(m), m.status]));
    expect(verdicts(warm)).toEqual(verdicts(reference));

    const survivors = warm.mutants
      .filter((m) => m.status === 'Survived')
      .map((m) => `${m.file}:${m.location.start.line} ${m.mutatorName} ${m.replacement}`)
      .sort();
    expect(survivors).toEqual(
      [
        'src/discount.ts:2 EqualityOperator percent <= 0',
        'src/discount.ts:2 ConditionalExpression false',
        'src/discount.ts:2 EqualityOperator percent >= 100',
        "src/discount.ts:3 StringLiteral \"\"",
        'src/discount.ts:5 EqualityOperator percent >= 50',
        'src/discount.ts:12 ConditionalExpression true',
      ].sort(),
    );
    // `percent > 100 -> false`, not `percent < 0 -> false`: three ConditionalExpression false on line 2
    const falses = warm.mutants.filter((m) => m.location.start.line === 2 && m.replacement === 'false');
    expect(falses.map((m) => [m.original, m.status]).sort()).toEqual([
      ['percent < 0 || percent > 100', 'Killed'],
      ['percent < 0', 'Killed'],
      ['percent > 100', 'Survived'],
    ]);

    // shout() is never called by a test
    const shout = warm.mutants.filter((m) => m.file === 'src/strings.ts' && m.location.start.line >= 7);
    expect(shout.length).toBeGreaterThan(0);
    for (const m of shout) expect(m.status).toBe('NoCoverage');

    // SEPARATOR is reached only while the module evaluates: a static mutant, killed in isolation
    const sep = warm.mutants.find((m) => m.file === 'src/strings.ts' && m.location.start.line === 1)!;
    expect(sep).toMatchObject({ status: 'Killed', static: true });

    const counts = (r: AnalysisResult) => r.mutants.reduce<Record<string, number>>((c, m) => ((c[m.status] = (c[m.status] ?? 0) + 1), c), {});
    expect(counts(warm)).toEqual(counts(reference));
  });
});
