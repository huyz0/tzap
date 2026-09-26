# Mutators and filters

A mutator decides what changes. A filter decides which of those changes are not worth running.
Both matter: an unfiltered tool reports mutants no test could reasonably catch, and each is a
permanent false alarm.

```bash
npx tzap mutators                      # the mutators
npx tzap list-mutants --format table   # the inventory, without running a test
```

## The mutators

The seventeen of StrykerJS 10, **under Stryker's names and with Stryker's rules**, so an
inventory can be compared with Stryker's mutant for mutant (see
[parity-and-benchmarks.md](parity-and-benchmarks.md)). The names are treated as public: renaming
one invalidates caches and breaks the comparison.

| Mutator | What it changes |
|---|---|
| `ArithmeticOperator` | `+`↔`-`, `*`↔`/`, `%`→`*`; not where an operand is a string or template |
| `ArrayDeclaration` | `[a, b]`→`[]`, `[]`→`["Stryker was here"]`, `new Array(n)`→`new Array()` |
| `ArrowFunction` | `x => expr` returns `undefined` instead |
| `AssignmentOperator` | `+=`↔`-=`, `*=`↔`/=`, `&&=`↔`\|\|=`, `??=`→`&&=`, ... |
| `BlockStatement` | a non-empty `{ ... }` becomes `{}` |
| `BooleanLiteral` | `true`↔`false`, `!x`→`x` |
| `CallExpression` | a call statement or `throw new X()` is removed, when nothing inside it is mutated |
| `ConditionalExpression` | `if` tests become `true`/`false`, loop tests `false`, boolean operands of `\|\|` `false` and of `&&` `true`, a `switch` case is skipped |
| `EqualityOperator` | `<`→`<=`/`>=`, `===`↔`!==`, ... |
| `LogicalOperator` | `&&`↔`\|\|`, `??`→`&&` |
| `MethodExpression` | `trim()`, `filter()`, `slice()`, `sort()`... removed; `startsWith`↔`endsWith`, `every`↔`some`, `min`↔`max`, ... |
| `ObjectLiteral` | a non-empty `{ ... }` becomes `{}` |
| `OptionalChaining` | `a?.b`→`a.b`, `f?.()`→`f()` |
| `Regex` | level-1 [weapon-regex](https://github.com/stryker-mutator/weapon-regex) mutations |
| `StringLiteral` | `"text"`→`""`, `""`→`"Stryker was here!"`; not imports, keys, directives, JSX attributes, `require`, `Symbol` |
| `UnaryOperator` | `+x`↔`-x`, `~x`→`x` |
| `UpdateOperator` | `++`↔`--` |

```bash
npx tzap run --mutators EqualityOperator,ConditionalExpression
```

### Where tzap differs from Stryker, deliberately

- **`ArrowFunction` keeps the function.** Stryker replaces `async (a, b) => expr` with
  `() => undefined`, which also changes its arity, its `async`-ness and the name a variable gives
  it — so the mutant can die for reasons that have nothing to do with the value it returns.
  tzap replaces only the returned expression. Reports keep Stryker's `() => undefined` as the
  replacement, so the two tools' reports line up, and give what actually runs in the mutant's
  `runs` field (`async (a, b) => undefined`); the type checker checks that.
- **A `case` that declares `let`/`const`/`class`/`function` is not emptied.** Wrapping it would
  change the scope of a binding other cases can see.
- **`(a ?? b) ?? c` with its outer `??` swapped becomes `(a ?? b) && c`**, parenthesised: without
  the parentheses it does not parse.

## What is never mutated

Type annotations and every type-only construct (`interface`, `type`, `enum`, `declare`,
overloads), `as` expressions and their operand (as Stryker), imports and export specifiers,
decorators, directive prologues (`"use strict"`, `"use client"`), object and class keys. In Vue
and Svelte files, only `<script>` blocks — templates are left alone.

## Disable comments

Stryker's syntax, so existing annotations carry over; `tzap` works in place of `Stryker`:

```ts
// Stryker disable next-line StringLiteral: the message is not part of the contract
throw new RangeError('percent out of range');

// tzap disable all
generatedTable();
// tzap restore all
```

Disabled mutants are reported `Ignored`, with the reason, and are outside the score.

## Arid rules: logging is not mutated

On by default. A mutant inside a logging call, or one that removes the call, is reported
`Ignored` with the reason `arid: logging`:

```ts
logger.info(`saved ${id}`);   // no mutants here
console.warn('slow path');    // nor here
```

The rules are data ([arid.ts](../packages/instrument/src/arid.ts)): `console.*`, `logger.*`/`log.*`
(also on `this`, and common logger names), and `debug(...)`. Google found the logging rule right
on 99 of 100 sampled cases, and logging noise is the most-discussed complaint about StrykerJS
(#1472). `--no-arid` turns the rules off; parity runs against Stryker use it.

## Type-invalid mutants

A mutant that does not type-check — `a?.b` becoming `a.b` on a possibly-undefined `a` — is not a
gap in the tests: the type checker already rules it out. On strict TypeScript, about 29% of
Stryker's mutants are like this. See [status.md](status.md) for tzap's `--typecheck` support.

## Reductions: fewer mutants, at a stated price

All off by default. Each makes a run faster by not reporting some real gaps, so each is reported
with what it costs, never with its speed alone. Measured on `fixtures/hazards-vitest` (57
mutants, 6 genuine survivors); `tools/bench` measures them on the larger benchmark fixture.

| Flag | What it does | Mutants run | Survivors still reported |
|---|---|---:|---:|
| (none) | the full set | 57 | 6 |
| `--dedup` | drops mutants whose file compiles (oxc transform + minify, names unmangled) to the original program, or to another mutant's | 55 | 6 |
| `--one-per-line` | keeps one mutant per line, preferring comparisons and conditions (Google's practice) | 29 | **3** |
| `--extreme` | one mutant per function: its body removed ([Descartes](https://github.com/STAMP-project/pitest-descartes)-style) | 11 | 0 |

- **`--dedup` costs nothing in detection by construction**: what it drops cannot be killed, or is
  killed exactly when its twin is. Both mutants it dropped here were real duplicates:
  `if (false) clearTimeout(t)` is the same program as removing the `clearTimeout` call. It costs
  a transform and a minify of the file per mutant.
- **`--one-per-line` stopped reporting half the gaps here.** jzap measured 34% on its benchmark.
  Google adopted it at a scale where that trade is defensible; state the number before choosing it.
- **`--extreme` answers a different question** — is this function tested at all — and found no
  untested function in a fixture whose gaps are all in *what* functions compute.
