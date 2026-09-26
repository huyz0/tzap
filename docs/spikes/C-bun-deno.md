# Spike C: Bun and Deno — and the Mocha adapter's numbers

- **Date:** 2026-09-26
- **Questions (from M18):** (1) what is the cheapest correct way to run many mutant tries per run
  under Mocha, and what does it cost; (2) should tzap support `bun test` and `deno test`, now?
- **Environment:** Mocha 12.0.2, Node 26.7.0, Windows 11, i5-13600KF. Neither Bun nor Deno is
  installed on this machine, and none was installed for the spike: part 2 is from documentation,
  issue trackers and npm download counts, and says so where a claim is unverified.

## Part 1: Mocha

### Paths measured

All in one process, Mocha loaded through its programmatic API from the project, test files loaded
once with `loadFilesAsync` and the suite tree kept across runs with `cleanReferencesAfterRun(false)`
(an ES module cannot be unloaded, so re-running the same tree is the only warm option that works
for ESM and CommonJS alike).

| Path | Per run | Per try | Verdict |
|---|---:|---:|---|
| Bare Mocha re-run, no tzap hooks (`suite.tests` = clones, spike) | 0.033 ms | ~5 us | the floor |
| A: one `test.clone()` per try in `suite.tests` | ~0.1 ms | 29 us at 10k tries, **140 us at 60k** | rejected: super-linear |
| B: Mocha's own retry loop, one test object per planned test (built) | 0.1–0.3 ms in-process, **0.36–0.42 ms** through the session (IPC) | **20–26 us** in-process, 36–38 us through the session, flat from 1k to 60k tries | adopted |
| C: one `mocha.run()` per try with a grep | = per-run cost per try | ~0.4 ms | 10–20x B |

Path A goes super-linear because Mocha's `runTests` takes `suite.tests.slice()` and `shift()`s it
once per test: an array of tens of thousands lives in V8's large-object space, cannot be
left-trimmed, and each shift is O(n). Path B keeps that queue at the size of the suite's planned
tests: `retries` is set to the test's tries minus one, a passing try that is not the last fails
with a marker error, and Mocha re-queues a fresh clone at the front, running the full
beforeEach → body → afterEach cycle again — the same trick runner-jest plays on jest-circus.
Per-try cost was still growing (14 → 50 us) until the adapter dropped each finished clone's
`error` listener from the runner's `_eventListeners` map, which Mocha otherwise holds until the
run ends.

Other costs, measured by the package tests:

- Host start + Mocha + test files, first run: 30–60 ms in-process; a fresh host through the
  session ~230 ms (what an isolated static mutant pays).
- `analyse()` on `fixtures/sample-mocha`, 37 mutants: **warm 345 ms** (coverage 161, execute 6,
  isolated 159 — the one static mutant), reference engine 4.3 s; verdicts identical, and the
  hand-derived survivors as for sample-vitest / sample-node. (node:test on the same code: warm
  238 ms, reference 2.1 s.)

### What the adapter keeps of Mocha's semantics, and where it departs

- Configuration from `.mocharc.*` / `package.json` via Mocha's own `loadOptions`, files via its
  `collectFiles`, `require` and root-hook plugins (`mochaHooks`) via `handleRequires`; global
  setup/teardown fixtures once per session, not once per run.
- Timeouts are Mocha's own (default 2000 ms), so a never-settling mutant is K with Mocha's
  message; a synchronous hang is caught by the loop guard (T), and anything else by the silence
  backstop and the progress file.
- Departures, all deliberate: `bail`, `retries`, `parallel`, `forbidPending`, `forbidOnly` are
  ignored; `.only` is ignored (tzap runs every test, as the node:test adapter does). A failing
  `beforeEach`/`afterEach` fails **its try** instead of the rest of its suite — Mocha would skip
  every later try of every test in the suite; Vitest and Jest keep such a failure to the test,
  and so does tzap. A hook that *times out* still aborts the suite (Mocha fails it from outside
  the hook's function), and those tries go to the isolated path.
- Not supported yet: `delay`/`run()`, `node-option` / loader flags in `.mocharc` (the host is a
  plain `fork`; `require`-based loaders such as `tsx/cjs` work).

## Part 2: Bun and Deno

### What tzap needs from a runtime

A warm adapter needs four things; every existing adapter has all four:

1. **Instrumented code delivery**: rewrite a module's source on load (Vite plugin, Jest
   transformer, `module.registerHooks` for node:test and Mocha).
2. **Many tries per run**: a loop that runs one test's hooks + body many times in one process
   (Vitest `repeats`, jest-circus retries, Mocha retries, node:test re-registration).
3. **Per-try brackets**: a hook or event before the first `beforeEach` and after the last
   `afterEach` of each try, to switch the mutant and read the outcome.
4. **A host the engine can drive**: start once, receive run requests, report structured results,
   be killed on silence.

### Bun (1.4.2, released 2026-09-05)

| Need | Status |
|---|---|
| 1 delivery | `module.registerHooks` is **not implemented** ([oven-sh/bun#27369](https://github.com/oven-sh/bun/issues/27369), open). The route is a runtime `Bun.plugin({ setup(b) { b.onLoad(...) } })` in a `--preload` / `[test] preload` file. Documented for custom file types; that `onLoad` may replace the source of an ordinary `.ts`/`.js` file under `bun test` is plausible but **unverified** here. A second delivery path to build and test. |
| 2 many tries | No programmatic test API: `bun test` is a native CLI, and the request for one has been open since 2023 ([oven-sh/bun#5411](https://github.com/oven-sh/bun/issues/5411)). `--rerun-each N` reruns *files*, not planned per-test tries; `--retry` / `retry` exist but are only a starting point, and whether a failing-then-retried test re-runs its hooks per attempt is unverified. |
| 3 brackets | `beforeEach`/`afterEach` from `bun:test` in a preload file give global hooks; per-test identity (full title) from inside them is not documented. |
| 4 host | One `bun test` process per round, results over a reporter (JUnit file, or the inspector WebSocket TestReporter events since 1.3.7 that the third-party Stryker runner uses). No warm host between rounds. |

Also: tzap's own engine does not run on Bun ([stryker-js#4439](https://github.com/stryker-mutator/stryker-js/issues/4439)
notes a Bun `Error.prepareStackTrace` bug breaking Vite-based tooling as late as 2026-09-23), so
Bun would only ever be the *test child*, as in the third-party runner.

### Deno (2.9.7, released 2026-09-17)

| Need | Status |
|---|---|
| 1 delivery | Better than the brief assumed: Deno **2.8 implemented `module.registerHooks`** (sync, same thread; async `module.register` is not implemented). Documented for both `import` and `require()` and usable with `deno test --import`. A format-reporting bug was fixed in 2026 ([denoland/deno#36841](https://github.com/denoland/deno/issues/36841)). Whether a `load` hook may return TypeScript for Deno to strip is not documented. |
| 2 many tries | `Deno.test` has `repeats` (every run must pass) and `retry`; each attempt re-runs `beforeEach`/`afterEach`. `repeats` does not continue past a failure in a way tzap can steer per attempt; as with Mocha, driving `retry` with a marker failure is the likely route. **Unverified**: nothing here has been run. |
| 3 brackets | `Deno.test.beforeEach/afterEach` exist (FIFO/LIFO order); per-test identity inside them is not documented. |
| 4 host | No programmatic runner API: `deno test` is a CLI; one process per round, results via its reporters (`--reporter=junit`). Sanitizers (ops, resources, exit) would have to be understood per try. |

### Demand

| Signal | Value (npm, 2026-08-26 → 2026-09-24) |
|---|---:|
| [stryker-js#4439](https://github.com/stryker-mutator/stryker-js/issues/4439) "Support bun test runner" | open since 2023-09-27, 20 👍, 14 comments, latest 2026-09-23 |
| `stryker-mutator-bun-runner` (third-party, last release 2025-07) | **8,153 / month** — the ~8k the plan quoted, confirmed |
| `@hughescr/stryker-bun-runner` (third-party, 1.4.0, 2026-09-15) | **93,948 / month** — not in the plan's evidence; ~11x the first |
| `@stryker-mutator/mocha-runner` | 96,261 / month |
| `@stryker-mutator/jest-runner` / `vitest-runner` | 1.54 M / 5.95 M per month |
| Deno | no Stryker runner exists; no issue with comparable traction found |

So Bun mutation testing is a real niche: the two third-party runners together (~102k/month) are
on a par with Stryker's own Mocha runner. Deno shows no measurable demand.

## Decision

- **Mocha: supported** (the adapter in `packages/runner-mocha`, path B above).
- **Bun: not now.** Two of the four needs (a warm, drivable test runner; supported source
  rewriting) have no stable public answer, so an adapter would be a cold, one-process-per-round
  runner reading reporter output through a second, unverified delivery path — the architecture
  tzap exists to avoid, at a cost we cannot measure without installing Bun. Users with
  Vitest-on-Bun projects are served today by the Vitest adapter where Vitest itself runs on Node.
  **What would change it:** `bun test` gaining a programmatic API (oven-sh/bun#5411) *or*
  `module.registerHooks` (oven-sh/bun#27369) plus a verified per-test retry loop; demand is
  already sufficient (~100k/month for third-party runners), so the gate is technical. Revisit at
  each Bun minor; the first step would be a spike like this one run on a machine with Bun.
- **Deno: not now.** Delivery is now feasible (`registerHooks` since 2.8), but there is no warm
  host and no demand signal. **What would change it:** a programmatic `deno test` API, or users
  asking with numbers comparable to Bun's.
- **Karma: unsupported** (deprecated; Angular 21 moved to Vitest), as the plan states.

Sources: [bun test configuration](https://bun.com/docs/test/configuration),
[bunfig.toml](https://bun.com/docs/runtime/bunfig), [Bun plugins](https://bun.com/docs/runtime/plugins),
[Deno loader hooks](https://docs.deno.com/runtime/reference/loader_hooks/),
[Deno testing](https://docs.deno.com/runtime/test/), npm downloads API
(`api.npmjs.org/downloads/point/last-month/<pkg>`), GitHub issues linked above.
