#!/usr/bin/env node
/**
 * Generates the benchmark fixtures: synthetic but realistic Vitest TypeScript packages.
 *
 *   node tools/bench/generate.mjs [--out fixtures/bench-vitest] [--check]
 *
 * Two variants, each a `src/` + `test/` tree:
 *
 *   main/    40 modules, 200 tests  (S1, S3–S6) — arithmetic, strings, branching, loops, small
 *            classes, module-level constants, validation, collections
 *   static/  20 modules, 100 tests  (S9) — module-level tables and derived constants, so a large
 *            share of the mutants are reached only at module load
 *
 * Tests are a deliberate mix of strong assertions (exact values), weak ones (`toBeDefined`, type
 * checks, one-sided comparisons) and none at all for some functions, so every run produces
 * Killed, Survived and NoCoverage mutants. Expected values are not hand-written: each generated
 * module is imported (Node strips the types) and the call is evaluated, so the suite is green by
 * construction.
 *
 * Output is deterministic (seeded PRNG, no clock, no environment). `--check` regenerates into a
 * temporary directory and fails if the checked-in tree differs.
 *
 * There is deliberately no package.json in the output: `fixtures/*` is a pnpm workspace glob, and
 * a package there would join the workspace and invalidate the lockfile. The bench materialises a
 * runnable copy (with a pinned Vitest) outside the repository; see bench.mjs.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

process.removeAllListeners('warning'); // stripTypeScriptTypes is experimental; the warning is noise here
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
export const SEED = 20260926;

// ---------------------------------------------------------------------------------------------
// Deterministic randomness

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rngTools(seed) {
  const r = mulberry32(seed);
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const chance = (p) => r() < p;
  const shuffle = (xs) => {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const ints = (n, lo, hi) => Array.from({ length: n }, () => int(lo, hi));
  return { r, int, pick, chance, shuffle, ints };
}

const WORDS = ['alpha', 'bravo', 'delta', 'echo', 'kilo', 'lima', 'oscar', 'papa', 'romeo', 'sierra', 'tango', 'victor', 'zulu', 'mango', 'cedar', 'maple', 'amber', 'ivory', 'coral', 'onyx'];
const lit = (v) => JSON.stringify(v);

// ---------------------------------------------------------------------------------------------
// Module templates. Each returns { name, source, fns } where fns maps an exported function (or
// class) to a list of candidate test expressions over the module's exports.

const TEMPLATES = {
  arith(g, n) {
    const factor = g.int(2, 9);
    const offset = g.int(1, 20);
    const src = `const FACTOR = ${factor};
const OFFSET = ${offset};

export function scale${n}(x: number): number {
  return x * FACTOR + OFFSET;
}

export function clamp${n}(x: number, lo: number, hi: number): number {
  if (x < lo) {
    return lo;
  }
  if (x > hi) {
    return hi;
  }
  return x;
}

export function average${n}(xs: number[]): number {
  if (xs.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const x of xs) {
    sum += x;
  }
  return sum / xs.length;
}

export function percentOf${n}(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

export function lerp${n}(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
`;
    return {
      src,
      fns: {
        [`scale${n}`]: [`scale${n}(${g.int(0, 9)})`, `scale${n}(${g.int(10, 50)})`, `scale${n}(-${g.int(1, 9)})`],
        [`clamp${n}`]: [`clamp${n}(${g.int(-20, -1)}, 0, 10)`, `clamp${n}(${g.int(11, 40)}, 0, 10)`, `clamp${n}(${g.int(1, 9)}, 0, 10)`],
        [`average${n}`]: [`average${n}(${lit(g.ints(g.int(2, 5), 1, 30))})`, `average${n}([])`],
        [`percentOf${n}`]: [`percentOf${n}(${g.int(1, 20)}, ${g.int(21, 80)})`, `percentOf${n}(5, 0)`],
        [`lerp${n}`]: [`lerp${n}(${g.int(0, 10)}, ${g.int(20, 40)}, 0.5)`],
      },
    };
  },

  strings(g, n) {
    const sep = g.pick(['-', '_', '.']);
    const ell = g.pick(['...', '~', '>']);
    const src = `const SEP = ${lit(sep)};
const ELLIPSIS = ${lit(ell)};

export function slug${n}(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .split(/\\s+/)
    .filter((w) => w.length > 0)
    .join(SEP);
}

export function truncate${n}(s: string, max: number): string {
  if (s.length <= max) {
    return s;
  }
  return s.slice(0, max - ELLIPSIS.length) + ELLIPSIS;
}

export function capitalize${n}(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

export function initials${n}(name: string): string {
  return name
    .split(' ')
    .map((p) => p.charAt(0))
    .join('')
    .toUpperCase();
}

export function padLeft${n}(s: string, width: number, ch = ' '): string {
  let out = s;
  while (out.length < width) {
    out = ch + out;
  }
  return out;
}
`;
    const w = () => g.pick(WORDS);
    return {
      src,
      fns: {
        [`slug${n}`]: [`slug${n}(${lit(`  ${w()} ${w().toUpperCase()}  ${w()} `)})`, `slug${n}(${lit(w())})`],
        [`truncate${n}`]: [`truncate${n}(${lit(`${w()} ${w()} ${w()}`)}, ${g.int(6, 9)})`, `truncate${n}(${lit(w())}, 20)`],
        [`capitalize${n}`]: [`capitalize${n}(${lit(w())})`, `capitalize${n}('')`],
        [`initials${n}`]: [`initials${n}(${lit(`${w()} ${w()}`)})`],
        [`padLeft${n}`]: [`padLeft${n}(${lit(String(g.int(1, 99)))}, ${g.int(4, 6)}, '0')`, `padLeft${n}(${lit(w())}, 3)`],
      },
    };
  },

  branching(g, n) {
    const [t3, t2, t1] = [g.int(40, 55), g.int(60, 72), g.int(80, 92)];
    const heavy = g.int(5, 15);
    const src = `const HEAVY = ${heavy};

export function grade${n}(score: number): string {
  if (score >= ${t1}) {
    return 'A';
  } else if (score >= ${t2}) {
    return 'B';
  } else if (score >= ${t3}) {
    return 'C';
  }
  return 'F';
}

export function sign${n}(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

export function canRent${n}(age: number, licensed: boolean): boolean {
  return age >= 21 && licensed;
}

export function shipping${n}(weight: number, express: boolean): number {
  let cost = weight > HEAVY ? 20 : 5;
  if (express) {
    cost *= 2;
  }
  return cost;
}
`;
    return {
      src,
      fns: {
        [`grade${n}`]: [`grade${n}(${t1})`, `grade${n}(${t2 + 1})`, `grade${n}(${t3})`, `grade${n}(${g.int(0, t3 - 1)})`],
        [`sign${n}`]: [`sign${n}(${g.int(1, 50)})`, `sign${n}(-${g.int(1, 50)})`, `sign${n}(0)`],
        [`canRent${n}`]: [`canRent${n}(${g.int(21, 60)}, true)`, `canRent${n}(${g.int(16, 20)}, true)`, `canRent${n}(30, false)`],
        [`shipping${n}`]: [`shipping${n}(${heavy + g.int(1, 5)}, true)`, `shipping${n}(${g.int(1, heavy)}, false)`],
      },
    };
  },

  loops(g, n) {
    const src = `export function sumTo${n}(n: number): number {
  let total = 0;
  for (let i = 1; i <= n; i++) {
    total += i;
  }
  return total;
}

export function countAtLeast${n}(xs: number[], min: number): number {
  let count = 0;
  for (const x of xs) {
    if (x >= min) {
      count++;
    }
  }
  return count;
}

export function fib${n}(n: number): number {
  let a = 0;
  let b = 1;
  for (let i = 0; i < n; i++) {
    const t = a + b;
    a = b;
    b = t;
  }
  return a;
}

export function indexOfMax${n}(xs: number[]): number {
  let best = -1;
  for (let i = 0; i < xs.length; i++) {
    if (best === -1 || xs[i]! > xs[best]!) {
      best = i;
    }
  }
  return best;
}
`;
    return {
      src,
      fns: {
        [`sumTo${n}`]: [`sumTo${n}(${g.int(3, 20)})`, `sumTo${n}(0)`],
        [`countAtLeast${n}`]: [`countAtLeast${n}(${lit(g.ints(6, 0, 20))}, ${g.int(5, 15)})`],
        [`fib${n}`]: [`fib${n}(${g.int(5, 15)})`, `fib${n}(1)`],
        [`indexOfMax${n}`]: [`indexOfMax${n}(${lit(g.ints(5, 0, 99))})`, `indexOfMax${n}([])`],
      },
    };
  },

  klass(g, n) {
    const limit = g.int(100, 500);
    const src = `export class Account${n} {
  private balance = 0;
  private readonly history: number[] = [];

  deposit(amount: number): void {
    if (amount <= 0) {
      throw new Error('amount must be positive');
    }
    this.balance += amount;
    this.history.push(amount);
  }

  withdraw(amount: number): boolean {
    if (amount > this.balance || amount > ${limit}) {
      return false;
    }
    this.balance -= amount;
    this.history.push(-amount);
    return true;
  }

  get total(): number {
    return this.balance;
  }

  count(): number {
    return this.history.length;
  }
}

export class Stack${n}<T> {
  private items: T[] = [];

  push(x: T): this {
    this.items.push(x);
    return this;
  }

  pop(): T | undefined {
    return this.items.pop();
  }

  peek(): T | undefined {
    return this.items[this.items.length - 1];
  }

  get size(): number {
    return this.items.length;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }
}
`;
    const d = g.int(50, 200);
    const wd = g.int(10, 40);
    return {
      src,
      fns: {
        [`Account${n}`]: [
          `(() => { const a = new Account${n}(); a.deposit(${d}); a.withdraw(${wd}); return a.total; })()`,
          `(() => { const a = new Account${n}(); a.deposit(${d}); return a.withdraw(${d + 1}); })()`,
          `(() => { const a = new Account${n}(); a.deposit(${d}); a.deposit(${wd}); return a.count(); })()`,
          `(() => { const a = new Account${n}(); return () => a.deposit(0); })()`,
          `(() => { const a = new Account${n}(); a.deposit(${limit + 50}); return a.withdraw(${limit + 1}); })()`,
        ],
        [`Stack${n}`]: [
          `new Stack${n}<number>().push(${g.int(1, 9)}).push(${g.int(10, 19)}).peek()`,
          `new Stack${n}<string>().push('a').push('b').size`,
          `new Stack${n}<number>().isEmpty()`,
          `(() => { const s = new Stack${n}<number>().push(1).push(2); s.pop(); return s.peek(); })()`,
        ],
      },
    };
  },

  constants(g, n) {
    const levels = g.shuffle(['debug', 'info', 'warn', 'error', 'fatal']).slice(0, 4);
    const kinds = g.shuffle(WORDS).slice(0, 3);
    const prefix = g.pick(WORDS);
    const src = `export const LEVELS${n} = ${lit(levels)};
const WEIGHTS: Record<string, number> = { ${kinds.map((k, i) => `${k}: ${(i + 1) * g.int(2, 5)}`).join(', ')} };
const PREFIX = ${lit(prefix)} + '-';
export const DEFAULT_LEVEL${n} = LEVELS${n}.includes('info') ? 'info' : LEVELS${n}[0];
export const LIMITS${n} = { min: ${g.int(0, 5)}, max: ${g.int(50, 99)}, unit: 'ms' };

export function levelRank${n}(level: string): number {
  return LEVELS${n}.indexOf(level);
}

export function weightOf${n}(kind: string): number {
  return WEIGHTS[kind] ?? 0;
}

export function label${n}(id: number): string {
  return \`\${PREFIX}\${id}\`;
}

export function withinLimits${n}(x: number): boolean {
  return x >= LIMITS${n}.min && x <= LIMITS${n}.max;
}

export function describeLimits${n}(): string {
  return LIMITS${n}.min + '..' + LIMITS${n}.max + ' ' + LIMITS${n}.unit;
}
`;
    return {
      src,
      fns: {
        [`levelRank${n}`]: [`levelRank${n}(${lit(levels[2])})`, `levelRank${n}('nope')`],
        [`weightOf${n}`]: [`weightOf${n}(${lit(kinds[1])})`, `weightOf${n}('missing')`],
        [`label${n}`]: [`label${n}(${g.int(1, 999)})`],
        [`withinLimits${n}`]: [`withinLimits${n}(${g.int(10, 40)})`, `withinLimits${n}(1000)`],
        [`describeLimits${n}`]: [`describeLimits${n}()`],
        [`DEFAULT_LEVEL${n}`]: [`DEFAULT_LEVEL${n}`],
      },
    };
  },

  validation(g, n) {
    const minLen = g.int(2, 4);
    const src = `export interface User${n} {
  name?: string;
  email?: string;
  age?: number;
  tags?: string[];
}

export function isEmail${n}(s: string): boolean {
  return /^\\S+@\\S+$/.test(s);
}

export function displayName${n}(u: User${n}): string {
  return u.name?.trim() || 'anonymous';
}

export function isAdult${n}(u: User${n}): boolean {
  return (u.age ?? 0) >= 18;
}

export function hasTag${n}(u: User${n}, tag: string): boolean {
  return u.tags?.includes(tag) ?? false;
}

export function validate${n}(u: User${n}): string[] {
  const errors: string[] = [];
  if (!u.name || u.name.length < ${minLen}) {
    errors.push('name too short');
  }
  if (u.email !== undefined && !isEmail${n}(u.email)) {
    errors.push('invalid email');
  }
  return errors;
}
`;
    const w = g.pick(WORDS);
    return {
      src,
      fns: {
        [`isEmail${n}`]: [`isEmail${n}(${lit(`${w}@example.com`)})`, `isEmail${n}(${lit(`${w}.example.com`)})`],
        [`displayName${n}`]: [`displayName${n}({ name: ${lit(` ${w} `)} })`, `displayName${n}({})`],
        [`isAdult${n}`]: [`isAdult${n}({ age: ${g.int(18, 70)} })`, `isAdult${n}({})`],
        [`hasTag${n}`]: [`hasTag${n}({ tags: ['x', ${lit(w)}] }, ${lit(w)})`, `hasTag${n}({}, 'x')`],
        [`validate${n}`]: [`validate${n}({ name: ${lit(w)}, email: 'a@b.io', age: 30 })`, `validate${n}({ name: 'x', email: 'nope', age: -1 })`],
      },
    };
  },

  collections(g, n) {
    const mod = g.int(2, 4);
    const src = `export function multiplesOf${mod}_${n}(xs: number[]): number[] {
  return xs.filter((x) => x % ${mod} === 0);
}

export function doubled${n}(xs: number[]): number[] {
  return xs.map((x) => x * 2);
}

export function total${n}(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

export function unique${n}(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

export function countByLength${n}(xs: string[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const x of xs) {
    out[x.length] = (out[x.length] ?? 0) + 1;
  }
  return out;
}

export function range${n}(xs: number[]): { min: number; max: number } | undefined {
  if (xs.length === 0) {
    return undefined;
  }
  return { min: Math.min(...xs), max: Math.max(...xs) };
}
`;
    const words = () => lit(g.shuffle(WORDS).slice(0, g.int(3, 5)).concat(g.pick(WORDS)));
    return {
      src,
      fns: {
        [`multiplesOf${mod}_${n}`]: [`multiplesOf${mod}_${n}(${lit(g.ints(6, 1, 30))})`],
        [`doubled${n}`]: [`doubled${n}(${lit(g.ints(3, 1, 9))})`],
        [`total${n}`]: [`total${n}(${lit(g.ints(4, 1, 50))})`, `total${n}([])`],
        [`unique${n}`]: [`unique${n}(${words()})`],
        [`countByLength${n}`]: [`countByLength${n}(${words()})`],
        [`range${n}`]: [`range${n}(${lit(g.ints(5, -20, 20))})`, `range${n}([])`],
      },
    };
  },

  // S9: module-level tables and derived values, evaluated once at import. Most mutants here are
  // static: they are reached while the module loads, outside any test.
  table(g, n) {
    const rows = g.int(10, 14);
    const codes = g.shuffle(WORDS).slice(0, rows);
    const entries = codes.map((c) => `  { code: ${lit(c)}, rate: ${g.int(1, 9)}, region: ${lit(g.pick(['north', 'south', 'east', 'west']))} },`);
    const cut = g.int(3, 6);
    const src = `interface Row${n} {
  code: string;
  rate: number;
  region: string;
}

const TABLE: Row${n}[] = [
${entries.join('\n')}
];

const BY_CODE = new Map(TABLE.map((r) => [r.code, r]));
const HIGH = TABLE.filter((r) => r.rate > ${cut}).map((r) => r.code.toUpperCase() + '!');
const REGIONS = [...new Set(TABLE.map((r) => r.region))].sort();
export const SUMMARY${n} = { rows: TABLE.length, high: HIGH.length, name: 'table-' + ${lit(String(n))}, regions: REGIONS.join('|') };

export function rateOf${n}(code: string): number {
  return BY_CODE.get(code)?.rate ?? -1;
}

export function isHigh${n}(code: string): boolean {
  return HIGH.includes(code.toUpperCase() + '!');
}

export function inRegion${n}(region: string): string[] {
  return TABLE.filter((r) => r.region === region).map((r) => r.code);
}
`;
    return {
      src,
      fns: {
        [`rateOf${n}`]: [`rateOf${n}(${lit(codes[0])})`, `rateOf${n}('none')`],
        [`isHigh${n}`]: [`isHigh${n}(${lit(codes[1])})`, `isHigh${n}(${lit(codes[2])})`],
        [`inRegion${n}`]: [`inRegion${n}('north')`, `inRegion${n}('south')`],
        [`SUMMARY${n}`]: [`SUMMARY${n}`, `SUMMARY${n}.regions`, `SUMMARY${n}.high`],
      },
    };
  },
};

const MAIN_KINDS = ['arith', 'strings', 'branching', 'loops', 'klass', 'constants', 'validation', 'collections'];

// ---------------------------------------------------------------------------------------------
// Tests

function assertion(g, expr, value, threw, thunkError) {
  // Strength mix: ~55% exact, ~25% weak but still executing the code, ~20% one-sided.
  const roll = g.r();
  if (threw) return roll < 0.7 ? `expect(() => ${expr}).toThrow()` : `expect(() => ${expr}).toThrowError(/./)`;
  if (thunkError) return `expect(${expr}).toThrow(${lit(thunkError.message)})`;
  if (roll < 0.55) {
    if (value === undefined) return `expect(${expr}).toBeUndefined()`;
    if (typeof value === 'object' && value !== null) return `expect(${expr}).toEqual(${lit(value)})`;
    if (typeof value === 'number' && !Number.isInteger(value)) return `expect(${expr}).toBeCloseTo(${value}, 5)`;
    return `expect(${expr}).toBe(${lit(value)})`;
  }
  if (roll < 0.8) {
    if (value === undefined) return `expect(${expr}).not.toBeNull()`;
    if (Array.isArray(value)) return `expect(Array.isArray(${expr})).toBe(true)`;
    return `expect(typeof ${expr}).toBe(${lit(typeof value)})`;
  }
  if (typeof value === 'number') return value > 0 ? `expect(${expr}).toBeGreaterThan(0)` : `expect(${expr}).toBeLessThanOrEqual(${value})`;
  if (typeof value === 'string') return value.length > 0 ? `expect(${expr}.length).toBeGreaterThan(0)` : `expect(${expr}).toBe('')`;
  if (Array.isArray(value)) return value.length > 0 ? `expect(${expr}.length).toBeGreaterThan(0)` : `expect(${expr}).toHaveLength(0)`;
  if (value === undefined) return `expect(${expr}).toBeUndefined()`;
  return `expect(${expr}).toBeDefined()`;
}

async function evaluate(modFile, expr) {
  const mod = await import(pathToFileURL(modFile).href);
  const names = Object.keys(mod);
  const fn = new Function(...names, `return (${stripTypeScriptTypes(expr)});`);
  try {
    const v = fn(...names.map((k) => mod[k]));
    if (typeof v === 'function') {
      try {
        v();
      } catch (e) {
        return { value: undefined, threw: false, thunkError: e };
      }
      throw new Error(`thunk did not throw: ${expr}`);
    }
    return { value: v, threw: false };
  } catch (e) {
    return { value: undefined, threw: true };
  }
}

async function generateVariant(outDir, variant) {
  const g = rngTools(SEED + (variant === 'static' ? 1 : 0));
  const count = variant === 'static' ? 20 : 40;
  const testsPer = 5;
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(path.join(outDir, 'src'), { recursive: true });
  mkdirSync(path.join(outDir, 'test'), { recursive: true });
  let tests = 0;
  for (let i = 0; i < count; i++) {
    const n = String(i).padStart(2, '0');
    const kind = variant === 'static' ? (i % 4 === 3 ? MAIN_KINDS[i % MAIN_KINDS.length] : 'table') : MAIN_KINDS[i % MAIN_KINDS.length];
    const base = `${kind === 'klass' ? 'model' : kind}${n}`;
    const { src, fns } = TEMPLATES[kind](g, n);
    const srcFile = path.join(outDir, 'src', `${base}.ts`);
    writeFileSync(srcFile, src);

    // Leave one function (or class) per module untested now and then: NoCoverage mutants.
    let names = Object.keys(fns);
    if (g.chance(0.6)) {
      const drop = g.pick(names);
      names = names.filter((x) => x !== drop);
    }
    const its = [];
    const used = new Set();
    for (let t = 0; t < testsPer; t++) {
      const fnName = names[t % names.length];
      const options = fns[fnName].filter((e) => !used.has(e));
      const expr = options.length ? g.pick(options) : g.pick(fns[fnName]);
      used.add(expr);
      const { value, threw, thunkError } = await evaluate(srcFile, expr);
      its.push(`  it(${lit(`${fnName} #${t}`)}, () => {\n    ${assertion(g, expr, value, threw, thunkError)};\n  });`);
      tests++;
    }
    const imports = Object.keys(fns).filter((k) => names.includes(k));
    const test = `import { describe, expect, it } from 'vitest';\nimport { ${imports.join(', ')} } from '../src/${base}';\n\ndescribe(${lit(base)}, () => {\n${its.join('\n\n')}\n});\n`;
    writeFileSync(path.join(outDir, 'test', `${base}.test.ts`), test);
  }
  return { modules: count, tests };
}

export async function generate(out) {
  const main = await generateVariant(path.join(out, 'main'), 'main');
  const stat = await generateVariant(path.join(out, 'static'), 'static');
  writeFileSync(
    path.join(out, 'README.md'),
    `# bench-vitest (generated)\n\nGenerated by \`node tools/bench/generate.mjs\` (seed ${SEED}); do not edit by hand.\n\n` +
      `- \`main/\`: ${main.modules} modules, ${main.tests} tests (scenarios S1, S3-S6)\n` +
      `- \`static/\`: ${stat.modules} modules, ${stat.tests} tests, module-level tables (scenario S9)\n\n` +
      'No package.json on purpose: `fixtures/*` is a pnpm workspace glob. `tools/bench/bench.mjs` copies a variant to a\n' +
      'work directory outside the repository and installs a pinned Vitest there.\n',
  );
  return { main, static: stat };
}

function listTree(dir, rel = '') {
  const out = [];
  for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...listTree(dir, r));
    else out.push(r);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outArg = args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(REPO, 'fixtures', 'bench-vitest');
  if (args.includes('--check')) {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'tzap-bench-gen-'));
    await generate(tmp);
    const a = listTree(tmp);
    const b = existsSync(outArg) ? listTree(outArg) : [];
    const diff = a.filter((f) => !b.includes(f) || readFileSync(path.join(tmp, f), 'utf8') !== readFileSync(path.join(outArg, f), 'utf8'));
    const extra = b.filter((f) => !a.includes(f));
    rmSync(tmp, { recursive: true, force: true });
    if (diff.length || extra.length) {
      console.error(`bench fixture is stale: ${[...diff, ...extra].slice(0, 10).join(', ')}; run node tools/bench/generate.mjs`);
      process.exit(1);
    }
    console.log('bench fixture is up to date');
  } else {
    const r = await generate(path.resolve(outArg));
    console.log(`generated ${path.relative(process.cwd(), path.resolve(outArg)) || '.'}: main ${r.main.modules} modules / ${r.main.tests} tests, static ${r.static.modules} modules / ${r.static.tests} tests`);
  }
}
