# Spike A: the cost of re-running a test in a warm Vitest

- **Date:** 2026-09-26
- **Question:** what does it cost to run one test against one mutant in an already-warm
  Vitest 5, and should the adapter host Vitest or drive `@vitest/runner` directly?
- **Environment:** Vitest 5.0.2, Node 26.7.0, Windows 11, i5-13600KF. Code in
  [spikes/vitest-rerun/](../../spikes/vitest-rerun/).

## Result

**Neither of the two paths the plan named. A third one, found by reading the runner, is ~2,400x
cheaper per mutant than the first and needs no Vitest internals.**

### Path 1: hosted Vitest, one `runTestSpecifications` per mutant

`createVitest` once, then per mutant: `provide('tzapMutant', id)` and
`runTestSpecifications([createSpecification(file, { testIds: [id] })])`.

| Pool | Boot | First run | Re-run, one test (median of 200) | p10–p90 |
|---|---:|---:|---:|---:|
| threads, `isolate: false` | 43 ms | 101 ms | **138.6 ms** | 125.6–157.6 ms |
| forks, `isolate: false` | 43 ms | 335 ms | **110.3 ms** | 101.4–339.7 ms |

Functionally correct: the mutant reaches the worker through `provide`/`inject` on every run, a
mutant is detected (`adds` fails under mutant 1 and passes without it), and the module under test
is evaluated **once** across all 220 runs (`evals: 1`). But ~110–140 ms per mutant is 20–30x the
5 ms threshold the plan set, and it is the same order as what StrykerJS pays with `ctx.start()`.
The cost is Vitest's per-run orchestration, not the test.

### Path 2: driving `@vitest/runner` directly

Not viable as planned: Vitest 5 **bundles** its runner (`node_modules/@vitest/runner` does not
exist; the npm package stops at 4.1.11). Driving it would mean importing hashed internal chunks.

### Path 3: many mutants per run, through `repeats` and public hooks

Reading `runTest` in the bundled runner showed that the `repeats` loop re-runs a test's full
`beforeEach` → body → `afterEach` cycle per repetition **and does not stop on failure**. So one
ordinary Vitest run can try many mutants against a test:

- a setup file's `beforeAll(({}, file) => …)` receives the collected file and sets
  `test.repeats = plan.length - 1` on each planned test and `mode = 'skip'` on the rest;
- `beforeEach` activates the mutant for this repetition (`test.result.repeatCount`);
- `afterEach` (registered first, so it runs last) records whether this repetition failed, stores
  it in `task.meta` — which Vitest serialises back to the controller — and clears the failure so
  the next repetition starts clean and the run reports green.

| Run | Tries | Wall clock | Marginal cost per mutant try |
|---|---:|---:|---:|
| `isolate: false`, 1,000 tries | 1,000 | 147–175 ms | ~150 us (dominated by the run's fixed cost) |
| `isolate: true`, 1,000 tries | 1,000 | 145–177 ms | ~150 us |
| `isolate: false`, 10,000 tries | 10,000 | 560–603 ms | **~56 us** |

Every verdict was right: exactly the 500 (or 5,000) repetitions with mutant 1 active were
recorded as kills, the others as survivals, and the test reported `passed` to Vitest.

## Decision

The Vitest adapter uses **rounds**: one Vitest run executes, per test file, a plan of
(test → ordered mutants). The fixed per-run cost (~100–150 ms) is paid per round, not per mutant.

- **Round 1** tries each covered mutant against its most likely killer (previous killer from the
  cache, else the fastest covering test).
- **Later rounds** try survivors against their remaining covering tests. Kill-first ordering keeps
  the number of rounds small; a test for a mutant already killed in the same round is skipped by
  the in-worker plan.
- **Static mutants** (hit outside any test) run in rounds of their own with isolation forced, the
  mutant set before the test file imports anything, one mutant per test file per round.
- It works under the user's own `isolate` setting, so tzap does not change the semantics of the
  suite to gain speed — which the transparency gate would otherwise have to catch.

What it relies on, and therefore what the adapter's version matrix must pin: `task.repeats` being
read at the start of `runTest`, the repeats loop not breaking on failure, `beforeAll` receiving the
file as its second argument, `task.meta` being serialised to the controller, and
`result.repeatCount` being set before `beforeEach`. Each gets a test in `@tzap/runner-vitest` so a
Vitest release that changes one fails loudly rather than producing a plausible-looking zero —
exactly the failure Stryker hit with Vitest 5's test-name matching (#6210).

## Follow-ups this creates

- `it.concurrent` tests would race on the global switch; the plan must force them sequential
  (set `concurrent = false` in the same `beforeAll`) — needs a fixture.
- A mutant that hangs synchronously outside instrumented loops blocks the worker; the backstop is
  killing the host process that runs Vitest, so the host is a child process, not the controller.
- Snapshot assertions under a mutant must never write: runs use `update: false`.
