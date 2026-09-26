# tzap architecture

Decision in one line: **an engine that owns the test-execution loop, fed by a versioned project
model, delivering instrumented source through the user's own toolchain, running mutants in a warm
worker pool.** Runners, frameworks and CI systems are adapters around that core.

The research behind every choice here is in [research/](research/README.md); the language choice
is [ADR 0001](adr/0001-implementation-language.md). The shape deliberately follows
[jzap's](https://github.com/huyz0/jzap/blob/main/docs/architecture.md), and where it departs the
reason is the runtime, not taste.

## Pipeline

```
 project model ──► scope ──► inventory ──► instrument ──► coverage ──► execute ──► verdicts ──► reports
 (discovery or     (diff /    (oxc parse,   (schemata +    (warm pool,   (warm pool,  (cache,        (console, json,
  hand-written)    full)      mutators,     counters,      per-test      ordered,     typecheck      elements, agent,
                              filters)      source maps)   counters)     early exit)  survivors)     annotations)
```

1. **Model.** Discovery (`tzap model`) or a hand-written JSON describes packages, sources, tests,
   tsconfig and runner. The engine never reads `package.json` scripts or guesses a runner itself.
2. **Scope.** A git range or a patch file becomes changed line ranges per file, or the scope is
   everything. The engine understands only "these line ranges in these files".
3. **Inventory.** Each in-scope source file is parsed with oxc; mutators propose mutants; filters
   (arid, type-directed, equivalence, ignore comments) drop some with a recorded reason. No test
   runs. `tzap list-mutants` stops here.
4. **Instrument.** Every in-scope file is rewritten once, with all its mutants compiled in behind
   a numeric switch and a coverage counter per mutant site. Source dialect is preserved.
5. **Coverage.** The relevant tests run once, unmutated, in the warm pool. Per test: which mutant
   counters moved, hit counts, loop-iteration counts, duration. Counters that move outside any
   test mark **static** mutants. The baseline must be green; a red test is excluded and reported.
6. **Execute.** For each mutant: the covering tests, ordered previous-killer first then fastest
   first, run in a warm worker with the switch set; stop at the first failure.
7. **Verdicts.** Cache writes; survivors optionally type-checked and reclassified `CompileError`
   if the checker rejects them.
8. **Reports.** Sorted by mutant key, deterministic apart from a timing block.

## Package layout

A pnpm workspace. Published as **one npm package, `tzap`**, with entry points `tzap` (CLI),
`tzap/vitest`, `tzap/jest` and `tzap/runtime`; the internal packages exist to enforce boundaries,
not to be installed separately. In dependency order — nothing depends on anything below it, and a
boundary test (dependency-cruiser rules plus an import walk) asserts it:

```
@tzap/model        project model, mutant keys, statuses, result schema. Zero dependencies.
@tzap/runtime      the shim loaded into user code: active-mutant switch, counters, loop guard.
                   Zero dependencies, no Node built-ins beyond globalThis — it runs inside the
                   user's module graph, possibly in a browser-like environment. A test walks its
                   bundle and fails on any import.
@tzap/protocol     worker <-> controller messages. Zero dependencies (structured-clone payloads).

@tzap/instrument   oxc parse adapter, mutators, filters, schemata codegen, source maps, mutant ids.
@tzap/core         scheduling, coverage phase, worker pool, verdicts, cache, typecheck orchestration.
                   Knows the RunnerAdapter SPI, never a concrete runner, never git.

@tzap/git          git range or unified diff -> changed line ranges. Spawns the git CLI.
@tzap/report       console, native JSON, mutation-testing-elements, HTML, agent, GitHub
                   annotations, SARIF.
@tzap/discover     workspace, tsconfig and runner discovery -> project model. The analogue of
                   jzap's Gradle/Maven adapters.

@tzap/runner-vitest  RunnerAdapter implementations, loaded inside workers. Each resolves the
@tzap/runner-node    runner from the *user's* project, never bundles it.
@tzap/runner-jest
@tzap/runner-mocha

tzap               CLI: the composition root, the only package that knows all the others.
```

Why `git` and `report` are siblings of the engine rather than inside it: both see only the model,
which is what lets a CI system hand over a patch file instead of a repository, and what keeps the
engine testable without either.

## The seam: a project model

One versioned JSON document, produced by `@tzap/discover` or by hand:

```jsonc
{
  "schemaVersion": 1,
  "root": "/repo",
  "packages": [{
    "id": "@acme/orders",
    "root": "packages/orders",
    "sources": ["src/**/*.{ts,tsx}"],
    "exclude": ["src/**/*.d.ts", "src/generated/**"],
    "tests":   ["src/**/*.test.ts"],
    "tsconfig": "packages/orders/tsconfig.json",
    "runner": { "kind": "vitest", "config": "packages/orders/vitest.config.ts", "version": "5.0.2" },
    "environment": "node",
    "execArgv": [],
    "env": { "TZ": "UTC" }
  }],
  "scope":     { "kind": "diff", "from": "origin/main", "to": "-Local-", "granularity": "line" },
  "cache":     { "dir": ".tzap/cache" },
  "reporters": ["console", "elements", "agent"]
}
```

Why a file rather than flags, as in jzap: discovery stays dumb and unit-testable; a bug report is
"attach the model"; the model version moves independently of the engine; and a monorepo with
forty packages does not fit on a command line (Windows' limit is 32k characters).

**Multi-package from day one.** The model takes a list, because the ordinary monorepo shape is a
library package with no tests of its own, killed by tests in an app package. Analysing it package
at a time reports every mutant uncovered and the score means nothing. jzap learned this the hard way;
tzap starts there.

## Instrumentation

**Source in, same dialect out.** oxc-parser (raw transfer) gives a TS-ESTree AST with UTF-16
spans; magic-string splices around those spans. Nothing is re-printed, so comments, formatting
and everything tzap does not touch stay byte-identical, and the user's pipeline transpiles the
result exactly as it would the original.

**Encoding.** A global `__tz` object from `@tzap/runtime`, with `a` (active mutant id, `-1` when
none), `c` (a `Uint32Array` of per-mutant hit counters), and a loop budget. Three placements:

```ts
// expression — nested ternary; each branch carries the ORIGINAL operand text, never a clone
(__tz.c[17]++, __tz.a === 17 ? a - b : __tz.a === 18 ? a * b : a + b)

// statement
if (__tz.a === 42) { /* mutated: empty block */ } else { __tz.c[42]++; doWork(); }

// loop back-edge guard, only in instrumented files
while (cond) { if (++__tz.l > __tz.L) __tz.hang(); ... }
```

Measured cost of this shape when no mutant is active: ~1.0x on a hot loop, against ~10x for a
helper-call encoding ([runtime-and-execution.md §3.2](research/runtime-and-execution.md)). Counter
index = mutant id, so coverage needs no source-map remapping.

**Positions that are never mutated** — each a correctness rule with a fixture, not a filter:
type annotations and type-only constructs, `declare`, enum member initialisers used as types,
import/export specifiers, `super()` placement, directive prologues (`"use strict"`, `"use client"`),
decorator expressions (they run at class definition, i.e. static), and object/class keys.

**Delivery** — tzap never copies the project into a sandbox. Instrumented code reaches the runtime
through the pipeline the project already uses:

| Runner / setup | Delivery |
|---|---|
| Vitest (default) | Vite plugin, `enforce: 'pre'`, `transform` returns instrumented source + map |
| Vitest with `experimental.viteModuleRunner: false`, node:test, Mocha | `module.registerHooks` `load` hook in the worker |
| Jest | a transformer that instruments, then delegates to the project's configured transformer |
| Vue / Svelte / Astro | the framework's own parser locates `<script>` blocks; one magic-string over the whole file, so maps stay in original coordinates |

## Execution

**A warm worker pool.** `worker_threads` by default; child processes where a thread cannot work
(`process.chdir`, `process.exit`, non-thread-safe native addons, a runner that requires a process).
Each worker boots the runner, test environment (jsdom/happy-dom) and SUT **once**, then receives
`{mutantId, orderedTestIds, hitLimit, budgetMs}` messages. Measured round trip for a trivial test:
~47 us, against ~35 ms for a fork.

**The runner adapter SPI** is one of exactly three extension points (with mutators and reporters):

```ts
interface RunnerAdapter {
  boot(pkg: PackageModel, hooks: InstrumentHooks): Promise<void>;     // once per worker
  discover(): Promise<TestUnit[]>;                                    // stable ids
  run(tests: TestId[], opts: { bail: true; perTestBudgetMs: number }): Promise<RunResult>;
  onTestBoundary(cb: (id: TestId | null) => void): void;              // coverage attribution
  dispose(): Promise<void>;
}
```

A `TestUnit` id must be stable across runs — the cache keys killing tests by it. Where a runner
exposes only names, the id is `(file, full name path, ordinal among duplicates)`, and duplicate
names are reported, since name-based selection is ambiguous (Stryker's Vitest filter is regex on
names and broke on Vitest 5, #6210).

**Scheduling.** Mutants are partitioned by source file, so a worker keeps the modules it
exercises hot. Worker count defaults from a measured estimate of work, capped at cores − 1; jzap
measured that more workers than work is a net loss once a mutant is cheap.

**Hangs, deterministically.** Primary signal: the active mutant's hit count exceeding
10 x its baseline, and loop back-edges exceeding 10 x the unmutated run's count on the same tests
(with a floor). The guard sets a sticky flag before throwing, so a user `catch` cannot hide it.
Backstop: a per-test wall-clock budget; on expiry the controller calls `worker.terminate()`
(0.74 ms on a sync loop) and a pre-warmed spare replaces the worker. Async hangs (a promise that
never settles) do not block the thread and are caught by the per-test budget without losing the
worker.

**Static mutants** — reached only while a module evaluates — cannot be switched in a warm worker,
because the module already ran. They run in a separate batch, each re-evaluating the affected
module subgraph in a fresh context (strategy chosen by the static-mutant spike), running only test files that
import the module, never the whole suite by default.

## Soundness gates

The engine is only as trustworthy as these, and they exist before the optimisations they judge:

- **Reference engine.** `--engine=reference` runs every mutant in a fresh process with no reuse,
  no ordering and no caching. Kept permanently. Every fixture must produce identical verdicts
  under both engines, including fixtures written to leak module state, global state and timers.
- **Transparency.** Instrumented but unmutated, every project's suite must pass exactly as it
  does uninstrumented. Checked across the corpus in CI.
- **Oracle.** Verdict agreement with StrykerJS on shared mutants, every disagreement triaged
  ([parity-and-benchmarks.md](parity-and-benchmarks.md)).
- **Determinism.** Same model + same sources + same lockfile → byte-identical report outside a
  designated timing block, at 1, 2 and 8 workers.

## Statuses and score

tzap uses the **mutation-testing-elements status set as its own**, so no translation layer can
drift: `Killed`, `Survived`, `NoCoverage`, `Timeout`, `CompileError`, `RuntimeError`, `Ignored`.
`statusReason` carries the detail (which test, which hang signal, which checker diagnostic, which
filter).

Score is the schema's: `detected / valid`, where detected = Killed + Timeout, valid excludes
CompileError, RuntimeError and Ignored. Two consequences, both deliberate:

- A type-invalid mutant is not a test gap — the type system already rules it out — and it is not
  a test success either. It is outside the score, as in jzap. With ~29% of strict-TS mutants
  type-invalid, the default policy (type-check **survivors** only) means some type-invalid killed
  mutants still count as detected; `--typecheck=all` removes that bias at a measured cost, and
  every report states which policy produced it.
- A `RuntimeError` (the analysis broke) exits non-zero even when the threshold passes, as in jzap.

## Diff scoping

The git range only **selects**; analysis always runs against the working tree, and the CLI says
so. Changed lines come from the git CLI (`from`/`to`, `-Local-` for staged + unstaged, `-Empty-`)
or a unified diff with no repository. Mutant selection is by span overlap with added/modified
lines; a pure deletion marks the following line.

The part Stryker lacks: **the coverage phase is narrowed too.** Candidate tests are those whose
static import closure reaches a changed file (an over-approximation: dynamic `import()` with a
computed specifier or `require` of a variable widens to all tests in the package), then the cached
per-test coverage map narrows further. A differential test runs the narrowed and the un-narrowed
coverage on every fixture and asserts identical verdicts for in-scope mutants.

## Cache

Opt-in (`--cache-dir`), plain text in sorted sections so a diff of it is readable. Keys:

- **Mutant id:** hash of (package-relative path, enclosing scope path, mutator, normalised
  original text, replacement, ordinal within scope). Survives edits elsewhere in the file.
- **Reuse a Killed verdict** only if the killing test's file and its transitive import closure
  are unchanged. **Reuse Survived/NoCoverage** only if the covering set is identical and every
  covering test's closure is unchanged.
- **Invalidate everything** on a change of lockfile, tsconfig, runner config, tzap version, Node
  major, runner version, filter set or mutator set. The cache records this toolchain and refuses
  to be read under another.
- `Timeout` from the wall-clock backstop and `RuntimeError` are never cached.
- Coverage maps are cached too, and reused only when they cover every file the current run needs;
  jzap found that caching verdicts without coverage left most of the cost in place.

## Where the core is allowed to be opinionated

- tzap drives tests itself through the adapter SPI; it never shells out to `npm test` except in
  the reference engine's fallback and a documented "command" mode with no per-test selection.
- Type checking is optional and off the critical path.
- The runtime shim is dependency-free and relocatable, since it lives in the user's module graph.

## Risks this structure creates

- **State leakage in warm workers** — false kills and false survivals. Mitigated by the reference
  engine gate, deliberate-leak fixtures, recycling after N mutants or heap growth, and optional
  re-verification of survivors in a fresh worker.
- **Runner internals churn.** Vitest's APIs are partly `experimental_`; Jest has no warm re-run
  API. Mitigated by a narrow SPI, a CI version matrix per runner, and a clear error — never a
  plausible-looking zero — on an unsupported version.
- **Transform fidelity.** Instrumenting before the user's pipeline means the pipeline must accept
  what tzap emits. The transparency gate is the mitigation.
- **Over-abstraction.** Three extension points only: mutators, runners, reporters.
- **Model drift between discovery and reality.** A conformance suite runs each fixture through
  discovery and through a hand-written model and diffs them.
