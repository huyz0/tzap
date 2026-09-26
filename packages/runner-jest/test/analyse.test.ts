/**
 * End to end: the engine's `analyse()` on fixtures/sample-jest through the Jest adapter. The warm
 * engine must agree with the reference engine (a fresh session per mutant) on every mutant, and
 * the survivors must be the ones derived by hand for the fixture (the same as sample-vitest's).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyse } from '@tzap/core';
import type { AnalysisResult, ProjectModel } from '@tzap/model';
import { describe, expect, it } from 'vitest';
import { createJestSession } from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../fixtures/sample-jest').split(path.sep).join('/');
const model: ProjectModel = {
  schemaVersion: 1,
  root,
  packages: [{ id: 'sample-jest', root: '.', sources: ['src/**/*.ts'], runner: { kind: 'jest' } }],
};

const run = (engine: 'warm' | 'reference') => analyse(model, { engine, runners: { jest: createJestSession }, tzapVersion: '0.0.0-test', concurrency: 4 });
const verdicts = (r: AnalysisResult) => r.mutants.map((m) => `${m.id} ${m.status}`);
const describeMutant = (m: AnalysisResult['mutants'][number]) =>
  `${m.file}:${m.location.start.line} ${m.mutatorName} ${m.replacement}`;

describe('analyse() on sample-jest', () => {
  it('warm and reference agree, and the survivors are the hand-derived ones', async () => {
    const warm = await run('warm');
    const reference = await run('reference');
    expect(verdicts(warm)).toEqual(verdicts(reference));
    expect(warm.redTests).toEqual([]);
    expect(warm.tests).toHaveLength(5);

    const survived = warm.mutants.filter((m) => m.status === 'Survived').map(describeMutant);
    expect(survived).toEqual([
      'src/discount.ts:2 EqualityOperator percent <= 0',
      'src/discount.ts:2 ConditionalExpression false',
      'src/discount.ts:2 EqualityOperator percent >= 100',
      "src/discount.ts:3 StringLiteral \"\"",
      'src/discount.ts:5 EqualityOperator percent >= 50',
      'src/discount.ts:12 ConditionalExpression true',
    ]);
    const uncovered = warm.mutants.filter((m) => m.status === 'NoCoverage');
    expect(uncovered.length).toBeGreaterThan(0);
    // shout() is never called by any test.
    expect(uncovered.every((m) => m.file === 'src/strings.ts' && m.location.start.line >= 7)).toBe(true);
    expect(warm.mutants.filter((m) => m.status === 'Killed')).toHaveLength(28);
    // The top-level SEPARATOR is a static mutant, killed through the isolated path.
    const sep = warm.mutants.find((m) => m.file === 'src/strings.ts' && m.location.start.line === 1)!;
    expect(sep.status).toBe('Killed');
    expect(sep.static).toBe(true);
  }, 120_000);
});
