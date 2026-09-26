import { afterEach, describe, expect, it } from 'vitest';
import { activateStatic, beginTry, drainHits, endTry, install, RUNTIME_GLOBAL, runtimeHeader, STATIC_LIMIT, type TzapRuntime } from '../src/index.js';

const fresh = (): TzapRuntime => install({});

describe('install', () => {
  it('creates one runtime per target and returns it again after', () => {
    const target: Record<string, unknown> = {};
    const rt = install(target);
    expect(target[RUNTIME_GLOBAL]).toBe(rt);
    expect(install(target)).toBe(rt);
    expect(install({})).not.toBe(rt);
  });

  it('starts with no mutant active and no limits', () => {
    const rt = fresh();
    expect([rt.a, rt.n, rt.N, rt.l, rt.L, rt.h]).toEqual([-1, 0, Infinity, 0, Infinity, 0]);
  });

  describe('TZAP_ACTIVE_MUTANT', () => {
    afterEach(() => {
      delete process.env.TZAP_ACTIVE_MUTANT;
    });
    it('activates a mutant from the environment, for code loaded outside a tzap worker', () => {
      process.env.TZAP_ACTIVE_MUTANT = '7';
      expect(fresh().a).toBe(7);
    });
  });
});

describe('counters', () => {
  it('grow to hold any site and keep the hits already counted', () => {
    const rt = fresh();
    rt.c[3] = 2;
    rt.g(5000);
    expect(rt.c.length).toBeGreaterThan(5000);
    expect(rt.c[3]).toBe(2);
    const before = rt.c;
    rt.g(10);
    expect(rt.c).toBe(before);
  });

  it('drain as (site, hits) pairs, then read zero', () => {
    const rt = fresh();
    rt.c[1] = 3;
    rt.c[900] = 1;
    expect(drainHits(rt)).toEqual([
      [1, 3],
      [900, 1],
    ]);
    expect(drainHits(rt)).toEqual([]);
  });
});

describe('hang detection', () => {
  it('declares a try hung once the mutant runs more than its hit limit', () => {
    const rt = fresh();
    beginTry(rt, 4, 2, 100);
    rt.m();
    rt.m();
    expect(() => rt.m()).toThrow(expect.objectContaining({ name: 'TzapHangError', message: 'tzap: mutant declared hung' }));
    expect(endTry(rt).hung).toBe(true);
  });

  it('is sticky: once hung, every later guard throws, so a user catch cannot hide it', () => {
    const rt = fresh();
    beginTry(rt, 4, 1, 100);
    rt.m();
    try {
      rt.m();
    } catch {
      // swallowed, as user code might
    }
    rt.n = 0;
    expect(() => rt.m()).toThrow();
  });

  it('starts every try clean, and endTry reports the loops taken and turns the mutant off', () => {
    const rt = fresh();
    beginTry(rt, 4, 1, 100);
    expect(() => rt.x()).toThrow();
    beginTry(rt, 5, 10, 100);
    expect([rt.a, rt.n, rt.h]).toEqual([5, 0, 0]);
    rt.l = 42;
    expect(endTry(rt)).toEqual({ hung: false, loops: 42 });
    expect([rt.a, rt.N, rt.L]).toEqual([-1, Infinity, Infinity]);
  });
});

describe('activateStatic', () => {
  it('keeps a mutant active with the same limit for hits and loops, the default when none is measured', () => {
    const rt = fresh();
    activateStatic(rt, 9);
    expect([rt.a, rt.N, rt.L]).toEqual([9, STATIC_LIMIT, STATIC_LIMIT]);
    activateStatic(rt, 9, 500);
    expect([rt.N, rt.L]).toEqual([500, 500]);
  });
});

describe('runtimeHeader', () => {
  it('installs the runtime on first use and sizes the counters for the file', () => {
    const g: Record<string, unknown> = {};
    const run = new Function('globalThis', `${runtimeHeader(3000)}; return ${RUNTIME_GLOBAL};`);
    const rt = run(g) as TzapRuntime;
    expect(g[RUNTIME_GLOBAL]).toBe(rt);
    expect(rt.c.length).toBeGreaterThan(3000);
    // A second file reuses it.
    expect(run(g)).toBe(rt);
  });
});
