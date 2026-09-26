/**
 * Session-level tests of the Jest adapter against fixtures/sample-jest, with hand-written
 * instrumented sources so every mutant's behaviour is known exactly. Needs a build first
 * (`npx tsc -b packages/runner-jest`): the session forks dist/host.js.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunnerSession, SessionOptions, TestOutcome, Try } from '@tzap/protocol';
import { runtimeHeader } from '@tzap/runtime';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createJestSession } from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, '../../../fixtures/sample-jest');
const slash = (p: string) => p.replace(/\\/g, '/');

const DISCOUNT = `${runtimeHeader(3)}
export function discountedPrice(price: number, percent: number): number {
  __tzap.c[0]++;
  if (percent < 0 || percent > 100) {
    __tzap.c[1]++;
    throw new RangeError('percent out of range');
  }
  if (__tzap.a === 1 ? (__tzap.m(), percent >= 50) : percent > 50) {
    return price / 2;
  }
  if (__tzap.a === 2) { __tzap.m(); return 0; }
  if (__tzap.a === 3) { for (;;) { __tzap.m(); } }
  if (__tzap.a === 4) { for (;;) {} }
  return price - (price * percent) / 100;
}

export function isFree(price: number): boolean {
  __tzap.c[2]++;
  if (__tzap.a === 5) { __tzap.m(); return false; }
  return price === 0;
}
`;

const STRINGS = `${runtimeHeader(3)}
__tzap.c[3]++;
export const SEPARATOR = __tzap.a === 7 ? '; ' : ', ';

export function joinNames(names: string[]): string {
  return names.filter((n) => n.trim().length > 0).join(SEPARATOR);
}

export function shout(s: string): string {
  return s.toUpperCase() + '!';
}
`;

const SMALL = 'test/discount.test.ts::discountedPrice > applies a small discount';
const CAPS = 'test/discount.test.ts::discountedPrice > caps large discounts at half price';
const FREE = 'test/discount.test.ts::isFree > is free at zero';
const JOIN = 'test/strings.test.ts::joins non-blank names';

const scratch = mkdtempSync(path.join(tmpdir(), 'tzap-jest-test-'));
const instrumented = path.join(scratch, 'instrumented.json');
writeFileSync(
  instrumented,
  JSON.stringify({
    [path.join(FIXTURE, 'src/discount.ts')]: { code: DISCOUNT, map: null },
    [path.join(FIXTURE, 'src/strings.ts')]: { code: STRINGS, map: null },
  }),
);

const opts = (extra: Partial<SessionOptions> = {}): SessionOptions => ({
  root: slash(FIXTURE),
  pkg: { id: 'sample-jest', root: '.', sources: ['src/**/*.ts'], runner: { kind: 'jest' } },
  instrumented,
  tmpDir: scratch,
  ...extra,
});

const sessions: RunnerSession[] = [];
async function open(extra: Partial<SessionOptions> = {}): Promise<RunnerSession> {
  const s = createJestSession(opts(extra));
  sessions.push(s);
  await s.start();
  return s;
}
afterAll(async () => {
  await Promise.all(sessions.map((s) => s.close()));
  rmSync(scratch, { recursive: true, force: true });
});

const byId = (tests: TestOutcome[]) => new Map(tests.map((t) => [t.id, t]));
const mut = (m: number, N = 1000): Try => ({ m, N, L: 100_000 });
const control: Try = { m: -1, N: Infinity, L: 100_000 };

describe('JestSession', () => {
  let s: RunnerSession;
  beforeAll(async () => {
    s = await open();
  }, 60_000);

  it('reports the Jest version', async () => {
    const other = createJestSession(opts());
    const { runnerVersion } = await other.start();
    await other.close();
    expect(other.kind).toBe('jest');
    expect(runnerVersion).toMatch(/^30\./);
  });

  it('coverage: per-test hits, static hits, durations, nothing state-sensitive', async () => {
    const res = await s.run({ id: 1, mode: 'coverage' });
    const t = byId(res.tests);
    expect(res.tests).toHaveLength(5);
    expect(res.tests.every((x) => x.state === 'pass')).toBe(true);
    expect(t.get(SMALL)!.hits).toEqual([[0, 1]]);
    expect(t.get('test/discount.test.ts::discountedPrice > rejects negative percentages')!.hits).toEqual([
      [0, 1],
      [1, 1],
    ]);
    expect(t.get(FREE)!.hits).toEqual([[2, 1]]);
    expect(t.get(JOIN)!.hits).toEqual([]);
    expect(t.get(SMALL)!.name).toBe('discountedPrice > applies a small discount');
    expect(t.get(SMALL)!.file).toBe(slash(path.join(FIXTURE, 'test/discount.test.ts')));
    expect(res.tests.some((x) => x.stateSensitive)).toBe(false);
    expect(res.tests.every((x) => typeof x.duration === 'number')).toBe(true);
    const strings = res.files.find((f) => f.file.endsWith('strings.test.ts'))!;
    expect(strings.staticHits).toEqual([[3, 1]]);
    expect(res.files.find((f) => f.file.endsWith('discount.test.ts'))!.staticHits).toEqual([]);
  });

  it('mutate: control tries bracket the mutants; K, S, U and X; unplanned tests skipped', async () => {
    const res = await s.run({
      id: 2,
      mode: 'mutate',
      plan: {
        [SMALL]: [control, mut(1), mut(2), mut(5), control],
        [CAPS]: [control, mut(2), mut(1), control],
      },
    });
    const t = byId(res.tests);
    const small = t.get(SMALL)!.tries!;
    expect(small.map(([m, o]) => [m, o])).toEqual([
      [-1, 'S'],
      [1, 'S'],
      [2, 'K'],
      [5, 'U'],
      [-1, 'S'],
    ]);
    expect(small[2]![2]).toMatch(/Expected: 180/);
    // Mutant 2 died in the small-discount test: its try in a later test is skipped (it would be
    // unreached there anyway: 80% returns before the mutant).
    expect(t.get(CAPS)!.tries!.map(([m, o]) => [m, o])).toEqual([
      [-1, 'S'],
      [2, 'X'],
      [1, 'S'],
      [-1, 'S'],
    ]);
    expect(t.get(FREE)!.state).toBe('skip');
    expect(t.get(JOIN)!.state).toBe('skip');
    expect(t.get(SMALL)!.state).toBe('pass');
  });

  it('mutate: a runaway mutant hits its limit and is declared hung (T)', async () => {
    const res = await s.run({ id: 3, mode: 'mutate', plan: { [SMALL]: [control, mut(3, 1000), control] } });
    expect(byId(res.tests).get(SMALL)!.tries!.map(([m, o]) => [m, o])).toEqual([
      [-1, 'S'],
      [3, 'T'],
      [-1, 'S'],
    ]);
  });

  it('mutate: the killed set is per run', async () => {
    const res = await s.run({ id: 4, mode: 'mutate', plan: { [SMALL]: [control, mut(2), control] } });
    expect(byId(res.tests).get(SMALL)!.tries!.map(([m, o]) => [m, o])).toEqual([
      [-1, 'S'],
      [2, 'K'],
      [-1, 'S'],
    ]);
  });

  it('static: the mutant is active before the test file loads', async () => {
    const file = slash(path.join(FIXTURE, 'test/strings.test.ts')).toLowerCase();
    const res = await s.run({ id: 5, mode: 'static', staticMutant: 7, files: [file], plan: { [JOIN]: [mut(7)] } });
    expect(res.files).toHaveLength(1);
    expect(res.tests).toHaveLength(1);
    const [[m, o, msg]] = res.tests[0]!.tries!;
    expect([m, o]).toEqual([7, 'K']);
    expect(msg).toMatch(/a; b/);
    // And the next run, without the mutant, is clean: a fresh registry per test file.
    const again = await s.run({ id: 6, mode: 'static', staticMutant: -1, files: [file], plan: { [JOIN]: [mut(-1)] } });
    expect(again.tests[0]!.tries).toEqual([[-1, 'S']]);
  });
});

describe('JestSession hang recovery', () => {
  it('the wall-clock backstop kills the host and names the try in flight', async () => {
    const s = await open();
    const res = await s.run({ id: 1, mode: 'mutate', plan: { [SMALL]: [control, mut(4), control] }, budgetMs: 4000 });
    expect(res.timedOut).toBe(true);
    expect(res.inFlight).toEqual([{ test: SMALL, mutant: 4 }]);
    await expect(s.run({ id: 2, mode: 'coverage' })).rejects.toThrow(/not running/);
    const fresh = await open();
    const ok = await fresh.run({ id: 3, mode: 'mutate', plan: { [SMALL]: [control, mut(2), control] }, budgetMs: 30_000 });
    expect(ok.timedOut).toBeUndefined();
    expect(byId(ok.tests).get(SMALL)!.tries!.map(([m, o]) => [m, o])).toEqual([
      [-1, 'S'],
      [2, 'K'],
      [-1, 'S'],
    ]);
  }, 60_000);
});

describe('JestSession snapshots', () => {
  const dir = path.join(FIXTURE, `tzap-snap-${process.pid}`);
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('never writes a snapshot, new or obsolete', async () => {
    mkdirSync(path.join(dir, 'test'), { recursive: true });
    writeFileSync(path.join(dir, 'test/snap.test.ts'), `it('matches', () => { expect({ a: 1 }).toMatchSnapshot(); });\n`);
    const config = path.join(dir, 'jest.config.json');
    writeFileSync(config, JSON.stringify({ rootDir: '.', testMatch: ['<rootDir>/test/**/*.test.ts'], testEnvironment: 'node' }));
    const s = await open({
      pkg: { id: 'sample-jest', root: '.', sources: ['src/**/*.ts'], runner: { kind: 'jest', config: slash(path.relative(FIXTURE, config)) } },
    });
    const res = await s.run({ id: 1, mode: 'coverage' });
    expect(res.tests).toHaveLength(1);
    // Under --ci a missing snapshot fails instead of being written.
    expect(res.tests[0]!.state).toBe('fail');
    expect(res.tests[0]!.message).toMatch(/snapshot/i);
    expect(existsSync(path.join(dir, 'test/__snapshots__'))).toBe(false);
    await s.close();
  }, 60_000);
});

describe('JestSession state-sensitive tests', () => {
  it('coverage runs each test twice and flags one that takes another path when repeated', async () => {
    const file = path.join(scratch, 'stateful.json');
    const stateful = DISCOUNT.replace('__tzap.c[2]++;', '__tzap.c[2]++; if ((globalThis as any).__seen) __tzap.c[3]++; (globalThis as any).__seen = true;');
    writeFileSync(file, JSON.stringify({ [path.join(FIXTURE, 'src/discount.ts')]: { code: stateful, map: null } }));
    const s = await open({ instrumented: file });
    const res = await s.run({ id: 1, mode: 'coverage', files: [slash(path.join(FIXTURE, 'test/discount.test.ts')).toLowerCase()] });
    const t = byId(res.tests);
    expect(t.get(FREE)!.hits).toEqual([[2, 1]]);
    expect(t.get(FREE)!.stateSensitive).toBe('takes a different path when repeated');
    expect(t.get(SMALL)!.stateSensitive).toBeUndefined();
    await s.close();
  }, 60_000);
});
