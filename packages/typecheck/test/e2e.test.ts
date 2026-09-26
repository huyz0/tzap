/**
 * End to end on fixtures/typed-vitest: `analyse()` with the checker in `survivors` and `all`
 * modes against the same run without it.
 */
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyse } from '@tzap/core';
import type { AnalysisResult, MutantResult, ProjectModel } from '@tzap/model';
import { createVitestSession } from '@tzap/runner-vitest';
import { createTypeChecker, type TypeChecker } from '../src/index.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const root = path.join(repo, 'fixtures', 'typed-vitest');

const model: ProjectModel = {
  schemaVersion: 1,
  root,
  packages: [{ id: 'fixture', root: '.', sources: ['src/**/*.ts'], runner: { kind: 'vitest' } }],
};

const key = (m: MutantResult) =>
  `${m.file}:${m.location.start.line}:${m.location.start.column}-${m.location.end.line}:${m.location.end.column} ${m.mutatorName} ${m.replacement}`;
const byKey = (r: AnalysisResult) => new Map(r.mutants.map((m) => [key(m), m]));

describe('analyse() with the type checker', () => {
  let checker: TypeChecker;
  let off: AnalysisResult;
  let survivors: AnalysisResult;
  let all: AnalysisResult;
  /** Keys of the mutants the checker rejects, checked directly. */
  let invalid: Set<string>;

  beforeAll(async () => {
    checker = createTypeChecker({ root });
    const run = (typecheck?: 'survivors' | 'all') =>
      analyse(model, {
        runners: { vitest: createVitestSession },
        tzapVersion: 'test',
        ...(typecheck ? { typecheck: { mode: typecheck, check: (m, r) => checker.check(m, r) } } : {}),
      });
    off = await run();
    survivors = await run('survivors');
    all = await run('all');
    const placed = off.mutants.filter((m) => m.status !== 'Ignored');
    const rejected = await checker.check(placed, root);
    invalid = new Set(placed.filter((m) => rejected.has(m.num)).map(key));
  });
  afterAll(() => checker.close());

  it('reports no CompileError without the checker', () => {
    expect(off.config.typecheck).toBe('off');
    expect(off.mutants.filter((m) => m.status === 'CompileError')).toEqual([]);
    expect(invalid.size).toBeGreaterThan(20);
  });

  it('survivors: only undetected type-invalid mutants become CompileError; every other verdict is unchanged', () => {
    expect(survivors.config.typecheck).toBe('survivors');
    const before = byKey(off);
    let compileErrors = 0;
    for (const m of survivors.mutants) {
      const was = before.get(key(m))!;
      const undetected = was.status === 'Survived' || was.status === 'NoCoverage';
      if (undetected && invalid.has(key(m))) {
        expect(m.status, key(m)).toBe('CompileError');
        expect(m.statusReason).toMatch(/error TS\d+:/);
        compileErrors++;
      } else {
        expect(m.status, key(m)).toBe(was.status);
      }
    }
    expect(compileErrors).toBeGreaterThan(0);
  });

  it('all: every type-invalid mutant is CompileError and never runs; type-valid verdicts are unchanged', () => {
    expect(all.config.typecheck).toBe('all');
    const before = byKey(off);
    for (const m of all.mutants) {
      const was = before.get(key(m))!;
      if (invalid.has(key(m))) {
        expect(m.status, key(m)).toBe('CompileError');
        expect(m.killedBy ?? []).toEqual([]);
      } else {
        expect(m.status, key(m)).toBe(was.status);
      }
    }
  });

  it('survivors leaves type-invalid mutants the tests killed counted as detected (the score bias)', () => {
    const killedInvalid = survivors.mutants.filter((m) => invalid.has(key(m)) && m.status === 'Killed');
    const allCompile = all.mutants.filter((m) => m.status === 'CompileError');
    const survCompile = survivors.mutants.filter((m) => m.status === 'CompileError');
    expect(killedInvalid.length).toBeGreaterThan(0);
    expect(survCompile.length + killedInvalid.length + survivors.mutants.filter((m) => invalid.has(key(m)) && m.status === 'Timeout').length).toBe(allCompile.length);
  });
});
