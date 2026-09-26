# tzap delivery plan

25 milestones in 7 phases, from an empty repository to a published 1.0. Each milestone states a
goal, a binary definition of done, and a task list. Every milestone from M6 onward is gated on the
StrykerJS parity harness in [parity-and-benchmarks.md](parity-and-benchmarks.md).

Architecture and package names come from [architecture.md](architecture.md); technique choices
from [research/](research/README.md); the language choice from
[ADR 0001](adr/0001-implementation-language.md). The method is
[jzap's](https://github.com/huyz0/jzap/blob/main/docs/delivery-plan.md), including its lessons,
which are cited where they changed this plan before it started.

## Sequencing rationale

1. **Correctness before speed.** A slow, obviously-correct reference engine (M6) ships before any
   optimisation and is kept forever as the thing every optimisation is differentially tested
   against. Optimising an engine whose verdicts cannot be trusted produces fast wrong answers.
2. **The oracle comes early.** The Stryker parity harness (M4) and benchmark harness (M7) exist
   before the work they measure.
3. **De-risk the unknowns first.** M1 is timeboxed spikes on the five questions the architecture
   rests on. If one fails, the design changes while that is still cheap.
4. **One runner end to end before breadth.** Vitest carries the whole engine through Phase 3.
   A second runner before then would double the surface every bug has to be fixed on.
5. **Diff scoping is the product, not a feature.** It is built as soon as the reference engine
   exists (it may run in parallel with Phase 2) and ships in the first release.
6. **Warm execution is not an afterthought.** jzap added parallelism late and recorded that it
   should not have. Here the warm pool is M8a, the first speed milestone.

## Kill criteria

Checked at M9 and again at M13. If, at equal mutant inventory (the mapped intersection, tzap's
extra filters off):

- tzap is not **≥3x faster than StrykerJS** on a full Vitest package run (S1), **and**
- tzap is not **≥5x faster** on a full Jest package run (S2, once M17 exists; M9 checks S1 and S3
  only), **and**
- tzap is not **≥10x faster** on a cold PR-sized diff run (S3) against Stryker given the same diff
  as `--mutate` line ranges,

then the performance premise has failed and the project should be reconsidered, not continued on
momentum. The thresholds are higher than jzap's (2x and 5x against PIT) because the research
located the waste precisely: Stryker pays runner boot per mutant, has no bail in Jest, and runs
the whole suite's dry run for a one-line change. If tzap cannot recover a large multiple of that,
the thesis is wrong. Record the measurement either way.

## Delivery status

Where every milestone stands, as built. The milestone text below is the plan as written before
building; what building it changed is recorded at the end rather than edited in.

| Milestone | Status |
|---|---|
| M0 Skeleton & CI | **Done**, CI unrun: workspace, boundary check against imports, zero-import runtime, pack-and-install smoke test; the CI workflow is written but the repository has no remote yet |
| M1 Risk spikes | **Done**: [A](spikes/A-vitest-rerun.md) Vitest (found the `repeats` path, ~56 µs/try), [B](spikes/B-jest-warm.md) Jest (jest-circus retry loop), C transparency (a sweep of 696,278 mutants over 2,536 files, all parsing), D static mutants (packed per-file runs), E TypeScript 7 (unstable API, 5 ms/mutant grouped) |
| M2 Model, discovery, CLI | **Done**: schema v1, validation with field-level messages, pnpm/npm/yarn workspaces, root `test.projects`, `--dry-run` |
| M3 Inventory | **Done**: Stryker's seventeen mutators under Stryker's names, disable comments, stable ids, hand-written expectations |
| M4 Parity harness (inventory) | **Done**: `tools/parity`, Tier A and three Tier B libraries pinned by commit, gate in both directions |
| M5 Instrumentation + Vitest + coverage | **Done**: schemata by span splicing, runtime shim, Vite plugin delivery, per-test coverage run twice |
| M6 Reference kill loop | **Done**: `--engine reference`; parity 96.6–99.9% on real libraries, every difference classified |
| M7 Bench harness | **Done**: `tools/bench`, S1/S3/S4/S5/S6/S9; S2/S7/S8 declared; RSS and CPU-seconds not yet collected |
| M8a/b Warm pool, schemata switching | **Done** differently: many mutants per runner invocation through the runner's own repeat/retry loop, instead of a worker pool the engine owns |
| M9 Selection, ordering, hangs | **Done**: covering tests only, previous killer first, early exit everywhere, loop and hit counting, silence backstop |
| M10 Static mutants | **Done**: packed one per test file per run, parallel lanes, load-time loop limits |
| M11 Incremental cache | **Done**: import-closure keys, static survivors reusable; S5 0.30 s |
| M12 Type-aware viability | **Done**: `--typecheck`, grouped checking, measured syntactic rules |
| M13 Reduction and noise | **Done**: arid logging rules on by default; `--dedup`, `--one-per-line`, `--extreme` with detection loss |
| M14 Diff scoping | **Done**: git and patch scoping, coverage narrowed to tests that can import the change |
| M15 Reporters + 0.1 | **Done** except publishing: eight reporters; the package is bundled and smoke-tested from its tarball; `npm publish` needs the owner's account |
| M16 node:test | **Done** |
| M17 Jest | **Done** (Jest 30; 29 refused with a message) |
| M18 Mocha; Bun/Deno | **Done**: Mocha 12; [Bun and Deno: not now](spikes/C-bun-deno.md) |
| M19 Frontend | **Done** for React/TSX, Vue, Svelte under jsdom; Angular templates and Astro not |
| M20 Monorepo | **Done** |
| M21 Daemon/watch | **Closed by measurement**: a warm-cache diff run takes 0.19 s in all |
| M22 Native instrumenter | **Closed by measurement**: tzap's own CPU work is 0.3% of a run |
| M23 Published comparison | **Done** for StrykerJS on the fixtures and corpus here; no third-party reproduction yet |
| M24 1.0 hardening | **Partly**: docs, compatibility, versioning, diagnostics, GitHub Action, agent skill; not published, no 30-day external dogfood |

## Release train

| Release | After | Contents |
|---|---|---|
| 0.1 | M15 | Vitest, Node environment, TS/JS/TSX, full and diff runs, cache, reports incl. agent and PR annotations |
| 0.2 | M17 | node:test and Jest |
| 0.3 | M20 | Frontend (jsdom/happy-dom, Vue, Svelte), monorepo single run, Mocha |
| 1.0 | M24 | Published comparison, hardening, GitHub Action, dogfood |

---

# Phase 0 — Foundations

## M0 · Repository skeleton and CI

**Goal.** A pnpm workspace that builds, tests and lints on three operating systems and three Node
versions, with the package boundaries from [architecture.md](architecture.md) enforced from the
first commit.

**Definition of done.**
- `pnpm install && pnpm build && pnpm test` green from a clean clone with Node and pnpm only.
- Packages exist and compile: `@tzap/model`, `@tzap/runtime`, `@tzap/protocol`,
  `@tzap/instrument`, `@tzap/core`, `@tzap/git`, `@tzap/report`, `@tzap/discover`,
  `@tzap/runner-vitest`, `tzap`. Empty is fine; boundaries are not.
- Dependency rules enforced by a build check that fails on violation: `model`, `runtime` and
  `protocol` import nothing; `core` imports no runner package, no `git`, no `report`.
- `@tzap/runtime` zero-dependency test: its built bundle is walked and any `import`/`require`
  fails the build.
- CI matrix: Node 22, 24, 26 × Linux, macOS, Windows. Windows is first class from day one, since
  it is where process spawn is most expensive and paths are least forgiving.
- `tzap --version` runs from the packed tarball (`pnpm pack`, installed into a temp project), not
  only from the workspace — the test that catches missing `files` and broken `exports`.
- TypeScript strict, ESM-only, Biome or ESLint + Prettier in CI, Vitest for tzap's own tests.
- Licence (Apache-2.0, matching jzap), `CONTRIBUTING.md`.

**Tasks.**
- Workspace, tsconfig references, build (tsdown or tsc), `exports` maps.
- Boundary check (dependency-cruiser rules) and the runtime-bundle import walk.
- CI workflow with the matrix; pack-and-install smoke test.
- Decide and record: minimum Node for *running* tzap (22.12) versus the syntax and runtimes it
  can *analyse* — different numbers, and conflating them causes support pain.

## M1 · Risk spikes (timeboxed, one week hard stop)

**Goal.** Answer the five unmeasured questions the architecture rests on, before anything
depends on them.

**Definition of done.** A written spike report per question with runnable throwaway code, a
go/no-go, and [architecture.md](architecture.md) updated or an ADR opened for anything that
contradicts it.

- **Spike A — Vitest warm re-run cost.** Vitest 5 in a sample repo, `isolate: false`, threads
  pool; re-run one test by id 1,000 times through `createVitest` + `TestSpecification.testIds`, and
  separately through `@vitest/runner` driven from tzap's own worker. **Output: per-re-run cost of
  each path. Above ~5 ms for hosted Vitest, the adapter drives `@vitest/runner` directly.** This is
  the single most important number in the plan.
- **Spike B — Jest warm hosting.** Host jest-circus + jest-runtime for one test file in a
  long-lived worker and re-run a test after flipping a global. **Output: feasible or not on
  Jest 30, which internals it touches, and the fallback (per-file `runCLI` with a warm pool) with
  its measured cost.**
- **Spike C — Instrumentation transparency.** oxc + magic-string schemata pass over every source
  file of three Tier B candidates; run each project's own suite on the instrumented, unmutated
  code. **Output: pass rate (target 100%) and the list of constructs that broke.** Includes the
  exponential-clone trap as a regression test.
- **Spike D — Static mutants under ESM.** A fixture with 50 top-level constants imported by ten
  test files. Compare: fresh worker per static mutant; epoch-query re-import of the subgraph;
  `vm.SourceTextModule` re-link. **Output: cost per static mutant and memory growth per strategy.**
- **Spike E — Type checking with TypeScript 7.** Through `typescript/unstable/*`: check 1,000
  mutants of a strict project one at a time, grouped by non-interaction, and survivors-only.
  **Output: cost per mutant per mode, against Stryker's checker on the same mutants.**

**Tasks.** One throwaway prototype per spike in `spikes/` (deleted once reports are written);
reports in `docs/spikes/`; architecture updates and ADRs.

## M2 · Project model, discovery and CLI contract

**Goal.** The seam is real and versioned before anything consumes it.

**Definition of done.**
- JSON Schema for the project model v1 published from `@tzap/model`; TypeScript types generated
  from it, not hand-maintained alongside it.
- Round-trip tests: parse → serialise → byte-identical.
- Validation errors name the field, the expected shape and the actual value.
- Forward compatibility: unknown fields warn; an unknown `schemaVersion` major is fatal with
  advice.
- `tzap model` (discovery) produces a model for: a single-package Vitest project, a pnpm
  workspace, an npm workspace, a yarn workspace — reading `package.json` workspaces,
  `pnpm-workspace.yaml`, tsconfig (with `extends` and `references`), and `vitest.config.*` /
  `vitest.workspace` / projects.
- `tzap run --dry-run` prints resolved packages, source and test files, runner and version, scope,
  and exits 0 with no analysis.
- Hand-written models committed for three shapes: single package, monorepo, JS-only CJS package.
- `@argfile` support and model-by-file everywhere (Windows command-line limits).
- Config file `tzap.config.{ts,js,json}` merged over discovery, with the precedence documented.

**Tasks.**
- Schema, types, validator, round-trip tests.
- Workspace, tsconfig and runner discovery; conformance test (discovery vs hand-written model).
- CLI parsing, `--dry-run`, config loading.

---

# Phase 1 — A correct engine

## M3 · Mutant inventory

**Goal.** Enumerate mutation points from source with stable identities. No execution.

**Definition of done.**
- oxc-parser adapter (raw transfer) with a Babel fallback behind the same interface, chosen per
  file on parse failure and reported.
- All seventeen StrykerJS 10 mutators implemented **with Stryker's names and semantics**,
  including the 10.0 `CallExpression` nesting rule and StringLiteral's skip list
  ([research/stryker-js.md §3](research/stryker-js.md)).
- Never-mutate positions from [architecture.md](architecture.md) enforced, each with a fixture.
- `// Stryker disable` / `// tzap-disable` comments honoured (next-line, line ranges, per mutator),
  so existing Stryker users keep their annotations.
- Stable mutant ids per [architecture.md](architecture.md) — survive edits elsewhere in the file,
  asserted by editing fixtures and re-inventorying.
- `tzap list-mutants` emits normalised JSON and a table.
- Deterministic: same sources, identical list and order, asserted.
- `tools/parity/mutator-mapping.yaml` committed.
- Tier A fixtures per mutator with **hand-written** expected mutant lists, never copied from any
  tool's output.
- TSX/JSX parsed and mutated; JSX attribute strings excluded as Stryker does.

**Tasks.**
- Parse adapter; mutator SPI; the seventeen mutators; position rules; ignore comments.
- Mutant id scheme with documentation of its invalidation rules; stability tests.
- `list-mutants`; Tier A inventory fixtures.

## M4 · Stryker parity harness — inventory level

**Goal.** Automated, reproducible inventory comparison against StrykerJS, available to every
later milestone.

**Definition of done.**
- `tools/parity` runs both tools over a corpus tier and emits `tzap-only` / `stryker-only` /
  `shared`, grouped by cause.
- Both tools' output parsed by one mutation-testing-elements reader into one normalised record.
- Tier A (~50 fixtures) and Tier B (≥4 real projects to start) pinned in `corpus.lock`, including
  runner versions.
- `parity-baseline.yaml` gate in CI in both directions (new disagreement fails; vanished
  baselined disagreement fails).
- A human-readable triage report per run with every difference classified A/B/C/D.
- Documented: how to add a corpus project, how to accept a baseline change.

**Tasks.**
- Corpus fetch and pin tooling; Stryker runner at the pinned configuration from
  [parity-and-benchmarks.md](parity-and-benchmarks.md).
- Normaliser, comparator, triage renderer, baseline gate.
- Triage the first real diff to zero unclassified entries.

## M5 · Instrumentation, the Vitest adapter, and per-test coverage

**Goal.** Deliver instrumented code through Vitest and record, per test, which mutant sites ran.

**Definition of done.**
- Schemata codegen for the three placements (expression, statement, switch case) with
  magic-string, original operand text in every branch, and composed source maps.
- `@tzap/runtime`: `__tz.a`, `Uint32Array` counters sized per run, loop back-edge guard with a
  sticky flag, `hang()`, all dependency-free.
- Vitest delivery via an `enforce: 'pre'` plugin, and via `module.registerHooks` when
  `viteModuleRunner: false`. The path chosen is recorded in the report.
- The Vitest adapter implements the RunnerAdapter SPI using Spike A's winning path: boot once,
  discover stable test ids, run by id, test-boundary callbacks.
- Coverage phase produces mutant → [(test id, hits, loop iterations, duration)], plus the set of
  **static** mutants (counters moved with no current test).
- **Transparency gate:** every Tier A and Tier B project's suite passes instrumented and
  unmutated exactly as uninstrumented. In CI.
- A red baseline is detected: a test failing before any mutant is active is excluded from
  selection and reported with its failure, never allowed to "kill" mutants.
- Duplicate test names detected and reported; ids stay unambiguous.
- Coverage deterministic given a fixed test order; order controlled and recorded.
- Hazard fixtures pass: TDZ, hoisting, class fields, generators, async, decorators (as static),
  top-level await, circular imports, fake timers.

**Tasks.**
- Codegen and runtime; source-map composition tests (position of every mutant maps back exactly).
- Vite plugin and loader-hook delivery; Vitest adapter; coverage model and serialisation.
- Transparency CI job over the corpus; red-baseline handling.

## M6 · Reference kill loop — the correctness baseline

**Goal.** A complete, obviously-correct mutation run. Slow is expected.

**Definition of done.**
- One fresh worker process per mutant, all covering tests in discovery order, no reuse, no
  caching, stop at first failure. Retained permanently behind `--engine=reference`.
- Static mutants: fresh process, all test files in the package.
- Hangs: per-test wall-clock budget from coverage timings (factor × baseline + constant), process
  killed on expiry, status `Timeout`.
- Full status set produced: `Killed`, `Survived`, `NoCoverage`, `Timeout`, `RuntimeError`
  (analysis broke — e.g. mutant makes a module throw at load outside any test), `Ignored`
  (filters, with the reason); `CompileError` arrives with M12.
- **Verdict parity vs Stryker on Tier A and Tier B: 100% agreement on shared mutants, modulo
  entries justified in `parity-baseline.yaml`.** Zero unclassified disagreements; every
  `Killed`/`Survived` disagreement resolved before the milestone closes.
- Killing-test (`killedBy`/`coveredBy`) comparison run and triaged.
- Exit codes: 0 met the bar, 1 threshold or `--fail-on-survivors`, 2 usage error, 3 analysis
  failed (any `RuntimeError`).

**Tasks.**
- Controller, process lifecycle, kill and retry with the retry recorded.
- Status determination; mutation-testing-elements writer (needed for the harness now).
- Extend the parity harness to verdicts and killing tests; triage; Tier A fixtures wherever the
  cause is a Stryker limitation.

## M7 · Benchmark harness and an honest baseline

**Goal.** Know exactly how slow the reference engine is, and have the apparatus that will
measure every later claim.

**Definition of done.**
- `tools/bench` implements S1–S9 from [parity-and-benchmarks.md](parity-and-benchmarks.md);
  scenarios needing later milestones are declared and skipped with the reason.
- Metrics per scenario: phase-split wall clock, mutants generated and executed, test executions
  per mutant, worker boots, mutants/s, peak RSS, CPU-seconds, process/thread count.
- Five runs, median with min–max. A single number is rejected by the report renderer.
- Stryker baselines recorded: default + `perTest`, `--incremental`, and `--mutate` ranges for S3.
- tzap fills the elements report's `performance` block and per-mutant `duration`.
- Both tools' configuration checked in.
- CI gates on machine-independent metrics with budgets in `budgets.yaml`.
- A published baseline stating, without spin, how the reference engine compares to Stryker.
- The S3 guard: target lines derived from the inventory; no figure printed when nothing is in scope.

**Tasks.**
- Scenario runner; metric collection (`--cpu-prof` hooks for phase attribution).
- Quiet-machine procedure documented; Windows and Linux reported separately.
- Report renderer; CI gates; publish the baseline.

---

# Phase 2 — Speed

Every milestone here carries two standing gates in addition to its own:

- **Self-differential:** identical verdicts to `--engine=reference` on Tier A and Tier B, with the
  optimisation on and off.
- **Determinism:** same model + same sources + same lockfile → byte-identical report outside the
  timing block.

## M8 · Warm execution

### M8a · Warm worker pool

**Goal.** Pay runner, environment and SUT boot once per worker, not once per mutant.

**Definition of done.**
- `worker_threads` pool; each worker boots the adapter once and serves
  `{mutantId, orderedTestIds, hitLimit, budgetMs}` requests over `@tzap/protocol`.
- Child-process workers selected automatically when a package needs them (`process.chdir`,
  `process.exit`, a known non-thread-safe native addon, or configured), and the reason reported.
- Mutants partitioned by source file across workers.
- Worker count defaults from estimated work, capped at cores − 1; `--workers N` overrides.
- Recycling after N mutants or a heap-growth threshold; both measured to pick defaults.
- `module.enableCompileCache()` in every worker.
- **Soundness suite:** fixtures that leak module state, global state, timers and unhandled
  promises produce identical verdicts in the pool and under `--engine=reference`. At least one
  fixture is written to fail if recycling were not enough.
- Byte-identical reports at 1, 2 and 8 workers.
- A hung mutant kills only its worker; a pre-warmed spare replaces it. Fixture with a genuine
  sync infinite loop.
- Measured: speedup over M6 on S1 and S8, with the range.

**Tasks.**
- Pool, protocol, recycling, spares; thread/process selection.
- Soundness fixtures; differential runs at 1/2/8 workers; benchmark.

### M8b · Schemata switching in the warm worker

**Goal.** Activate a mutant by setting a number, with no module reload.

**Definition of done.**
- Non-static mutants run by setting `__tz.a`; nothing is re-imported between mutants.
- Per-worker switch; tests that spawn their own workers or child processes receive the active id
  through the environment, with a fixture proving it.
- Every mutant is either switchable or routed to the static path; a test asserts none is silently
  dropped — a dropped mutant looks like a smaller inventory rather than a bug.
- Instrumentation overhead with no mutant active measured on the Tier B suites and published
  (target ≤ 1.2x suite time; research measured ~1.0x on a micro-benchmark).
- Standing gates pass.
- Measured on S1 and S8.

**Tasks.**
- Switch plumbing; drop-detection test; overhead measurement; benchmark.

## M9 · Selection, ordering and deterministic hangs

**Goal.** Run the fewest tests that decide each mutant, and decide hangs without the clock.

**Definition of done.**
- Only covering tests run for each mutant.
- Ordering: previous killer (from cache) first, then tests that killed neighbouring mutants in
  the same function, then fastest first.
- Early exit on first failure, uniformly — including for runners whose own bail is unavailable.
- **Hang detection is primarily by count:** active-mutant hits > 10x baseline, or loop back-edges
  > 10x the unmutated count on the same tests, with a floor. Sticky flag so a user `catch` cannot
  swallow it. Wall-clock budget only as backstop.
- A run with a 1 ms wall-clock budget and one with 30 s produce byte-identical reports on the
  loop-hang fixtures.
- Async hangs (never-settling promises) time out per test without losing the worker.
- **Test executions per mutant** reported and gated in CI.
- **First kill-criteria checkpoint** (S1 and S3 against Stryker) evaluated and recorded here.

**Tasks.**
- Ordering from history; early exit in the adapter loop.
- Loop-guard calibration against Tier A loop fixtures; async-hang fixture.
- Benchmark; kill-criteria writeup.

## M10 · Static mutants

**Goal.** Make mutants reached only at module evaluation affordable and correct.

**Definition of done.**
- Strategy from Spike D implemented: re-evaluate the affected module subgraph in a fresh context
  (or a fresh worker where the spike said so), running only test files that import the module.
- Memory growth bounded by recycling; asserted on a fixture with 200 static mutants.
- Decorators, class field initialisers, top-level constants and config objects covered by fixtures.
- Verdicts identical to the reference engine on every static fixture; parity with Stryker on the
  cases where Stryker is correct (not with `testFiles`, per #6144).
- `--ignore-static` available and reported as a count, never silent.
- Measured on S9: share of wall clock spent on static mutants before and after.

**Tasks.**
- Subgraph re-evaluation; import-graph lookup from coverage; recycling policy.
- Static fixtures; benchmark S9.

## M11 · Incremental cache

**Goal.** Reuse prior verdicts safely across runs and machines.

**Definition of done.**
- Cache key composition implemented and documented per [architecture.md](architecture.md),
  including **the covering tests' transitive import closure** — the change Stryker's incremental
  mode misses.
- Coverage map cached, reused only when it covers every file the run needs.
- Invalidation rules implemented, one test per rule, **and** exact-invalidation-set tests by
  mutant key (jzap left this outstanding; it is the test that proves the rules).
- Plain-text, sorted, diffable format.
- Toolchain fingerprint (Node major, runner version, TypeScript version, lockfile hash, tzap
  version, filter and mutator sets) recorded; mismatches refused with a message.
- Wall-clock `Timeout` and `RuntimeError` never cached.
- Cold and warm runs produce identical verdicts on Tier A and Tier B.
- **S5 ≤ 5% of S1; S6 re-analyses exactly the mutants provably affected.**
- Measured against Stryker `--incremental` on S5 and S6.

**Tasks.**
- Format, key composition, fingerprinting.
- Invalidation engine and its tests; exact-set fixtures; cold/warm differential in CI.
- Benchmark S5/S6.

## M12 · Type-aware viability

**Goal.** Stop type-invalid mutants from distorting the score and the noise level, at a cost
that does not erase the speed work.

**Definition of done.**
- **Type-directed generation** where it is decidable from syntax and local declarations without a
  checker, each rule a fixture: no `OptionalChaining` removal where the receiver's declared type
  is non-nullable, no `ObjectLiteral` → `{}` where the target has a declared type with required
  properties, no `ArrowFunction` → `undefined` where the return type is declared non-void, etc.
  Every rule measured for precision against the checker on the corpus.
- **Checker integration** through TypeScript 7's unstable API (TS 6 fallback), using the project's
  own `typescript` and tsconfig; modes `off`, `survivors` (default), `all`.
- Grouping of non-interacting mutants per check (Spike E's result), with the grouping's accuracy
  measured against one-at-a-time checking.
- Type-invalid mutants reported `CompileError`, outside the score; the report states the policy.
- Measured on Tier B: share of mutants type-invalid, share caught by type-directed generation,
  cost of `survivors` and `all`, and **the score bias of `survivors`** (type-invalid mutants
  counted as killed), published together.
- CompileError parity with Stryker's TypeScript checker under `--typecheck=all`.

**Tasks.**
- Syntactic type rules; checker client; grouping.
- Bias and cost measurement; parity extension; docs.

## M13 · Mutant reduction and noise

**Goal.** Cut the mutant set and the noise without cutting usefulness, and quantify the trade.

**Definition of done.**
- **Arid rules as data** (a checked-in rule file, tunable without a release): `console.*`, common
  logger calls (`logger.*`, `log.*`, `debug(...)`), messages of thrown errors, telemetry and
  metrics calls, `process.env` default strings, timeouts and durations in config objects. Logging
  rules on by default — Google measured the logging rule right on 99 of 100 sampled cases — the
  rest opt-in until measured.
- **One mutant per line** and **per statement** modes, opt-in.
- **Minifier-based equivalence** (normalise original and mutant with oxc-minify, compare), opt-in,
  with the actual reduction measured — jzap found javac-TCE dropped nothing, so the number must be
  measured, not quoted.
- **Extreme mode** (function body → `return undefined` / empty / thrown), Descartes-style.
- **A detection-loss report** per technique and cumulatively: mutants removed, survivors no
  longer reported, speed gained — published with equal prominence.
- Every technique individually toggleable; `--no-reduction` reproduces M12 behaviour exactly
  (asserted); parity runs use `--no-reduction`.
- **Second kill-criteria checkpoint** evaluated and recorded.

**Tasks.**
- Rule engine and rule file; per-line/per-statement modes; equivalence filter; extreme mode.
- Detection-loss harness; publish; kill-criteria writeup.

---

# Phase 3 — Delta and reporting

M14 and M15 depend only on M6/M7 and may run in parallel with Phase 2, since they touch scope
resolution and output rather than the execution engine. jzap built them early for the same reason.

## M14 · Git diff scoping with a narrowed coverage phase

**Goal.** A PR run whose cost is proportional to the diff — the product's core differentiator,
since no JS tool offers it.

**Definition of done.**
- `@tzap/git` resolves `--from`/`--to` including `-Local-` (staged + unstaged) and `-Empty-`, via
  the git CLI; `--patch FILE` accepts a unified diff with no repository present.
- Mutants selected by span overlap with added/modified lines; a pure deletion marks the next line.
  `--scope line|function|file` widening available.
- **Core never depends on `@tzap/git`**: asserted by the boundary check and by a test that runs a
  diff-scoped analysis from a patch file with git absent from `PATH`.
- **Coverage narrowed:** candidate tests from the static import closure of changed files (oxc
  parse of imports + the project's resolver: tsconfig paths, package `exports`, workspace links),
  widened to all tests in the package when a dynamic specifier makes the graph unknowable, then
  narrowed by cached coverage. A differential test asserts identical verdicts to an un-narrowed
  run on every fixture.
- "Analysis runs against the working tree; the range only selects" stated in the CLI output.
- Fixture repositories: renames, moves, whitespace-only changes, mode changes, merge commits,
  shallow clones (CI default), detached HEAD, a change touching only types, a change touching
  only a test file (then: mutants the changed tests cover — the "test-based" mode), and a change
  in a test-less library package.
- **S3/S4 measured** against Stryker given the same diff as `--mutate` line ranges.

**Tasks.**
- Diff parsing and ref resolution; span mapping; widening modes.
- Import-graph builder with resolver; narrowing; differential test.
- Fixture repositories; benchmark S3/S4.

## M15 · Reporters, exit codes, and the 0.1 release

**Goal.** Output that existing tooling, code review and coding agents already understand — and a
first public release.

**Definition of done.**
- **mutation-testing-elements JSON**, validated against the published schema in CI, rendering in
  the standard `mutation-test-elements` HTML component; the HTML reporter embeds that component
  rather than reimplementing it.
- Native tzap JSON (full detail, the harness's input, versioned).
- **Console** reporter: survivors with source line, counts, score and test strength
  (score over covered mutants), as jzap prints them.
- **Agent** reporter (`-r agent`): survivors and uncovered only, one per line, no snippets, no
  timings — jzap measured 16 KB against 509 KB of JSON for the same content.
- **GitHub annotations**: Checks API output capped at 50 per request and ranked by relevance, with
  a workflow-command fallback that respects the 10-per-level-per-step limit; SARIF for code
  scanning.
- Thresholds per scope (`--threshold`, separate defaults for full and diff runs), `--fail-on-survivors`.
- Reports byte-identical outside the timing block, asserted.
- **0.1.0 published to npm** with provenance, a README quickstart for Vitest, and
  `skills/tzap/SKILL.md` for coding agents, mirroring jzap's.

**Tasks.**
- Writers; schema validation job; HTML embedding.
- Annotation ranking and limits; SARIF.
- Release automation (changesets or release-please, npm provenance), docs site, skill file.

---

# Phase 4 — Runner breadth

Each runner adapter implements the same SPI and passes the same gates: transparency, reference
parity, Stryker parity, determinism, and a same-code cross-runner check — an equivalent Vitest
suite and a suite in the new runner over the same production code produce the same verdicts. The
framework must not be able to change what a mutant means.

## M16 · node:test adapter

**Goal.** Native Node test suites, with no third-party runner in the loop.

**Definition of done.**
- Delivery via `module.registerHooks`; TS through the project's configured loader (tsx, swc-node,
  or Node's own type stripping where sufficient).
- Warm execution with `isolation: 'none'` and selection by stable `file:line:col` ids / name
  patterns via the `run()` API; known Node bugs in this path listed with workarounds.
- Coverage attribution via test boundary events.
- Stryker comparison through its tap runner (the route Stryker recommends for node:test), with
  the granularity difference stated.
- Supported Node versions documented; unsupported ones fail with a clear message.

**Tasks.** Adapter; fixtures; cross-runner verdict check; parity; docs.

## M17 · Jest adapter and the 0.2 release

**Goal.** The largest installed base, warm — the runner where Stryker is slowest.

**Definition of done.**
- Spike B's path implemented: a hosted jest-circus + jest-runtime in a long-lived worker if
  feasible, else a warm pool running per-file with the measured cost stated plainly.
- Delivery via a transformer that instruments and then delegates to the project's configured
  transformer (ts-jest, babel-jest, @swc/jest), with source maps composed.
- Test environments (`node`, `jsdom`) booted once per worker; module registry reset between test
  files as Jest's semantics require, and **not** between mutants beyond that.
- Early exit, which Stryker cannot do for Jest.
- Snapshot tests: obsolete/written snapshots never persisted during mutation runs (`--ci`
  semantics), asserted.
- Supported Jest versions (29, 30) in the CI matrix; unsupported versions fail clearly.
- **S2 measured**; the S2 kill criterion evaluated.
- 0.2.0 released.

**Tasks.** Adapter; transformer delegation; environment reuse; snapshot guard; version matrix;
benchmark; release.

## M18 · Mocha adapter; Bun and Deno decision

**Goal.** Cover the remaining mainstream Node runner, and decide the non-Node runtimes on
evidence.

**Definition of done.**
- Mocha adapter with in-process re-run (`cleanReferencesAfterRun(false)`, grep by full title),
  CJS and ESM (ESM static mutants via the M10 path).
- A written decision for Bun and Deno: supported with an adapter and the gates above, or
  documented as unsupported with the reason. Demand evidence (Stryker's Bun issue #4439 open since
  2023; a third-party Bun runner at ~8k downloads/month) goes into the decision.
- Karma documented as unsupported (deprecated; Angular 21 moved to Vitest).

**Tasks.** Adapter; fixtures; parity; Bun/Deno spike and decision record.

---

# Phase 5 — Frontend, monorepos and scale

## M19 · Frontend: JSX/TSX, DOM environments, Vue, Svelte

**Goal.** Component test suites at warm speed, with source-faithful mutants in SFCs.

**Definition of done.**
- jsdom and happy-dom booted once per worker; DOM reset between tests exactly as the runner does
  it, and verified by the soundness suite with a DOM-leaking fixture.
- React Testing Library fixtures (TSX) under both environments, with hand-written expectations.
- Vue SFC: `<script>` and `<script setup>` located with `@vue/compiler-sfc`'s parser, mutated with
  one magic-string over the whole file, delivered through the Vite pipeline; template expressions
  explicitly out of scope and documented.
- Svelte: `<script>` blocks the same way; Svelte 5 runes fixtures.
- Astro and Angular: a written decision (supported, or unsupported with the reason). Angular's move
  to Vitest makes its component classes reachable through M5's path; templates are not.
- **S8 measured**: environment boots per run, against Stryker.

**Tasks.** Environment reuse; SFC extraction for Vue and Svelte; fixtures; benchmark; decisions.

## M20 · Monorepo single run and the 0.3 release

**Goal.** One invocation over a whole workspace, where a test in one package kills a mutant in
another.

**Definition of done.**
- Cross-package selection: a mutant in a test-less library package is killed by an app package's
  test, with a fixture, and the same case shown reporting `NoCoverage` under package-at-a-time
  analysis.
- Workers hold per-package runner instances, started on demand; a mutant's covering tests may span
  packages and run group by group, stopping at the first kill.
- Packages with no tests are analysed as mutation sources only, never started as runners.
- Workspace linking resolved (pnpm, npm, yarn; `workspace:` protocol; package `exports`
  conditions), so an app's import of the library reaches the library's **instrumented source**, not
  a stale `dist/` — or the report states, per package, that it tested built output and why.
- Scheduling keeps cores busy across packages; the largest tested workspace documented with
  numbers.
- **S7 measured.**
- 0.3.0 released.

**Tasks.** Multi-package model consumption; source-vs-dist resolution; cross-package scheduling;
large-workspace fixture; benchmark; release.

## M21 · Watch mode and resident daemon (gated)

**Goal.** Mutation feedback in the edit loop — if the numbers say it is worth it.

**Gate.** Built only if, after M11, a warm-cache diff run (S4) on the Tier C corpus still spends
more than half its wall clock on tool startup and worker boot. Otherwise closed by measurement,
as jzap closed block coverage.

**Definition of done.**
- `tzap watch`: on save, re-instrument changed files, re-run the diff scope against a resident
  warm pool, report survivors.
- `tzap run --daemon` hands the invocation to a resident process keyed by the model's path and
  toolchain fingerprint, idle-exiting after 30 minutes.
- Staleness safety: any change to a file in a worker's loaded graph recycles that worker rather
  than patching it; a fixture proves a changed file cannot yield a stale verdict.
- Concurrent invocations serialised, with a test.
- Standing gates, and identical verdicts cold and warm.

**Tasks.** Daemon, keying, idle exit; watch integration; staleness and concurrency tests; benchmark.

## M22 · Native instrumenter (optional, gated)

**Goal.** Move parse → mutate → instrument → source map into Rust, if and only if it matters.

**Gate.** [ADR 0001](adr/0001-implementation-language.md)'s first revisit condition: tzap's own
CPU work exceeding 10% of wall clock on any benchmark scenario.

**Definition of done.**
- A napi-rs addon on the oxc crates returning instrumented code, a source map and a mutant table.
- **Byte-identical output to the TypeScript instrumenter** across Tier A, B and C — the TS
  implementation stays as the reference, the way the reference engine does.
- Prebuilt binaries for the supported platforms with a wasm fallback; install size stated.
- The TS path remains selectable and is the fallback when the binary is unavailable.

**Tasks.** Addon; differential test; packaging; benchmark.

---

# Phase 6 — Hardening and 1.0

## M23 · Published comparison against StrykerJS

**Goal.** The headline claims, measured, reproducible and fair.

**Definition of done.**
- S1–S9 published for tzap and every Stryker baseline, on Linux and Windows, five runs, median
  with range, quiet machine, procedure documented well enough for a third party.
- Correctness published alongside: the agreement matrix, the full `parity-baseline.yaml` with
  justifications, the reference-engine differential results.
- Reduction and type-aware filtering: detection loss published with the same prominence as speed.
- **Noise comparison on Tier C**: a blind sample of 200 survivors per tool, each classified
  actionable / noise by a reviewer against a written rubric. tzap's default configuration must
  report fewer noise survivors than Stryker's.
- Every scenario tzap loses published as prominently as those it wins.
- A third-party reproduction attempt before publication.

**Tasks.** Final runs; noise review; writeup; reproduction.

## M24 · 1.0 hardening

**Goal.** A tool someone else can adopt without talking to us.

**Definition of done.**
- Diagnostics for the failures that produce a plausible-looking nothing: no source files matched,
  no mutants, no tests discovered, runner version unsupported, every mutant `NoCoverage` (usually a
  delivery problem — instrumented code never loaded). Each names what was looked at and what to
  check, each asserted by a test.
- Error-message catalogue of the top 20 failure modes, each tested.
- Docs: quickstart per runner, mutator reference, diff-mode guide, CI recipes (GitHub Actions,
  GitLab), migration from Stryker (config mapping, ignore comments carried over, dashboard
  upload), troubleshooting, performance tuning.
- Compatibility matrix: Node, OS, Vitest, Jest, Mocha, TypeScript, Vue, Svelte versions — stating
  what was run, not what might work.
- Versioning policy covering the project model, cache format, mutator ids, mutant ids, runner SPI
  and daemon protocol, including the awkward row: a fix that corrects a wrong verdict changes
  scores and ships as a patch that says so.
- A **GitHub Action** (`tzap-action`) running a diff-scoped run on pull requests with annotations
  and a summary comment.
- Release automation with npm provenance and reproducible builds.
- Public parity and benchmark dashboards regenerated per release.
- A 30-day dogfood on at least two external projects (one Vitest monorepo, one Jest app), findings
  triaged and blockers closed. jzap's status page names this as the gap a tool cannot close on its
  own fixtures; tzap schedules it rather than leaving it outstanding.
- 1.0.0 released.

**Tasks.** Diagnostics and catalogue; documentation set; compatibility matrix; versioning policy;
action; release pipeline; dashboards; dogfood and triage.

---

## Milestone summary

| Milestone | Phase | Size | Depends on | Ships in |
|---|---|---|---|---|
| M0 Skeleton & CI | 0 | S | — | — |
| M1 Risk spikes | 0 | S (1 week) | M0 | — |
| M2 Model, discovery, CLI | 0 | M | M0 | 0.1 |
| M3 Inventory | 1 | M | M2 | 0.1 |
| M4 Parity harness (inventory) | 1 | M | M3 | — |
| M5 Instrumentation + Vitest + coverage | 1 | L | M1, M3 | 0.1 |
| M6 Reference kill loop | 1 | M | M4, M5 | 0.1 |
| M7 Bench harness | 1 | M | M6 | — |
| M8a Warm pool | 2 | L | M7 | 0.1 |
| M8b Schemata switching | 2 | M | M8a | 0.1 |
| M9 Selection, ordering, hangs | 2 | M | M8b | 0.1 |
| M10 Static mutants | 2 | M | M9 | 0.1 |
| M11 Incremental cache | 2 | M | M9 | 0.1 |
| M12 Type-aware viability | 2 | L | M6, M1-E | 0.1 |
| M13 Reduction & noise | 2 | M | M11 | 0.1 |
| M14 Diff scoping | 3 | L | M6, M7 | 0.1 |
| M15 Reporters + 0.1 | 3 | M | M6, M14 | 0.1 |
| M16 node:test | 4 | M | M15 | 0.2 |
| M17 Jest + 0.2 | 4 | L | M15, M1-B | 0.2 |
| M18 Mocha; Bun/Deno decision | 4 | S | M16 | 0.3 |
| M19 Frontend | 5 | L | M17 | 0.3 |
| M20 Monorepo + 0.3 | 5 | M | M14, M17 | 0.3 |
| M21 Watch/daemon (gated) | 5 | M | M11, M20 | 1.0 or closed |
| M22 Native instrumenter (gated) | 5 | L | M7 | 1.0 or closed |
| M23 Published comparison | 6 | M | M20 | 1.0 |
| M24 1.0 hardening | 6 | L | M23 | 1.0 |

Sizes are relative (S ≈ days, M ≈ one to two weeks, L ≈ two to four weeks of focused work) and
exist for ordering, not promising dates.

## Dependency graph

    M0 -> M1 -> M2 -> M3 -> M4 -> M5 -> M6 -> M7
                                          |
                     +--------------------+--------------------+
                     v                                         v
       M8a -> M8b -> M9 -> M10                          M14 -> M15 (0.1)
                      |                                        |
                      +-> M11 -> M13                           |
                      +-> M12                                  |
                                                               v
                                     M16 -> M18        M17 (0.2) -> M19
                                                               |
                                                               v
                                                        M20 (0.3) -> M21 (gated)
                                                               |
                                                               v
                                          M22 (gated)   M23 -> M24 (1.0)

- M14/M15 may run in parallel with Phase 2 once M7 exists.
- M12 depends technically only on M6 and Spike E, and can move earlier if the type-invalid share
  on the corpus turns out to dominate the noise.
- If Spike B finds Jest cannot be hosted warm, M17's scope shrinks to a warm per-file pool and its
  S2 kill criterion is re-evaluated with that stated; M17 then can move ahead of M16.
- M21 and M22 are closed by measurement if their gates are not met; that is a result, not a
  failure, and is recorded here with the numbers.

## What building it changed

Recorded here rather than silently edited in, because the differences are the useful part.

- **The engine does not own a worker pool.** The plan's M8 assumed tzap would host each runner's
  internals in its own workers. Spike A found something better: Vitest's `repeats` loop runs a
  test's full hook cycle per repetition and does not stop on failure, so one ordinary run of the
  user's own runner can try thousands of mutants through public hooks. Jest (jest-circus's retry
  loop) and Mocha (its retries) turned out to have the same shape; node:test needed a shim. The
  per-try cost is 37–180 µs in every runner, and no runner internals are imported.
- **Warm reuse needed four defences the plan did not foresee, each found by a fixture or a real
  library disagreeing with the reference engine:** control tries around mutant tries; the
  unreached outcome (a try whose mutant never ran decides nothing); running every test twice in
  coverage to catch tests that depend on leftover state; and confirming warm survivors in
  isolation when their tests touch module state — on superjson, 14 of 82 warm survivors had been
  masked by a registration an earlier run of the same test left behind.
- **A shortcut was built and removed.** Letting the warm engine try hybrid static mutants first
  looked sound — a kill is a kill — until a test that compares against a value computed at load
  time showed a false kill. The hazards fixture now holds that case.
- **Static mutants were the dominant cost, as the research predicted:** 98% of a dogfood run on
  tzap's own sources. Packing one static mutant per test file per run, with measured load-time
  loop limits, took that run from 4 min 4 s to 52 s.
- **The oracle paid for itself.** StrykerJS comparison found three tzap bugs (Vitest 4.1
  reporters, logical-chain precedence, uncaught exceptions reported as survivals) and then a
  regression in the fix for the second, which is why the instrumenter now re-parses its own output.
- **The S3 kill criterion was set for a suite whose dry run is expensive.** On the benchmark
  fixture, StrykerJS's full dry run costs 0.4 s, and tzap's fixed floor (a runner boot and a
  coverage pass) dominates a 10-line diff. It is recorded as unmet rather than re-scoped; a diff
  benchmark on a corpus project with a real suite is the measurement that would settle it.
- **M21 and M22 were closed by measurement**, as the plan allowed: the warm-cache path is already
  0.19 s, and tzap's own CPU work is 0.3% of a run.
- **Tools that are not the product needed the most care about Windows**: NUL bytes and
  backspaces from scripted edits, CRLF line endings, a pnpm policy that silently stopped builds,
  and TypeScript 7's incremental build missing an edit (the build now always forces).
