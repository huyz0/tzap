import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { instrument } from '@tzap/instrument';
import type { MutantDescriptor } from '@tzap/model';
import { createTypeChecker, newDiagnostics } from '../src/index.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const fixture = path.join(repo, 'fixtures', 'typed-vitest');
const scratch = path.join(repo, '.tzap-test-tmp', 'typecheck');

function mutantsOf(root: string, files: readonly string[]): MutantDescriptor[] {
  const out: MutantDescriptor[] = [];
  let firstMutant = 0;
  let firstSite = 0;
  for (const file of files) {
    const r = instrument({ file, source: readFileSync(path.join(root, file), 'utf8'), firstMutant, firstSite });
    firstMutant = r.nextMutant;
    firstSite = r.nextSite;
    out.push(...r.mutants.filter((m) => m.num >= 0));
  }
  return out;
}

const FILES = ['src/users.ts', 'src/config.ts', 'src/math.ts', 'src/blocks.ts', 'src/logic.ts'];
const key = (m: MutantDescriptor) =>
  `${m.file}:${m.location.start.line}:${m.location.start.column}-${m.location.end.line}:${m.location.end.column} ${m.mutatorName} ${m.replacement}`;
const rejectedKeys = (mutants: readonly MutantDescriptor[], r: Map<number, string>) => mutants.filter((m) => r.has(m.num)).map(key).sort();

/** The fixture's own typescript is 6.x (classic API); resolving from the repository root gives 7.x (the Go API). */
const BACKENDS = [
  { name: 'ts6', options: {}, expect: 'ts6' },
  { name: 'ts7', options: { resolveFrom: [repo] }, expect: 'ts7' },
] as const;

describe.each(BACKENDS)('checker on typed-vitest ($name)', ({ options, expect: kind }) => {
  const mutants = mutantsOf(fixture, FILES);
  let single: Map<number, string>;
  let grouped: Map<number, string>;
  let backend: string | undefined;

  beforeAll(async () => {
    const one = createTypeChecker({ root: fixture, grouping: false, ...options });
    single = await one.check(mutants, fixture);
    backend = one.stats.backend;
    await one.close();
    const many = createTypeChecker({ root: fixture, ...options });
    grouped = await many.check(mutants, fixture);
    expect(many.stats.groups).toBeGreaterThan(0);
    await many.close();
  });

  it('uses the expected compiler API', () => {
    expect(backend).toMatch(new RegExp(`^${kind} `));
  });

  const find = (file: string, line: number, mutator: string, replacement?: string) => {
    const m = mutants.find((x) => x.file === file && x.location.start.line === line && x.mutatorName === mutator && (replacement === undefined || x.replacement === replacement));
    if (!m) throw new Error(`no mutant ${file}:${line} ${mutator} ${replacement ?? ''}`);
    return m;
  };

  it('rejects known type-invalid mutants, with the diagnostic', () => {
    const invalid = [
      [find('src/users.ts', 15, 'OptionalChaining'), 'TS18047'],
      [find('src/users.ts', 20, 'OptionalChaining'), 'TS18048'],
      [find('src/users.ts', 35, 'OptionalChaining'), 'TS18048'],
      [find('src/config.ts', 9, 'ObjectLiteral'), 'TS2739'],
      [find('src/config.ts', 21, 'ObjectLiteral'), 'TS2739'],
      [find('src/config.ts', 31, 'ObjectLiteral'), 'TS2339'],
      [find('src/math.ts', 15, 'ArrowFunction'), 'TS2322'],
      [find('src/blocks.ts', 2, 'BlockStatement'), 'TS2355'],
      [find('src/blocks.ts', 18, 'BlockStatement'), 'TS2366'],
      [find('src/blocks.ts', 37, 'BlockStatement'), 'TS2454'],
      [find('src/logic.ts', 3, 'LogicalOperator'), 'TS2322'],
      [find('src/logic.ts', 18, 'LogicalOperator'), 'TS2322'],
    ] as const;
    for (const [m, code] of invalid) expect(single.get(m.num), key(m)).toContain(`error ${code}:`);
    // Reported against the file and position of the error, 1-based.
    expect(single.get(find('src/users.ts', 15, 'OptionalChaining').num)).toMatch(/^src\/users\.ts\(15,10\): error TS18047: 'user\.address' is possibly 'null'\./);
  });

  it('rejects a mutant that only breaks an importing file (the test calling it)', () => {
    expect(single.get(find('src/math.ts', 2, 'ArrowFunction').num)).toMatch(/^test\/math\.test\.ts\(\d+,\d+\): error TS2554/);
  });

  it('accepts type-valid mutants', () => {
    const valid = [
      find('src/users.ts', 25, 'OptionalChaining'),
      find('src/users.ts', 30, 'OptionalChaining'),
      find('src/users.ts', 25, 'LogicalOperator'),
      find('src/config.ts', 15, 'ObjectLiteral'),
      find('src/config.ts', 26, 'ObjectLiteral'),
      find('src/math.ts', 19, 'ArrowFunction'),
      find('src/math.ts', 23, 'ArrowFunction'),
      find('src/math.ts', 26, 'ArrowFunction'),
      find('src/math.ts', 10, 'BlockStatement'),
      find('src/blocks.ts', 3, 'BlockStatement'),
      find('src/blocks.ts', 24, 'BlockStatement'),
      find('src/logic.ts', 8, 'LogicalOperator'),
      find('src/logic.ts', 13, 'LogicalOperator'),
    ];
    for (const m of valid) expect(single.has(m.num), key(m)).toBe(false);
  });

  it('gives the same verdicts grouped as one at a time', () => {
    expect(rejectedKeys(mutants, grouped)).toEqual(rejectedKeys(mutants, single));
  });

  it('finds 49 of the fixture mutants type-invalid', () => {
    expect(single.size).toBe(49);
  });
});

describe('both compiler APIs', () => {
  it('agree on every fixture mutant', async () => {
    const mutants = mutantsOf(fixture, FILES);
    const results = [];
    for (const b of BACKENDS) {
      const c = createTypeChecker({ root: fixture, ...b.options });
      results.push(rejectedKeys(mutants, await c.check(mutants, fixture)));
      await c.close();
    }
    expect(results[1]).toEqual(results[0]);
  });

  it('refuse the classic API on a TypeScript 7 project, and name why', async () => {
    const c = createTypeChecker({ root: fixture, typescript: 6, resolveFrom: [repo] });
    await expect(c.check(mutantsOf(fixture, ['src/logic.ts']), fixture)).rejects.toThrow(/does not ship it/);
    await c.close();
  });
});

describe('baseline noise', () => {
  beforeAll(() => {
    mkdirSync(path.join(scratch, 'src'), { recursive: true });
    writeFileSync(path.join(scratch, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'preserve', types: [] }, include: ['src'] }));
    writeFileSync(
      path.join(scratch, 'src', 'noisy.ts'),
      [
        '// A type error that is already there: it must not reject any mutant.',
        "export const broken: number = 'not a number';",
        '',
        'export function greet(name: string | undefined): string {',
        "  return name ?? 'nobody';",
        '}',
        '',
        "export const alsoBroken: string = 42;",
        '',
      ].join('\n'),
    );
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it.each([
    ['ts7', [repo]],
    ['ts6', [fixture]],
  ])('ignores errors present before mutation (%s)', async (_name, resolveFrom) => {
    const mutants = mutantsOf(scratch, ['src/noisy.ts']);
    const c = createTypeChecker({ root: scratch, resolveFrom });
    const r = await c.check(mutants, scratch);
    await c.close();
    const byKey = Object.fromEntries(mutants.map((m) => [`${m.mutatorName} ${m.replacement}`, r.get(m.num)]));
    expect(byKey["LogicalOperator name && 'nobody'"]).toMatch(/TS2322/);
    // String literal mutants on the broken lines keep the same, pre-existing error: not new.
    expect(byKey['StringLiteral ""']).toBeUndefined();
    expect(byKey['StringLiteral "Stryker was here!"']).toBeUndefined();
    expect([...r.values()].every((d) => !/\((2|8),/.test(d))).toBe(true);
  });
});

describe('newDiagnostics', () => {
  const d = (code: number, start: number, message = 'm') => ({ code, start, end: start + 1, message });
  const edit = (start: number, end: number, replacement: string) => ({ start, end, m: { replacement } });

  it('matches baseline diagnostics shifted by the edit', () => {
    // The edit at [10, 12) grows by 3; a baseline error at 20 is now at 23.
    expect(newDiagnostics([d(1, 5), d(2, 20)], [d(1, 5), d(2, 23)], [edit(10, 12, 'abcde')])).toEqual([]);
  });

  it('reports a diagnostic the original did not have', () => {
    expect(newDiagnostics([d(1, 5)], [d(1, 5), d(3, 11)], [edit(10, 12, 'abcde')])).toEqual([d(3, 11)]);
  });

  it('matches a diagnostic that stays inside the edited region', () => {
    expect(newDiagnostics([d(4, 11)], [d(4, 10)], [edit(10, 12, 'x')])).toEqual([]);
  });

  it('counts duplicates: a second identical error is new', () => {
    expect(newDiagnostics([d(1, 5)], [d(1, 5), d(1, 30)], [edit(10, 12, 'x')])).toEqual([d(1, 30)]);
  });
});
