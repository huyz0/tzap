# Research: fast, diff-aware mutation testing for TypeScript and JavaScript

Synthesis of the research tzap is built on. Dated 2026-09-26. The four notes below hold the
detail and the sources; this page holds the conclusions and the decisions they force.

| Note | Question it answers |
|---|---|
| [stryker-js.md](stryker-js.md) | How StrykerJS 10.0 works, read from source, and where its time goes |
| [landscape.md](landscape.md) | Every other JS/TS tool, fast engines in other ecosystems, the literature, type-invalid mutants measured |
| [runtime-and-execution.md](runtime-and-execution.md) | Where the wall clock of a JS mutation run goes, and which runtime levers exist (measured on Node 26) |
| [toolchain-and-language.md](toolchain-and-language.md) | Engine language, parser, codegen, type checking, packaging, mutant identity |
| [bench/](bench/) | The throwaway parser/instrumenter benchmarks behind the toolchain numbers |

Tags used in the notes: **[M]** measured here (Node 26.7, Windows 11, i5-13600KF), **[src]** read
from source at a pinned commit, **[C]** a claim by the project or a third party, not reproduced.

The sibling project [jzap](https://github.com/huyz0/jzap) is the template: same method (oracle
first, correctness before speed, every number with a range, every reduction with its detection
loss), different runtime.

---

## 1. The market: one incumbent, a crowd of prototypes

- **StrykerJS is the only serious tool.** 10.0.0 released 2026-08-14, ~3.1k stars, ~9.2M npm
  downloads a month for `@stryker-mutator/core`. Everything older (Mutode, grunt-mutation-testing,
  js-mutation-testing, Mutandis) is dead.
- **About fifteen 2024–26 entrants**, almost all aimed at AI coding agents (mutineer, three
  separate `mutate4ts`, Mutasaurus for Deno, testtruth, gutcheck, …). None has traction, none
  publishes a benchmark, and the Rust-written ones run the user's test command once per mutant —
  they gave up schemata and per-test coverage, so a fast parser bought them nothing.
- **No JS mutation tool does native line-level diff scoping.** Users script `git diff` into
  Stryker's `--mutate file:L1-L2`, and even then Stryker runs the **full** suite dry run with
  coverage, so a one-line PR pays whole-suite cost.

The unclaimed position mirrors jzap's: **free, fast, diff-first, type-aware, low-noise, and
emitting the mutation-testing-elements schema so Stryker's HTML report, dashboard and existing
actions keep working.** Compete on the PR loop, not on runner breadth.

## 2. Where StrykerJS spends its time

Ranked, for a typical Vitest or Jest TypeScript project ([stryker-js.md §11](stryker-js.md)):

1. **Per-mutant test-framework invocation.** Jest: a full `runCLI(runInBand)` per mutant, a fresh
   module registry per test file, and **no bail** (`bail:false` is forced) — one dry run measured
   41.8 s of overhead against 3.1 s of test time. Vitest: `ctx.start()` per mutant, re-executing
   test files and their imports. Only Mocha/Jasmine/Cucumber hot-reload.
2. **Static mutants** — mutants reached only at module load. Each runs the full suite in a fresh
   environment. Reported shares: 2% of mutants taking 45% of time; 8% taking 83%.
3. **No test ordering.** Covering tests run in dry-run order; nothing puts the previous killer
   first.
4. **Timeouts:** `1.5 × net + 5000 ms + suite overhead`, then a worker re-fork.
5. **Fixed costs:** sandbox copy of the project, sequential Babel instrumentation, workers started
   two at a time (21 s to start 12 in one report), full dry run even in incremental/range modes.
6. **Type checker:** up to 10× slower before mutant grouping; grouping cut 43% at 99.1% accuracy.
7. **Instrumentation tax:** `stryCov_`/`stryMutAct_` helper calls on every evaluation, on every
   run. Measured at ~10× on a hot loop against ~1.0× for an inline typed-array switch
   ([runtime-and-execution.md §3.2](runtime-and-execution.md)).

Reported real-world costs: ~20 h estimated for 5.2k mutants with a 73 s suite; 2.5 h for 2.5k
mutants on Karma; 7 min for 2,637 mutants on Vitest 4.1. There is **no neutral head-to-head
benchmark**, Stryker's own perf tests were disabled in CI in June 2026, and its report never fills
the `performance` fields. A reproducible published benchmark is itself a contribution.

## 3. Where the wall clock of a JS mutation run goes

Measured on Node 26.7 ([runtime-and-execution.md](runtime-and-execution.md)):

| Cost | Measured |
|---|---|
| `child_process.fork` to first IPC message | ~35 ms |
| New `worker_threads` worker | ~15 ms |
| Fresh `vm` context | ~0.2 ms |
| Warm worker: send mutant id, run one small test, reply | **~47 µs** |
| jsdom import | 200–500 ms [C] |
| 500-module CJS graph: first load / cache-clear reload / re-eval in fresh vm | 110 / 22 / 2 ms |
| Node compile cache on a 4.2 MB file | 97 → 32 ms |
| `worker.terminate()` on a sync infinite loop | 0.74 ms (then the worker must re-warm) |

**The harness is not where the time goes; boot, re-import and unselected tests are.** A warm
worker round trip is ~750× cheaper than a fork. The tool's own CPU work — parse, instrument,
source-map, diff, hash — is ~0.01–0.35 s for a PR touching 5–50 files, under 2% of the run
([toolchain-and-language.md §1](toolchain-and-language.md)).

Coverage instrumentation cost on a hot branchy loop:

| Variant | Slowdown |
|---|---|
| Schemata switch `M.active === k`, no mutant active | 1.00× |
| + flat `Uint32Array` counter increment | ~1.0× (noise) |
| Stryker's helper-call shape | ~10× |
| V8 precise coverage, function level | 1.0× |
| V8 precise coverage, block level | ~8× |

The cheapest per-test coverage is **inline typed-array counters**, which also need no source-map
remapping, because the counter index *is* the mutant id.

## 4. What transfers from jzap, and what does not

| jzap technique | JS/TS status |
|---|---|
| Mutant schemata, branch-free dispatch | Transfers. Stryker already uses schemata; the win is the cheaper encoding and not paying runner boot per mutant |
| Per-test coverage + early exit | Transfers, and Stryker lacks bail in Jest |
| Kill-test-first ordering | Transfers; Stryker has none |
| Deterministic hang detection (loop counting) | Transfers, and matters more: a sync infinite loop blocks the event loop and only `terminate()` stops it |
| Incremental cache keyed on content | Transfers; must key on the covering tests' **transitive module graph**, which Stryker ignores |
| Warm daemon | Transfers, but the bigger win is warm **workers within a run**, which Stryker lacks for Jest/Vitest |
| Line-level diff scoping | Transfers, plus a new requirement: **narrow the dry run**, not just the mutants |
| Forked analysis JVM with shaded, dependency-free agent | Becomes: warm `worker_threads` pool with a dependency-free runtime shim loaded into user code |
| Bytecode as the mutation substrate | Does **not** transfer. JS has no stable IR a user ships; mutate source, keep the dialect, let the user's pipeline transpile |
| `fork()` a warmed process (mutmut 3) | Not available: no `fork()` in V8/Node, none on Windows, and user-land V8 snapshots cannot capture a warmed test environment |
| JVM-level class redefinition for static initialisers | Becomes: re-evaluating the importing module subgraph in a fresh context; ESM cannot be unloaded, so this leaks and needs recycling |

## 5. The JS-specific problems jzap did not have

1. **Type-invalid mutants.** Measured on eight of Stryker's own TS modules from its dashboard:
   **3,263 of 11,307 mutants (28.9%) are CompileError** (21–37% per module). The worst operators:
   OptionalChaining 87%, ObjectLiteral 69%, ArrowFunction 57%, BlockStatement 44%,
   LogicalOperator 42%; ArithmeticOperator ~2%. Strict-mode code; looser projects will be lower.
   Nobody chooses replacements that type-check *before* generating them. That is an unclaimed
   technique, and the score definition around it moves a TS project's score substantially.
2. **Runner diversity without a common platform.** The JVM had the JUnit Platform. JS has Vitest,
   Jest, Mocha, node:test, Bun, Deno, Karma (deprecated; Angular 21 moved to Vitest), each with its
   own module system and isolation. Vitest 4.1 added test-id selection and a native-loader mode;
   Jest has no public warm re-run API and bundles its internals since Jest 30.
3. **ESM cannot be unloaded.** Static mutants in ESM mean re-evaluation with leaks, bounded by
   worker recycling.
4. **Transpilation fidelity.** TS enums, namespaces, parameter properties, decorators, path
   aliases, Vue/Svelte/Astro SFCs, Angular templates. Node's type stripping handles none of the
   first four and Node 26 removed `--experimental-transform-types`. Conclusion: tzap mutates the
   source dialect and hands it to the user's own pipeline (Vite plugin, Jest transform, loader hook).
5. **Noise.** Logging mutants are Stryker's most-discussed complaint (#1472); one user reported
   half their survivors were logger strings/objects. Google's arid-node rules moved usefulness from
   ~15% to 80–89%, and the logging rule was right on 99 of 100 sampled cases.
6. **Frontend environment cost.** jsdom/happy-dom boot is hundreds of ms; it must be paid per
   worker, not per mutant.

## 6. Language and toolchain

Settled in [ADR 0001](../adr/0001-implementation-language.md): **TypeScript on Node**, ESM-only,
parse with **oxc-parser** (raw transfer), edit with **magic-string** span splicing, keep the source
dialect, check types with **TypeScript 7** through its (currently unstable) API. Rust is an escape
hatch gated on a measurement, not a starting point.

Key measured numbers ([toolchain-and-language.md §1.3](toolchain-and-language.md)):

| File | oxc raw transfer + magic-string | Babel parse + traverse + generate (Stryker-shaped) |
|---|---:|---:|
| utils.ts, 210 mutants | 1.9 ms | 10.5 ms |
| scanner.ts, 842 mutants | 6.9 ms | 27.6 ms |
| cal.com.tsx (1 MiB), 1,581 mutants | 80.7 ms | 389 ms |

One design trap found while measuring: a naive schemata pass that clones an already-instrumented
subtree grows **exponentially** with nesting depth (ran out of memory at 12 GB on
`typescript.js`). Copying the original operand *text* into the mutant branch keeps it linear.

TypeScript 7 (the Go compiler) went GA 2026-07-08, claims 8–12× faster checks, and exposes only
`typescript/unstable/*` RPC APIs until 7.1 (stable planned 2026-11-24). There is no public Go API,
so writing tzap in Go would not buy type-check speed; depending on TS 7 does.

## 7. What the literature adds

- **Google** (TSE'21): 16.9M mutants over 776k changelists, including 1.0M TypeScript mutants.
  Median per changelist: 820 unfiltered → 77 at one-per-line → **7** with arid suppression. Mutants
  would have flagged 70% of 1,502 high-priority bugs on the change that introduced them (ICSE'21).
- **jzap's counter-evidence on one-per-line:** it lost 43 of 125 real survivors (34%) for 1.4×.
  One-per-line is a user choice with a published price, not a default.
- **LLM mutants** (LLMorpheus, JS, TSE 2025): 20% of survivors equivalent vs 1% for Stryker. Meta's
  ACH: 25% trivially equivalent. Not an engine; possibly a later opt-in tier.
- **TCE for JS**: minifier-normalised comparison (oxc-minify/terser) is the analogue. jzap found
  TCE drops zero mutants on javac output; JS minifiers fold more, so it must be measured, off by
  default.
- **Grouped/simultaneous mutants**: 3% on Stryker once sessions are cheap. Not worth it.
- **Predictive mutation testing**: its accuracy was mostly coverage in disguise. Not worth it.

## 8. Decisions this research forces

Each is taken in [architecture.md](../architecture.md):

1. **tzap owns the execution loop.** Only an owned loop gets schemata, per-test coverage, ordering
   and uniform early exit. The cost is tracking runner internals; the mitigation is a narrow
   adapter SPI and a version matrix. (Stryker's Vitest name filter just broke on Vitest 5: #6210.)
2. **Vitest first**, node:test second, Jest third. Vitest has test-id selection, `isolate:false`
   warm workers and is Angular's default; node:test is native and simple; Jest is the largest
   installed base and the hardest to host warm.
3. **No sandbox copy.** Serve instrumented modules from memory via the user's own pipeline.
4. **Score definition:** CompileError (type-invalid) and RuntimeError are outside the score, as in
   jzap and the mutation-testing-elements metrics. Timeouts count as detected, as in the schema.
5. **Diff scoping narrows the dry run.** Static import graph as an over-approximate pre-filter,
   cached per-test coverage as the precise filter, differential test against an un-narrowed run.
6. **Reuse soundness is tested, not assumed**: every fixture runs with one fresh worker per mutant
   and with reuse; verdicts must match, including a fixture that leaks module state on purpose.
7. **StrykerJS 10.0.0 is the oracle.** Match mutants by `(file, mutator, location, replacement)`,
   Stryker's own incremental key; run Stryker on Vitest 4.1.x or Jest, no `testFiles`, concurrency
   ≤ half the physical cores, twice, flips quarantined.
8. **Emit mutation-testing-elements JSON from day one**, with `performance` and per-mutant
   `duration` filled — which also makes the Stryker comparison measurable.

## 9. Open questions the first spikes must answer

Each could change the architecture, so each was measured before the engine was built; the
answers are in [spikes/](../spikes/) and [status.md](../status.md).

1. **Vitest warm re-run cost** for one test id with `isolate:false` in a warm worker. If above
   ~5 ms, drive `@vitest/runner` directly inside tzap's own worker instead of hosting Vitest.
2. **Jest warm hosting**: can jest-circus + jest-runtime be hosted in a long-lived worker across
   mutants on Jest 30, and at what maintenance cost?
3. **Transparency**: instrument every file of the Tier B corpus and run each project's own suite
   unmutated. Anything short of 100% passing is a blocker.
4. **Static-mutant strategy for ESM**: epoch-based re-evaluation vs fresh worker, measured on a
   fixture with many top-level constants.
5. **TS 7 unstable API**: per-mutant check cost, grouping, and survivors-only checking.
