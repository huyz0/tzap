# StrykerJS parity and benchmark harness

StrykerJS is tzap's correctness oracle and its performance baseline, as PIT was for jzap. The
harness is built before the engine it judges, and every engine change is gated on it.
Nothing about the engine is believed until this harness says so.

Stryker's internals and known oracle hazards are in [research/stryker-js.md](research/stryker-js.md).

## 1. Why StrykerJS is the oracle, and where it is not trusted

StrykerJS 10 is mature, used everywhere, and writes a per-mutant verdict in the
mutation-testing-elements schema — the same schema tzap writes, so neither format is privileged
by translation. If tzap and Stryker disagree on a mutant, one is wrong, and the burden of proof
is on tzap.

Stryker has **known open verdict bugs**, and the harness must not import them as truth:

- Static mutants reported Survived when `testFiles` is set (#6144, #6209) → never set `testFiles`.
- Vitest 5's name matching makes filtered mutants run zero tests (#6210) → run Stryker on
  Vitest **4.1.x**, not 5.
- Scores vary between identical runs from load-induced timeouts and worker reuse (#4878, #5284)
  → run twice, quarantine flips, concurrency ≤ half the physical cores, generous `timeoutMS`.
- Hot-reload runners can leak state between mutants (#6147) → a disagreement on a mutant in a
  state-leaking module is checked against tzap's reference engine before being blamed on tzap.

Pinned baseline configuration: `@stryker-mutator/*` 10.0.0, `coverageAnalysis: perTest`,
`ignoreStatic: false`, no `testFiles`, `checkers: []` for verdict comparison (and a second run with
the TypeScript checker for the CompileError comparison).

## 2. Corpus

All pinned to exact commits in `tools/parity/corpus.lock`; never a floating ref.

**Tier A — microfixtures (hand-written, ~50).** One tiny package per semantic hazard, each with a
hand-written expected outcome independent of both tools. A hand-written expectation always
outranks Stryker.

- One per mutator (the seventeen Stryker operators in [research/stryker-js.md §3](research/stryker-js.md)).
- Language hazards: `const` TDZ, function hoisting, class fields and `#private`, getters/setters,
  `super` in constructors, generators, `async`/`await`, `for await`, optional chaining chains,
  nullish assignment, labelled `break`/`continue`, `switch` fallthrough, tagged templates,
  `using`/`await using`, top-level `await`, `"use client"` directives, regex literals, BigInt.
- TypeScript hazards: enums (const and regular), namespaces, parameter properties, legacy and
  TC39 decorators, `satisfies`, `as const`, overloads, abstract classes, `declare`, path aliases.
- Module hazards: CJS, ESM, dual packages, circular imports, dynamic `import()`, JSON imports,
  module-level state (a counter, a memo cache, a singleton), top-level side effects.
- Runtime hazards: sync infinite loop, async never-settling promise, `setInterval` left running,
  `process.exit`, `process.chdir`, unhandled rejections, tests that spawn workers or child
  processes, fake timers, snapshot tests.
- Test-side hazards: duplicate test names, `describe.each`/`test.each`, `.only`/`.skip`/`.todo`,
  concurrent tests, retries, shared `beforeAll` state, order-dependent tests.
- Frontend: TSX with React Testing Library under jsdom and happy-dom; a Vue SFC; a Svelte
  component.

**Tier B — real TS/JS libraries (~8).** Mid-size, fast suites, permissive licences, a mix of
runners. Candidates, runner confirmed at pin time: zod, valibot, date-fns, superjson, immer,
Redux Toolkit, commander.js, express (Mocha). At least two on Vitest, two on Jest, one on Mocha,
one on node:test.

**Tier C — real applications and monorepos (~4).** A pnpm monorepo with a test-less library
package, a React app, a Node service, and a Vue or Svelte app. Tier C is where tzap must beat
Stryker on *noise* and *PR latency*, not just throughput.

## 3. Mutant identity and normalisation

Comparison key, which is Stryker's own incremental key:

    (package-relative file, mutatorName, start line:column, end line:column, replacement text)

- **Location, not mutant id.** Stryker's ids are run-local integers.
- **Replacement normalised** (whitespace collapsed, quotes normalised) because both tools may
  print the same mutation differently.
- `tools/parity/mutator-mapping.yaml` maps each tzap mutator to Stryker's as `equivalent` /
  `broader` / `narrower` / `no-equivalent`, each `no-equivalent` justified in writing. tzap uses
  **Stryker's mutator names** for the shared set, so the mapping is mostly identity.
- Both tools' reports are parsed by the same mutation-testing-elements reader into one normalised
  record type.

## 4. Correctness comparison

Same corpus commit, same runner and version, same Node, same mutator set (the mapped
intersection), filters that Stryker lacks switched **off** (arid, type-directed, equivalence).

1. **Inventory.** `tzap-only`, `stryker-only`, `shared`. Every *category* of difference is named
   in the baseline.
2. **Verdict.** An agreement matrix over the seven statuses for shared mutants. `Killed` vs
   `Survived` is the serious cell and blocks release until explained. Compared per mutant, never
   as a score: the two tools can agree on every verdict and print different scores when the
   checker is off (Stryker then runs type-invalid mutants as JS).
3. **Killing test.** `killedBy` / `coveredBy` sets compared. Differences surface coverage
   attribution and test-selection bugs, which is exactly the machinery tzap changes.
4. **CompileError.** With Stryker's TypeScript checker on and `tzap --typecheck=all`, the sets of
   type-invalid mutants must agree; a difference is a checker-configuration or tsconfig bug.

### Triage discipline

Every disagreement is exactly one of:

- **A — tzap bug.** Fixed before the work that exposed it is called done.
- **B — Stryker limitation.** Documented with its issue number; a Tier A fixture with a
  hand-written expectation proves tzap right.
- **C — intentional semantic difference.** Written justification in the baseline.
- **D — nondeterminism in the project under test.** Quarantined, reported as a test-quality
  signal.

`tools/parity/parity-baseline.yaml` records every accepted B/C/D. CI fails on any unlisted
disagreement, and on a baselined disagreement that **disappears** without the baseline changing.

### Self-differential testing

`--engine=reference` — one fresh process per mutant, full covering set, no reuse, no ordering, no
cache — is kept forever. Every optimisation must produce identical verdicts to it on Tier A and
Tier B, on and off. This catches what Stryker comparison cannot: state leakage in warm workers,
stale cache verdicts, narrowed-coverage mistakes.

## 5. Performance comparison

### Controls

Published numbers: a quiet machine (fixed governor, no turbo, nothing else running), same Node
build, same runner version for both tools, same worker count, same mutator set, same timeout
settings, reports on a RAM disk. Install and build time excluded and reported separately.
Five runs, **median with min–max**, never a best run. On a busy machine, compare two builds by
alternating them, and treat differences below the ordering effect as unmeasured (jzap measured
that effect at ~10% under load).

Windows and Linux are reported separately: process spawn is ~35 ms on Windows and 2–3x cheaper on
Linux, which changes Stryker's numbers more than tzap's.

### Scenarios

| # | Scenario | What it isolates |
|---|---|---|
| S1 | Full run, one Vitest package, cold | headline throughput |
| S2 | Full run, one Jest package, cold | the runner Stryker is slowest on |
| S3 | Diff run: synthetic 10-line PR, cold | PR latency, the core claim |
| S4 | Diff run: same PR, warm cache | best-case developer loop |
| S5 | Re-run with no changes | cache effectiveness |
| S6 | Re-run after a one-line change | invalidation precision |
| S7 | Full run, monorepo with a test-less library | cross-package selection |
| S8 | Frontend package (TSX + jsdom), full run | environment amortisation |
| S9 | Package with many static mutants | the static-mutant path |

A scenario that cannot fail is not measuring anything: the harness derives S3's changed lines
from the inventory and refuses to print a figure when nothing is in scope (jzap's first diff
benchmark reported 158x for a patch that hit no mutants).

### Baselines

- StrykerJS 10.0.0, default config plus `perTest`
- StrykerJS with `--incremental` (for S4–S6)
- StrykerJS with `--mutate file:L1-L2` ranges from the same diff (the best a Stryker user can do
  for S3)
- StrykerJS with the TypeScript checker (for the CompileError comparison only)

### Metrics

Per scenario, per tool: wall clock by phase (discover / instrument / coverage / execute / typecheck
/ report), mutants generated, mutants executed, **test executions per mutant**, worker boots,
mutants per second, peak RSS, CPU-seconds, process and thread count.

`test executions per mutant` and `worker boots` are machine-independent, so they are the CI gates;
wall clock on shared CI is advisory.

### Fairness rules

- A reduced tzap mutant set is never compared with Stryker's full set on a time axis; reductions
  report time **and** detection loss side by side.
- Every scenario tzap loses is published as prominently as those it wins.
- Both tools' configuration is checked in so anyone can rerun it.

## 6. Deliverables

    tools/parity/
      corpus.lock                pinned corpus, exact commits and runner versions
      mutator-mapping.yaml       tzap <-> Stryker mutator equivalence
      parity-baseline.yaml       accepted B/C/D disagreements with justification
      run.ts                     run both tools over a tier
      normalise.ts               elements JSON (both tools) -> normalised records
      compare.ts                 inventory diff, agreement matrix, triage report
    tools/bench/
      scenarios.yaml             S1–S9
      budgets.yaml               CI budgets on machine-independent metrics
      report.ts                  markdown + chart output
