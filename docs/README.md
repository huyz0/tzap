# tzap documentation

tzap is a planned fast, diff-aware mutation testing tool for TypeScript and JavaScript, the
sibling of [jzap](https://github.com/huyz0/jzap) for Java and Kotlin. Nothing is built yet; these
documents are the research and the plan.

Read in this order:

1. [research/README.md](research/README.md) — what the research found and the decisions it forces
2. [adr/0001-implementation-language.md](adr/0001-implementation-language.md) — TypeScript on Node, oxc for parsing, no Rust core in v1
3. [architecture.md](architecture.md) — the engine, the project-model seam, execution, soundness gates
4. [parity-and-benchmarks.md](parity-and-benchmarks.md) — StrykerJS as the oracle; corpus, triage, scenarios
5. [delivery-plan.md](delivery-plan.md) — 25 milestones in 7 phases, with definitions of done and kill criteria

Research notes, each with sources and measured numbers:

- [research/stryker-js.md](research/stryker-js.md) — StrykerJS 10 internals and where its time goes
- [research/landscape.md](research/landscape.md) — other tools, fast engines elsewhere, literature, type-invalid mutants measured
- [research/runtime-and-execution.md](research/runtime-and-execution.md) — Node/Vitest/Jest execution costs, measured on Node 26
- [research/toolchain-and-language.md](research/toolchain-and-language.md) — parsers, codegen, TypeScript 7, packaging, mutant identity
- [research/bench/](research/bench/) — parser and instrumenter benchmark scripts
