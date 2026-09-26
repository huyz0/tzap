import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { instrument } from '@tzap/instrument';
import type { MutantDescriptor } from '@tzap/model';
import { createTypeChecker, TYPE_RULES, typeFilters } from '../src/index.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const fixture = path.join(repo, 'fixtures', 'typed-vitest');
const FILES = ['src/users.ts', 'src/config.ts', 'src/math.ts', 'src/blocks.ts', 'src/logic.ts', 'src/shapes.ts'];

const where = (m: MutantDescriptor) => `${m.file}:${m.location.start.line} ${m.mutatorName}`;

describe('type-directed rules on typed-vitest', () => {
  const placed: MutantDescriptor[] = [];
  /** Rule names that flag each mutant id, each rule applied on its own. */
  const flagged = new Map<string, string[]>();
  let invalid: Map<number, string>;

  beforeAll(async () => {
    let firstMutant = 0;
    let firstSite = 0;
    for (const file of FILES) {
      const source = readFileSync(path.join(fixture, file), 'utf8');
      const all = instrument({ file, source, firstMutant, firstSite });
      firstMutant = all.nextMutant;
      firstSite = all.nextSite;
      placed.push(...all.mutants.filter((m) => m.num >= 0));
      for (const rule of TYPE_RULES) {
        const out = instrument({ file, source, firstMutant: 0, firstSite: 0, filters: [{ name: rule.name, filter: rule.filter }] });
        for (const m of out.mutants) if (m.ignoredBy === rule.name) flagged.set(m.id, [...(flagged.get(m.id) ?? []), rule.name]);
      }
    }
    const checker = createTypeChecker({ root: fixture });
    invalid = await checker.check(placed, fixture);
    await checker.close();
  });

  const flaggedBy = (rule: string) => placed.filter((m) => flagged.get(m.id)?.includes(rule));

  it.each(TYPE_RULES.filter((r) => r.shipped).map((r) => r.name))('%s flags only type-invalid mutants, and at least one', (rule) => {
    const hits = flaggedBy(rule);
    expect(hits.length).toBeGreaterThan(0);
    for (const m of hits) expect(invalid.has(m.num), where(m)).toBe(true);
  });

  it('flags the hand-picked cases', () => {
    const expected = [
      ['src/users.ts:15 OptionalChaining', 'type:nullable-receiver'],
      ['src/users.ts:20 OptionalChaining', 'type:nullable-receiver'],
      ['src/users.ts:35 OptionalChaining', 'type:nullable-receiver'],
      ['src/shapes.ts:32 OptionalChaining', 'type:nullable-receiver'],
      ['src/config.ts:9 ObjectLiteral', 'type:required-properties'],
      ['src/config.ts:21 ObjectLiteral', 'type:required-properties'],
      ['src/shapes.ts:23 ObjectLiteral', 'type:required-properties'],
      ['src/config.ts:31 ObjectLiteral', 'type:used-keys'],
      ['src/shapes.ts:10 BlockStatement', 'type:returning-body'],
      ['src/shapes.ts:26 BlockStatement', 'type:returning-body'],
      ['src/blocks.ts:2 BlockStatement', 'type:returning-body'],
      ['src/logic.ts:3 LogicalOperator', 'type:nullish-to-and'],
      ['src/logic.ts:18 LogicalOperator', 'type:nullish-to-and'],
      ['src/logic.ts:23 ConditionalExpression', 'type:boolean-in-value-position'],
    ];
    for (const [at, rule] of expected) {
      const ms = placed.filter((m) => where(m) === at);
      expect(ms.length, at).toBeGreaterThan(0);
      expect(
        ms.some((m) => flagged.get(m.id)?.includes(rule!)),
        `${at} by ${rule}`,
      ).toBe(true);
    }
  });

  it('leaves the type-valid look-alikes alone', () => {
    const untouched = ['src/users.ts:25 OptionalChaining', 'src/users.ts:30 OptionalChaining', 'src/config.ts:15 ObjectLiteral', 'src/config.ts:26 ObjectLiteral', 'src/users.ts:25 LogicalOperator', 'src/math.ts:10 BlockStatement'];
    for (const at of untouched) {
      const shipped = new Set(typeFilters().map((f) => f.name));
      for (const m of placed.filter((x) => where(x) === at)) expect((flagged.get(m.id) ?? []).filter((r) => shipped.has(r)), at).toEqual([]);
    }
  });

  it('keeps the imprecise rules off by default: they flag type-valid mutants', () => {
    const shipped = typeFilters().map((f) => f.name);
    expect(shipped).not.toContain('type:declared-return-arrow');
    expect(shipped).not.toContain('type:untyped-array');
    // The naive ArrowFunction rule flags `flush`, an async arrow declared `Promise<void>`: returning
    // `undefined` there still returns a promise, and compiles.
    const naive = flaggedBy('type:declared-return-arrow');
    expect(naive.filter((m) => !invalid.has(m.num)).map(where)).toEqual(['src/math.ts:38 ArrowFunction']);
  });
});

describe('type-directed rules on look-alikes', () => {
  const root = path.join(import.meta.dirname, '../fixtures/lookalikes');
  const file = 'src/lookalikes.ts';

  it('drop nothing the checker accepts: guards, shadowing, opaque aliases, nested scopes', async () => {
    const source = readFileSync(path.join(root, file), 'utf8');
    const all = instrument({ file, source, firstMutant: 0, firstSite: 0 });
    const placed = all.mutants.filter((m) => m.num >= 0);
    const checker = createTypeChecker({ root });
    const invalid = await checker.check(placed, root);
    await checker.close();
    // The look-alikes are there: the mutants each case is about compile.
    for (const [line, mutator] of [[10, 'OptionalChaining'], [16, 'OptionalChaining'], [22, 'BlockStatement'], [25, 'ArrowFunction'], [28, 'ObjectLiteral'], [36, 'BooleanLiteral'], [40, 'ArrowFunction']] as const) {
      const ms = placed.filter((m) => m.location.start.line === line && m.mutatorName === mutator);
      expect(ms.length, `${line} ${mutator}`).toBeGreaterThan(0);
      expect(ms.some((m) => !invalid.has(m.num)), `${line} ${mutator} compiles`).toBe(true);
    }
    const filtered = instrument({ file, source, firstMutant: 0, firstSite: 0, filters: typeFilters() });
    const dropped = filtered.mutants.filter((m) => m.ignoredBy?.startsWith('type:'));
    const byKey = new Map(placed.map((m) => [m.id, m]));
    for (const m of dropped) expect(invalid.has(byKey.get(m.id)!.num), `${m.location.start.line} ${m.mutatorName} dropped by ${m.ignoredBy}`).toBe(true);
  });
});
