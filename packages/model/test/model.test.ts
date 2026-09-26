import { describe, expect, it } from 'vitest';
import {
  compareMutants,
  languageOf,
  MODEL_SCHEMA_VERSION,
  ModelValidationError,
  parseModel,
  score,
  serialiseModel,
  validateModel,
  type MutantDescriptor,
  type MutantStatus,
  type ProjectModel,
} from '../src/index.js';

const valid: ProjectModel = {
  schemaVersion: MODEL_SCHEMA_VERSION,
  root: '.',
  packages: [{ id: 'app', root: 'packages/app', sources: ['src/**/*.ts'], runner: { kind: 'vitest' } }],
};

/** The problems a model is rejected with, or [] when it is accepted. */
const problems = (value: unknown): string[] => {
  try {
    validateModel(value);
    return [];
  } catch (e) {
    expect(e).toBeInstanceOf(ModelValidationError);
    return (e as ModelValidationError).problems;
  }
};
const withPackage = (p: Record<string, unknown>) => ({ ...valid, packages: [{ ...valid.packages[0], ...p }] });

describe('validateModel', () => {
  it('accepts a complete model and returns it unchanged', () => {
    const full = {
      ...valid,
      packages: [
        {
          id: 'app',
          root: 'packages/app',
          sources: ['src/**/*.ts'],
          exclude: ['src/generated/**'],
          tests: ['test/**/*.test.ts'],
          tsconfig: 'tsconfig.json',
          runner: { kind: 'jest', config: 'jest.config.cjs', version: '30.5.2' },
          env: { TZ: 'UTC' },
        },
      ],
      scope: { kind: 'diff', from: 'main', to: '-Local-', granularity: 'function' },
      cache: { dir: '.tzap/cache' },
      reporters: ['console', 'json'],
    };
    const { model, warnings } = validateModel(full);
    expect(model).toBe(full);
    expect(warnings).toEqual([]);
  });

  it('warns about unknown fields at every level and ignores them, for forward compatibility', () => {
    const { warnings } = validateModel({
      ...valid,
      future: 1,
      packages: [{ ...valid.packages[0], later: true, runner: { kind: 'vitest', pool: 'threads' } }],
      scope: { kind: 'full', depth: 2 },
      cache: { dir: 'c', ttl: 3 },
    });
    expect(warnings).toEqual([
      'model.future: unknown field, ignored',
      'packages[0].later: unknown field, ignored',
      'packages[0].runner.pool: unknown field, ignored',
      'scope.depth: unknown field, ignored',
      'cache.ttl: unknown field, ignored',
    ]);
  });

  it('rejects anything but an object, before looking further', () => {
    expect(problems([])).toEqual(['model: expected a JSON object, got []']);
    expect(problems(null)).toEqual(['model: expected a JSON object, got null']);
    expect(problems(undefined)).toEqual(['model: expected a JSON object, got nothing']);
  });

  it('refuses a model of another major version, saying which way to go', () => {
    expect(problems({ ...valid, schemaVersion: MODEL_SCHEMA_VERSION + 1 })[0]).toMatch(/Upgrade tzap/);
    expect(problems({ ...valid, schemaVersion: MODEL_SCHEMA_VERSION - 1 })[0]).toMatch(/Regenerate the model/);
    // A newer minor of the same major is read.
    expect(problems({ ...valid, schemaVersion: MODEL_SCHEMA_VERSION + 0.5 })).toEqual([]);
  });

  it('collects every problem in one error, each naming the field, the shape and the value', () => {
    expect(problems({ root: '', packages: [] })).toEqual([
      `schemaVersion: expected ${MODEL_SCHEMA_VERSION}, got nothing`,
      'model.root: expected a non-empty string, got ""',
      'packages: expected a non-empty array of packages, got []',
    ]);
  });

  it('checks each package and its runner', () => {
    expect(problems({ ...valid, packages: ['app'] })).toEqual(['packages[0]: expected an object, got "app"']);
    expect(problems(withPackage({ sources: 'src' }))).toEqual(['packages[0].sources: expected an array of strings, got "src"']);
    expect(problems(withPackage({ exclude: [1] }))).toEqual(['packages[0].exclude: expected an array of strings, got [1]']);
    expect(problems(withPackage({ runner: 'vitest' }))).toEqual(['packages[0].runner: expected an object, got "vitest"']);
    expect(problems(withPackage({ runner: { kind: 'ava' } }))).toEqual([
      'packages[0].runner.kind: expected one of vitest, jest, node, mocha, got "ava"',
    ]);
    expect(problems(withPackage({ runner: { kind: 'jest', config: 3 } }))).toEqual(['packages[0].runner.config: expected a non-empty string, got 3']);
    expect(problems(withPackage({ env: { N: 1 } }))).toEqual(['packages[0].env: expected an object of string values, got {"N":1}']);
    expect(problems(withPackage({ env: ['A=1'] }))).toEqual(['packages[0].env: expected an object of string values, got ["A=1"]']);
    // A runner is optional: a package with no test runner is mutated and covered by others.
    expect(problems(withPackage({ runner: undefined }))).toEqual([]);
  });

  it('rejects duplicate package ids', () => {
    const p = valid.packages[0]!;
    expect(problems({ ...valid, packages: [p, { ...p, root: 'other' }] })).toEqual(['packages[1].id: duplicate package id "app"']);
  });

  it('checks the scope, the cache and the reporters', () => {
    expect(problems({ ...valid, scope: 'diff' })).toEqual(['scope: expected an object, got "diff"']);
    expect(problems({ ...valid, scope: { kind: 'partial' } })).toEqual(['scope.kind: expected "full" or "diff", got "partial"']);
    expect(problems({ ...valid, scope: { kind: 'diff', from: '' } })).toEqual(['scope.from: expected a non-empty string, got ""']);
    expect(problems({ ...valid, scope: { kind: 'diff', granularity: 'hunk' } })).toEqual([
      'scope.granularity: expected one of line, function, file, got "hunk"',
    ]);
    expect(problems({ ...valid, cache: true })).toEqual(['cache: expected an object, got true']);
    expect(problems({ ...valid, cache: {} })).toEqual(['cache.dir: expected a non-empty string, got nothing']);
    expect(problems({ ...valid, reporters: 'json' })).toEqual(['model.reporters: expected an array of strings, got "json"']);
  });

  it('shortens long values in messages', () => {
    const [p] = problems({ ...valid, reporters: 'x'.repeat(100) });
    expect(p).toBe(`model.reporters: expected an array of strings, got "${'x'.repeat(56)}...`);
  });
});

describe('parseModel and serialiseModel', () => {
  it('round-trips byte for byte', () => {
    const text = serialiseModel(valid);
    expect(text.endsWith('}\n')).toBe(true);
    expect(serialiseModel(parseModel(text).model)).toBe(text);
  });

  it('reports a JSON syntax error as a validation problem', () => {
    expect(() => parseModel('{ "root": ')).toThrow(ModelValidationError);
    expect(() => parseModel('{ "root": ')).toThrow(/model: not valid JSON/);
  });
});

describe('score', () => {
  const of = (counts: Partial<Record<MutantStatus, number>>) =>
    score(Object.entries(counts).flatMap(([status, n]) => Array.from({ length: n }, () => ({ status: status as MutantStatus }))));

  it('uses the mutation-testing-elements definitions', () => {
    const s = of({ Killed: 6, Timeout: 2, Survived: 2, NoCoverage: 10, CompileError: 3, RuntimeError: 1, Ignored: 4, Pending: 1 });
    expect(s).toMatchObject({ total: 29, detected: 8, undetected: 12, covered: 10, valid: 20, invalid: 4, ignored: 4, pending: 1 });
    // Timeout is detected; CompileError, RuntimeError and Ignored are in neither denominator.
    expect(s.mutationScore).toBe(40);
    expect(s.mutationScoreBasedOnCoveredCode).toBe(80);
  });

  it('is NaN, not 0 or 100, when nothing could be detected', () => {
    const s = of({ CompileError: 2, Ignored: 1 });
    expect(s.mutationScore).toBeNaN();
    expect(s.mutationScoreBasedOnCoveredCode).toBeNaN();
    expect(of({ NoCoverage: 3 }).mutationScoreBasedOnCoveredCode).toBeNaN();
  });
});

describe('compareMutants', () => {
  const m = (line: number, column: number, extra: Partial<MutantDescriptor> = {}): MutantDescriptor => ({
    id: 'a',
    num: 0,
    file: 'src/a.ts',
    mutatorName: 'EqualityOperator',
    location: { start: { line, column }, end: { line, column: column + 1 } },
    replacement: '<',
    original: '<=',
    site: 0,
    ...extra,
  });

  it('orders by file, position, mutator, replacement, then id: a total order', () => {
    const sorted = [
      m(1, 1, { file: 'src/b.ts' }),
      m(2, 1),
      m(1, 5),
      m(1, 1, { location: { start: { line: 1, column: 1 }, end: { line: 1, column: 9 } } }),
      m(1, 1, { mutatorName: 'ConditionalExpression' }),
      m(1, 1, { replacement: '>' }),
      m(1, 1, { id: 'b' }),
      m(1, 1),
    ].sort(compareMutants);
    expect(sorted.map((x) => `${x.file}:${x.location.start.line}:${x.location.start.column}-${x.location.end.column} ${x.mutatorName} ${x.replacement} ${x.id}`)).toEqual([
      'src/a.ts:1:1-2 ConditionalExpression < a',
      'src/a.ts:1:1-2 EqualityOperator < a',
      'src/a.ts:1:1-2 EqualityOperator < b',
      'src/a.ts:1:1-2 EqualityOperator > a',
      'src/a.ts:1:1-9 EqualityOperator < a',
      'src/a.ts:1:5-6 EqualityOperator < a',
      'src/a.ts:2:1-2 EqualityOperator < a',
      'src/b.ts:1:1-2 EqualityOperator < a',
    ]);
    expect(compareMutants(m(1, 1), m(1, 1))).toBe(0);
  });
});

describe('languageOf', () => {
  it('names the mutation-testing-elements language of a file', () => {
    expect(['a.ts', 'a.MTS', 'a.cts', 'a.tsx', 'a.jsx', 'a.vue', 'a.svelte', 'a.js', 'a.mjs', 'Makefile'].map(languageOf)).toEqual([
      'typescript',
      'typescript',
      'typescript',
      'tsx',
      'jsx',
      'vue',
      'svelte',
      'javascript',
      'javascript',
      'javascript',
    ]);
  });
});
