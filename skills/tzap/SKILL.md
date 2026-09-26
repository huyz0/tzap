---
name: tzap
description: Run mutation testing on TypeScript or JavaScript with tzap to find tests that execute code without asserting anything. Use when asked to check whether tests are meaningful, find weak or missing assertions, verify a change is actually tested, or act on surviving mutants. Also covers reading tzap output and its exit codes.
---

# Mutation testing with tzap

Coverage says a line ran. Mutation testing says whether anything was **asserted** about it. tzap
changes the code in small ways — flips a comparison, swaps an operator, empties a block — and
reports each change the test suite fails to notice. Every survivor is a specific, fixable gap.

## Always scope to the change

A full run analyses every mutant in the package. A diff-scoped run analyses only changed lines,
runs only the tests that can reach them, and produces output you can act on.

```bash
npx tzap run --from HEAD -r agent -q                      # uncommitted work
npx tzap run --from origin/main --to -Local- -r agent -q  # the whole branch, committed or not
```

The range only *selects* what to analyse. The analysis always runs against the files on disk;
nothing is checked out. Save your edits first.

## Always use `-r agent`

The default reporter is shaped for a human. `-r agent` prints only the findings, one per line,
with no source snippets, killed mutants or timings.

## Reading the output

```
tzap: 2 survived, 3 uncovered of 12 mutants (score 58.3%, strength 77.8%)

survived:
src/discount.ts
  10 EqualityOperator replaced percent > 50 with percent >= 50
  17 ConditionalExpression replaced price === 0 with true

uncovered:
src/strings.ts
  7 StringLiteral replaced '!' with ""
```

- **`survived`** is the actionable list. A test runs that line and would not notice the change.
  Open the file at that line and add or strengthen an assertion.
- **`uncovered`** means no test runs the line at all: a coverage gap, lower priority.
- **`baseline-failures`**, if present, comes first and invalidates everything else: a test fails
  with no mutant applied. Fix those tests and re-run; do not act on the findings.

## How to fix a survivor

Assert the thing that distinguishes the original from the mutant.

| Mutator | What the test is missing |
|---|---|
| `EqualityOperator` `>` became `>=` | a case exactly *at* the boundary |
| `ConditionalExpression` became `true`/`false` | a case that takes the other branch |
| `ArithmeticOperator` | an assertion on the computed value, not just that it ran |
| `LogicalOperator` | a case where the two operands differ |
| `BlockStatement` / `CallExpression` removed | an assertion on the block's or call's *effect* |
| `StringLiteral` | an assertion on the string, or a reason it does not matter |
| `ObjectLiteral` / `ArrayDeclaration` emptied | an assertion on the contents |
| `MethodExpression` (`trim`, `filter`, `sort` removed) | input where the method changes the result |
| `OptionalChaining` `?.` became `.` | a case where the value is `null`/`undefined` |
| `BooleanLiteral` | an assertion on the boolean in both states |

The fix is nearly always an assertion in an existing test, not a new test. If a survivor is
genuinely unobservable, say so rather than asserting an implementation detail to silence it; a
`// tzap disable next-line MutatorName: reason` comment records that decision.

Re-run after changing the tests to confirm the mutant is killed.

## Verdicts

| Status | Meaning |
|---|---|
| `Killed` | a test failed: the suite detects this fault |
| `Survived` | covered, and every test passed: an undetected fault |
| `NoCoverage` | no test runs the line |
| `Timeout` | the mutant made a test hang; counted as detected |
| `CompileError` | the type checker rejects the mutant: not a test gap |
| `RuntimeError` | the analysis broke: a tzap or environment problem, not a finding |
| `Ignored` | a disable comment or an arid rule (logging) excluded it |

**Mutation score** is detected over all valid mutants; **test strength** is the same over covered
mutants only, and is the better number for judging the tests themselves.

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| `0` | met its bar | nothing |
| `1` | below `--threshold`, or survivors with `--fail-on-survivors` | act on the findings |
| `2` | usage error | fix the command |
| `3` | the analysis failed | not a finding about the tests; report it |

## When output is empty or wrong

Run `npx tzap run --dry-run` first: it prints the packages, runner and files in scope.

- **No mutants.** On a diff run this is normal: the changed lines carry no mutants.
- **Everything uncovered, and a warning that tests never reach a package's source.** The tests
  import that package's built `dist/`; point its `exports` at the source for tests.
- **In CI, nothing in scope.** `actions/checkout` clones one commit; use `fetch-depth: 0`.

## Cost

A diff-scoped run on a typical change takes seconds. A full run on a large package is minutes. Do
not run a full analysis unless asked; `--cache-dir .tzap/cache` makes re-runs reuse every verdict
that provably still holds.
