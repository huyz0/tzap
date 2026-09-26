# tzap architecture

Decision in one line: **an engine that owns the test-execution loop, fed by a versioned project
model, delivering instrumented source through the user's own toolchain, running many mutants per
run in the project's own test runner, kept warm in a host process.** Runners, frameworks and CI
systems are adapters around that core.

The research behind every choice here is in [research/](research/README.md); the language choice
is [ADR 0001](adr/0001-implementation-language.md). The shape deliberately follows
[jzap's](https://github.com/huyz0/jzap/blob/main/docs/architecture.md), and where it departs the
reason is the runtime, not taste.

## Pipeline

```
 project model ──► scope ──► inventory ──► instrument ──► coverage ──► execute ──► verdicts ──► reports
 (discovery or     (diff /    (oxc parse,   (schemata +    (one run,     (warm rounds (cache,        (console, json,
  hand-written)    full)      mutators,     counters,      per-test      + isolated   typecheck      elements, agent,
                              filters)      source maps)   counters)     runs)        survivors)     annotations)
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
5. **Coverage.** The relevant tests run once, unmutated. Per test: which site counters moved, hit
   counts, loop-iteration counts, duration. Counters that move outside any test (while modules
   load) mark **static** mutants. A red test is excluded and reported.
6. **Execute.** Covered mutants are tried in warm rounds, many per runner invocation, each test's
   tries ordered previous-killer first then fastest first; a mutant's later tries are skipped once
   a test kills it. Static mutants, and those a warm verdict cannot be trusted for, run isolated.
7. **Verdicts.** Cache writes; survivors optionally type-checked and reclassified `CompileError`
   if the checker rejects them.
8. **Reports.** Sorted by mutant key, deterministic apart from a timing block.

## Package layout

A pnpm workspace. Published as **one npm package, `tzap`**, the CLI, with every internal package
bundled in (scripts/bundle.mjs); the internal packages exist to enforce boundaries, not to be
installed separately. In dependency order — nothing depends on anything below it, and
scripts/check-boundaries.mjs walks every import to assert it:

```
@tzap/model        project model, mutant keys, statuses, result schema. Zero dependencies.
@tzap/runtime      the shim loaded into user code: active-mutant switch, counters, loop guard.
                   Zero dependencies, no Node built-ins beyond globalThis — it runs inside the
                   user's module graph, possibly in a browser-like environment. A test walks its
                   bundle and fails on any import.
@tzap/protocol     the runner session contract and the engine <-> host messages; progress files.
                   Plain-data payloads that survive structured clone.

@tzap/instrument   oxc parse adapter, mutators, filters, schemata codegen, source maps, mutant ids.
@tzap/core         the engine: coverage phase, warm rounds, isolated runs, verdicts, cache,
                   import graph. Knows the RunnerSession contract, never a concrete runner, never git.
@tzap/typecheck    type-checks mutants against the project's tsconfig; rules that drop
                   type-invalid mutants before they run.

@tzap/git          git range or unified diff -> changed line ranges. Spawns the git CLI.
@tzap/report       console, native JSON, mutation-testing-elements, HTML, agent, GitHub
                   annotations, SARIF.
@tzap/discover     workspace, tsconfig and runner discovery -> project model. The analogue of
                   jzap's Gradle/Maven adapters.

@tzap/runner-kit     what every runner shares: the host-process session, the host loop, and
                     Node module hooks for runners that load modules through Node itself.
@tzap/runner-vitest  RunnerSession implementations. Each resolves the runner from the *user's*
@tzap/runner-node    project, never bundles it, and runs it in a host process of its own.
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

**Encoding.** A global `__tzap` object from `@tzap/runtime`, with `a` (active mutant number, `-1`
when none), `c` (a `Uint32Array` of per-site hit counters), a hit guard `m()` on every mutated
branch and a loop guard. Every mutant at one position shares that position's site. Actual output
for `while (s < a) { s += b; }` and `return a + b`:

```ts
// expression — nested ternary; each branch carries the ORIGINAL operand text, never a clone
while ((__tzap.a===1?(__tzap.m(),s <= a):__tzap.a===2?(__tzap.m(),s >= a):(__tzap.c[1]++,s < a))) {
  if(++__tzap.l>__tzap.L)__tzap.x();          // loop back-edge guard, only in instrumented files
  if(__tzap.a===3){__tzap.m();}else{__tzap.c[2]++; s += b; }   // statement: an emptied block
}
return (__tzap.a===4?(__tzap.m(),a - b):(__tzap.c[3]++,a + b));
```

Measured cost of this shape when no mutant is active: ~1.0x on a hot loop, against ~10x for a
helper-call encoding ([runtime-and-execution.md §3.2](research/runtime-and-execution.md)). Counters
are indexed by site number, so coverage needs no source-map remapping.

**Positions that are never mutated** — each a correctness rule with a fixture, not a filter:
type annotations and type-only constructs, `declare`, enum member initialisers used as types,
import/export specifiers, `super()` placement, directive prologues (`"use strict"`, `"use client"`),
decorator expressions (they run at class definition, i.e. static), and object/class keys.

**Delivery** — tzap never copies the project into a sandbox. Instrumented code reaches the runtime
through the pipeline the project already uses:

| Runner / setup | Delivery |
|---|---|
| Vitest | a Vite plugin, `enforce: 'pre'`, whose `load` hook returns instrumented source + map |
| node:test, Mocha | a `module.registerHooks` `load` hook in the host process |
| Jest | a transformer that instruments, then delegates to the project's configured transformer |
| Vue / Svelte | only `<script>` blocks are mutated: everything else is blanked to spaces for parsing, and edits are spliced into the original file, so positions stay in original coordinates and the framework's compiler sees an ordinary component |

## Execution

**A host process per package.** Each runner session forks a host that loads the user's runner
from the project and keeps it, and the modules under test, warm across runs. A mutant that blocks
the host's thread forever is dealt with by killing the process, the one thing that reliably stops
synchronous JavaScript.

**The runner session contract** (`@tzap/protocol`) is one of exactly three extension points (with
mutators and reporters):

```ts
interface RunnerSession {
  start(): Promise<{ runnerVersion: string; isolatesFiles?: boolean; staticPerFile?: boolean; threads?: boolean }>;
  listFiles?(): Promise<string[]>;             // the runner's own test files, for diff narrowing
  run(request: RunRequest): Promise<RunResult>; // coverage, mutate (warm) or static (isolated)
  close(): Promise<void>;
}
```

A `mutate` request carries a plan: per test, the ordered tries `{ m, N, L }` (mutant, hit limit,
loop limit). The runner runs every try of a test through its own retry or repeat machinery, so
each try gets the full beforeEach -> body -> afterEach cycle, and reports an outcome letter per
try. A test id must be stable across runs — the cache keys killing tests by it: `file::suite >
name`, with ` #n` for the nth duplicate name in a file.

**Warm rounds, bracketed by controls.** Round one tries each mutant against its likeliest killer,
round two against the rest of its covering tests. Each test's tries in a round are bracketed by
unmutated controls: when a control fails, the tries it brackets ran in state the unmutated test is
unhappy with and do not count; they are tried again, each behind a control of its own, until a
round resolves none of them, and then in isolation.

**Isolated runs.** A static mutant — reached while a module evaluates — is active from before any
module loads, in a session whose runner gives every test file fresh modules; every test of every
file that loads the module judges it. Mutants whose files do not overlap share a run where the
runner can activate a different mutant per file. A warm survivor whose tests can reach mutable
module state is confirmed the same way (`--verify-survivors`).

**Hangs, deterministically.** Primary signal: the active mutant's hit count exceeding 100 x its
baseline, and loop back-edges exceeding 10 x the unmutated run's count (each with a floor). The
guard sets a sticky flag before throwing, so a user `catch` cannot hide it. Backstop: silence —
every host and worker records each try's start and end in a progress file, synchronously; when no
try has started or ended for the budget, the host is killed, the try in flight is Timeout, and the
rest of the round runs again in a new host.

## Soundness gates

The engine is only as trustworthy as these, and they exist before the optimisations they judge:

- **Reference engine.** `--engine=reference` runs every mutant in a fresh process with no reuse,
  no ordering and no caching. Kept permanently. Every fixture must produce identical verdicts
  under both engines, including fixtures written to leak module state, global state and timers.
- **Transparency.** Instrumented but unmutated, every project's suite must pass exactly as it
  does uninstrumented: the coverage run is that run, and a test red in it is reported.
- **Oracle.** Verdict agreement with StrykerJS on shared mutants, every disagreement triaged
  ([parity-and-benchmarks.md](parity-and-benchmarks.md)).
- **Determinism.** Same model + same sources + same lockfile → byte-identical report outside a
  designated timing block, whatever the worker count.

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
static import closure reaches a changed file, following tsconfig `paths` (an over-approximation:
dynamic `import()` with a computed specifier, `require` of a variable, or a bare specifier nothing
resolves — a bundler alias — widens to all tests in the package). A differential
test runs the narrowed and the un-narrowed coverage and asserts identical verdicts for in-scope
mutants.

## Cache

Opt-in (`--cache-dir`), plain text in sorted sections so a diff of it is readable. Keys:

- **Mutant id:** hash of (root-relative path, enclosing scope path, mutator, normalised
  original text, replacement, ordinal within scope). Survives edits elsewhere in the file.
- **Reuse a Killed or Timeout verdict** only if the killing test still reaches the mutant and its
  transitive import closure is unchanged. **Reuse Survived** only if the covering set is identical
  and every covering test's closure is unchanged. **Reuse a static mutant's verdict** only if the
  same tests would decide it (every test of the files that load it) and none of their closures
  changed. NoCoverage is decided afresh by the coverage run, which always happens.
- **Ignore everything** under a different toolchain: tzap version, Node major, platform, runner
  versions, mutator and filter sets, type-check and survivor-verification settings, and a hash of
  the dependency, compiler and runner config files (manifests, lockfiles, tsconfig, runner
  configs), which change how every test runs without changing any import closure.
- `Timeout` from the wall-clock backstop and `RuntimeError` are never reused.
- **Nothing changed at all** (every file under the package roots fingerprinted, fixtures and
  data included): every verdict is
  reused and no test runs. Otherwise the coverage run happens, since reuse is decided on it.

## Where the core is allowed to be opinionated

- tzap drives tests itself through the runner session contract; it never shells out to
  `npm test`.
- Type checking is optional and off the critical path.
- The runtime shim is dependency-free and relocatable, since it lives in the user's module graph.

## Risks this structure creates

- **State leakage in warm runs** — false kills and false survivals. Mitigated by controls around
  every warm try, the reference engine gate, deliberate-leak fixtures, and re-verification of
  survivors in isolation.
- **Runner internals churn.** Vitest's APIs are partly `experimental_`; Jest has no warm re-run
  API. Mitigated by a narrow SPI, a CI version matrix per runner, and a clear error — never a
  plausible-looking zero — on an unsupported version.
- **Transform fidelity.** Instrumenting before the user's pipeline means the pipeline must accept
  what tzap emits. The transparency gate is the mitigation.
- **Over-abstraction.** Three extension points only: mutators, runners, reporters.
- **Model drift between discovery and reality.** A conformance suite runs each fixture through
  discovery and through a hand-written model and diffs them.
