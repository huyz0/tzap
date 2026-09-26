# Runtime and execution: where the wall clock goes in JS/TS mutation testing

*Research date: 2026-09-26. Scope: the runtime-level levers available to tzap for executing tests against thousands of mutants quickly. Versions current on that date: Node 26.10.0 / 24.21.0 LTS / 22.23.3, Vitest 5.0.2 (5.0.0 shipped 2026-09-03), Jest 30.5.2, Bun 1.4.2, StrykerJS 10.0.0 (2026-08-14). Release versions and dates come from the GitHub releases API.*

**How to read this document.** Every number is tagged:

- **[M]**: measured by this research on Windows 11, Intel i5-13600KF (20 threads), Node v26.7.0. The benchmark scripts were throwaway files, so the scenarios are described in enough detail to reproduce them. These are micro-benchmarks meant to show orders of magnitude. They are not predictions for real suites.
- **[C]**: a claim taken from the linked source. It has not been reproduced here.

Source permalinks point at the commits that were read: Vitest `428e2e5` (2026-09-25) and StrykerJS `f2a49ff` (2026-09-11).

---

## 0. TL;DR

1. **Process startup is the largest per-mutant cost you can remove.** Spawning a fresh Node process costs about 35–38 ms before any user code runs, and about 15 ms for a worker thread [M]. A test runner then adds its own startup on top: loading the runner, the config and the transform pipeline, and setting up the environment. jsdom alone costs roughly 200–500 ms per import [C: [Vitest perf guide](https://vitest.dev/guide/improving-performance)]. Sending a mutant id to an already-warm worker and running one test takes about **47 µs** of round trip [M]. That is roughly 750× cheaper than a fork, and ~10,000× cheaper than a cold runner start.
2. **Module re-evaluation is the next cost.** With mutant schemata and runtime activation (a global `activeMutant` checked at each mutation point), the source modules never need re-evaluating. Only test files need reloading, and sometimes not even those. Vitest with `isolate: false` already works this way internally: it keeps a worker's `evaluatedModules` across files and runs, and invalidates only the test files and any changed files ([source](https://github.com/vitest-dev/vitest/blob/428e2e5043c64635b6b157358bde2fdeaa7b6b3a/packages/vitest/src/runtime/workers/base.ts#L152-L166)).
3. **Choosing a coverage mechanism is mostly about overhead in hot code.** On a branchy hot loop [M]:
   - V8 function-level precise coverage: about 1.0× (free).
   - V8 **block** coverage: about **8×** slower.
   - Stryker-shaped `stryCov_(...)` helper calls: about **10×** slower.
   - A flat `Uint32Array` counter increment: about **0.95–1.0×**.
   - Schemata checks `M.active === k` with no mutant active: **1.0×**.

   Instrumented typed-array counters are therefore the cheapest way to get per-test coverage. V8's `takePreciseCoverage` also resets its counters, so it is usable per test. It is cheap per call (0.1–30 ms depending on heap size [M]), but block granularity makes the code itself slow.
4. **Hang handling.** A synchronous infinite loop can only be stopped from outside the thread. `worker.terminate()` stops one in **0.74 ms** [M]. The replacement worker then has to be warmed again (cold start about 15 ms plus imports). Stryker's `hitLimit` stops the loop from inside, which avoids that cost. It counts executions of the *active mutant* and throws once the count exceeds 100× the dry-run count ([source](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/core/src/mutants/mutant-test-planner.ts#L37)). Async hangs (promises that never resolve) do not block the event loop. They need a per-test timeout, and the worker can be kept.
5. **Runner APIs have caught up.** Vitest 4.1 added `TestSpecification.testIds` and `testNamePattern` per specification ([docs](https://vitest.dev/advanced/api/test-specification)), plus `experimental.viteModuleRunner: false`, which runs on Node's native loader. Vitest 5 adds `fsModuleCache`, prewarmed VM pools, and vm pools that are 18–53% faster [C: [Vitest 5 blog](https://vitest.dev/blog/vitest-5.html)]. Node 26 marks type stripping stable, removes `--experimental-transform-types`, promotes `module.registerHooks` (sync, in-thread) to release candidate, and runtime-deprecates async `module.register` ([docs](https://nodejs.org/api/module.html)).

---

## 1. Anatomy of a mutation run in JS

For a mutant `m` covered by tests `T(m)`, the cost of one mutant run is roughly:

```
t(m) = t_proc_start + t_runner_boot + t_env_setup + t_module_load(test files + SUT graph)
     + t_transform(cache miss) + Σ_{t∈T(m)} t_exec(t) + t_report_ipc + t_teardown
```

A traditional runner pays every term for every mutant: a `command` runner does, and so does Stryker when `reloadEnvironment` is true. In real suites the terms **other than** `t_exec` usually dominate. Vitest 5 shows this in its duration breakdown line, which its blog gives as `environment 79%, import 13%, transform 6%, tests 1%, setup 1%` for a jsdom suite [C: [Vitest 5 blog](https://vitest.dev/blog/vitest-5.html)]. The same pattern shows up in the Vitest 5 benchmark table: an 80-file jsdom suite takes 4–5 s, and nearly all of it is environment and import time.

The jzap playbook carries over directly. The only change is to replace JVM class loading with "module graph evaluation":

| jzap lever (Java) | JS equivalent | What gets removed |
|---|---|---|
| Mutant schemata | Babel/oxc-instrumented `M.active===k ? mutated : orig` (Stryker already does this) | One transform and one module load per mutant |
| Warm daemon | Long-lived worker pool that stays warm across mutants and across runs | `t_proc_start`, `t_runner_boot`, `t_env_setup` |
| Per-test coverage | Per-test counters (instrumented) or V8 precise coverage | Running irrelevant tests |
| Kill-test-first plus early exit | Order `T(m)` by historical kill rate and duration, stop at the first failure (`bail`) | Most of `Σ t_exec` for killed mutants |
| Loop-counting hang detection | In-band hit counters (Stryker `hitLimit`) plus out-of-band `worker.terminate()` | Timeouts measured in seconds |
| Incremental cache | Content hash of (mutant site, covering tests, transitive deps) | Whole mutants |

---

## 2. Test runners: internals relevant to "run test X against mutant N, repeatedly, warm"

### 2.1 Vitest (5.0.2, current)

**Architecture.**

- **Main process.** The main process hosts a Vite dev server. Transforms happen there (esbuild, or oxc via rolldown-vite, plus plugins for JSX, Vue and Svelte) and are served to workers over RPC.
- **Module runner.** Workers execute modules through Vite's **module runner**. This replaced `vite-node` in Vitest 4.
- **Pools.** The worker pools were rewritten without tinypool in Vitest 4 ([PR #8705](https://github.com/vitest-dev/vitest/pull/8705)). `poolOptions` became top-level options such as `maxWorkers` ([migration guide](https://vitest.dev/guide/migration)). The available pools are:
  - `forks`: child processes, the default.
  - `threads`: `worker_threads`.
  - `vmThreads` and `vmForks`: a fresh `vm` context per test file inside a reused worker. `isolate` has no effect on these ([docs](https://vitest.dev/config/isolate)).

**Isolation semantics (from source).** In `runBaseTests`, before each test file, Vitest runs:

```js
if (config.isolate) { moduleRunner.mocker?.reset(); resetModules(workerState.evaluatedModules, true) }
```

([source](https://github.com/vitest-dev/vitest/blob/428e2e5043c64635b6b157358bde2fdeaa7b6b3a/packages/vitest/src/runtime/runBaseTests.ts#L52-L57)).

With `isolate: false`, the worker's module-level `evaluatedModules` persists across files **and across runs**. At the start of a run, Vitest invalidates only:
- `ctx.invalidates`, the changed files, and
- the test files themselves ([source](https://github.com/vitest-dev/vitest/blob/428e2e5043c64635b6b157358bde2fdeaa7b6b3a/packages/vitest/src/runtime/workers/base.ts#L125-L166)).

The Vitest 4 pool rewrite also reuses workers across tasks when `isolate === false` (`canReuse`, [pool.ts](https://github.com/vitest-dev/vitest/blob/428e2e5043c64635b6b157358bde2fdeaa7b6b3a/packages/vitest/src/node/pools/pool.ts)).

This is almost exactly the behaviour tzap wants. SUT modules instrumented with schemata stay evaluated, and each run re-executes only the test file. The catch is that SUT module-level state leaks between runs (see §5).

**Programmatic API** (`vitest/node`, [docs](https://vitest.dev/advanced/api/vitest)):

- `createVitest(mode, options)` / `startVitest`.
- `runTestSpecifications(specs)` / `rerunTestSpecifications(specs)`.
- `invalidateFile(path)`, `setGlobalTestNamePattern`, `getModuleSpecifications(moduleId)`, `cancelCurrentRun`, `watcher`.
- `experimental_parseSpecifications`, and `enableCoverage` / `disableCoverage` (added in 4.0, [blog](https://vitest.dev/blog/vitest-4)).
- **4.1+:** `TestSpecification.testIds` ("the ids of tasks inside of this specification to run"), a per-spec `testNamePattern`, and `testTagsFilter` ([docs](https://vitest.dev/advanced/api/test-specification)).

With these, tzap can select a single test by **id** instead of by name regex. Stryker still builds a regex from full test names ([source](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/vitest-runner/src/vitest-test-runner.ts#L230-L245)), which is ambiguous when two tests share a name.

**Per-test hooks.** There are three ways to hook into each test:

- **Setup file.** Use `beforeEach(({task}) => …)` in a setup file, and pass data back through `task.meta` / `suite.meta`. This is how Stryker's `stryker-setup.ts` sets `ns.currentTestId` and ships coverage and hit counts ([source](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/vitest-runner/src/stryker-setup.ts)).
- **Custom runner.** A custom `VitestRunner` exposes `onBeforeRunTask`, `onBeforeTryTask`, `onAfterRunTask`, `onAfterTryTask`, `onTaskUpdate`, `importFile` and `injectValue` ([runner docs](https://github.com/vitest-dev/vitest/blob/428e2e5043c64635b6b157358bde2fdeaa7b6b3a/docs/api/advanced/runner.md)).
- **Injected values.** `project.provide(key, value)` plus `inject(key)` pass values from the main process into workers. Stryker uses this to deliver `activeMutant` and `hitLimit` per run.

**Relevant experimental and new options:**

| Option | Since | Relevance |
|---|---|---|
| `experimental.viteModuleRunner: false` | 4.1 | Uses native `import` with no Vite transforms. `vi.mock` goes through Node loaders (22.15+). There is no `import.meta.env`, no aliases, no plugins and no `vi.resetModules`. Recommended only for backend tests ([docs](https://vitest.dev/config/experimental)). Lets tzap serve pre-instrumented JS through its own `registerHooks`. |
| `experimental.nodeLoader` | 4.1 | Native loader for transforms when the module runner is disabled |
| `experimental.preParse` | 4.1.3 | Parses specs before execution (for `.only`, patterns and tags). Useful for test discovery without executing anything. |
| `experimental.importDurations` | 4.1 | Per-module import timing, which helps tell whether import cost dominates |
| `fsModuleCache` | 5.0 | "Persists transformed modules across reruns and separate processes" [C] |
| `experimental.diagnostics` / `vitest doctor` | 5.0 | Recommends faster configurations [C] |

**Cost of a rerun.** No independent benchmark of `rerunTestSpecifications` for a single test was found, and installing Vitest to measure it was out of scope. The claims:

- The Vitest 5 changelog says that "warm modules [are] delivered in [a] single trip" and that "VM pools reuse compiled code across contexts with module graph prewarming" [C].
- In its benchmark suite the fastest project (`deps-heavy`) takes 0.74 s for a full run [C]. That is the order of magnitude for a *whole-run* floor, not for a single test.

The expected rerun cost, by pool:

- **`forks` with `isolate: true`:** every rerun pays process spawn plus environment setup plus a full module re-import.
- **`threads` with `isolate: false` and `maxWorkers: 1`, the Stryker configuration:** pays RPC, the test-file import, and reporter/state bookkeeping, probably 5–50 ms.

**This needs measuring before committing (open item 1).**

**What Stryker does today** ([source](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/vitest-runner/src/vitest-test-runner.ts)):

- Creates one `createVitest('test', {pool:'threads', maxWorkers:1, bail:1, coverage:{enabled:false}})` per Stryker worker process.
- For each mutant: clears `state.filesMap`, sets `config.related` and `testNamePattern`, and calls `ctx.start(files)`.
- Flips the active mutant via `provide('activeMutant', id)`.
- In the current source, Stryker "hot-swaps" (sets `reloadEnvironment: false`) only when a test filter exists and the mutant is not static ([planner](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/core/src/mutants/mutant-test-planner.ts#L189-L218)).

**Browser mode.** Browser mode has been stable since 4.0, with providers `@vitest/browser-playwright` and friends. Per the Vitest 5 benchmarks, a React SPA in browser mode takes 2.0 s versus about 1.7 s for a jsdom design system [C]. Each mutant switch needs a message to the page. A tab can be terminated, but a synchronous infinite loop inside a page requires killing the CDP target. tzap should treat browser mode as a later-stage target.

### 2.2 Jest (30.5.2)

- **Sandbox per test file.** jest-runtime runs each test file in a fresh `vm` context created by the environment (`jest-environment-node` or `-jsdom`), with its **own module registry**. Modules are re-evaluated for every test file even when they are shared ([issue #4413](https://github.com/jestjs/jest/issues/4413)).
- **Cost of the vm context.** Accessing globals through a vm context is slower. Jest's `sandboxInjectedGlobals` exists to speed up lookups such as `Math` ([config docs](https://jestjs.io/docs/configuration)).
- **Isolation tools.** `jest.isolateModules(fn)` and `resetModules` give finer-grained registries. The transform cache is on disk and keyed by file content plus config.
- **Jest 30** (June 2025) [C: [blog](https://jestjs.io/blog/2025/06/04/jest-30)]:
  - Switched resolution to `unrs-resolver`.
  - Added `testEnvironmentOptions.globalsCleanup`.
  - Supports native type stripping for `.ts`, `.mts` and `.cts`.
  - Reported gains: one large TypeScript application went from about 1350 s / 7.8 GB to about 850 s / 1.8 GB (37% faster, 77% less memory). Happo went from 14 to 9 minutes.
  - `--testPathPattern` was renamed to `--testPathPatterns`.
- **Why Jest is slow for mutation testing.**
  - Every `runCLI` call rebuilds or revalidates the haste map, creates a vm context per test file, re-requires the whole SUT graph inside that context, and sets up the environment again (jsdom is expensive).
  - There is no programmatic "rerun this test in the same context" entry point.
  - Stryker's jest runner calls `runCLI` for every mutant with `--findRelatedTests <sandboxFile>` and a `testNamePattern` regex built from test full names ([source](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/jest-runner/src/jest-test-runner.ts#L170-L205)). It passes the active mutant through `process.env.__STRYKER_ACTIVE_MUTANT__`.
- **Per-test hooks.** A custom test environment's `handleTestEvent` receives `test_start` and `test_done` under jest-circus. Stryker's mixin uses it to set `currentTestId` ([source](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/jest-runner/src/jest-plugins/mixin-jest-environment.cts#L51-L62)).
- **Implication for tzap.** A fast Jest path means **not** using `runCLI` per mutant. Instead, tzap would:
  - host `jest-runtime` directly (the approach of `jest-runner` and `jest-circus/runner`): create the environment and runtime once per test file per worker, and keep them;
  - re-execute only the `describe`/`test` registration and the selected test under circus.

  This means reaching into Jest internals, which Jest 30 bundles into single files per package ("may break tools reaching into Jest internals" [C]). High payoff, high maintenance.

### 2.3 Mocha

- Mocha loads files once. `mocha.cleanReferencesAfterRun(false)` together with `mocha.grep(regex)` allows repeated `run()` calls in the same process. Stryker's mocha runner does exactly this, with `reloadEnvironment: false` because "Mocha directly uses `import`, so reloading files once they are loaded is impossible" ([source](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/mocha-runner/src/mocha-test-runner.ts#L58-L63)).
- This is the closest existing thing to the tzap warm model, and it shows the ESM constraint: **ESM modules cannot be unloaded**. Static mutants (code that runs at module-evaluation time) therefore force a process restart.

### 2.4 node:test (Node 26)

- `run({ isolation: 'none' | 'process', testNamePatterns, testSkipPatterns, files, concurrency, only, setup, testTagFilters, shard, rerunFailuresFilePath })` ([docs](https://nodejs.org/api/test.html)).
  - `isolation` was added in v22.8.0.
  - `'none'` runs every file in the current process.
  - `--test-rerun-failures` (v24.7.0) keys tests as `file:line:column`, which is a stable test id.
- Hooks: global `beforeEach`/`afterEach(t)` expose `t.fullName` and `t.filePath`, which is enough for per-test coverage attribution. The event stream (`test:start` with line and column, `test:pass`, `test:fail`) gives results.
- Known rough edges with `isolation: 'none'`:
  - `run()` waits for `beforeExit` ([#57234](https://github.com/nodejs/node/issues/57234)).
  - No concurrency ([#55939](https://github.com/nodejs/node/issues/55939)).
  - Breaks inside child processes ([#60020](https://github.com/nodejs/node/issues/60020)).
  - Repeated `run()` calls in one process re-import test files, which ESM caches, so tests do not re-register. tzap would need `?v=N` cache-busting on test files (see §4.4) or a custom harness.
- Built-in coverage is V8-based (`NODE_V8_COVERAGE`) and still Stability 1.

### 2.5 Bun test (1.4.2) and Deno test

- **Bun** [C: [docs](https://bun.com/docs/test/parallel)]:
  - By default `bun test` runs **all files in one process with one shared module registry**. This is fast, but `mock.module` and globals leak across files.
  - `--isolate` gives each file a fresh global object in the same process. Between files Bun drains microtasks, closes sockets, cancels timers and kills subprocesses.
  - `--parallel[=N]` implies `--isolate`.
  - "Bun caches transpiled source and bytecode at the process level and shares them across globals."
  - Filtering is by name (`-t`) only. Bun is a secondary target: Stryker has an open issue for a Bun runner ([#4439](https://github.com/stryker-mutator/stryker-js/issues/4439)).
- **Deno:** `deno test --filter` works by name ([docs](https://docs.deno.com/runtime/fundamentals/testing/)). Deno is out of scope for v1.

### 2.6 Browser and component runners

- **Karma is deprecated.** Angular 21 made Vitest the default and ships a `karma-to-vitest` schematic ([Angular docs](https://angular.dev/guide/testing/migrating-to-vitest)). This consolidates the Angular market onto Vitest.
- **Playwright component tests and real browsers:** each page load is about 100 ms or more. Keep the page alive and flip the mutant with `page.evaluate`, which is the same schemata model but inside a browser.

### 2.7 Test selection by id: summary

| Runner | Select one test | Stable id | Per-test hook for coverage | Warm rerun in same process |
|---|---|---|---|---|
| Vitest ≥4.1 | `TestSpecification.testIds`, per-spec `testNamePattern` | task id (hash of file + name path) plus `includeTaskLocation` | setup-file `beforeEach`, custom runner `onBeforeRunTask` | Yes, via `runTestSpecifications`. With `isolate:false` SUT modules stay cached. |
| Jest 30 | `testNamePattern` regex only | full name (ambiguous) | env `handleTestEvent` | Not via public API. Only by hosting jest-runtime. |
| Mocha | `grep` regex | full title | root hooks | Yes (`cleanReferencesAfterRun(false)`) |
| node:test | `testNamePatterns` | `file:line:col` | global `beforeEach(t)` | Partially. ESM caching blocks re-registration. |
| Bun | `-t` regex | name | `beforeEach` | CLI only |

---

## 3. Coverage for per-test attribution

### 3.1 Options

| Mechanism | Granularity | How it attributes per test | Notes |
|---|---|---|---|
| Instrumented counters, Stryker style (`stryCov_(id…)`) | per mutant site | a `currentTestId` global set in `beforeEach`; `cov.perTest[testId][mutantId]++` | Exact mapping from mutant to test, independent of transpiler source maps. [Helper source](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/instrumenter/testResources/instrumenter/console-sample.js.out.snap) |
| Instrumented typed-array counters (proposed) | per mutant site or per block | snapshot and zero a `Uint32Array` after each test, or use a bitset per test | Cheapest [M]. Needs a known mutant-id → index mapping per file. |
| V8 precise coverage via inspector (`Profiler.startPreciseCoverage({callCount, detailed})`, `takePreciseCoverage` per test) | function or block | calling `take` between tests; the counters reset on each take in count mode | No source rewrite needed, but results must be remapped from transpiled output to source ranges ([V8 blog](https://v8.dev/blog/javascript-code-coverage)). |
| `NODE_V8_COVERAGE` | function or block, per process | whole process only | Useless per test unless there is one process per test |
| istanbul (`@vitest/coverage-istanbul`, babel-plugin-istanbul) | statement, branch, function | `__coverage__` global snapshot and diff | Heavy counters, similar in cost to Stryker's |

**Remapping.** `@vitest/coverage-v8` switched to **AST-aware remapping** (`ast-v8-to-istanbul`) as the only mode in Vitest 4 ([issue #7928](https://github.com/vitest-dev/vitest/issues/7928)). This fixed the false positives of `v8-to-istanbul`. monocart-coverage-reports takes a similar AST-based approach. All V8 approaches need the transpiler's source maps. Instrumented counters do not, because the id is embedded in the code.

### 3.2 Measured overhead [M]

Workload: a branchy tokenizer loop, 20,000 iterations over a 3.4 KB string, all TurboFan-hot. Time is the total wall time. The instrumented variants carry 5 mutation points.

| Variant | Time | vs plain |
|---|---|---|
| plain | 168 ms | 1.00× |
| schemata only: `M.active===k ? mut : orig`, none active | 169 ms | **1.00×** |
| schemata plus `Uint32Array` counter per point (`C[k]++`) | 159 ms | **0.95×** (noise) |
| Stryker shape (`stryMutAct_("k") ? … : (stryCov_("k"), …)`) | 1683 ms | **10.0×** |
| V8 precise coverage, function binary (`callCount:false, detailed:false`) | 170 ms | 1.01× |
| V8 precise coverage, **block** binary (`detailed:true`) | 1380 ms | **8.2×** |
| V8 precise coverage, block count (`callCount:true, detailed:true`) | 1362 ms | 8.1× |

Taking the Stryker shape apart in a separate run gives: `act()` only (string-id compare through a helper) 581 ms (3.5×), `cov()` only 6846 ms (deoptimisation around `arguments` and dictionary maps; noisy). The dominant costs are the `arguments` object and the object-keyed counters. The branch itself costs almost nothing.

Caveat: this is a worst case, a hot tight loop. Typical unit-test code is cold and interpreter-bound, where the relative overhead is far smaller. The V8 blog puts block count coverage at up to about 40% regression on web-tooling-benchmark [C: [V8 blog](https://v8.dev/blog/javascript-code-coverage)]. It also notes that precise count mode must disable optimization of the functions it tracks.

**Cost of `takePreciseCoverage` per call** [M], with a generated module of N small functions and 1/30 of them called between takes:

| Functions in heap | function mode | block mode |
|---|---|---|
| 1,000 | 0.33 ms | 0.84 ms |
| 10,000 | 1.6 ms | 5.4 ms |
| 50,000 | 7.4 ms | 29.5 ms (p90 41 ms) |

A large app with 50k or more functions (node_modules included) would add 10–40 ms **per test** in block mode during the coverage pass. That is acceptable for a one-time dry run, and bad for anything done per mutant.

**Recommendation.** Use schemata instrumentation that emits `if (M.active===k)` checks and **flat typed-array hit counters**. Per test, `beforeEach` zeroes the array (or records a dirty list) and `afterEach` records the non-zero indices. This is exact, needs no source maps, is nearly free once JIT'd, and the same counters provide the hang-detection hit count (§5.3). Keep V8 block coverage as a fallback for code tzap cannot instrument, such as test-only transforms.

---

## 4. Process and isolation models, with costs

### 4.1 Startup costs [M] (Windows; Linux process spawn is typically 2–3× faster)

| Operation | Median | p90 |
|---|---|---|
| `spawnSync(node, ['-e',''])` | 38.4 ms | 41.1 ms |
| `child_process.fork` → first IPC message | 35.3 ms | 36.9 ms |
| `new Worker(eval)` → first message | 14.8 ms | 17.5 ms |
| `worker.terminate()` while the worker spins in `for(;;){}` | **0.74 ms** | 0.80 ms |
| `vm.createContext({})` plus a trivial run | 0.20 ms | 0.24 ms |
| `vm.createContext(vm.constants.DONT_CONTEXTIFY)` | 0.18 ms | 0.20 ms |
| Warm worker: post mutant id, run 1 small test (sync or async), reply | **47 µs** | — |

Claims about Bun's startup (8–15 ms "hello world") come from secondary blogs of variable quality ([example](https://dev.to/jsgurujobs/bun-vs-deno-vs-nodejs-in-2026-benchmarks-code-and-real-numbers-2l9d)) and were not reproduced.

### 4.2 Module (re)loading [M]

The test graph was 500 CJS or ESM modules, each importing the next 3, each with 20 small functions.

| Strategy | Time |
|---|---|
| First CJS load (fs, resolve, wrap, compile, eval) | 109–119 ms |
| CJS: `delete require.cache[...]` for the graph, then re-require | **21–24 ms** |
| First ESM import | 124–155 ms |
| ESM re-import of the root with `?v=N` (only the root re-evaluates; children stay cached, **old instances leak**) | 0.5 ms |
| Fresh `vm` context plus eval of all 500 module bodies (sources in memory) | 2.6 ms |
| Same, with precompiled `vm.Script` reused | 1.7 ms |

Takeaway: in a warm process, **V8 compile and eval of an already-seen module graph is cheap (a few ms)**. The loader machinery (resolution, fs, wrappers) costs about 10× more. V8's isolate-level compilation cache makes re-evaluation cheap. Vitest 5 even disables that cache in vm pools with `--no-compilation-cache`, because it keeps every `vm.SourceTextModule` alive until memory pressure hits ([source](https://github.com/vitest-dev/vitest/blob/428e2e5043c64635b6b157358bde2fdeaa7b6b3a/packages/vitest/src/runtime/workers/vm.ts#L195-L203)). That is a memory warning tzap must heed if it uses vm contexts per mutant.

### 4.3 Node primitives, as of Node 26

- **`module.registerHooks({resolve, load})`**: synchronous and in-thread, covering `require`, `import` and `createRequire`. Added in v23.5.0 / v22.15.0, **release candidate (1.2) since v25.4.0 / v24.13.1**, and returns `deregister()`. **`module.register` (async, off-thread) is deprecated (v25.9) and runtime-deprecated in v26.0 (DEP0205)** ([docs](https://nodejs.org/api/module.html)). tzap should use `registerHooks` to serve instrumented sources and to cache-bust test files.
- **Compile cache:** `module.enableCompileCache({directory, portable, readOnly})` / `NODE_COMPILE_CACHE`. Added in v22.8.0, **stable since v25.4.0**, with `portable` added in v25.0 / v24.12. It caches V8 code for CJS, ESM and TS. Measured on a 4.2 MB CJS file: top-level `require` went from 97 ms to **32 ms** once cached (the first run writes the cache at 127 ms) [M]. Lazily compiled inner functions benefit little: require plus call-all went from 459 ms to 436 ms. Worth enabling for every tzap worker, because it cuts warm-up of each new or replacement worker.
- **User-land startup snapshots** (`--build-snapshot` / `--snapshot-blob`, stable since v24.0 / v22.17, [docs](https://nodejs.org/api/v8.html)): the entry must be a **single script** that loads only built-ins, with no user-land CJS or ESM ([PR #38905](https://github.com/nodejs/node/pull/38905)). A deserialized app cannot be re-snapshotted. The only way to snapshot a warmed-up test environment would be to bundle the whole SUT plus runner plus environment into one file, which is not practical for arbitrary projects. **Not a viable fork() substitute today.**
- **No `fork()` of a running Node process.** `child_process.fork` means exec, not a copy of the address space. mutmut 3's model is not available, because it runs pytest once and then really `fork()`s a warmed child per mutant ([README](https://github.com/boxed/mutmut)). The JS alternatives are:
  1. **A pre-spawned warm pool plus runtime mutant switching.** No per-mutant reload.
  2. **Pre-warming spares.** Keep k idle workers already warmed, so replacing a worker after a hang or a static mutant costs nothing on the critical path.
  3. **`vm` contexts per mutant inside a warm worker.** The context costs 0.2 ms and V8 code is shared, but module state has to be re-evaluated. Vitest's vm pools do this per file.
  4. **Bun `--isolate`-style fresh globals.** Not available to Node code.
- **`vm.SourceTextModule`** still requires `--experimental-vm-modules`. Vitest vmThreads and vmForks depend on it.
- **Worker threads vs forks.** Workers start 2–3× faster and support `terminate()`, but they share the process. Native addons that are not context-aware, `process.chdir`, `process.exit` and signal handlers all behave differently. Vitest defaults to `forks` for compatibility ([discussion #4914](https://github.com/vitest-dev/vitest/discussions/4914)). tzap should default to threads and fall back to forks.

### 4.4 The ESM problem

ESM has no public unload. Re-importing with a query string creates new module instances and leaks the old ones (§4.2). Consequences:

- **Runtime mutant activation is mandatory** for ESM SUTs in a warm process. Mutants cannot be "reloaded", because the code already contains all of them.
- **Static mutants** are mutations that only execute during module evaluation: top-level constants, class field initializers, module-scope config objects. They need a fresh module instance. Stryker marks them "static" and runs them with `reloadEnvironment` ([planner](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/core/src/mutants/mutant-test-planner.ts#L189-L192)). With a `registerHooks` loader that owns resolution, tzap can re-evaluate a **sub-graph** by appending `?tzap=<epoch>` to that sub-graph's URLs. This is a leak by design, so recycle the worker every N epochs. Alternatively, it can run static mutants in a fresh vm context or a fresh worker, batched at the end.

---

## 5. State leakage, isolation and hangs

### 5.1 What leaks in a reused process

- **Module-level state:** caches, memoized singletons, counters, registries (DI containers, i18n, event emitters). This is the primary false-kill and false-survive risk when SUT modules persist across mutants.
- **Globals and prototypes:** `globalThis.fetch` mocks, polyfills, `Date` / fake timers left installed, `process.env` changes.
- **Timers, sockets, servers:** leaked timers fire during the *next* mutant's test. Unhandled rejections get attributed to the wrong test.
- **Mocks:** `vi.mock` / `jest.mock` registries. Vitest 5 defaults `clearMocks: true` [C].
- **A mutant that corrupts shared state.** For example, a mutated cache key poisons the memo for every later mutant. This is unique to mutation testing and the strongest argument for **periodic recycling plus verification**. When a surviving or killed result is ambiguous, or after a mutant is known to have written shared state (detectable via the counters), re-run it in a fresh worker.

### 5.2 How existing tools isolate

| Tool | Default between units | Cost |
|---|---|---|
| Jest | New vm context and module registry **per test file**. `globalsCleanup` (30) scrubs leaked globals. | Re-evaluates the SUT per file |
| Vitest `isolate:true` (default) | `resetModules` per file in a pooled worker (threads/forks), or a new vm context (vm pools) | Re-imports the SUT per file |
| Vitest `isolate:false` | Shared module cache per worker; only test files are re-evaluated | Leaks SUT state across files and runs |
| Bun | Nothing by default. `--isolate` gives fresh globals per file with a shared transpile and bytecode cache. | Cheap |
| Stryker | One `createVitest` (or runCLI) per Stryker child process, and **the child process is restarted after timeouts and static mutants** | Process restart |

### 5.3 Hang detection

- **Synchronous infinite loops** block the worker's event loop. An in-band timer can never fire. The options are:
  - **In-band counters.** Stryker's `isActive()` increments `ns.hitCount` every time the active mutant is evaluated and throws `Hit count limit reached` when `hitCount > hitLimit`, with `hitLimit = 100 × dry-run hits` ([helper](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/instrumenter/testResources/instrumenter/console-sample.js.out.snap), [factor](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/core/src/mutants/mutant-test-planner.ts#L37)). This catches loops that repeatedly evaluate the mutated expression, such as loop conditions. It does **not** catch a loop elsewhere whose exit depends on a value the mutant computed once. It can also be swallowed by a user `try/catch`, so tzap should set a sticky flag in addition to throwing.
  - **Loop-back-edge counters** (the jzap approach): instrument each loop back-edge, or only loops in functions reachable from mutated code, with `if (++L > limit) throw`. With a typed array this costs about the same as §3.2's counters.
  - **Out-of-band termination:** a watchdog in the parent calls `worker.terminate()` (0.74 ms [M]) or `SIGKILL`s the fork after `timeout = factor × baseline + constant`. The worker is then lost and must be re-warmed; keep spares.
- **Async hangs** (a promise that never resolves, `await new Promise(()=>{})`) do **not** block the loop. A per-test timeout inside the runner (Vitest `testTimeout`, Mocha `timeout`) reports a failure, and the worker survives. Kill the timers and handles the test leaked, or recycle.
- **CPU-heavy but finite mutants** (for example a changed exponential algorithm) look like hangs. Use a timeout relative to the baseline duration of each test from the coverage pass, as PIT and Stryker do.

---

## 6. Transpilation and parsing costs

### 6.1 Running TypeScript

- **Node native type stripping** ([docs](https://nodejs.org/api/typescript.html)):
  - Added in v22.6, on by default since v23.6 / v22.18, no warning since v24.3, **stable since v25.2 / v24.12**.
  - **`--experimental-transform-types` removed in v26.0.** Not supported: enums, namespaces with runtime code, parameter properties, import aliases, tsconfig `paths`, decorators, and `.ts` files inside `node_modules`.
  - Types are replaced by whitespace, so no source map is needed and positions are preserved. That is ideal for mutation positions.
  - The implementation is amaro, a wrapper around `@swc/wasm-typescript` ([repo](https://github.com/nodejs/amaro)).
  - Measured `module.stripTypeScriptTypes` throughput: **35 MB/s**, i.e. 97 ms for 3.44 MB of TS [M].
- **Implication.** Many real codebases use enums, parameter properties or decorators (Angular, NestJS), so tzap cannot rely on Node stripping alone. It needs a real TS→JS transform (oxc-transform, swc or esbuild) with source maps, or the project's own pipeline (Vite and Vitest do this in the main process).

### 6.2 Parsers and transformers

**Native Rust, no JS interop** [C: [oxc bench](https://github.com/oxc-project/bench-javascript-parser-written-in-rust), M3 Max]:

| File | oxc | swc | biome |
|---|---|---|---|
| cal.com.tsx | 3.4 ms | 14.4 ms | 18.3 ms |
| typescript.js | 26.4 ms | 91.0 ms | 139.3 ms |

The transformer benchmarks put oxc about 4× faster than swc and **about 40× faster than Babel** [C: [oxc.rs benchmarks](https://oxc.rs/docs/guide/benchmarks)].

**From Node via NAPI, including AST materialization in JS** [C: [yuku benchmark](https://github.com/yuku-toolchain/ecmascript-parser-benchmark-js), M3]:

| File | Yuku (Zig) | Acorn | Babel | oxc-parser | @swc/core |
|---|---|---|---|---|---|
| typescript.js (7.8 MB) | 45 ms | 145 ms | 164 ms | 211 ms | 374 ms |
| checker.ts (2.95 MB) | 17 ms | fail | 67 ms | 62 ms | 121 ms |
| react.js (70 KB) | 0.29 ms | 0.85 ms | 1.12 ms | 1.12 ms | 2.09 ms |

**Key insight.** Crossing the NAPI boundary and building JS AST objects erases most of the Rust advantage: oxc-parser is about Babel speed when used from JS. The advantage survives only if the **whole mutate-and-instrument pass stays native** and returns a string plus a mutant table. oxc's experimental raw-transfer mode (a shared ArrayBuffer AST) narrows the gap but is undocumented. For tzap: do parsing, mutant generation, schemata codegen and source maps in Rust (oxc), and hand JS only the final code.

> **Reconciled with [toolchain-and-language.md](toolchain-and-language.md).** The table above is a
> third-party benchmark of AST *materialisation*. Measured locally on the full pipeline tzap needs
> (parse + schemata instrument + source map), oxc-parser with raw transfer plus magic-string is
> 2–5x faster than a Stryker-shaped Babel pipeline (cal.com.tsx: 81 ms vs 389 ms). Both notes agree
> that tzap's own CPU work is ≤2% of a PR-sized run, so this decides the parser, not the engine
> language. The Rust-native instrumenter is kept as a gated option (built only if tzap's own CPU work becomes a real share of a run), not the
> default. See [ADR 0001](../adr/0001-implementation-language.md).

**Schemata vs re-transform per mutant.** Re-transforming a file per mutant costs parse, transform and load, several ms per file even with oxc, and it forces a module reload. With schemata, each file is transformed once (at 40× Babel speed with oxc), and all of its mutants are then activated at runtime for free (§3.2: 1.00× when inactive). This is also Stryker's design. Stryker uses Babel, and moved to Babel 8 in 10.0 ([release](https://github.com/stryker-mutator/stryker-js/releases/tag/v10.0.0)).

### 6.3 Integrating with the project's pipeline

Two options:

- **Own the pipeline.** A `registerHooks` loader serves oxc-instrumented JS and strips TS. This works for Node, Mocha and node:test, and for Vitest with `viteModuleRunner:false`.
- **Plug into the project's pipeline.** Add a Vite plugin with `enforce: 'pre'` that runs the tzap instrumenter on the SUT files before other plugins, or rather after TS/JSX/SFC compilation so the code is plain JS. Vitest's transform cache (`fsModuleCache`) then persists the instrumented output. This is required for Vue, Svelte and Angular, whose SFC and template compilers must run first.

---

## 7. Monorepos and module graphs: test ↔ source reachability

- **Vitest `related` / `--changed`:** transforms each test file's import closure through the Vite SSR environment (`transformRequest`), builds reverse edges, and walks them back from the changed files. `node_modules` is skipped ([source](https://github.com/vitest-dev/vitest/blob/428e2e5043c64635b6b157358bde2fdeaa7b6b3a/packages/vitest/src/node/specifications.ts#L170-L240)). It honours aliases, tsconfig paths (via plugin) and SFCs because it uses the real transform. It is expensive the first time, since it amounts to a full transform of the test closures.
- **Jest `--findRelatedTests`:** uses jest-haste-map's dependency extraction plus jest-resolve (`unrs-resolver` in 30) ([CLI docs](https://jestjs.io/docs/cli#--findrelatedtests-spaceseparatedlistofsourcefiles)).
- **Workspace-level graphs:** Nx `affected` ([docs](https://nx.dev/ci/features/affected)) and Turborepo `--affected` ([docs](https://turborepo.com/docs/reference/run#--affected)) work at package granularity from `package.json` and workspace dependencies. They are too coarse for per-file selection, but useful as a first filter in diff mode.
- **Resolvers:** oxc-resolver is about 30× faster than enhanced-resolve [C: [oxc.rs](https://oxc.rs/docs/guide/benchmarks)] and handles tsconfig `paths`, `exports` / `imports` conditions, and pnpm symlinks.
- **Static graphs are approximations.** Dynamic `import()` with computed specifiers, `require` in try/catch, DI containers, `vi.mock` factories and bundler-only virtual modules all defeat static analysis. **Per-test coverage is the ground truth.** A static graph is only a cheap pre-filter for diff mode, telling tzap which test files could possibly reach a changed file before paying for a coverage run.

**Recommendation.** In diff mode:
1. Resolve the changed files to candidate test files with a Rust static graph (oxc parser plus oxc-resolver), and cache it.
2. Run the coverage pass only on those test files.
3. Use the per-test counters for exact mutant → test mapping.
4. Fall back to Vitest's `related` when the project needs Vite plugins to resolve modules.

---

## 8. Frontend specifics

- **DOM environments:** jsdom costs about **200–500 ms per import** and happy-dom **90–200 ms** [C: [Vitest perf guide](https://vitest.dev/guide/improving-performance)]. In an 80-file jsdom benchmark suite, environment setup accounts for most of the 4–5 s [C: [Vitest 5 blog](https://vitest.dev/blog/vitest-5.html)]. **A warm worker that sets up the DOM environment once and reuses it across mutants removes the single largest cost** for frontend suites. It must reset `document.body`, `localStorage`, timers and listeners between tests (RTL `cleanup()` already unmounts React roots).
- **React Testing Library:** `getByRole` computes accessibility trees and `getComputedStyle`, and can take 100–1000× longer than `getByTestId` ([dom-testing-library #820](https://github.com/testing-library/dom-testing-library/issues/820), [RTL #1213](https://github.com/testing-library/react-testing-library/issues/1213): about 1.6 s for a single call). Test execution itself, `Σ t_exec`, is significant in frontend suites, so kill-first ordering and early exit pay off more there than on backends.
- **JSX/TSX:** mutating JSX (attribute values, conditional rendering `&&`, ternaries) requires schemata that are valid inside JSX expression containers. Stryker handles this in Babel.
- **Vue SFC / Svelte:** the `<script>` blocks must be mutated before the SFC compiler runs, or the compiled output must be mutated using source maps. Stryker has a dedicated Svelte transformer and parses template expressions as TS when `lang="ts"` (a 10.0 fix). Template mutation, such as `v-if` conditions, is a separate problem.
- **Angular:** Vitest is now the default (v21). Templates are compiled into JS render functions, so only TS classes and services are cheaply mutable. Decorators rule out Node type stripping.
- **Browser mode or Playwright CT:** keep the page alive and flip `activeMutant` via RPC, as in §2.1. For hangs, kill the CDP target and reload, at a cost of about 100 ms or more.

---

## 9. Implications for tzap

### 9.1 Ranked levers (estimated speedup over a Stryker-like baseline, same machine)

| # | Lever | Mechanism | Estimated payoff | Confidence |
|---|---|---|---|---|
| 1 | **Warm worker pool with SUT evaluated once** | `worker_threads` (fall back to forks) that load the runner, environment and SUT once, and then receive `{mutantId, testIds}` messages | Removes 35 ms of spawn plus 100 ms–2 s of runner, environment and import per mutant. In-process overhead falls to about 50 µs [M]. **5–50×** on suites where boot dominates, which covers most frontend and Jest suites. | High |
| 2 | **Schemata with runtime activation** (no reload per mutant) | oxc-based instrumenter emitting `M.active===k` and typed-array counters | Zero transform or reload per mutant, and about 1.0× runtime overhead when inactive [M] | High |
| 3 | **Per-test coverage with typed-array counters** | `beforeEach` / `afterEach` snapshot into a per-test bitset | Runs only the covering tests, typically 1–5 per mutant instead of every test in related files. **3–20×** on top of related-files selection. | High |
| 4 | **Kill-test-first plus bail** | Order covering tests by prior kills (incremental cache), then by duration | For the typical 70–90% of mutants that are killed, cost goes from "all covering tests" to about "one test". **2–5×**. | High (jzap evidence) |
| 5 | **Incremental and diff mode** | Hash of (file content, mutant, covering tests' transitive deps); a Rust static graph pre-filter | 10–100× on PR runs | High |
| 6 | **In-band hang detection** | Hit counter on the active mutant plus back-edge counters with a sticky flag | Avoids timeout waits (1 s or more each) and worker re-warming. A large win when there are many timeout mutants. | Medium–High |
| 7 | **Node compile cache in workers** | `module.enableCompileCache()` | About 3× faster top-level compile on re-warm (97 → 32 ms per 4 MB [M]). Matters for spare workers and recycling. | High, small absolute gain |
| 8 | **Native-side mutation and instrumentation** | Rust oxc end-to-end, returning code strings | Instrumentation about 40× faster than Babel [C]. Matters for large repos and cold starts, not for steady state. | Medium |
| 9 | **Sharing a DOM environment across mutants** | One jsdom or happy-dom per worker, reset between tests | Saves 90–500 ms per mutant file on frontend suites [C] | Medium (reset correctness risk) |
| 10 | Snapshots and forking | — | Not feasible in Node today (§4.3) | — |

### 9.2 Recommended execution model

1. **Prepare**, in Rust with oxc:
   - parse the source;
   - generate mutants;
   - emit schemata-instrumented JS for every SUT file, containing `if (__tz.a===k)` switches, `__tz.c[k]++` counters and back-edge counters;
   - produce source maps and a mutant table;
   - hash everything for the incremental cache.

   Where TS cannot be stripped, transform it in the same pass. When the project needs Vite plugins (SFCs, aliases), deliver the instrumented code via a `pre` Vite plugin (Vitest adapter). Otherwise deliver it via a `module.registerHooks` loader (Node, Mocha and node:test adapters, and Vitest with `viteModuleRunner:false`).
2. **Coverage pass** (once, cached): run every relevant test file in the warm pool with per-test counter snapshots. This produces a map of mutant → [(test id, hits, duration)] plus static mutants (those hit outside any test).
3. **Mutant pass:**
   - Each worker is long-lived, with the runner, environment and SUT evaluated once.
   - For each mutant, the orchestrator sends `{mutant k, ordered test ids, hitLimit, timeout}`.
   - The worker sets `__tz.a = k` and runs the tests by id through the adapter: Vitest `runTestSpecifications` with `testIds` on `isolate:false` / threads; Mocha `grep` with `cleanReferencesAfterRun(false)`; a hosted jest-circus for Jest.
   - It bails on the first failure, resets `__tz.a`, and reports.
   - A parent-side watchdog calls `terminate()` on overrun, and a warmed spare takes the worker's place.
4. **Static mutants** go in a separate batch, each in a fresh vm context or worker (or by re-evaluating the sub-graph with `?epoch`), with capped parallelism.
5. **Hygiene:**
   - Recycle each worker after N mutants, or when its heap grows by more than X%.
   - Re-verify a sample of results (all survivors optionally) in fresh workers, to catch state-leak false negatives.
   - Record leaked handles per test.

### 9.3 Hard problems and risks

1. **State leakage across mutants in a warm process.** This is the central correctness risk. Mitigations: counters to detect which mutants wrote module state, periodic recycling, re-verification of survivors in a fresh worker, and a `--isolate` safety mode.
2. **Static mutants in ESM:** no unload, so every re-evaluation leaks. This needs an epoch-based loader plus recycling. Some projects have many static mutants (config objects, top-level constants).
3. **Adapting runners without public APIs.** Jest has no warm "run this test again" API. Hosting jest-runtime or jest-circus directly depends on internals that Jest 30 bundles. Vitest's APIs are good but still `experimental_` in places, and Stryker still resets `state.filesMap` as a hack ([discussion](https://github.com/vitest-dev/vitest/discussions/3017#discussioncomment-5901751)).
4. **Hang semantics:** hit limits can be swallowed by user `try/catch`, and loops outside mutated code are not counted. Terminating a worker loses its warm state, and re-warming a jsdom and SUT worker costs 0.5–3 s.
5. **Transform fidelity.** Vue, Svelte, Angular, decorators, enums and path aliases all need the project's own pipeline. Instrumenting after the framework compiler has run requires correct source-map composition to report positions in the original source.
6. **Unmeasured:** the per-rerun cost of Vitest `runTestSpecifications` for one test with `isolate:false` in a warm worker. **This is the first thing to benchmark** (install Vitest 5 in a sample repo, loop 1000 reruns of a single test id). If it exceeds about 5 ms, a thin custom harness that drives `@vitest/runner` directly inside tzap's own worker may be worth building.
7. **Windows process costs:** spawn is about 35–40 ms, measured here; Linux is typically faster. Any design that spawns per mutant is especially slow on Windows developer machines. A warm pool neutralises this.

---

### Appendix A: measurement scripts (summary)

All run with Node v26.7.0 on Windows 11 / i5-13600KF, each 20 iterations with the median reported unless noted.

- `startup.mjs`: `spawnSync`, `fork`+IPC, `new Worker`+message, `terminate()` during `for(;;){}`, `vm.createContext`.
- `cov.mjs`: tokenizer hot loop in variants plain, schema, counters, stryker-shape, and V8 coverage modes via `node:inspector/promises` `Session`. It also measures `takePreciseCoverage` latency.
- `covscale.mjs`: `takePreciseCoverage` latency against generated modules of 1k, 10k and 50k functions.
- `strip.mjs`: `module.stripTypeScriptTypes` on 3.44 MB of generated TS.
- `NODE_COMPILE_CACHE` on a generated 4.2 MB CJS file, and `reload.cjs` / `vmgraph.cjs` on a 500-module CJS/ESM graph.
- `proto.mjs`: a warm worker with a schemata-instrumented module, running 5000 mutant×test executions (`mutant` flips `globalThis.__M.active`).
