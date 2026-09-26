# Status

What exists today, what it has been verified against, and what is not built. Every figure comes
from a harness in `tools/` or
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
| Jest 29 | the same loop, whose retries circus 29 defers to the end of the describe block | ~150 µs (Linux container, where Jest 30 measured ~490 µs) |
| node:test | a shim registering each planned test once per try; fresh test-file URLs, warm code under test | ~77–119 µs |
| Mocha 12 | Mocha's own retry loop | ~37 µs |

**The seventeen StrykerJS 10 mutators**, under Stryker's names and rules, plus `FunctionBody`
for extreme mode. JS, TS, JSX, TSX, ESM, CommonJS; Vue and Svelte `<script>` blocks.

**Diff scoping at span granularity**, from a git range (`-Local-`, `-Empty-`, `A...B`, renames
followed) or a unified diff with no repository, and **a coverage phase narrowed to the tests
whose import closure reaches the change** — the cost StrykerJS pays in full on every run.

**An incremental cache** keyed on each test's import closure: when nothing changed no test runs
at all (S5: 0.39 s against StrykerJS's 7.8 s); when something did, a verdict is reused only
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
into fresh projects outside the repository and run on Vitest, node:test, Mocha, Jest 30 and Jest 29
fixtures by `scripts/pack-smoke.mjs`. Node 22.22, 22.23, 24.21 and 26.7.

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
on anything unlisted; each accepted difference carries its evidence in that file. The three tzap
bugs it found (A1–A3) are fixed.

**Speed** — `tools/bench`, a generated 40-module, 200-test Vitest package (1,495 mutants),
Windows, median of 5 (tzap) and 3 (StrykerJS at its fastest concurrency, 10), build `a1a4249`,
9–20% background load. See [performance.md](performance.md), which also explains why S1 is
better read as 6–7x.

| Scenario | tzap | StrykerJS | Ratio |
|---|---:|---:|---:|
| S1 full run | 4.13 s | 29.41 s | **7.1x** |
| S3 10-line diff | 0.79 s | 3.53 s | **4.5x** |
| S4 same diff, warm cache | 0.19 s | — | — |
| S5 re-run, nothing changed | 0.39 s | 7.79 s | 19.9x |
| S6 one-line change, warm cache | 1.79 s | 8.77 s | 4.9x |
| S9 static-heavy | 13.07 s | 20.94 s | 1.6x |

## Speed targets

- **S1 ≥ 3x: met** (7.1x at identical inventory: 1,495 shared mutants, none unique to either
  tool; 6.3x against the previous report's StrykerJS time).
- **S3 ≥ 10x: not met**, on either suite. On the fixture (4.5x) StrykerJS's full dry run costs
  0.4 s, because its 200 tests take milliseconds: the cost the criterion targets barely exists,
  and tzap's fixed floor (a runner boot and a coverage pass) dominates. On remeda's real suite
  (2,226 tests, 15.5 s) it is 3.4x — 14.1 s against 47.5 s, up from 2.6x once coverage stopped
  repeating tests that reach no mutant and static mutants were tried in one file first — where
  the derived patch hit an internal helper most of the library goes through, so the change
  reaches 572 tests and narrowing saves little
  ([performance.md](performance.md#s3-on-a-real-suite-remeda)). What is left is mostly the
  suite's own time.

## Measured and deliberately not built

- **A resident daemon or watch mode.** Worth building only if a warm-cache diff run spending more than
  half its time on startup. It spends 0.19 s in total (S4); a daemon cannot save a tenth of that.
- **A native (Rust) instrumenter.** Worth building only if tzap's own CPU work above 10% of a run. On
  tzap's own sources it is 144 ms of 52 s (0.3%).
- **Bun and Deno runners** — [spike C](spikes/C-bun-deno.md): Bun has no programmatic test API;
  Deno has no drivable warm `deno test`. Revisit when either changes.

## Not supported yet

- **The npm registry.** The package, its bundle and its tarball are tested
  (`scripts/pack-smoke.mjs`), but it is not published; [usage.md](usage.md#install) says how to
  install it from the tarball.
- **Vitest browser mode, Angular templates, Astro, Karma.**
- **Field use.** tzap has been run on itself and on three libraries (superjson, es-toolkit,
  remeda), not yet on a long stretch of real projects' pull requests.

## Known limitations

- **The 10x diff-run target is not met**, on the benchmark fixture or on remeda's real suite (above).
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
- **A failure raised after a test's last `afterEach`** (in an `afterAll`, or by a timer that
  fires between tests) is not attributed to the try that caused it in a warm Vitest session.
  A mutant that only such a failure detects is still reported correctly when it is static (it
  runs isolated) or when survivor verification re-runs it in a fresh session; with
  `--verify-survivors none` it can be reported Survived.

## Running the checks

```bash
pnpm build && pnpm test                       # every runner, warm against reference
pnpm check:boundaries                         # the package graph against the imports
pnpm check:size                               # no file over 700 lines, no folder over 20 files
pnpm coverage                                 # line coverage, workers and runner processes; gate 95%
node packages/tzap/dist/bin.js run --model dogfood.model.json   # tzap on its own model, instrument and report
node scripts/pack-smoke.mjs                   # the published package, from its tarball
cd tools/parity && node compare.mjs           # the StrykerJS comparison (after run.mjs)
node tools/bench/bench.mjs                    # the benchmark scenarios
node tools/bench/s3-corpus.mjs                # S3 on remeda (after tools/parity fetch.mjs remeda)
```
