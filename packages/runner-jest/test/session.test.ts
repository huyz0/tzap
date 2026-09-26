/**
 * Session-level tests of the Jest adapter against fixtures/sample-jest (Jest 30) and
 * fixtures/sample-jest29 (Jest 29), the same suite under each, with hand-written
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

const byId = (tests: TestOutcome[]) => new Map(tests.map((t) => [t.id, t]));
const mut = (m: number, N = 1000): Try => ({ m, N, L: 100_000 });
const control: Try = { m: -1, N: Infinity, L: 100_000 };

const FIXTURES = [
  { name: 'sample-jest', major: 30 },
  { name: 'sample-jest29', major: 29 },
] as const;

describe.each(FIXTURES)('Jest $major', ({ name, major }) => {
  const FIXTURE = path.resolve(here, `../../../fixtures/${name}`);
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
    pkg: { id: name, root: '.', sources: ['src/**/*.ts'], runner: { kind: 'jest' } },
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
      expect(runnerVersion).toMatch(new RegExp(`^${major}\\.`));
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
      expect(res.tests.every((x) => Number.isFinite(x.duration) && x.duration >= 0)).toBe(true);
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
        pkg: { id: name, root: '.', sources: ['src/**/*.ts'], runner: { kind: 'jest', config: slash(path.relative(FIXTURE, config)) } },
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

  describe('JestSession concurrent tests', () => {
    const dir = path.join(FIXTURE, `tzap-concurrent-${process.pid}`);
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('runs every try of a test.concurrent test, one test at a time', async () => {
      mkdirSync(path.join(dir, 'test'), { recursive: true });
      writeFileSync(
        path.join(dir, 'test/concurrent.test.ts'),
        `import { discountedPrice } from '../../src/discount';\n` +
          `let running = 0;\n` +
          `const alone = async (f: () => void) => { running++; try { await new Promise((r) => setTimeout(r, 5)); expect(running).toBe(1); f(); } finally { running--; } };\n` +
          `test.concurrent('small', () => alone(() => expect(discountedPrice(200, 10)).toBe(180)));\n` +
          `test.concurrent('caps', () => alone(() => expect(discountedPrice(200, 80)).toBe(100)));\n`,
      );
      // babel-jest looks for its config under the rootDir: the fixture's TypeScript preset.
      writeFileSync(path.join(dir, 'babel.config.cjs'), `module.exports = require('../babel.config.cjs');\n`);
      const config = path.join(dir, 'jest.config.json');
      writeFileSync(config, JSON.stringify({ rootDir: '.', testMatch: ['<rootDir>/test/**/*.test.ts'], testEnvironment: 'node' }));
      const s = await open({
        pkg: { id: name, root: '.', sources: ['src/**/*.ts'], runner: { kind: 'jest', config: slash(path.relative(FIXTURE, config)) } },
      });
      const cov = await s.run({ id: 1, mode: 'coverage' });
      expect(cov.tests.map((t) => [t.name, t.state, t.hits])).toEqual([
        ['small', 'pass', [[0, 1]]],
        ['caps', 'pass', [[0, 1]]],
      ]);
      const small = 'test/concurrent.test.ts::small';
      const caps = 'test/concurrent.test.ts::caps';
      const res = await s.run({ id: 2, mode: 'mutate', plan: { [small]: [control, mut(2), mut(1), control], [caps]: [control, mut(1), control] } });
      const t = byId(res.tests);
      expect(t.get(small)!.tries!.map(([m, o]) => [m, o])).toEqual([
        [-1, 'S'],
        [2, 'K'],
        [1, 'S'],
        [-1, 'S'],
      ]);
      // At 80% the mutated `percent >= 50` takes the same branch.
      expect(t.get(caps)!.tries!.map(([m, o]) => [m, o])).toEqual([
        [-1, 'S'],
        [1, 'S'],
        [-1, 'S'],
      ]);
      await s.close();
    }, 60_000);
  });

  describe('JestSession static runs', () => {
    const dir = path.join(FIXTURE, `tzap-static-limit-${process.pid}`);
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('hold the loop limit the engine measured while test files load', async () => {
      mkdirSync(path.join(dir, 'test'), { recursive: true });
      // Under mutant 5 each call counts one hit: a thousand while the file loads.
      writeFileSync(
        path.join(dir, 'test/load.test.ts'),
        `import { isFree } from '../../src/discount';\n` + `for (let i = 0; i < 1000; i++) isFree(i);\n` + `test('loads', () => { expect(isFree(0)).toBeDefined(); });\n`,
      );
      writeFileSync(path.join(dir, 'babel.config.cjs'), `module.exports = require('../babel.config.cjs');\n`);
      const config = path.join(dir, 'jest.config.json');
      writeFileSync(config, JSON.stringify({ rootDir: '.', testMatch: ['<rootDir>/test/**/*.test.ts'], testEnvironment: 'node' }));
      const s = await open({
        pkg: { id: name, root: '.', sources: ['src/**/*.ts'], runner: { kind: 'jest', config: slash(path.relative(FIXTURE, config)) } },
      });
      const file = slash(path.join(dir, 'test/load.test.ts'));
      const id = 'test/load.test.ts::loads';
      const tight = await s.run({ id: 1, mode: 'static', staticMutant: 5, staticLimit: 100, files: [file], plan: { [id]: [mut(5)] } });
      expect(tight.files.map((f) => f.error)).toEqual([expect.stringMatching(/declared hung/)]);
      const loose = await s.run({ id: 2, mode: 'static', staticMutant: 5, staticLimit: 1_000_000, files: [file], plan: { [id]: [mut(5)] } });
      expect(loose.files.map((f) => f.error)).toEqual([undefined]);
      await s.close();
    }, 60_000);
  });

  describe('JestSession coverage repeats', () => {
    const dir = path.join(FIXTURE, `tzap-repeat-${process.pid}`);
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('repeats a test only when its first run reached a mutant', async () => {
      mkdirSync(path.join(dir, 'test'), { recursive: true });
      // Both fail when run a second time; only the one that reaches a mutant is repeated.
      writeFileSync(
        path.join(dir, 'test/repeat.test.ts'),
        `import { isFree } from '../../src/discount';\n` +
          `const runs: Record<string, number> = {};\n` +
          `const once = (k: string) => { runs[k] = (runs[k] ?? 0) + 1; expect(runs[k]).toBe(1); };\n` +
          `test('reaches a mutant once', () => { expect(isFree(0)).toBe(true); once('a'); });\n` +
          `test('reaches no mutant once', () => { once('b'); });\n`,
      );
      writeFileSync(path.join(dir, 'babel.config.cjs'), `module.exports = require('../babel.config.cjs');\n`);
      const config = path.join(dir, 'jest.config.json');
      writeFileSync(config, JSON.stringify({ rootDir: '.', testMatch: ['<rootDir>/test/**/*.test.ts'], testEnvironment: 'node' }));
      const s = await open({
        pkg: { id: name, root: '.', sources: ['src/**/*.ts'], runner: { kind: 'jest', config: slash(path.relative(FIXTURE, config)) } },
      });
      const res = await s.run({ id: 1, mode: 'coverage' });
      expect(res.tests.map((t) => [t.name, t.state, t.stateSensitive])).toEqual([
        ['reaches a mutant once', 'pass', expect.stringMatching(/^fails when repeated/)],
        ['reaches no mutant once', 'pass', undefined],
      ]);
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
});
