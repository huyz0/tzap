import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { instrument } from '@tzap/instrument';
import type { MutantDescriptor, PackageModel } from '@tzap/model';
import type { RunResult, TestOutcome, Try } from '@tzap/protocol';
import { MochaSession, createMochaSession } from '../dist/index.js';

const here = import.meta.dirname;
const repo = path.resolve(here, '../../..');
const sample = path.join(repo, 'fixtures/sample-mocha');
const hazards = path.join(here, '../fixtures/hazards');
const mochaVersion = (JSON.parse(readFileSync(path.join(sample, 'node_modules/mocha/package.json'), 'utf8')) as { version: string }).version;

interface Prepared {
  tmp: string;
  instrumented: string;
  mutants: MutantDescriptor[];
}

function prepare(root: string, files: string[]): Prepared {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'tzap-mocha-'));
  const out: Record<string, { code: string; map: unknown }> = {};
  const mutants: MutantDescriptor[] = [];
  let firstMutant = 0;
  let firstSite = 0;
  for (const f of files) {
    const r = instrument({ file: f, source: readFileSync(path.join(root, f), 'utf8'), firstMutant, firstSite });
    firstMutant = r.nextMutant;
    firstSite = r.nextSite;
    mutants.push(...r.mutants);
    out[path.join(root, f)] = { code: r.code!, map: r.map };
  }
  const instrumented = path.join(tmp, 'instrumented.json');
  writeFileSync(instrumented, JSON.stringify(out));
  return { tmp, instrumented, mutants };
}

const find = (p: Prepared, file: string, line: number, replacement: string) => {
  const m = p.mutants.find((x) => x.file === file && x.location.start.line === line && x.replacement === replacement);
  if (!m) throw new Error(`no mutant ${file}:${line} ${replacement}`);
  return m;
};
const byId = (r: RunResult, id: string): TestOutcome => {
  const t = r.tests.find((x) => x.id === id);
  if (!t) throw new Error(`no test ${id} in ${r.tests.map((x) => x.id).join(', ')}`);
  return t;
};
const pkgOf = (root: string): PackageModel => ({ id: path.basename(root), root: '.', sources: ['src/**/*'], runner: { kind: 'mocha' } });
const control: Try = { m: -1, N: Infinity, L: 100_000 };
const tryOf = (m: MutantDescriptor): Try => ({ m: m.num, N: 1000, L: 100_000 });

describe('sample-mocha', () => {
  let p: Prepared;
  let s: MochaSession;
  let coverage: RunResult;
  beforeAll(async () => {
    p = prepare(sample, ['src/discount.ts', 'src/strings.ts']);
    s = new MochaSession({ root: sample, pkg: pkgOf(sample), instrumented: p.instrumented, tmpDir: p.tmp });
    expect((await s.start()).runnerVersion).toBe(mochaVersion);
    coverage = await s.run({ id: 1, mode: 'coverage' });
  });
  afterAll(async () => {
    await s?.close();
    rmSync(p.tmp, { recursive: true, force: true });
  });

  it('lists the test files by the project .mocharc spec', async () => {
    expect((await s.listFiles()).map((f) => path.relative(sample, f).replace(/\\/g, '/'))).toEqual(['test/discount.test.ts', 'test/strings.test.ts']);
  });

  it('attributes coverage per test, with stable ids', () => {
    expect(coverage.tests.map((t) => [t.id, t.state])).toEqual([
      ['test/discount.test.ts::discountedPrice > applies a small discount', 'pass'],
      ['test/discount.test.ts::discountedPrice > caps large discounts at half price', 'pass'],
      ['test/discount.test.ts::discountedPrice > rejects negative percentages', 'pass'],
      ['test/discount.test.ts::isFree > is free at zero', 'pass'],
      ['test/strings.test.ts::joins non-blank names', 'pass'],
    ]);
    const cap = byId(coverage, 'test/discount.test.ts::discountedPrice > caps large discounts at half price');
    expect(cap.name).toBe('discountedPrice > caps large discounts at half price');
    expect(cap.file).toBe(path.join(sample, 'test/discount.test.ts'));
    const half = find(p, 'src/discount.ts', 6, 'price * 2');
    const rest = find(p, 'src/discount.ts', 8, 'price + (price * percent) / 100');
    expect(cap.hits!.map(([site]) => site)).toContain(half.site);
    expect(cap.hits!.map(([site]) => site)).not.toContain(rest.site);
    const join = byId(coverage, 'test/strings.test.ts::joins non-blank names');
    // the filter callback runs once per name
    expect(join.hits!.some(([, n]) => n === 3)).toBe(true);
    const shout = p.mutants.filter((m) => m.file === 'src/strings.ts' && m.location.start.line >= 7);
    for (const t of coverage.tests) for (const m of shout) expect(t.hits!.map(([x]) => x)).not.toContain(m.site);
    for (const t of coverage.tests) expect(t.stateSensitive).toBeUndefined();
  });

  it('reports module evaluation as static hits of the files that import the module', () => {
    const sep = find(p, 'src/strings.ts', 1, '""');
    const strings = coverage.files.find((f) => f.file.endsWith('strings.test.ts'))!;
    const discount = coverage.files.find((f) => f.file.endsWith('discount.test.ts'))!;
    expect(strings.staticHits).toEqual([[sep.site, 1]]);
    expect(discount.staticHits).toEqual([]);
    for (const t of coverage.tests) expect(t.hits!.map(([x]) => x)).not.toContain(sep.site);
  });

  it('runs planned tries warm, with control tries, early exit and unreached mutants', async () => {
    const small = 'test/discount.test.ts::discountedPrice > applies a small discount';
    const cap = 'test/discount.test.ts::discountedPrice > caps large discounts at half price';
    const free = 'test/discount.test.ts::isFree > is free at zero';
    const kill = find(p, 'src/discount.ts', 8, 'price + (price * percent) / 100');
    const survive = find(p, 'src/discount.ts', 5, 'percent >= 50');
    const both = find(p, 'src/discount.ts', 5, 'true');
    const isFreeTrue = find(p, 'src/discount.ts', 12, 'true');
    const res = await s.run({
      id: 2,
      mode: 'mutate',
      plan: {
        [small]: [control, tryOf(kill), tryOf(survive), tryOf(both), control],
        [cap]: [control, tryOf(both), tryOf(survive), control],
        // isFree's test never reaches discountedPrice: unreached, not survived
        [free]: [control, tryOf(kill), tryOf(isFreeTrue), control],
      },
      budgetMs: 30_000,
    });
    expect(res.timedOut).toBeUndefined();
    expect(res.tests.map((t) => t.id).sort()).toEqual([small, cap, free].sort());
    expect(byId(res, small).tries!.map(([m, o]) => [m, o])).toEqual([
      [-1, 'S'],
      [kill.num, 'K'],
      [survive.num, 'S'],
      [both.num, 'K'],
      [-1, 'S'],
    ]);
    expect(byId(res, small).tries![1]![2]).toMatch(/220 !== 180/);
    // killed earlier in this run: skipped
    expect(byId(res, cap).tries!.map(([m, o]) => [m, o])).toEqual([
      [-1, 'S'],
      [both.num, 'X'],
      [survive.num, 'S'],
      [-1, 'S'],
    ]);
    expect(byId(res, free).tries!.map(([m, o]) => [m, o])).toEqual([
      [-1, 'S'],
      [kill.num, 'X'],
      [isFreeTrue.num, 'S'],
      [-1, 'S'],
    ]);
    // A later run starts with an empty killed set; an unreached mutant is U.
    const res2 = await s.run({ id: 3, mode: 'mutate', plan: { [free]: [control, tryOf(kill), control] } });
    expect(byId(res2, free).tries).toEqual([
      [-1, 'S'],
      [kill.num, 'U'],
      [-1, 'S'],
    ]);
  });

  it('re-runs warm repeatedly at a small fixed cost per run', async () => {
    const small = 'test/discount.test.ts::discountedPrice > applies a small discount';
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      const r = await s.run({ id: 100 + i, mode: 'mutate', plan: { [small]: [control] } });
      times.push(performance.now() - t0);
      expect(r.tests[0]!.tries).toEqual([[-1, 'S']]);
    }
    times.sort((a, b) => a - b);
    const median = times[times.length >> 1]!;
    console.log(`warm run, one try, round trip through the session: median ${median.toFixed(2)} ms (p90 ${times[Math.floor(times.length * 0.9)]!.toFixed(2)} ms)`);
    expect(median).toBeLessThan(50);
  });

  it('runs many tries per run at a small cost per try', async () => {
    const small = 'test/discount.test.ts::discountedPrice > applies a small discount';
    const one = async (n: number) => {
      const t0 = performance.now();
      const r = await s.run({ id: 150 + n, mode: 'mutate', plan: { [small]: Array.from({ length: n }, () => control) } });
      expect(r.tests[0]!.tries).toHaveLength(n);
      return performance.now() - t0;
    };
    await one(1000);
    const t1 = await one(1);
    const t2 = await one(10_000);
    console.log(`per try: ${(((t2 - t1) / 9_999) * 1000).toFixed(1)} us (10,000 tries in ${t2.toFixed(0)} ms, 1 try in ${t1.toFixed(2)} ms)`);
  });

  it('treats the budget as a silence window: a long run that keeps finishing tries is not killed', async () => {
    const small = 'test/discount.test.ts::discountedPrice > applies a small discount';
    const t0 = performance.now();
    const r = await s.run({ id: 200, mode: 'mutate', plan: { [small]: Array.from({ length: 60_000 }, () => control) }, budgetMs: 250 });
    expect(performance.now() - t0).toBeGreaterThan(250);
    expect(r.timedOut).toBeUndefined();
    expect(r.tests[0]!.tries).toHaveLength(60_000);
  });

  it('runs a static mutant in a fresh process, active before modules evaluate', async () => {
    const sep = find(p, 'src/strings.ts', 1, '""');
    const join = 'test/strings.test.ts::joins non-blank names';
    const iso = createMochaSession({ root: sample, pkg: pkgOf(sample), instrumented: p.instrumented, tmpDir: p.tmp, isolate: true });
    await iso.start();
    try {
      const file = path.join(sample, 'test/strings.test.ts');
      const r1 = await iso.run({ id: 1, mode: 'static', staticMutant: sep.num, files: [file], plan: { [join]: [tryOf(sep)] } });
      expect(r1.tests.map((t) => [t.id, t.tries?.map(([m, o]) => [m, o])])).toEqual([[join, [[sep.num, 'K']]]]);
      expect(r1.files.map((f) => f.file)).toEqual([file]);
      // The next run gets another fresh process: no mutant left over from the last one.
      const ok = find(p, 'src/discount.ts', 12, 'true');
      const r2 = await iso.run({ id: 2, mode: 'static', staticMutant: ok.num, files: [file], plan: { [join]: [tryOf(ok)] } });
      expect(r2.tests[0]!.tries).toEqual([[ok.num, 'S']]);
    } finally {
      await iso.close();
    }
  });
});

describe('hazards', () => {
  let p: Prepared;
  let s: MochaSession;
  let coverage: RunResult;
  beforeAll(async () => {
    p = prepare(hazards, ['src/loops.ts', 'src/state.ts', 'src/legacy.cjs']);
    s = new MochaSession({ root: hazards, pkg: pkgOf(hazards), instrumented: p.instrumented, tmpDir: p.tmp });
    await s.start();
    coverage = await s.run({ id: 1, mode: 'coverage' });
  });
  afterAll(async () => {
    await s?.close();
    rmSync(p.tmp, { recursive: true, force: true });
  });

  it('identifies duplicates by ordinal, skips pending tests, loads CommonJS', () => {
    expect(coverage.tests.map((t) => [t.id, t.state])).toEqual([
      ['test/loops.test.ts::spins to a limit', 'pass'],
      ['test/loops.test.ts::sums > uses the hook', 'pass'],
      ['test/loops.test.ts::sums > dup', 'pass'],
      ['test/loops.test.ts::sums > dup #2', 'pass'],
      ['test/loops.test.ts::sums > is skipped', 'skip'],
      ['test/loops.test.ts::sums > is pending', 'skip'],
      ['test/loops.test.ts::settling > settles', 'pass'],
      ['test/plugin.test.ts::plugin > runs inside the root hooks', 'pass'],
      ['test/plugin.test.ts::plugin > ran the global setup once', 'pass'],
      ['test/state.test.ts::memoises', 'pass'],
      ['test/legacy.test.cjs::doubles', 'pass'],
    ]);
    const exportsObj = find(p, 'src/legacy.cjs', 4, '{}');
    expect(coverage.files.find((f) => f.file.endsWith('legacy.test.cjs'))!.staticHits!.map(([x]) => x)).toContain(exportsObj.site);
    const loop = find(p, 'src/loops.ts', 3, 'i--');
    // beforeEach hits belong to the test they run for
    expect(byId(coverage, 'test/loops.test.ts::sums > uses the hook').hits!.map(([x]) => x)).toContain(loop.site);
    expect(byId(coverage, 'test/loops.test.ts::sums > dup').loops).toBeGreaterThan(0);
  });

  it('flags a test whose second run takes another path', () => {
    expect(byId(coverage, 'test/state.test.ts::memoises').stateSensitive).toMatch(/different path/);
    expect(byId(coverage, 'test/loops.test.ts::sums > dup').stateSensitive).toBeUndefined();
  });

  it('declares a looping mutant hung (T) and times out a never-settling one with Mocha\'s own timeout', async () => {
    const loop = find(p, 'src/loops.ts', 3, 'i--');
    const never = find(p, 'src/loops.ts', 9, 'false');
    const dup = 'test/loops.test.ts::sums > dup';
    const settles = 'test/loops.test.ts::settling > settles';
    const res = await s.run({
      id: 2,
      mode: 'mutate',
      plan: { [dup]: [control, { m: loop.num, N: 1000, L: 1000 }, control], [settles]: [control, tryOf(never), control] },
      budgetMs: 30_000,
    });
    // The loop mutant already hangs in the suite's beforeEach (sumTo(3)): the guard throws there.
    // The try is declared hung, and the hook's failure stays inside it: the control after it runs.
    expect(byId(res, dup).tries!.map(([m, o]) => [m, o])).toEqual([
      [-1, 'S'],
      [loop.num, 'T'],
      [-1, 'S'],
    ]);
    const settled = byId(res, settles).tries!;
    expect(settled.map(([m, o]) => [m, o])).toEqual([
      [-1, 'S'],
      [never.num, 'K'],
      [-1, 'S'],
    ]);
    expect(settled[1]![2]).toMatch(/timeout of 500ms exceeded/i);
  });

  it('kills the host on the wall-clock backstop and names the try in flight', async () => {
    const big = find(p, 'src/loops.ts', 14, 'true');
    const spin = 'test/loops.test.ts::spins to a limit';
    const local = new MochaSession({ root: hazards, pkg: pkgOf(hazards), instrumented: p.instrumented, tmpDir: p.tmp });
    await local.start();
    try {
      const res = await local.run({ id: 1, mode: 'mutate', plan: { [spin]: [control, tryOf(big), control] }, budgetMs: 1500 });
      expect(res.timedOut).toBe(true);
      expect(res.inFlight).toEqual([{ test: spin, mutant: big.num }]);
    } finally {
      await local.close();
    }
  });

  it('runs root-hook plugins around every try, and global fixtures once per session', async () => {
    const inside = 'test/plugin.test.ts::plugin > runs inside the root hooks';
    const once = 'test/plugin.test.ts::plugin > ran the global setup once';
    const flip = find(p, 'src/loops.ts', 3, 's -= i');
    const res = await s.run({ id: 4, mode: 'mutate', plan: { [inside]: [control, tryOf(flip), control, control], [once]: [control, control] } });
    expect(byId(res, inside).tries!.map(([m, o]) => [m, o])).toEqual([
      [-1, 'S'],
      [flip.num, 'K'],
      [-1, 'S'],
      [-1, 'S'],
    ]);
    expect(byId(res, once).tries).toEqual([
      [-1, 'S'],
      [-1, 'S'],
    ]);
  });

  it('keeps hooks per try: a test that depends on beforeEach passes every control', async () => {
    const hook = 'test/loops.test.ts::sums > uses the hook';
    const flip = find(p, 'src/loops.ts', 3, 's -= i');
    const res = await s.run({ id: 3, mode: 'mutate', plan: { [hook]: [control, tryOf(flip), control, control] } });
    expect(byId(res, hook).tries!.map(([m, o]) => [m, o])).toEqual([
      [-1, 'S'],
      [flip.num, 'K'],
      [-1, 'S'],
      [-1, 'S'],
    ]);
  });
});
