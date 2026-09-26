# tzap

Fast, diff-aware mutation testing for TypeScript and JavaScript.

**Status: research and plan. Nothing is built yet.** See [docs/](docs/README.md).

Mutation testing measures whether your tests would actually notice a bug: it changes your code in
small, realistic ways and reports every change the test suite fails to catch. tzap aims to do for
TS/JS what [jzap](https://github.com/huyz0/jzap) does for Java and Kotlin: make that fast enough
to run on every pull request.

## The thesis

StrykerJS, the only serious tool in the ecosystem, spends most of a run on things other than the
tests: booting the test runner per mutant (Jest re-imports the module graph each time, and cannot
stop at the first failing test), static mutants that re-run the whole suite, and a full-suite dry
run even when only one line changed. tzap's levers, each measured before it is claimed:

- a **warm worker pool**: runner, environment and code under test loaded once; a mutant is a
  number written to a global (~47 µs per round trip measured, against ~35 ms for a fork)
- **per-test coverage with kill-test-first ordering and early exit** in every runner
- **line-level git diff scoping that also narrows the coverage run**, so a PR costs in proportion
  to the diff
- **type-aware mutants**: ~29% of strict-TypeScript mutants are type-invalid (measured on
  Stryker's own dashboard reports); tzap avoids or classifies them instead of scoring them
- **built-in noise suppression** for logging and similar code, with its detection loss published
- an **incremental cache** that tracks each test's transitive imports

Output is the mutation-testing-elements schema, so Stryker's HTML report and dashboard work
unchanged, plus console, agent-oriented and PR-annotation reporters. StrykerJS is the correctness
oracle: every verdict disagreement is triaged, and the project has written kill criteria if it
cannot beat Stryker by a large margin.

## Documentation

- [docs/research/](docs/research/README.md) — the research, with sources and measurements
- [docs/adr/0001-implementation-language.md](docs/adr/0001-implementation-language.md) — why TypeScript on Node with oxc, not a Rust core
- [docs/architecture.md](docs/architecture.md) — how it fits together
- [docs/parity-and-benchmarks.md](docs/parity-and-benchmarks.md) — the StrykerJS comparison harness
- [docs/delivery-plan.md](docs/delivery-plan.md) — the milestones, from empty repository to 1.0
