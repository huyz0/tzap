/**
 * What instrumented code does, not only that it parses. For every mutant of every snippet, the
 * instrumented code run with that mutant active must behave exactly as the source with the
 * mutant's reported change applied: same result, or a throw where it throws. A difference means
 * the report and the tests disagree about which program was tested.
 */
import { beginTry, endTry, install, type TzapRuntime } from '@tzap/runtime';
import { describe, expect, it } from 'vitest';
import type { MutantDescriptor } from '@tzap/model';
import { ALL_MUTATORS, instrument } from '../src/index.js';

const rt: TzapRuntime = install();

/** Offset of a 1-based line and column. */
function offset(source: string, line: number, column: number): number {
  let at = 0;
  for (let l = 1; l < line; l++) at = source.indexOf('\n', at) + 1;
  return at + column - 1;
}
/** The source with a mutant applied, as it runs. */
const apply = (source: string, m: MutantDescriptor) =>
  source.slice(0, offset(source, m.location.start.line, m.location.start.column)) + (m.runs ?? m.replacement) + source.slice(offset(source, m.location.end.line, m.location.end.column));

/** Compiles a snippet that defines `f`, and returns what calling it gives for each input. */
function outcomes(code: string, inputs: unknown[][], before = () => {}, after = () => {}): string[] {
  const f = new Function(`${code}\nreturn f;`)() as (...a: unknown[]) => unknown;
  return inputs.map((args) => {
    before();
    try {
      return JSON.stringify(f(...args)) ?? 'undefined';
    } catch (e) {
      return `throws ${(e as Error).constructor.name}`;
    } finally {
      after();
    }
  });
}

const SNIPPETS: Array<{ name: string; source: string; inputs: unknown[][] }> = [
  {
    name: 'branches and arithmetic',
    source: 'function f(a, b) {\n  if (a > b) {\n    return a - b;\n  }\n  return b - a;\n}\n',
    inputs: [[1, 2], [3, 1], [2, 2]],
  },
  {
    name: 'no semicolons',
    source: 'function f(xs) {\n  let n = 0\n  for (const x of xs) {\n    if (x % 2 === 0) n += x\n    else n -= 1\n  }\n  return n\n}\n',
    inputs: [[[1, 2, 3, 4]], [[]], [[5]]],
  },
  {
    name: 'switch',
    source: "function f(k) {\n  switch (k) {\n    case 1:\n      return 'a';\n    case 2:\n      return 'b';\n    default:\n      return 'c';\n  }\n}\n",
    inputs: [[1], [2], [3]],
  },
  {
    name: 'logical and nullish operators',
    source: 'function f(a, b, c) {\n  return (a ?? b) || (c && a);\n}\n',
    inputs: [[null, 0, 1], [1, 2, 3], [0, null, 2], [undefined, undefined, 0]],
  },
  {
    name: 'strings, templates, conditional',
    source: "function f(n) {\n  return `${n} item` + (n > 1 ? 's' : '');\n}\n",
    inputs: [[0], [1], [2]],
  },
  {
    name: 'method chains, parenthesised objects included',
    source: "function f(s, t) {\n  return [s.trim().toUpperCase().slice(1), (s + t).trim().length, (s || t).startsWith('a')];\n}\n",
    inputs: [[' ab ', 'c '], ['a', ''], ['', 'b']],
  },
  {
    name: 'unary operators',
    source: 'function f(x) {\n  return [-x, +x, !x, +-x, -+x];\n}\n',
    inputs: [[1], [0], [-2]],
  },
  {
    name: 'a method chain with a comment before the dot',
    source: 'function f(s) {\n  return (s // note\n    .trim());\n}\n',
    inputs: [[' a '], ['b']],
  },
  {
    name: 'operands that keep their parentheses',
    source: 'function g(a, b) {\n  return [a, b];\n}\nfunction f(a, b, c) {\n  return [!(a ?? b) && c, g(!(a, b)), ~(a | b)];\n}\n',
    inputs: [[null, 1, 2], [0, 0, 1], [3, null, 0]],
  },
  {
    name: 'an arrow whose body is a parenthesised object',
    source: 'function f(n) {\n  const mk = (x) => ({ x });\n  return mk(n);\n}\n',
    inputs: [[1], [0]],
  },
  {
    name: 'object and array literals',
    source: 'function f(x) {\n  return { a: [x, x + 1], b: {} };\n}\n',
    inputs: [[1], [0]],
  },
  {
    name: 'updates and assignments',
    source: 'function f(a) {\n  let i = 0;\n  i++;\n  a += i;\n  a -= 1;\n  return a * 2;\n}\n',
    inputs: [[1], [5]],
  },
  {
    name: 'equality and boolean literals',
    source: 'function f(a) {\n  return (a === 1 && true) || false;\n}\n',
    inputs: [[1], [2]],
  },
  {
    name: 'optional chaining',
    source: "function f(o) {\n  return o?.x?.y ?? 'none';\n}\n",
    inputs: [[{ x: { y: 1 } }], [{ x: null }], [null]],
  },
  {
    name: 'classes and this',
    source: 'function f(n) {\n  class K {\n    constructor(v) {\n      this.v = v;\n    }\n    get() {\n      return this.v + 1;\n    }\n  }\n  return new K(n).get();\n}\n',
    inputs: [[1], [-1]],
  },
  {
    name: 'arrow functions and array methods',
    source: 'function f(xs) {\n  const double = (x) => x * 2;\n  return xs.filter((x) => x > 1).map(double).some((x) => x > 5);\n}\n',
    inputs: [[[1, 2, 3]], [[1]], [[4]]],
  },
];

describe('replacements read the same wherever they are spliced', () => {
  const mutants = (source: string, name: string) =>
    instrument({ file: 'm.js', source, firstMutant: 0, firstSite: 0 })
      .mutants.filter((m) => m.mutatorName === name)
      .map((m) => [m.original, m.replacement]);

  it('keeps the parentheses of an object whose method call is removed', () => {
    expect(mutants('f((s + t).trim().length, (await p).slice(1), x?.trim());', 'MethodExpression')).toEqual(
      expect.arrayContaining([
        ['(s + t).trim()', '(s + t)'],
        ['(await p).slice(1)', '(await p)'],
        ['x?.trim()', 'x'],
      ]),
    );
  });

  it('never turns a sign flip into an increment or a decrement', () => {
    expect(mutants('f(-x, +-x, -+x);', 'UnaryOperator')).toEqual([
      ['-x', '+x'],
      ['+-x', '-(-x)'],
      ['-x', '(+x)'],
      ['-+x', '+(+x)'],
      ['+x', '(-x)'],
    ]);
  });
});

describe('the safety net', () => {
  it('reports a mutant that cannot sit where it is placed, and instruments the rest', () => {
    // No known mutator output fails to parse; a broken one stands in for the next bug.
    const booleans = ALL_MUTATORS.find((m) => m.name === 'BooleanLiteral')!;
    const mutate = booleans.mutate;
    booleans.mutate = (node, ctx) => mutate(node, ctx).map((p) => ({ ...p, replacement: `${p.replacement} +` }));
    try {
      const r = instrument({ file: 'm.js', source: 'const x = 1 + 2;\nconst y = true;\n', firstMutant: 0, firstSite: 0 });
      expect(r.errors).toEqual([]);
      expect(r.mutants.map((m) => [m.mutatorName, m.ignoredBy, m.num])).toEqual([
        ['ArithmeticOperator', undefined, 0],
        ['BooleanLiteral', 'placement', -1],
      ]);
      expect(r.mutants[1]!.description).toMatch(/could not compile this mutant in place/);
      expect(r.code).toContain('const y = true;');
    } finally {
      booleans.mutate = mutate;
    }
  });

  it('never proposes a mutant in a class member computed key, which runs once as the class is defined', () => {
    const r = instrument({ file: 'm.js', source: 'class C {\n  [1 + 2]() {}\n  m() { return 3 - 1; }\n}\n', firstMutant: 0, firstSite: 0, mutators: ['ArithmeticOperator'] });
    expect(r.mutants.map((m) => [m.original, m.ignoredBy])).toEqual([['3 - 1', undefined]]);
  });
});

describe('instrumented code with a mutant active runs the reported mutant', () => {
  for (const s of SNIPPETS) {
    it(s.name, () => {
      const r = instrument({ file: 'm.js', source: s.source, firstMutant: 0, firstSite: 0 });
      expect(r.errors).toEqual([]);
      const placed = r.mutants.filter((m) => m.num >= 0);
      expect(placed.length).toBeGreaterThan(0);
      // Unmutated, instrumented code behaves as the source.
      expect(outcomes(r.code!, s.inputs, () => beginTry(rt, -1, 1e6, 1e6), () => endTry(rt))).toEqual(outcomes(s.source, s.inputs));
      for (const m of placed) {
        const expected = outcomes(apply(s.source, m), s.inputs);
        const actual = outcomes(r.code!, s.inputs, () => beginTry(rt, m.num, 1e6, 1e6), () => endTry(rt));
        expect(actual, `${m.mutatorName} ${m.original} -> ${m.replacement} at ${m.location.start.line}:${m.location.start.column}`).toEqual(expected);
      }
    });
  }
});

describe('a diff run', () => {
  it('proposes exactly the mutants a full run has on the changed lines, with the same ids', () => {
    const source = 'export function f(a, b) {\n  foo(\n    a + b);\n  return [a, b];\n}\nfunction foo(x) {\n  return x;\n}\n';
    const full = instrument({ file: 'm.js', source, firstMutant: 0, firstSite: 0 }).mutants;
    for (let line = 1; line <= 8; line++) {
      const diff = instrument({ file: 'm.js', source, lines: [[line, line]], firstMutant: 0, firstSite: 0 }).mutants;
      const expected = full.filter((m) => diff.some((d) => d.id === m.id));
      expect(diff.map((m) => [m.id, m.mutatorName, m.replacement]), `line ${line}`).toEqual(expected.map((m) => [m.id, m.mutatorName, m.replacement]));
      expect(diff.every((d) => full.some((m) => m.id === d.id)), `line ${line}: nothing a full run lacks`).toBe(true);
    }
  });
});
