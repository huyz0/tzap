/**
 * Tier A inventory expectations, one block per mutator. Every expected list is written by hand
 * from Stryker's documented and source-verified behaviour, never copied from any tool's output.
 */
import { describe, expect, it } from 'vitest';
import { instrument } from '../src/index.js';

function inventory(source: string, mutators?: string[], file = 'src/a.ts') {
  const out = instrument({ file, source, mutators, firstMutant: 0, firstSite: 0 });
  expect(out.errors).toEqual([]);
  return out.mutants.map((m) => `${m.mutatorName} ${m.location.start.line}:${m.location.start.column} ${m.original} -> ${m.replacement}${m.ignoredBy ? ` [${m.ignoredBy}]` : ''}`);
}

describe('ArithmeticOperator', () => {
  it('swaps each operator for its counterpart', () => {
    expect(inventory('x = a + b; y = a - b; z = a * b; w = a / b; v = a % b;', ['ArithmeticOperator'])).toEqual([
      'ArithmeticOperator 1:5 a + b -> a - b',
      'ArithmeticOperator 1:16 a - b -> a + b',
      'ArithmeticOperator 1:27 a * b -> a / b',
      'ArithmeticOperator 1:38 a / b -> a * b',
      'ArithmeticOperator 1:49 a % b -> a * b',
    ]);
  });
  it('leaves string concatenation alone, looking only at the nearest left operand as Stryker does', () => {
    expect(inventory("x = 'a' + b; y = a + `t`; z = 'a' + b + c;", ['ArithmeticOperator'])).toEqual([
      "ArithmeticOperator 1:31 'a' + b + c -> 'a' + b - c",
    ]);
  });
  it('finds the operator past parentheses and comments', () => {
    expect(inventory('x = (a) /* - */ - (b);', ['ArithmeticOperator'])).toEqual(['ArithmeticOperator 1:5 (a) /* - */ - (b) -> (a) /* - */ + (b)']);
  });
});

describe('EqualityOperator', () => {
  it('produces both boundary neighbours for relational operators and one negation for equality', () => {
    expect(inventory('a < b; a <= b; a > b; a >= b; a == b; a != b; a === b; a !== b;', ['EqualityOperator'])).toEqual([
      'EqualityOperator 1:1 a < b -> a <= b',
      'EqualityOperator 1:1 a < b -> a >= b',
      'EqualityOperator 1:8 a <= b -> a < b',
      'EqualityOperator 1:8 a <= b -> a > b',
      'EqualityOperator 1:16 a > b -> a >= b',
      'EqualityOperator 1:16 a > b -> a <= b',
      'EqualityOperator 1:23 a >= b -> a > b',
      'EqualityOperator 1:23 a >= b -> a < b',
      'EqualityOperator 1:31 a == b -> a != b',
      'EqualityOperator 1:39 a != b -> a == b',
      'EqualityOperator 1:47 a === b -> a !== b',
      'EqualityOperator 1:56 a !== b -> a === b',
    ]);
  });
});

describe('ConditionalExpression', () => {
  it('makes if tests true and false, and loop tests false', () => {
    expect(inventory('if (ok) f(); while (ok) g(); do {} while (ok); for (; ok;) {}', ['ConditionalExpression'])).toEqual([
      'ConditionalExpression 1:5 ok -> true',
      'ConditionalExpression 1:5 ok -> false',
      'ConditionalExpression 1:21 ok -> false',
      'ConditionalExpression 1:43 ok -> false',
      'ConditionalExpression 1:55 ok -> false',
    ]);
  });
  it('gives operands of || only false and of && only true', () => {
    expect(inventory('x = a > 1 || b < 2; y = a > 1 && b < 2;', ['ConditionalExpression'])).toEqual([
      'ConditionalExpression 1:5 a > 1 || b < 2 -> true',
      'ConditionalExpression 1:5 a > 1 || b < 2 -> false',
      'ConditionalExpression 1:5 a > 1 -> false',
      'ConditionalExpression 1:14 b < 2 -> false',
      'ConditionalExpression 1:25 a > 1 && b < 2 -> true',
      'ConditionalExpression 1:25 a > 1 && b < 2 -> false',
      'ConditionalExpression 1:25 a > 1 -> true',
      'ConditionalExpression 1:34 b < 2 -> true',
    ]);
  });
  it('gives for(;;) a false test and empties a non-fallthrough case', () => {
    expect(inventory('for (;;) {}\nswitch (x) { case 1: f(); break; case 2: }', ['ConditionalExpression'])).toEqual([
      'ConditionalExpression 1:1 for (;;) {} -> for (;false;) {}',
      'ConditionalExpression 2:14 case 1: f(); break; -> case 1:',
    ]);
  });
  it('does not empty a case that declares a lexical binding other cases can see', () => {
    expect(inventory('switch (x) { case 1: const y = 1; f(y); }', ['ConditionalExpression'])).toEqual([]);
  });
});

describe('LogicalOperator', () => {
  it('swaps && and ||, and turns ?? into &&', () => {
    expect(inventory('a && b; a || b; a ?? b;', ['LogicalOperator'])).toEqual([
      'LogicalOperator 1:1 a && b -> a || b',
      'LogicalOperator 1:9 a || b -> a && b',
      'LogicalOperator 1:17 a ?? b -> a && b',
    ]);
  });
});

describe('BooleanLiteral', () => {
  it('flips literals and removes negation', () => {
    expect(inventory('x = true; y = false; z = !a;', ['BooleanLiteral'])).toEqual([
      'BooleanLiteral 1:5 true -> false',
      'BooleanLiteral 1:15 false -> true',
      'BooleanLiteral 1:26 !a -> a',
    ]);
  });
});

describe('StringLiteral', () => {
  it('leaves module specifiers alone: string names in import and export lists, template specifiers of import() and require()', () => {
    const src = "const x = 1;\nexport { x as 'a-b' };\nconst n = 2;\nimport(`./m/${n}.js`);\nrequire(`./r/${n}`);\nf(`kept ${n}`);";
    expect(inventory(src, ['StringLiteral'])).toEqual(['StringLiteral 6:3 `kept ${n}` -> ``']);
  });

  it('empties strings and fills empty ones, but not keys, imports, directives or require', () => {
    const src = [
      "'use strict';",
      "import x from 'mod';",
      "const a = 'text';",
      "const b = '';",
      "const o = { 'key': 'v' };",
      "require('dep');",
      "const s = Symbol('sym');",
      'const t = `tmpl ${a}`;',
      'const u = ``;',
      "export * from './other';",
    ].join('\n');
    expect(inventory(src, ['StringLiteral'])).toEqual([
      'StringLiteral 3:11 \'text\' -> ""',
      'StringLiteral 4:11 \'\' -> "Stryker was here!"',
      'StringLiteral 5:20 \'v\' -> ""',
      'StringLiteral 8:11 `tmpl ${a}` -> ``',
      'StringLiteral 9:11 `` -> `Stryker was here!`',
    ]);
  });
  it('leaves JSX attribute strings alone', () => {
    expect(inventory('const e = <div className="x">{"y"}</div>;', ['StringLiteral'], 'src/a.tsx')).toEqual([
      'StringLiteral 1:31 "y" -> ""',
    ]);
  });
});

describe('UnaryOperator and UpdateOperator', () => {
  it('swaps signs, removes bitwise not, and flips increments', () => {
    expect(inventory('a = -b; c = +d; e = ~f; i++; --j;', ['UnaryOperator', 'UpdateOperator'])).toEqual([
      'UnaryOperator 1:5 -b -> +b',
      'UnaryOperator 1:13 +d -> -d',
      'UnaryOperator 1:21 ~f -> f',
      'UpdateOperator 1:25 i++ -> i--',
      'UpdateOperator 1:30 --j -> ++j',
    ]);
  });
});

describe('AssignmentOperator', () => {
  it('swaps compound assignments, except arithmetic ones on string right-hand sides', () => {
    expect(inventory("a += 1; b -= 1; c *= 2; d ??= 3; e += 's'; f ||= 'x';", ['AssignmentOperator'])).toEqual([
      'AssignmentOperator 1:1 a += 1 -> a -= 1',
      'AssignmentOperator 1:9 b -= 1 -> b += 1',
      'AssignmentOperator 1:17 c *= 2 -> c /= 2',
      'AssignmentOperator 1:25 d ??= 3 -> d &&= 3',
      "AssignmentOperator 1:44 f ||= 'x' -> f &&= 'x'",
    ]);
  });
});

describe('ArrayDeclaration and ObjectLiteral', () => {
  it('empties arrays and objects and fills empty arrays', () => {
    expect(inventory('a = [1]; b = []; c = new Array(3); d = Array(); e = { k: 1 }; f = {};', ['ArrayDeclaration', 'ObjectLiteral'])).toEqual([
      'ArrayDeclaration 1:5 [1] -> []',
      'ArrayDeclaration 1:14 [] -> ["Stryker was here"]',
      'ArrayDeclaration 1:22 new Array(3) -> new Array()',
      'ArrayDeclaration 1:40 Array() -> Array([])',
      'ObjectLiteral 1:53 { k: 1 } -> {}',
    ]);
  });
});

describe('ArrowFunction', () => {
  it('replaces concise bodies with undefined, but not block bodies or undefined ones', () => {
    expect(inventory('f = (x) => x * 2; g = () => { return 1; }; h = () => undefined;', ['ArrowFunction'])).toEqual([
      'ArrowFunction 1:5 (x) => x * 2 -> () => undefined',
    ]);
  });
});

describe('BlockStatement', () => {
  it('empties non-empty blocks, not empty ones or directive-only bodies', () => {
    expect(inventory('function f() { g(); }\nfunction h() {}\nfunction s() { "use strict"; }', ['BlockStatement'])).toEqual([
      'BlockStatement 1:14 { g(); } -> {}',
    ]);
  });
  it('skips constructors that must call super because of parameter properties or initialised fields', () => {
    const src = 'class A extends B { x = 1; constructor() { super(); go(); } }\nclass C extends B { constructor() { super(); go(); } }';
    expect(inventory(src, ['BlockStatement'])).toEqual(['BlockStatement 2:35 { super(); go(); } -> {}']);
  });
});

describe('CallExpression', () => {
  it('removes call statements and thrown constructions, only when nothing else in them is mutated', () => {
    expect(inventory('f(); g(a + b); throw new Error();', ['CallExpression'])).toEqual([
      'CallExpression 1:1 f(); -> ;',
      'CallExpression 1:6 g(a + b); -> ;',
      'CallExpression 1:16 throw new Error(); -> ;',
    ]);
    // With ArithmeticOperator enabled, g(a + b) has another mutant inside it and is not removed.
    expect(inventory('g(a + b);', ['CallExpression', 'ArithmeticOperator'])).toEqual(['ArithmeticOperator 1:3 a + b -> a - b']);
  });
  it('never removes super()', () => {
    expect(inventory('class A extends B { constructor() { super(); } }', ['CallExpression'])).toEqual([]);
  });
});

describe('MethodExpression', () => {
  it('keeps a comment before the dot out of the object it leaves, and never leaves a bare super', () => {
    expect(inventory('a = s // note\n  .trim();\nclass A extends B { m() { return super.trim(); } }', ['MethodExpression'])).toEqual(['MethodExpression 1:5 s // note\n  .trim() -> s']);
  });

  it('removes and swaps the listed methods', () => {
    expect(inventory('a = s.trim(); b = s.toLowerCase(); c = xs.filter(f); d = Math.min(1, 2);', ['MethodExpression'])).toEqual([
      'MethodExpression 1:5 s.trim() -> s',
      'MethodExpression 1:19 s.toLowerCase() -> s.toUpperCase()',
      'MethodExpression 1:40 xs.filter(f) -> xs',
      'MethodExpression 1:58 Math.min(1, 2) -> Math.max(1, 2)',
    ]);
  });
});

describe('OptionalChaining', () => {
  it('turns each optional link into a plain one', () => {
    expect(inventory('a = x?.y; b = x?.[0]; c = f?.(); d = x?.y.z;', ['OptionalChaining'])).toEqual([
      'OptionalChaining 1:5 x?.y -> x.y',
      'OptionalChaining 1:15 x?.[0] -> x[0]',
      'OptionalChaining 1:27 f?.() -> f()',
      'OptionalChaining 1:38 x?.y -> x.y',
    ]);
  });
});

describe('Regex', () => {
  it('produces weapon-regex level-1 mutants for literals and new RegExp strings', () => {
    const out = inventory("a = /^a+$/; b = new RegExp('\\\\d');", ['Regex']);
    expect(out).toContain('Regex 1:5 /^a+$/ -> /a+$/');
    expect(out).toContain('Regex 1:5 /^a+$/ -> /^a+/');
    expect(out.some((l) => l.startsWith('Regex 1:28'))).toBe(true);
  });
});

describe('what is never mutated', () => {
  it('skips types, enums, declarations, imports, decorators and as-expressions', () => {
    const src = [
      "import { a } from 'a';",
      "type T = 'x' | 'y';",
      "interface I { k: 'v' }",
      "enum E { A = 1 + 1 }",
      "declare const d: number;",
      "const c = (1 + 2) as number;",
      "@dec('x') class K {}",
    ].join('\n');
    expect(inventory(src)).toEqual([]);
  });
});

describe('disable comments', () => {
  it('honours Stryker and tzap directives, next-line and ranges', () => {
    const src = [
      '// Stryker disable next-line ArithmeticOperator',
      'a = b + c;',
      'd = e + f;',
      '// tzap disable all: generated',
      'g = h + i;',
      '// tzap restore all',
      'j = k + l;',
    ].join('\n');
    expect(inventory(src, ['ArithmeticOperator'])).toEqual([
      'ArithmeticOperator 2:5 b + c -> b - c [comment]',
      'ArithmeticOperator 3:5 e + f -> e - f',
      'ArithmeticOperator 5:5 h + i -> h - i [comment]',
      'ArithmeticOperator 7:5 k + l -> k - l',
    ]);
  });
});

describe('line scoping', () => {
  it('keeps only mutants on changed lines, and statement mutants only when their first line changed', () => {
    const src = 'function f(a, b) {\n  const x = a + b;\n  return x * 2;\n}';
    const out = instrument({ file: 'a.ts', source: src, lines: [[3, 3]], firstMutant: 0, firstSite: 0 });
    expect(out.mutants.map((m) => `${m.mutatorName} ${m.location.start.line}`)).toEqual(['ArithmeticOperator 3']);
  });
});

describe('identity', () => {
  it('keeps mutant ids stable when unrelated code is added above', () => {
    const before = instrument({ file: 'a.ts', source: 'function f(a) { return a + 1; }', firstMutant: 0, firstSite: 0 });
    const after = instrument({ file: 'a.ts', source: 'const z = 3;\n\nfunction f(a) { return a + 1; }', firstMutant: 0, firstSite: 0 });
    const idOf = (o: typeof before) => o.mutants.find((m) => m.mutatorName === 'ArithmeticOperator')!.id;
    expect(idOf(after)).toBe(idOf(before));
  });
  it('is deterministic', () => {
    const src = 'export const f = (a: number) => (a > 1 ? a - 1 : [a]);';
    const a = instrument({ file: 'a.ts', source: src, firstMutant: 0, firstSite: 0 });
    const b = instrument({ file: 'a.ts', source: src, firstMutant: 0, firstSite: 0 });
    expect(a).toEqual(b);
  });
});

describe('LogicalOperator on nullish chains', () => {
  it('parenthesises a bare ?? operand so the mutant still parses', () => {
    expect(inventory('x = a ?? b ?? c;', ['LogicalOperator'])).toEqual([
      'LogicalOperator 1:5 a ?? b ?? c -> (a ?? b) && c',
      'LogicalOperator 1:5 a ?? b -> a && b',
    ]);
  });
});

describe('LogicalOperator on a parenthesised nullish chain', () => {
  it('still parenthesises the inner operand', () => {
    expect(inventory('x = !(a ?? b ?? c);', ['LogicalOperator'])).toEqual([
      'LogicalOperator 1:7 a ?? b ?? c -> (a ?? b) && c',
      'LogicalOperator 1:7 a ?? b -> a && b',
    ]);
  });
});

describe('arid rules', () => {
  it('ignores mutants in logging calls and the removal of logging statements', async () => {
    const { aridFilters } = await import('../src/index.js');
    const src = "console.log('saving ' + id);\nlogger.info(`done ${n > 1}`);\nsave(id + 1);\nthis.log.warn('x');";
    const out = instrument({ file: 'a.ts', source: src, filters: aridFilters(), firstMutant: 0, firstSite: 0 });
    const live = out.mutants.filter((m) => !m.ignoredBy).map((m) => `${m.mutatorName} ${m.location.start.line}`);
    expect(live).toEqual(['ArithmeticOperator 3']);
    expect(out.mutants.filter((m) => m.ignoredBy === 'arid').length).toBeGreaterThan(3);
  });
});

describe('single-file components', () => {
  it('mutates only <script> blocks, at the positions of the original file', () => {
    const src = '<template>\n  <p>{{ a + b }}</p>\n</template>\n<script setup lang="ts">\nconst x = 1 + 2;\n</script>\n';
    const out = instrument({ file: 'C.vue', source: src, mutators: ['ArithmeticOperator'], firstMutant: 0, firstSite: 0 });
    expect(out.mutants.map((m) => `${m.location.start.line}:${m.location.start.column} ${m.replacement}`)).toEqual(['5:11 1 - 2']);
    expect(out.code).toContain('{{ a + b }}');
    expect(out.code).toContain('<template>');
  });
  it('puts the runtime header in every script block', () => {
    const src = '<script context="module">\nexport const k = 1 + 1;\n</script>\n<script>\nlet n = 2 * 3;\n</script>\n';
    const out = instrument({ file: 'C.svelte', source: src, mutators: ['ArithmeticOperator'], firstMutant: 0, firstSite: 0 });
    expect(out.code!.match(/var __tzap=/g)).toHaveLength(2);
  });
  it('reads a script tag whose attributes hold a `>`', () => {
    const src = '<script setup lang="ts" generic="T extends Record<string, number>">\nconst x = 1 + 2;\n</script>\n';
    const out = instrument({ file: 'C.vue', source: src, mutators: ['ArithmeticOperator'], firstMutant: 0, firstSite: 0 });
    expect(out.errors).toEqual([]);
    expect(out.mutants.map((m) => `${m.location.start.line}:${m.location.start.column} ${m.replacement}`)).toEqual(['2:11 1 - 2']);
  });
});

describe('reductions', () => {
  const src = 'export function f(a: number, t?: number) {\n  if (t !== undefined) clearTimeout(t);\n  return a > 1 && a < 9 ? a * 2 : a;\n}\n';
  it('one-per-line keeps the most informative mutant on each line', () => {
    const out = instrument({ file: 'a.ts', source: src, reduce: { onePerLine: true }, firstMutant: 0, firstSite: 0 });
    const kept = out.mutants.filter((m) => !m.ignoredBy);
    expect(new Set(kept.map((m) => m.location.start.line)).size).toBe(kept.length);
    expect(kept.find((m) => m.location.start.line === 3)?.mutatorName).toBe('ConditionalExpression');
    expect(out.mutants.filter((m) => m.ignoredBy === 'one-per-line').length).toBeGreaterThan(0);
  });
  it('equivalence drops mutants that compile to another mutant or to the original', () => {
    const out = instrument({ file: 'a.ts', source: src, reduce: { equivalence: true }, firstMutant: 0, firstSite: 0 });
    // `if (false) clearTimeout(t)` is the same program as removing the call.
    // Nothing else is merged: every other mutant compiles to a distinct program.
    expect(out.mutants.filter((m) => m.ignoredBy).map((m) => [m.ignoredBy, m.location.start.line, m.mutatorName, m.description])).toEqual([
      ['duplicate', 2, 'CallExpression', 'compiles to the same program as another mutant (ConditionalExpression replacing t !== undefined)'],
    ]);
  });
  it('FunctionBody is outside the default set and empties whole functions', () => {
    expect(instrument({ file: 'a.ts', source: src, firstMutant: 0, firstSite: 0 }).mutants.some((m) => m.mutatorName === 'FunctionBody')).toBe(false);
    const out = instrument({ file: 'a.ts', source: `${src}const g = (x: number) => x + 1;\n`, mutators: ['FunctionBody'], firstMutant: 0, firstSite: 0 });
    expect(out.mutants.map((m) => `${m.location.start.line} ${m.replacement}`)).toEqual(['1 {}', '5 () => undefined']);
  });
});

describe('LogicalOperator keeps the grouping of a chain', () => {
  it('parenthesises the left operand when && would otherwise bind tighter', () => {
    // Stryker's mutant for the outer || of `a || b || c` is `(a || b) && c`.
    expect(inventory('x = a || b || c;', ['LogicalOperator'])).toEqual([
      'LogicalOperator 1:5 a || b || c -> (a || b) && c',
      'LogicalOperator 1:5 a || b -> a && b',
    ]);
  });
  it('needs no parentheses when || replaces &&', () => {
    expect(inventory('x = a && b && c;', ['LogicalOperator'])).toEqual([
      'LogicalOperator 1:5 a && b && c -> a && b || c',
      'LogicalOperator 1:5 a && b -> a || b',
    ]);
  });
});

describe('LogicalOperator on a chain of parenthesised operands', () => {
  it('keeps every parenthesis', () => {
    expect(inventory('x = (a && b) || (c && d) || (e && f);', ['LogicalOperator'])).toEqual([
      'LogicalOperator 1:5 (a && b) || (c && d) || (e && f) -> ((a && b) || (c && d)) && (e && f)',
      'LogicalOperator 1:5 (a && b) || (c && d) -> (a && b) && (c && d)',
      'LogicalOperator 1:6 a && b -> a || b',
      'LogicalOperator 1:18 c && d -> c || d',
      'LogicalOperator 1:30 e && f -> e || f',
    ]);
  });
});

describe('the safety net', () => {
  it('never emits code that does not parse', async () => {
    const { parse } = await import('../src/index.js');
    const src = 'const a = (x && y) || (z && w) || (q && r);\nexport const f = (n: number) => (n > 1 ? n - 1 : n + 1);\n';
    const out = instrument({ file: 'a.ts', source: src, firstMutant: 0, firstSite: 0 });
    expect(parse('a.ts', out.code!).errors).toEqual([]);
    expect(out.mutants.filter((m) => m.ignoredBy === 'placement')).toEqual([]);
  });
});
