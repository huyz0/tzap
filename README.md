# tzap

Fast, diff-aware mutation testing for TypeScript and JavaScript.

Mutation testing measures whether your tests would actually notice a bug. tzap changes your code
in small, realistic ways — flips a comparison, swaps an operator, empties a block — runs your
tests against each change, and reports every change they fail to catch. Each survivor is a
specific line where a bug could hide from your tests.

It is the TypeScript sibling of [jzap](https://github.com/huyz0/jzap), built the same way:
StrykerJS as the correctness oracle, every speed feature checked against a slow reference
engine, every number reproducible. See [docs/status.md](docs/status.md) for exactly what exists.

```bash
npm install --save-dev tzap
npx tzap run                                  # the whole package
npx tzap run --from origin/main --to -Local-  # only the lines this branch changed
```

```
Surviving mutants (6):
  src/discount.ts
    line 5: replaced percent > 50 with percent >= 50 [EqualityOperator]
      if (percent > 50) {
    line 12: replaced price === 0 with true [ConditionalExpression]
      return price === 0;
  ...
Mutation score 75.7% (test strength 82.4%, ignoring uncovered mutants)
```

## What it runs

- **Vitest** (4.1, 5), **Jest** 30, **node:test**, **Mocha** — your own runner, resolved from your
  project, driven warm: the code under test loads once and a mutant is a number written to a
  global. Many mutants run in one invocation of the runner, through each runner's own repeat or
  retry loop.
- TypeScript, JavaScript, JSX/TSX, ESM and CommonJS; **Vue** and **Svelte** components' scripts.
- Single packages and **monorepos**, where a library's mutants are killed by the tests of the
  packages that use it.

## Why it is fast

- **Warm execution**: ~40–180 µs per mutant try once a runner is up, against a runner restart per
  mutant in StrykerJS's Jest path and a re-run of the test files in its Vitest path.
- **Diff-first**: a pull request run mutates only the changed lines *and* runs coverage only for
  the tests whose imports can reach them.
- **Kill-test-first** ordering and early exit in every runner, including Jest.
- **An incremental cache** keyed on each test's import closure: nothing changed, no test runs.

Measured on a generated 40-module package against StrykerJS 10 at its fastest setting:
**6.5x faster on a full run, 25x on a re-run with nothing changed** — and, where tzap does not
win by much, it says so: a 10-line diff on that package is only ~1.3x, because StrykerJS's dry
run there costs 0.4 s. Every number, with its method, is in
[docs/performance.md](docs/performance.md).

## Why you can trust the verdicts

- **StrykerJS parity**: on es-toolkit, superjson and remeda, tzap and StrykerJS agree on
  97–99.9% of the mutants both generate, and every remaining difference is classified — a
  StrykerJS limitation, a deliberate difference, or nondeterminism — in
  `tools/parity/parity-baseline.yaml`. The gate fails on anything else.
- **A reference engine**, one fresh process per mutant with nothing reused, kept forever:
  every fixture, including one written to break warm engines, gives identical verdicts under both.
- **Warm survivors are confirmed**: a survivor whose tests touch module state is re-decided in
  isolation before it is reported — on superjson, 14 of 82 warm survivors turned out to be
  masked by state a previous run of the test had left behind.
- **Type-invalid mutants are not gaps**: with TypeScript, mutants the type checker rejects are
  `CompileError`, outside the score (`--typecheck survivors|all|off`).

## Output

`console` (default), `agent` (findings only, for coding agents), `json`, `elements` (the
mutation-testing-elements schema StrykerJS uses, so its HTML viewer and dashboard work),
`html`, `github` (annotations), `sarif`, `markdown`. Exit codes: 0 met the bar, 1 did not, 2
usage error, 3 the analysis failed.

```bash
npx tzap run -r agent -q          # what a coding agent should read
npx tzap run -r html -o reports   # the standard mutation-testing viewer
```

## Documentation

- [docs/usage.md](docs/usage.md) — install, run, scope to a diff, reports, CI, monorepos
- [docs/mutators.md](docs/mutators.md) — the mutators, what is never mutated, disable comments, arid rules, reductions
- [docs/status.md](docs/status.md) — what works, what was measured, what is not built
- [docs/performance.md](docs/performance.md) — every published number and how it was taken
- [docs/troubleshooting.md](docs/troubleshooting.md) — the failures people hit
- [docs/compatibility.md](docs/compatibility.md) — runners, Node, frameworks, as tested
- [docs/architecture.md](docs/architecture.md), [docs/delivery-plan.md](docs/delivery-plan.md), [docs/research/](docs/research/README.md) — how it was designed, and why

## Developing

```bash
pnpm install && pnpm build && pnpm test       # every runner, warm against reference
node scripts/pack-smoke.mjs                   # the published package, from its tarball
cd tools/parity && node compare.mjs           # the StrykerJS comparison
node tools/bench/bench.mjs                    # the benchmarks
```

## Licence

Apache License 2.0.
