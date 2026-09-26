# Status

What exists today, what it has been verified against, and what is not built. Milestone numbers
refer to [delivery-plan.md](delivery-plan.md); every figure comes from a harness in `tools/` or
a test, and is reproducible from the commands at the end.

## Working

**The full pipeline, end to end.** Discover the project, parse each source file with oxc,
generate mutants, compile them all into one instrumented copy delivered through the project's
own pipeline (no sandbox copy), run a coverage pass, try each mutant against the tests that
reach it in warm runs of the real test runner, confirm what needs confirming in isolated runs,
and report. `npx tzap run`.

**Four test runners**, each measured, each with warm and reference engines agreeing mutant for
mutant on its fixtures, and each reaching the same verdicts as the others on the same code:

| Runner | How many mutants one run tries | Cost per try |
|---|---|---|
| Vitest 4.1, 5 | Vitest's `repeats`, driven from public hooks ([spike A](spikes/A-vitest-rerun.md)) | ~56 µs |
| Jest 30 | jest-circus's own retry loop, from a custom environment ([spike B](spikes/B-jest-warm.md)) | ~80–180 µs |
| node:test | a shim registering each planned test once per try; fresh test-file URLs, warm code under test | ~77–119 µs |
| Mocha 12 | Mocha's own retry loop | ~37 µs |

**The seventeen StrykerJS 10 mutators**, under Stryker's names and rules, plus `FunctionBody`
for extreme mode. JS, TS, JSX, TSX, ESM, CommonJS; Vue and Svelte `<script>` blocks.

**Diff scoping at span granularity**, from a git range (`-Local-`, `-Empty-`, `A...B`, renames
followed) or a unified diff with no repository, and **a coverage phase narrowed to the tests
whose import closure reaches the change** — the cost StrykerJS pays in full on every run.

**An incremental cache** keyed on each test's import closure: when nothing changed no test runs
at all (S5: 0.30 s against StrykerJS's 7.4 s); when something did, a verdict is reused only
while the tests that decided it cannot see the change.

**Monorepos**: a test-less library's mutants killed by another package's tests; a root
`test.projects` config; a warning when tests reach a package only through its built output.

**Type-aware viability**, `--typecheck survivors` by default when the project has TypeScript:
TypeScript 7's API (TS 6 fallback), grouped checks agreeing with one-at-a-time on 3,080 of 3,080
mutants at 5 ms per mutant, and syntactic rules at 99.6–100% precision. 27.5% of the mutants in
tzap's own sources are type-invalid, in line with the 28.9% measured on Stryker's.

**Noise and reduction**: logging calls are arid by default; `--dedup`, `--one-per-line` and
`--extreme` are opt-in, each with its detection loss published in [mutators.md](mutators.md).

**Eight reporters**: console, agent, native JSON, mutation-testing-elements (validated against
the published schema, rendering in the standard viewer), self-contained HTML, GitHub
annotations, SARIF, markdown. Exit codes 0/1/2/3 as jzap's.

**One published package**: the internal packages bundled into `tzap`, installed from its tarball
into fresh projects outside the repository and run on Vitest, node:test and Mocha fixtures by
`scripts/pack-smoke.mjs`; Jest checked the same way by hand. Node 22.23, 24.21 and 26.7.

### Soundness, and what it took

A warm engine reuses a module across mutants; everything below exists because a fixture or a real
library showed the warm engine disagreeing with the reference one, and each disagreement was a
defect:

- **Control tries** bracket every test's mutant tries; when a control fails, the tries are
  repeated one behind each control, so a mutant that corrupts a module's state (superjson's
  transformer registry) is measured cleanly and so is everything after it.
- **Unreached tries** — the mutant never ran, whatever the test did — decide nothing.
- **Coverage runs every test twice**: a test that takes a different path the second time depends
  on leftover state, and its warm verdicts are not used.
- **Warm survivors are confirmed in isolation** when their tests reach module-level state
  (`--verify-survivors auto`): on superjson 14 of 82 warm survivors were masked by a
  registration an earlier run of the same test left behind.
- **Static mutants** — reached while modules load — are decided with the mutant active from the
  start, packed one per test file per run and run in parallel, with a loop guard measured from
  the unmutated files' loading. A hybrid shortcut through the warm engine was tried and removed:
  a test comparing against a value computed at load sees two programs where there is one.
- **Hangs** are stopped by counting loop iterations, not by the clock; the wall-clock backstop
  fires on silence read from per-worker progress files, and names the try.
- **Unhandled errors** a mutant causes fail the run: decided in isolation, reported Killed.

## Measured against StrykerJS

**Correctness** — `tools/parity`, StrykerJS 10.0.0 and tzap over the same corpus and Vitest
version, every difference classified in `tools/parity/parity-baseline.yaml` and the gate failing
on anything unlisted. See [tools/parity/reports/](../tools/parity/reports/) for the per-project
reports; the three tzap bugs it found (A1–A3) are fixed.

**Speed** — `tools/bench`, a generated 40-module, 200-test Vitest package (1,495 mutants),
Windows, median of 5 (tzap) and 3 (StrykerJS at its fastest concurrency, 10), on a quiet
machine. See [performance.md](performance.md).

| Scenario | tzap | StrykerJS | Ratio |
|---|---:|---:|---:|
| S1 full run | 8.18 s | 26.04 s | **3.2x** |
| S3 10-line diff | 1.47 s | 4.87 s | **3.3x** |
| S4 same diff, warm cache | 0.19 s | — | — |
| S5 re-run, nothing changed | 0.29 s | 7.27 s | 24.9x |
| S6 one-line change, warm cache | 2.98 s | 7.51 s | 2.5x |
| S9 static-heavy | 18.84 s | 23.43 s | 1.2x |

## Kill criteria

- **S1 ≥ 3x: met** (3.2x at identical inventory: 1,495 shared mutants, none unique to either
  tool). The margin is thin: most of a full run is now fixed cost plus the isolated runs that
  keep verdicts sound (static mutants, survivors whose tests can reach module state).
- **S3 ≥ 10x: not met** (3.3x). On this fixture StrykerJS's full dry run costs 0.4 s, because
  its 200 tests take milliseconds; the cost the criterion targets barely exists, and tzap's own
  fixed floor (a runner boot and a coverage pass) dominates. The criterion assumed a suite whose
  dry run is expensive. It stays recorded as failed on the evidence available; a diff run on a
  corpus project with a real suite is the measurement that would settle it.

## Measured and deliberately not built

- **M21, a resident daemon or watch mode.** Its gate: a warm-cache diff run spending more than
  half its time on startup. It spends 0.19 s in total (S4); a daemon cannot save a tenth of that.
- **M22, a native (Rust) instrumenter.** Its gate: tzap's own CPU work above 10% of a run. On
  tzap's own sources it is 144 ms of 52 s (0.3%).
- **Bun and Deno runners** — [spike C](spikes/C-bun-deno.md): Bun has no programmatic test API;
  Deno has no drivable warm `deno test`. Revisit when either changes.

## Not built yet

| Missing | Where it belongs |
|---|---|
| Publishing to npm — the bundle and tarball are verified, but publishing needs the owner's npm account | M24 |
| CI runs — the workflow is written; the repository has no remote yet | M0 |
| A 30-day dogfood on external projects (tzap has been run on itself and on three libraries) | M24 |
| Jest 29, Vitest browser mode, Angular templates, Astro, Karma | M17, M19 |
| node:test: a test file's top-level `before`/`after` run once per run, not once per file (isolation none) | M16 |

## Known limitations

- **S3's criterion is unmet** on the benchmark fixture (above).
- **Type-invalid mutants the tests killed** still count as detected under `--typecheck survivors`
  (the default); `--typecheck all` removes that bias at the cost of checking every mutant.
- **`--verify-survivors auto` assumes third-party packages hold no state a project mutant
  writes to.** A project function that registers with a library-level singleton and a mutant
  that removes that call could survive masked; `--verify-survivors all` closes it.
- **Killed and Timeout can trade places** between the warm and reference engines for a mutant
  that some test fails and another hangs on: which one reports first depends on test order.
  Both are detected, and both count the same in the score.
- **Arrow functions**: coverage counts when the body runs, not when the arrow is created, so an
  arrow no test calls is NoCoverage where StrykerJS says Survived (parity class C3).

## Running the checks

```bash
pnpm build && pnpm test                       # 200 tests, every runner, warm against reference
node scripts/check-boundaries.mjs             # the package graph against the imports
node scripts/pack-smoke.mjs                   # the published package, from its tarball
cd tools/parity && node compare.mjs           # the StrykerJS comparison (after run.mjs)
node tools/bench/bench.mjs                    # the benchmark scenarios
```
