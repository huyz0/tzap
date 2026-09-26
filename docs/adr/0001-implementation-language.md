# ADR 0001: Implementation language — TypeScript on Node, oxc for parsing, no Rust core in v1

- **Status:** Accepted
- **Date:** 2026-09-26
- **Context docs:** [research/README.md](../research/README.md),
  [research/toolchain-and-language.md](../research/toolchain-and-language.md),
  [research/runtime-and-execution.md](../research/runtime-and-execution.md),
  [architecture.md](../architecture.md)

## Context

tzap's premise is fast, diff-aware mutation testing for TypeScript and JavaScript. The JS tooling
wave of 2023–26 (oxc, Biome, Rolldown, swc, esbuild, TypeScript 7 in Go) makes "write it in
Rust" the reflexive answer. jzap faced the same question with Java and answered it with Amdahl's
law; the same argument applies here, with one difference worth stating: in JS, the parser is a
larger fraction of a *cold full-repo* run than ASM ever was on the JVM.

Where the wall clock goes in a tzap run:

| Phase | Share of wall clock | Language-addressable? |
|---|---|---|
| Coverage run (relevant tests, instrumented) | seconds → minutes | No — Node runs user tests |
| Mutant execution (N mutants × selected tests) | **dominant** | No — Node runs user tests |
| Runner/environment boot, module import | dominant in Stryker; amortised by a warm pool in tzap | No — it is the user's runner and code |
| Type-checking mutants | up to 10× a run in Stryker before grouping | Yes, but it is already native: TypeScript 7 is Go |
| Parse + instrument + source map | 0.01–0.35 s for a 5–50 file PR [M]; seconds on a cold 1M-line repo | Yes |
| Diff, scope, hashing, cache I/O, reports | milliseconds | Yes, irrelevantly |

Measured on Node 26.7 ([toolchain-and-language.md §1.3](../research/toolchain-and-language.md)):
oxc-parser with raw transfer plus magic-string span splicing does parse + schemata + source map on
`cal.com.tsx` (1 MiB, 1,581 mutants) in **81 ms**, against **389 ms** for a Stryker-shaped Babel
pipeline. That is the whole of the Rust advantage tzap can reach *through* Node, and it already
comes from a Rust parser shipped as a 1.6–2.1 MB napi binary.

Evidence that runtime tracks tests executed, not harness language:

- The Rust-written JS mutation tools of 2024–26 run the user's test command once per mutant and
  are slower per mutant than StrykerJS. Parsing was never their bottleneck
  ([landscape.md §1.2](../research/landscape.md)).
- A warm worker round trip — send mutant id, run one test, reply — measured **~47 µs**; a
  `fork` is ~35 ms. The levers are warm execution, schemata, selection and ordering, all of which
  execute inside Node alongside the user's code.
- Type-check speed comes from TypeScript 7, which is Go, exposed only through an RPC API
  (`typescript/unstable/*` now, stable in 7.1). There is **no public Go API**: its packages are
  `internal/`. Writing tzap in Go would not reach the checker any faster than Node does.

Beyond performance, everything tzap depends on must run in the user's JS runtime:

- the schemata switch and coverage counters — a runtime shim loaded into user code
- the test-runner adapters — Vitest's Node API and `@vitest/runner`, jest-circus, node:test
- module delivery — Vite plugins, Jest transforms, `module.registerHooks` loader hooks
- the project's own transpilation pipeline — tzap keeps the source dialect and does not
  reimplement decorators, enums, or SFC compilation

A Rust core would therefore still need a Node runtime for everything that matters, plus a napi
boundary, per-platform binaries, and a second language for contributors.

## Decision

1. **The engine is TypeScript on Node.** ESM-only, Node ≥ 22.12 (Vitest 5's floor), tested on
   22, 24 and 26 on Linux, macOS and Windows.
2. **Parser: `oxc-parser`** with raw transfer (TS-ESTree AST, UTF-16 spans), behind a thin
   `parse()` adapter with a version pin; `@babel/parser` kept as a fallback implementation of the
   same adapter for syntax oxc cannot handle, selected per file.
3. **Codegen: span splicing with `magic-string`**, never AST rebuild + print. The mutant branch
   copies the *original operand text*, never a cloned instrumented subtree — the latter is
   exponential in nesting depth and ran out of memory at 12 GB on `typescript.js`. Source maps
   from magic-string with `hires: 'boundary'`, composed with the user pipeline's own maps.
4. **Keep the dialect.** Instrumented TS stays TS; the user's Vite/Jest/Node pipeline transpiles
   it. tzap ships no TypeScript transpiler of its own.
5. **Type checking through TypeScript 7** via its unstable API while 7.0 is current, with a TS 6
   fallback, and move to the stable API when 7.1 ships. Never a hard dependency: the user's
   `typescript` is resolved from their project.
6. **The runtime shim loaded into user code is dependency-free**, as jzap's agent is. A test
   asserts it imports nothing but itself.

## Consequences

- One language across engine, adapters, runtime shim and tests. Contributors need Node only.
- Distribution is one npm package plus oxc-parser's prebuilt binaries (with its wasm32-wasi
  fallback), no tzap-owned native build matrix.
- tzap is exposed to oxc-parser 0.x API churn (near-weekly releases, raw transfer is
  `experimental`). Mitigated by the adapter, a pinned minor, and a CI job on the latest.
- The cold full-repo instrumentation phase is ~5× slower than a native Rust pass could be.
  Acceptable while it is a small share of the run; measured every release by the bench harness.

## Revisit when

Each is checked by the benchmark harness, not by opinion:

1. **tzap's own CPU work exceeds 10% of wall clock** on any benchmark scenario. Then build a
   napi-rs addon on the same oxc crates that does parse → mutate → instrument → source map
   natively and returns a string plus a mutant table. It is not built: tzap's own CPU work is
   0.3% of a run ([status.md](../status.md)).
2. TypeScript ships a stable public Go API and RPC overhead dominates type checking.
3. oxc stalls or hits a syntax gap the Babel fallback cannot cover.
4. A watch/IDE mode needs sub-50 ms cold starts and a warm daemon cannot provide them.
5. Bun or Deno suites become the primary target — that adds runner adapters; the engine stays.
