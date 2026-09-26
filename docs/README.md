# tzap documentation

Fast, diff-aware mutation testing for TypeScript and JavaScript; the sibling of
[jzap](https://github.com/huyz0/jzap) for Java and Kotlin.

Using it:

- [usage.md](usage.md) — install, run, scope to a diff, reports, the cache, monorepos, CI, agents
- [mutators.md](mutators.md) — the mutators, what is never mutated, disable comments, arid rules, reductions
- [troubleshooting.md](troubleshooting.md) — the failures people hit
- [compatibility.md](compatibility.md) — runners, Node versions, frameworks, as tested
- [versioning.md](versioning.md) — what counts as a breaking change

Where it stands:

- [status.md](status.md) — what works, what was measured, what is not built, known limitations
- [performance.md](performance.md) — every published number and how it was taken
- [parity-and-benchmarks.md](parity-and-benchmarks.md) — the StrykerJS oracle and the benchmark design

How it was built, and why:

- [research/README.md](research/README.md) — the research and the decisions it forced
- [adr/0001-implementation-language.md](adr/0001-implementation-language.md) — TypeScript on Node, oxc for parsing
- [architecture.md](architecture.md) — the engine, the project-model seam, soundness gates
- [delivery-plan.md](delivery-plan.md) — the milestones, their status, and what building them changed
- [spikes/](spikes/) — Vitest (A), Jest (B), Bun and Deno (C)
