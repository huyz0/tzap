# Spike B: running a Jest test many times against different mutants

- **Date:** 2026-09-26
- **Question:** can one long-lived process run a Jest test many times
  against different mutants without paying a `runCLI` per mutant? Should the adapter host
  jest-circus + jest-runtime directly, or drive Jest through its public entry point?
- **Environment:** Jest 30.5.2 (jest-circus, babel-jest + `@babel/preset-typescript` 7.29),
  Node 26.7.0, Windows 11, i5-13600KF. Fixture: [fixtures/sample-jest](../../fixtures/sample-jest)
  (two test files, five tests). Code in [spikes/jest-warm/](../../spikes/jest-warm/).

## Result

**Yes, through jest-circus's own retry loop, driven from a test environment's `handleTestEvent`.
One `runCLI({ runInBand: true })` per round; inside it, every planned try of a test re-runs the
test's full beforeEach -> body -> afterEach cycle at ~80–120 us per try, against ~46–70 ms for a
`runCLI` per mutant — the Stryker path.** No Jest internals are imported; hosting jest-runtime
directly would save at most ~4 ms per round.

### Path 1 (the floor): one `runCLI({ runInBand: true })` per round — `round.mjs`, `marks.mjs`

`runCLI` in the same process, repeatedly, on the fixture (2 files):

| | Wall clock |
|---|---:|
| First round in a process (loads Jest, transforms) | 651 ms |
| Later rounds, median of 19 | **45.9 ms** (p10 42.2, p90 59.4) |

Where a warm round goes (Jest's own `performance` marks, median of 20):

| Phase | ms from `runCLI` start |
|---|---:|
| `readConfigs` | 0 – 2.8 |
| `buildContextsAndHasteMaps` | 2.8 – 3.7 |
| `getTestPaths`, `globalSetup` | 3.7 – 4.1 |
| **`scheduleAndRun`** | **4.1 – 42.3** |
| results, teardown | 42.3 – 42.7 |

Nearly all of a warm round is the per-test-file work: a new `Runtime` (module registry), a new
test environment, jest-circus's initialisation, the test file's module graph from the transform
cache. That is Jest's semantics (a fresh registry per test file) and tzap must keep it. So a
round costs ~20 ms per test file plus ~5 ms, and one round per mutant — what StrykerJS does, with
a fresh process on top — is ~46 ms per mutant on this fixture at best.

### Path 2: many tries per test inside one round — `env.cjs`, `retry.mjs`

jest-circus (bundled into `jest-circus/build/jestAdapterInit.js` in Jest 30) retries a failed test
while `globalThis[Symbol.for('RETRY_TIMES')]` allows and `test.errors` is non-empty; with
`Symbol.for('RETRY_IMMEDIATELY')` it does so at once, and every retry is a full `_runTest`:
`test_start` (which increments `test.invocations`), beforeEach hooks, the body, afterEach hooks,
`test_done`. Every event goes through the environment's `handleTestEvent`, awaited, with the
circus `state` as second argument. So a test environment can drive it:

- `run_start`: walk `state.rootDescribeBlock`, give each test its plan, set `mode = 'skip'` on the
  unplanned ones, set `RETRY_TIMES` to the longest plan minus one, `RETRY_IMMEDIATELY` to true;
- `test_start`: try `invocations - 1` begins; activate its mutant;
- `test_done` (after afterEach, and after circus has added `expect.assertions` failures): record
  the try; if more tries remain, leave the test failed (push a marker error if it passed) so the
  loop continues; after the last one, empty `test.errors` so the test reports green.

One test, alternating mutant 1 (kills) and no mutant, one runCLI round each:

| Tries | Round | Marginal per try | Verdicts |
|---:|---:|---:|---|
| 1 | 34–48 ms | — | right |
| 1,000 (half failing) | 232–250 ms | ~200 us | all right |
| 10,000 (half failing) | 1.6–2.5 s | ~160–250 us | all right |
| 1,000 (all passing) | 178–187 ms | ~145 us | all right |
| 10,000 (all passing), marker error made per try | 1.2–1.4 s | ~125 us | all right |
| **10,000 (all passing), one reused marker error** | **883 ms** | **~84 us** | all right |
| 30,000 (all passing), one reused marker error | 3.0–3.5 s | ~110 us | all right |

beforeEach and afterEach ran exactly once per try; the module under test was evaluated **once**
per file per round (`evals: 1` at 100,000 tries). A CPU profile showed half the per-try cost was
the marker `new Error` (stack capture, then Jest's source-mapping of it in the per-try
`test-case-result` report); reusing one pre-made error removed it. What is left is Jest itself:
circus's `getState()` (a property lookup on the VM's contextified global, per handler per event)
and `expect`. The per-try cost grows slowly with tries per test (~80 us at 1,000, ~115 us at
30,000); real rounds have tens to hundreds of tries per test.

Failed tries in a failing-heavy run cost more (~200 us) because Jest formats every assertion
error it reports.

### Path 3: `jest.retryTimes` from a setup file instead of the environment

Not needed: the environment sets the same symbols directly and later than any user code, so a
suite's own `jest.retryTimes` cannot interfere. Describe-level retries (Jest 30's
`RETRY_TIMES_SETTER` per describe block) set `insideDescribeRetry`, which disables per-test
retries inside that block; a suite that uses them is not supported yet (see limitations).

### Path 4: hosting jest-circus + jest-runtime directly

Not pursued. Jest 30 bundles jest-circus into one webpack chunk (`jestAdapterInit.js`) and the
public `@jest/core` API is `runCLI`, `createTestScheduler`, `SearchSource`, `getVersion`.
Hosting the runtime ourselves could save only what a round spends outside `scheduleAndRun`
(~4 ms), because the per-file work *is* the module registry reset tzap must keep. Not worth
depending on bundle internals for.

### The adapter as built — `adapter.mjs`

`@tzap/runner-jest` with the path-2 environment, on the fixture, through the session API (IPC,
the tzap transformer delegating to babel-jest, per-try bookkeeping):

| | Wall clock |
|---|---:|
| `start()` (fork host, resolve Jest, read config) | 374–591 ms |
| first coverage run (each test twice) | 600–813 ms |
| warm coverage run, median of 10 | 57–63 ms |
| mutate round, 2 files, 0 mutant tries (4 control tries) | 46–50 ms |
| mutate round, 2 files, 2,000 mutant tries | 212 ms (**~81 us/try**) |
| mutate round, 2 files, 10,000 mutant tries | 1,866 ms (~182 us/try) |
| static run, one test file, median of 10 | 67–71 ms |

Progress messages (`process.send` per try, for hang attribution) measured as noise.

### End to end: `analyse()` vs StrykerJS — `analyse.mjs`, `bench.mjs`

Full run on the fixture (37 mutants), wall clock of the whole process, median of 3:

| Tool | Median | Runs | Killed / Survived / NoCoverage |
|---|---:|---|---|
| **tzap warm** (`analyse()`, `@tzap/runner-jest`) | **2.39 s** | 2.39, 2.62, 2.21 | 28 / 6 / 3 |
| StrykerJS 10.0.0, `@stryker-mutator/jest-runner` 10.0.0, `perTest`, `--concurrency 1` | 4.36 s | 4.36, 4.11, 5.24 | 28 / 6 / 3 |
| StrykerJS 10.0.0, default concurrency (19 runners) | 6.07 s | 7.96, 6.07, 5.59 | 28 / 6 / 3 |

Identical verdicts, and the six survivors are the hand-derived ones. tzap's time on this fixture
is fixed costs, not mutants: coverage 0.94 s (fork + Jest's first round), execute 0.14 s (two
rounds: 33 tries in 75 ms, 12 in 62 ms), and **isolated 0.90 s for the fixture's single static
mutant** (`SEPARATOR`), because the engine opens a fresh `isolate: true` session for the isolated
path — a second host boot plus a cold first round — although Jest already isolates every test
file and the warm session could run it in ~70 ms. With that one engine change the run would be
~1.5 s. This fixture is far too small to evaluate S2; it only shows the fixed costs.

## Decision

The Jest adapter uses **rounds**, like the Vitest one: one `runCLI({ runInBand: true })` per
engine request, in a host child process, with the per-try loop inside jest-circus's retry
mechanism, driven by a tzap test environment that extends the project's configured one.

- `runInBand`: the tests run in the host process, so the environment reads the plan from a host
  global and reports progress straight through `process.send`; a hang is recovered by killing
  the host (the session's wall-clock budget), exactly as in the Vitest adapter.
- Instrumented code reaches Jest through a tzap transformer wrapping every entry of the
  project's resolved `transform`: substitute the instrumented source, then delegate to the
  project's own transformer. Cache keys of instrumented files are the delegate's key over the
  instrumented source, prefixed; the cache directory is tzap's own.
- Static mutants: the environment's constructor activates the mutant before `setupFiles` and the
  test file load; Jest's per-file registry does the rest.
- Early exit: a per-run killed set across test files; a killed mutant's later tries are skipped
  (outcome `X`) by failing them before their hooks run.
- Snapshots: `ci: true` without `-u` gives `updateSnapshot: 'none'`; the host refuses to run if
  Jest reports anything else, and a test asserts a missing snapshot fails and is not written.

What it relies on, and what the version matrix must pin: `RETRY_TIMES` / `RETRY_IMMEDIATELY`
symbols read at the start of each describe block's run; the immediate retry loop continuing while
`test.errors` is non-empty; `test.invocations` incremented at `test_start`; `handleTestEvent`
awaited, after circus's own handler, with `state` as its second argument; `test_done` dispatched
after afterEach hooks and after the expected-assertions check; `state.maxConcurrency` read when
a concurrent group starts. Jest 29 lacks `RETRY_IMMEDIATELY`: retries are deferred to the end of
the describe block. This was first read as breaking the per-test cycle; it does not (see the last
follow-up).

## Follow-ups this creates

- **Engine:** let a runner declare that it isolates test files itself (Jest does, always), so the
  isolated path reuses the warm session instead of booting a fresh one per batch: ~0.85 s of the
  fixture's 2.4 s.
- Describe-level retries (`describe` retry options, new in Jest 30) and `jest.retryTimes` inside
  describe blocks: need a fixture; today they disable the loop inside that block, the missing
  tries come back `U` and are re-decided in isolation.
- `test.concurrent`: serialised by `state.maxConcurrency = 1`, keeping Jest's rule that
  concurrent tests do not run each-hooks. Needs a fixture.
- Multi-project configs (`projects`), ESM test files (`--experimental-vm-modules`), jsdom: not
  covered by the fixture yet.
- Source maps: the delegate's map is relative to the instrumented code; it is not yet composed
  with the instrumenter's map, so stack traces in kill messages point at instrumented lines.
- Observed twice: Jest 30 found no tests when the project's rootDir sat under a dot-directory
  (a `.tzap-snap-*` test directory, and StrykerJS's default `.stryker-tmp` sandbox, which
  therefore found no tests on this fixture; the benchmark sets `tempDirName: "stryker-tmp"`).
  Cause not investigated.
- Jest 29.7's jest-circus has no `RETRY_IMMEDIATELY` (checked in its `build/run.js`). **Done
  without another mechanism:** its deferred loop still runs each retry as a full `_runTest`
  (`test_retry` clears the errors, `test_start` increments `invocations`), so the same environment
  drives it; a test's later tries run after its siblings' first tries, each still bracketed by
  controls. `fixtures/sample-jest29` passes the session tests and the warm/reference agreement.
  One difference: circus 29 starts a concurrent test's body once and a retry awaits the same
  promise, so on 29 the environment clears `concurrent` at `run_start` and those tests run in
  sequence.
