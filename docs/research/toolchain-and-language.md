# Toolchain and implementation language for tzap

- **Date:** 2026-09-26
- **Question:** what should tzap's engine be written in, and which parser/codegen stack should
  build the mutant-schemata-instrumented source? Also distribution, integration points, and
  mutant identity for caching.
- **Sibling decision:** jzap [ADR 0001](https://github.com/huyz0/jzap/blob/main/docs/adr/0001-implementation-language.md)
  chose Java over Rust because more than 90% of wall clock is user tests running in the JVM, and
  every technique jzap depends on has to execute inside that JVM. This note asks whether the same
  argument holds for JavaScript. Short version: it does, with one twist. In TypeScript projects the
  *type checker* is a second CPU sink that can rival test execution, and TypeScript 7 has just
  moved it to Go.

Convention used below: **[measured]** means a number produced for this note on the machine
described in §1.3, with the scripts in [`bench/`](bench/). **[claimed]** means a number published
by the project or vendor that has not been reproduced here. Anything else is sourced inline.

---

## 1. Where the wall clock goes (Amdahl first)

### 1.1 Phases of a tzap run

| Phase | Where it runs | CPU owner | Rough share | Language-addressable? |
|---|---|---|---|---|
| Diff parse, scope resolution (git, globs, tsconfig/workspace discovery) | tzap | tzap | ms | Yes, irrelevantly |
| Parse + instrument changed files (schemata) | tzap | tzap | ms per file (§1.3) | Yes, but already native via oxc |
| **Type-check mutants** (TS projects only) | tsc / tsgo | TypeScript compiler | historically **up to 10x the rest of the run** in Stryker ([Stryker blog](https://stryker-mutator.io/blog/announcing-faster-typescript-checking/)) | Only by choosing TS 7 (Go), which is a *dependency* choice, not an engine-language one |
| Baseline run with per-test coverage | Node / Vitest / Jest workers | user's test runner | seconds → minutes | No |
| **Mutant execution** (N mutants × selected tests) | Node workers | user's tests | **dominant**, >90% once type-check is solved | No |
| Cache I/O, report generation | tzap | tzap | ms | Yes, irrelevantly |

Two non-negotiables mirror jzap's:

1. **Tests are JavaScript and run in Node (or Bun/Deno/a browser).** Mutant switching (a global
   `__tzm` id read by the schemata), per-test coverage capture, hooking into Vitest's module
   runner or Jest's environment all happen *inside* the user's JS runtime. A JS component exists
   no matter what the orchestrator is written in.
2. **The biggest non-test CPU sink (type-checking) is someone else's binary.** Since TypeScript 7.0
   (GA 2026-07-08) the checker is a Go program; tzap talks to it over an API/IPC channel whatever
   tzap is written in (§4).

So the Amdahl ceiling for rewriting tzap's own code in Rust or Go is the "tzap" rows above:
parsing/instrumenting plus bookkeeping. §1.3 measures that ceiling directly.

### 1.2 Evidence that runtime tracks mutants executed, not harness language

- Stryker's move to mutant schemata (compile once, switch by id at runtime) was its largest
  historical speedup ([stryker-js#1514](https://github.com/stryker-mutator/stryker-js/issues/1514)).
  It is algorithmic.
- Stryker's TypeScript checker was "up to 10x" slower than running without it until mutant
  grouping landed; grouping cut checker time by ~43–50% on Stryker's own core package at 99.1%
  accuracy ([Stryker blog](https://stryker-mutator.io/blog/announcing-faster-typescript-checking/)).
  Again algorithmic, and again not in the harness.
- Stryker's own experimental TS 7 checker reports "more than a 2x performance improvement" from
  swapping the checker binary alone ([stryker-js#6099](https://github.com/stryker-mutator/stryker-js/pull/6099)) [claimed].
- jzap's Descartes datapoint (8.8x fewer mutants → 10.6x less time) transfers unchanged.

### 1.3 Measured: cost of the tzap-owned CPU work

Machine: Intel i5-13600KF (20 threads), Windows 11, Node 26.7.0, single thread, median of
5–15 runs after 2 warm-ups. Versions: `oxc-parser` 0.151.0, `@babel/parser`/`traverse`/`generator`
7.29.x, `@swc/core` 1.16.2, `typescript` 6.0.2 (via `@typescript/typescript6`), `magic-string`
1.4.2. Inputs: Vite's `packages/vite/src/node/utils.ts` (v6.0.0, 1,543 lines), TypeScript's
`src/compiler/scanner.ts` (v5.9.2, 4,101 lines), and the two stress files from oxc's
[parser benchmark](https://github.com/oxc-project/bench-javascript-parser-written-in-rust)
(`cal.com.tsx` 1 MiB / 30,592 lines; `typescript.js` 8.2 MB). Script:
[`bench/parse-instrument-bench.mjs`](bench/parse-instrument-bench.mjs).

"Instrument" is a toy but realistic schemata pass: every arithmetic/relational/logical binary
expression gets `(__tzm===N ? (mutated) : original)` with a source map. The oxc path walks the
ESTree AST and splices text with magic-string; the Babel path is Stryker-shaped (parse → traverse →
replace node → `@babel/generator` with `sourceMaps: true`). Both produce the same mutant count.

**Parse only, ms (median)** [measured]

| File | oxc-parser (JS AST) | oxc-parser raw transfer | @babel/parser 7 | @swc/core `parseSync` | TS 6 `createSourceFile` |
|---|---:|---:|---:|---:|---:|
| utils.ts (43 KiB) | **0.8** | 1.2 | 3.5 | 4.6 | 3.0 |
| scanner.ts (214 KiB) | 2.1 | **1.7** | 7.0 | 14.8 | 6.5 |
| cal.com.tsx (1 MiB) | 18.8 | 19.3 | 138.5 | 185.0 | 96.4 |
| typescript.js (8 MB) | 86.1 | 86.0 | 668.8 | 1,351.9 | 627.5 |

**Parse + instrument + source map, ms (median)** [measured]

| File | mutants | oxc (default) + magic-string | oxc raw transfer + magic-string | Babel parse+traverse+generate |
|---|---:|---:|---:|---:|
| utils.ts | 210 | 4.0 | **1.9** | 10.5 |
| scanner.ts | 842 | 13.4 | **6.9** | 27.6 |
| cal.com.tsx | 1,581 | 176.7 | **80.7** | 389.1 |

Observations:

- Parsing from Node, oxc is **3.5–7x faster than Babel** and **2–3x faster than TS 6's scanner**.
  The published Rust-to-Rust numbers (oxc 3.4 ms vs swc 13.4 ms vs Biome 16.7 ms on `cal.com.tsx`,
  M3 Max) are [claimed] ([bench repo](https://github.com/oxc-project/bench-javascript-parser-written-in-rust)).
  From Node, the JS-visible AST costs ~5x the pure-Rust parse.
- `@swc/core`'s JS `parseSync` is the *slowest* option from Node: it serialises the AST to JSON
  and re-parses it. swc is fast in Rust and slow as a JS AST provider.
- End to end, oxc + magic-string is **2–5x faster than the Babel pipeline**. The gap on
  instrumentation is smaller than on parsing because the JS-side walk and string building
  dominate once parsing is cheap. Raw transfer halves the walk cost. Oddly, the default (non-raw)
  AST is fast to *produce* but slow to *walk*, which is consistent with deferred materialisation.
- A naive schemata implementation can blow up. A Babel `exit` visitor that deep-clones an
  already-instrumented subtree grows exponentially with nesting depth and ran out of heap on
  `typescript.js` at 12 GB. The magic-string approach inserts text around original spans and
  copies original operand text into the mutant branch, so it is linear per nesting level. That is
  a design constraint for whatever stack is chosen, not a Babel defect.

**Amdahl reading.** A typical PR diff touches 5–50 source files at ~2–7 ms each with oxc, so
instrumentation is 0.01–0.35 s, compared with seconds to minutes of test execution. Even a cold
full-repo run of 5,000 files is ~10–35 s single-threaded with oxc (vs ~50–140 s with Babel), and
that divides by core count with worker threads and is cached afterwards. A Rust-side walk would
remove most of the remaining JS walk cost, perhaps saving another 2–4x on this phase, but the
phase is already under 1–2% of a realistic diff run. **The parser choice matters (oxc over Babel
buys 2–5x on a phase users do notice on cold runs). The engine language does not.**

---

## 2. Parser / transform stacks

### 2.1 Comparison

| Stack | Language / npm | Parse speed | TS syntax (decorators, enums, `satisfies`, `using`) | JSX | Edit model | Comments / positions | Source maps | Maintenance (GitHub, 2026-09-25) |
|---|---|---|---|---|---|---|---|---|
| **Babel** (`@babel/parser`, traverse, generator) | JS; Babel 8 GA (`@babel/core` 8.0.6, Node ≥22.18) | baseline (§1.3) | full, with plugins; Stryker ships Babel 8 since v10 ([release](https://github.com/stryker-mutator/stryker-js/releases/tag/v10.0.0)) | yes | AST rebuild + generator | generator reprints: formatting lost, comments mostly kept | generator, good | 44k stars; top committers sebmck / nicolo-ribaudo / hzoo. Long-running funding strain, but active |
| **TypeScript compiler API** (6.x JS) | JS | ~2–3x slower than oxc from JS | reference implementation | yes | `transform` + printer, or text edits over node positions | printer loses formatting | via emit, awkward for source-to-source | TS 6 is the last JS version; frozen in favour of TS 7 ([TS 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)) |
| **TypeScript 7** (`typescript/unstable/ast`, `/sync`) | Go binary + JS client over IPC | fast in Go; AST crosses a process boundary | reference | yes | no stable transform API in 7.0 | — | — | API "not stable until 7.1" (§4) |
| **swc** (`@swc/core`, Rust plugins via Wasm) | Rust; napi + wasm | 3–4x slower than oxc in Rust [claimed]; slowest from JS (§1.3) | full; legacy + 2022 decorators | yes | Rust visitor + codegen, or Wasm plugin (ABI tied to `swc_core` version) | codegen reprints; comments via `SingleThreadedComments` | yes | 34k stars; kdy1 authored ~4.9k of top commits, so a high bus factor on one person. 28–33 MB native binary per platform [measured, npm] |
| **oxc** (`oxc_parser`, `oxc_ast`, `oxc_semantic`, `oxc_transformer`, `oxc_codegen`; npm `oxc-parser`, `oxc-transform`) | Rust; napi-rs + wasm32-wasip1 fallback | fastest measured and claimed | "passes all parser tests from Test262 and 99% from Babel and TypeScript" [claimed] ([docs](https://oxc.rs/docs/guide/usage/parser.html)). All of enum / const enum / namespace / legacy+2023 decorators / `accessor` / `satisfies` / `using` / `await using` / const type params / import attributes parsed without error [measured, `bench/syntax-coverage.mjs`] | yes | **spans + magic-string** (recommended by oxc's README for ESM rewrites), or Rust `oxc_transformer` + `oxc_codegen` | spans are exact; JS binding returns **UTF-16 offsets** (verified with an emoji before the target) so `String.slice` and magic-string work directly; `result.comments` exposed | codegen emits maps in Rust; in JS, magic-string `generateMap` | 23k stars, 461 contributors; Boshen / overlookmotel / camc314 lead. Funded by VoidZero; underpins Rolldown / Vite 8, Oxlint, Oxfmt, Astro's new compiler ([compiler-rs](https://github.com/withastro/compiler-rs)). 1.6–2.1 MB native binary per platform [measured, npm] |
| **esbuild** | Go | very fast | strips types; no decorator metadata | yes | **no AST API**: transform/bundle only | not applicable | yes | effectively a single maintainer (evanw ≈ 4.3k of top commits); last push 2026-08-09 |
| **Biome** (`@biomejs/biome`) | Rust CST (lossless) | ~5x slower than oxc [claimed]; "not apples to apples: CST" | full | yes | GritQL-based plugins for lint; no public transform API | lossless CST, perfect positions | n/a | 26k stars; ematipico leads. 65 MB CLI binary per platform [measured, npm] |
| **ast-grep** (`@ast-grep/napi`) | Rust over tree-sitter | fast | tree-sitter TS grammar, error-tolerant | yes | pattern → rewrite text edits | positions exact | none built in | 16k stars; one principal author (HerringtonDarkholme) |
| **tree-sitter** | C | fast, incremental | grammar lags new syntax; CST | yes | text edits | exact | none | 27k stars; built for editors, not semantics (no scopes or types) |

### 2.2 What "source-to-source with correct source maps" requires

Mutant schemata need three things: exact node spans, the ability to insert text around spans
without disturbing anything else, and a map from instrumented positions back to original ones so
that stack traces, coverage, and reports land on the user's lines. Two families:

- **AST rebuild + codegen** (Babel, TS printer, swc/oxc codegen). The whole file is reprinted.
  Formatting and some comments change, and every downstream consumer (coverage, error stacks)
  depends on the generated map being right. Stryker lives here with Babel.
- **Span splicing** (oxc-parser or any parser with exact offsets + [magic-string](https://github.com/Rich-Harris/magic-string)).
  Untouched bytes are untouched. Comments, formatting, `//# sourceMappingURL`, pragmas and
  `@ts-expect-error` placement all survive by construction. The map is trivial because every
  unedited character maps to itself. `generateMap({ hires: 'boundary' })` gives word-level
  granularity. This is how Vite, Rollup and Svelte have done source edits for years, and it is
  what oxc's README recommends for import rewriting.

Span splicing also sidesteps a whole class of problems. **tzap should emit TypeScript, not
JavaScript.** The instrumented file stays in its original dialect and goes through the user's
existing pipeline (Vite/oxc in Vitest, `ts-jest`/`babel-jest`/`@swc/jest` in Jest, Node's own
type stripping, stable since [Node 25.2](https://socket.dev/blog/node-js-moves-toward-stable-typescript-support-with-amaro-1-0)).
tzap never has to reproduce the user's decorator semantics, `emitDecoratorMetadata`, JSX runtime,
path aliases or enum lowering, because it never transpiles. The only hard rule is that inserted
text must be *erasable-syntax-safe*: plain JS expressions, no enums or namespaces, so Node's
strip-only mode still accepts the file. Stryker instead parses with Babel and regenerates, which
is why it carries `@babel/preset-typescript`, decorator plugins and
`plugin-transform-explicit-resource-management` in its instrumenter's
[dependencies](https://github.com/stryker-mutator/stryker-js/blob/master/packages/instrumenter/package.json).

Hard cases the instrumenter must handle, independent of stack:

- **Placement rules.** No schemata in type positions, in `const enum` initialisers, in decorator
  arguments evaluated at class-definition time (mutants there are "static" and need a reload,
  as in Stryker), in `import`/`export` specifiers, or in `declare` contexts. The AST type
  (TS-ESTree node types from oxc) answers all of these.
- **Nesting.** Copy *original* operand text into the mutant branch (linear), never an
  instrumented subtree (exponential, §1.3).
- **Type validity of the schemata itself.** `cond ? mutated : original` can widen types (a
  mutated literal changes a literal type). Stryker handles this by prepending `// @ts-nocheck` to
  instrumented files and type-checking each mutant separately. tzap should do the same: the
  instrumented file is for the runtime only, and the checker sees one mutant at a time (§4).
- **Hoisting and TDZ.** Wrapping function declarations or `let` in expressions changes semantics.
  Only expression and statement-body positions get schemata.

### 2.3 Verdict on the parser

**oxc-parser for all JS/TS parsing, magic-string for edits.** It is the fastest measured option
from Node, its AST is ESTree/TS-ESTree-conformant ("any deviation would be considered a bug"
per its README), so AST-shape knowledge and visitor keys port from the ESLint ecosystem. It
returns exact UTF-16 spans, comments and ESM import/export records (useful for the module graph,
§6) in one call. It ships a wasm32-wasi fallback, and it has the strongest institutional backing of
the Rust parsers. Because oxc is also a Rust crate set (`oxc_parser`, `oxc_semantic`,
`oxc_codegen` with source maps), moving the hot loop into Rust later means *the same parser*
behind a napi-rs addon, not a rewrite (§8, revisit conditions).

Babel remains the fallback if a syntax gap appears. Its AST is close enough to ESTree that
operator logic can be written against a shared node vocabulary.

---

## 3. Vue, Svelte, Astro, Angular without Babel

All four reduce to "find the script regions and their offsets in the original file, then run the
normal JS/TS instrumenter on each region with the offsets shifted". Using **one MagicString over the
whole original file** keeps the source map in `.vue`/`.svelte` coordinates, which is exactly what
Vite's plugins expect to compose with.

| Format | Region extraction | Notes |
|---|---|---|
| **Vue SFC** | `@vue/compiler-sfc` (3.5.43) `parse()` → `descriptor.script` / `descriptor.scriptSetup`, each with `loc.start.offset` and `lang` | Template expressions are a second tier (compile to render functions; mapping back is harder). Stryker extracts `<script>` via `angular-html-parser` ([instrumenter parsers](https://github.com/stryker-mutator/stryker-js/tree/master/packages/instrumenter/src/parsers)). A Rust route exists too: oxc is growing a Vue parser that attaches template JS to the script AST ([oxc#15761](https://github.com/oxc-project/oxc/issues/15761)) and there are community crates (`vue_oxc_toolkit`, `vize`). Volar (`@volar/language-core` 2.4) is for *type-checking* Vue (virtual TS files), not instrumentation |
| **Svelte 5** | `svelte/compiler` (5.57.1) `parse(src, { modern: true })` → `instance` / `module` `Script` nodes with `start`/`end` | Runes (`$state`, `$derived`) are compiler macros: schemata inside `$derived(...)` arguments are fine as expressions, but do not wrap the rune call itself. Stryker added TS-in-template parsing in v10 |
| **Astro** | Frontmatter between `---` fences (trivial), or `@astrojs/compiler-rs` 0.5.1 (Rust on oxc, NAPI-RS) now that it replaces the Go/Wasm compiler ([roadmap](https://github.com/withastro/roadmap/discussions/1306)) | Astro components are rarely unit-tested; low priority |
| **Angular** | Components are plain `.ts`; nothing to extract | Decorator arguments (`@Component({...})`) are static and should be skipped. Template (`.html`) mutation is out of scope for v1 |

None of this needs Babel. Each framework's own parser is JS-first and already in the user's
`node_modules`, which is another reason for a Node-hosted engine: tzap can `import` the project's
own `@vue/compiler-sfc`/`svelte` version rather than bundling one.

---

## 4. Type-checking mutants: what TypeScript 7 changes

### 4.1 Status on 2026-09-26

- **TypeScript 7.0 GA 2026-07-08**; the `typescript` package *is* the Go compiler (latest
  7.0.2, 2026-09-25). Speedups on full builds, default settings [claimed]: VS Code 125.7 s → 10.6 s
  (11.9x), Sentry 139.8 s → 15.7 s (8.9x), Playwright 12.8 s → 1.47 s (8.7x); with `--checkers 8`
  VS Code 7.51 s (16.7x). Memory −6% to −26% ([announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)).
- **"TypeScript 7.0 does not ship with an API."** 7.1 is expected "to ship with a new (and
  different) API". Tools that need the old API install `@typescript/typescript6` side by side
  (`tsc6`) (same source).
- In practice the 7.0.2 package already exports `typescript/unstable/sync`, `/unstable/async`,
  `/unstable/ast`, `/unstable/fs`, … [measured: `npm view typescript@7.0.2 exports`]. These
  spawn the Go binary and expose AST, symbol and type queries over RPC. Stryker's experimental TS 7
  checker uses exactly this. Its limitations as of v10 ([#6099](https://github.com/stryker-mutator/stryker-js/pull/6099)):
  no project references (no `--build` mode via the API), no mutant grouping (missing
  `program.getAllDependencies`), and TS 6 still needed for `parseConfigFileTextToJson`.
- **TypeScript 7.1 plan:** beta 2026-10-06, RC 2026-11-10, stable **2026-11-24**. It stabilises
  the Content Mapper, Emit and Language Service APIs, and publishes a wasm (wasip1) build
  ([iteration plan #63703](https://github.com/microsoft/TypeScript/issues/63703)).
- **There is no Go API.** typescript-go's packages are `internal/`, which Go forbids importing
  from another module. The only Go consumer, oxc's `tsgolint` (type-aware lint behind Oxlint),
  reaches the checker through a **`//go:linkname` shim layer** over internals
  ([tsgolint](https://github.com/oxc-project/tsgolint), [oxlint type-aware docs](https://oxc.rs/docs/guide/usage/linter/type-aware)).
  That works, and tsgolint is marked stable for TS 7, but it pins tzap to exact compiler internals
  on every TS release. VoidZero can afford that treadmill; a small tool should not.

### 4.2 Consequences for tzap

1. **The type checker is the only CPU-heavy phase outside the tests, and it will be a Go process
   whatever tzap is written in.** Writing tzap in Go would not give in-process access to the
   checker (no public Go API). Writing it in Rust would not either. The engine talks to `tsc` 7 over
   the same RPC the JS client uses. The engine-language question is therefore decoupled from
   type-check speed.
2. **Strategy, in order of payoff:**
   - *Don't generate type-invalid mutants.* Most compile errors come from a small set of operators
     (string literal → `""` on a literal-typed field, arithmetic on non-numbers, `true`/`false` on
     literal types). A local, syntactic type-risk filter (oxc AST + `oxc_semantic`-style scope info,
     or TS-ESTree annotations present in the file) skips them up front.
   - *Check only mutants that survived, or that were not covered at all.* A killed mutant's type
     validity is irrelevant for the score except to relabel "Killed" as "CompileError". Checking
     after execution, on survivors only, typically shrinks the checked set by the kill ratio
     (an estimate: kill ratios of 60–85% are typical of mature suites, so this is the dominant saving).
   - *Group mutants that cannot interact* (different files, no dependency path between them) and
     check a group per program update. This is Stryker's 43–50% win and needs the dependency graph,
     which tzap already has from §6.
   - *Use TS 7 via `typescript/unstable/sync` behind an adapter,* falling back to the TS 6 API
     (`@typescript/typescript6`) when the unstable API is missing or project references are needed.
     Move to the stable 7.1 Language Service/Emit API after 2026-11-24.
3. **Optional mode, off in diff runs by default:** a `--typecheck=survivors` default and
   `--typecheck=all` for CI parity with Stryker.

---

## 5. Implementation-language options

| Option | Parse/instrument | Type-check | Runs tests | Distribution | Contributor pool | Verdict |
|---|---|---|---|---|---|---|
| **(a) TypeScript on Node** (like Stryker, Vitest) | oxc-parser via napi (native speed where it matters, §1.3) | TS 7 via RPC, TS 6 fallback | in-process with Vitest/Jest plugins | one pure-JS package + oxc-parser's prebuilt bindings | the whole JS ecosystem; users can read and patch it | **Recommended** |
| **(b) Rust core + napi-rs + thin Node runtime** (like Oxlint, Rolldown, Biome) | oxc crates directly, no AST transfer | TS 7 via spawning `tsc`/RPC (no Rust API) | still needs the Node runtime half | 15–20 per-platform packages plus wasm; release matrix; Windows ARM, musl, FreeBSD | small | Rejected for v1. The upside is limited to the ~1% instrument phase, and it adds a language boundary and an IPC or FFI protocol (jzap's argument verbatim) |
| **(c) Go** (like esbuild, tsgo, tsgolint) | no production Go TS parser except typescript-go's `internal/` (esbuild's is not an API) | in-process only via `go:linkname` shims | needs a Node runtime half anyway | per-platform binaries (esbuild/TS 7 pattern) | small | Rejected. Its only real draw, in-process checker access, requires the tsgolint shim treadmill |
| **(d) Bun- or Deno-native** | Bun's transpiler has no AST API; Deno uses swc in Rust | via RPC like (a) | only under that runtime | single binary | small | Rejected as a host. Most JS test suites run on Node + Vitest/Jest. Support `bun test` / `deno test` later as *adapters* |

Why (a) and not (b), in one paragraph: in jzap the JVM half was unavoidable, so a Rust controller
meant two languages for ~3% of runtime. In tzap the Node half is equally unavoidable (Vitest pool
integration, Jest environment, mutant switch, per-test coverage). The two CPU-heavy things that
*aren't* test execution are already native through dependencies: parsing through oxc's napi
binding, type-checking through TS 7's Go binary. A Rust core would re-own the parsing speed tzap
already gets for free, and would buy nothing for type-checking. It would cost a per-platform release
matrix, a JS↔Rust boundary on every mutant record, and a contributor pool that must know both
languages.

---

## 6. Mutant identity and cache keys

### 6.1 How Stryker does it

Stryker's incremental mode ([docs](https://stryker-mutator.io/docs/stryker-js/incremental/),
[`incremental-differ.ts`](https://github.com/stryker-mutator/stryker-js/blob/master/packages/core/src/mutants/incremental-differ.ts))
keys a mutant on **(file name, mutator name, location, replacement)** and a test on (name, file,
location). Between runs it computes a text diff per file with Google's `diff-match-patch` and
*relocates* old locations through that diff. A result is reused if the mutant's code didn't
change and (for killed mutants) the killing test still exists unchanged, or (for survivors) no
covering test changed. Stated limitations: it does not see changes in non-mutated, non-test
files, dependency updates, env vars, or `.snap` files.

### 6.2 Proposed tzap identity

A mutant id that survives unrelated edits in the same file:

```
mutantId = hash(
  relPath,                       // POSIX, repo-relative
  scopePath,                     // "class OrderService > method total > arrow#2" from AST ancestry,
                                 //  named scopes only; anonymous ones numbered within parent
  operatorId,                    // e.g. "ArithmeticOperator:+->-"
  normalizedOriginalText,        // source text of the mutated node, whitespace-collapsed
  ordinalWithinScope             // n-th (operator, text) match within scopePath
)
```

- Stable across edits *above* the function (line shifts), unlike Stryker's location key.
- Stable across edits *elsewhere in the same function* unless they add an identical expression
  earlier in the same scope (ordinal shift). This is rare and fails safe (a re-run, not a wrong
  result).
- Human-debuggable: the scope path is printable in reports and the `-r agent` output.

**Result-reuse key** (a cached verdict is valid iff this hash is unchanged):

| Input | Why | Source |
|---|---|---|
| `mutantId` | identity | above |
| hash of the **enclosing function's source text** | semantics of the mutant's neighbourhood; cheaper and tighter than whole-file hash | oxc spans |
| hash of each **test file that covered the mutant** in the last run (killer test for killed mutants, all covering tests for survivors) | Stryker's rule, done per test file | per-test coverage |
| hash of the **transitive module graph** of those test files (resolved imports, file contents) | catches changes in helpers, fixtures, mocks and non-mutated sources that Stryker misses | Vitest's module graph when running under Vitest; otherwise oxc-parser's `module.staticImports` + [oxc-resolver](https://github.com/oxc-project/oxc-resolver) |
| lockfile hash (`package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` / `bun.lock`) | dependency updates | file |
| config hash: `tsconfig*.json` chain, `vitest.config.*` / `jest.config.*`, `package.json#type`/`exports`, `tzap.config.*` | transform and resolution semantics | files |
| snapshot files (`__snapshots__/*.snap`) adjacent to covering tests | Stryker explicitly misses these | files |
| tzap engine version + mutator-set version, test-runner version, Node major | tool semantics | runtime |
| explicit env allowlist (`TZ`, `NODE_ENV`, user-declared) | Stryker misses env | config |

This is the JS analogue of jzap's "identical model + identical bytecode ⇒ identical results"
invariant. The project model (§7.1) should carry the lockfile and config hashes so the cache can
be keyed without re-deriving them.

---

## 7. Integration points

### 7.1 Project-model seam (as in jzap)

Same idea as jzap's [architecture.md](https://github.com/huyz0/jzap/blob/main/docs/architecture.md):
adapters produce one versioned JSON document, and the engine consumes only that. For JS the leaky
parts are workspace discovery (npm/pnpm/yarn/bun workspaces, Nx/Turbo), tsconfig project
references and path aliases, and test-runner selection per package.

```jsonc
{
  "schemaVersion": 1,
  "root": ".",
  "packages": [{
    "id": "@acme/orders",
    "dir": "packages/orders",
    "sourceGlobs": ["src/**/*.{ts,tsx,vue}"],
    "testRunner": { "kind": "vitest", "config": "packages/orders/vitest.config.ts", "version": "5.0.2" },
    "tsconfig": "packages/orders/tsconfig.json",
    "typescript": { "version": "7.0.2", "api": "unstable-sync" },
    "moduleType": "module"
  }],
  "scope": { "kind": "diff", "from": "origin/main", "to": "WORKTREE", "granularity": "line" },
  "hashes": { "lockfile": "sha256:…", "configs": "sha256:…" },
  "cache": { "dir": ".tzap/cache" },
  "reporters": ["console", "elements"]
}
```

`tzap model` prints it, and `tzap run --model m.json` consumes it. That is also the seam at which
a native component could be inserted later without touching the engine.

### 7.2 Vitest (primary)

- Vitest 5.0 shipped 2026-09-03 and requires Node ≥ 22.12 and Vite ≥ 6.4 ([blog](https://vitest.dev/blog/vitest-5.html)).
  Its programmatic API: `createVitest` (instance without starting runs), `runTestSpecifications`,
  `parseSpecifications` (no longer experimental), custom pools via `createMethodsRPC`, reporters
  with `vitest.createReport(scope)` ([advanced API](https://vitest.dev/guide/advanced/)).
  Config resolution is now separate from server creation, which is a breaking change for
  programmatic users.
- Integration shape: a **Vite plugin** (`transform` hook) serves instrumented source for files in
  scope, returning magic-string's map for Vite to compose. A **controller** holds one `Vitest`
  instance per worker and, per mutant, sets `globalThis.__tzm` via a setup file / RPC, then
  reruns only the covering test specifications. The module cache stays warm because the
  schemata make the code identical across mutants. This is Stryker's vitest-runner approach,
  which uses per-test coverage, `related`, single-thread and bail ([docs](https://stryker-mutator.io/docs/stryker-js/vitest-runner/)).
  Browser Mode is unsupported in Stryker, and tzap should defer it too.
- Per-test coverage: cheapest is the schemata's own hit counters (`__tzc[id]=1` in each branch
  guard) recorded per test via `beforeEach`/`afterEach` hooks. No V8/Istanbul coverage is needed.

### 7.3 Jest

- `testEnvironment` subclass with `handleTestEvent` (test_start/test_done) records per-test
  mutant hits and reads the active mutant id. A `runner` (extends `CallbackTestRunner`) or
  in-process `runCLI` drives execution ([Jest config](https://jestjs.io/docs/configuration#testrunner-string)).
  Jest 30.5 (Node ≥ 18.14). The instrumented TS goes through whatever transform the user configured
  (`ts-jest`, `babel-jest`, `@swc/jest`) because tzap emits TS (§2.2).

### 7.4 CLI, config, output

- `tzap` CLI: `tzap run [--from origin/main] [-r console,elements,agent,github,sarif]`,
  `tzap model`, `tzap explain <mutantId>`.
- Config: `tzap.config.ts` via `defineConfig()`. Load it with Node's native type stripping on Node ≥
  22.18/23.6 (unflagged; stable in 25.2), falling back to an oxc-transform strip when unavailable.
  Also accept `tzap.config.{js,mjs,json}` and a `"tzap"` key in `package.json`.
- Reporters:
  - `elements`: the [mutation-testing-elements report schema](https://github.com/stryker-mutator/mutation-testing-elements/tree/master/packages/report-schema)
    (Stryker's HTML viewer and dashboard consume it unchanged; Stryker 10 uses elements 3.8).
  - `github`: prefer the **Checks API** (≤ 50 annotations per request, batched; `notice` /
    `warning` / `failure`; message ≤ 64 KB; title ≤ 255 chars ([docs](https://docs.github.com/en/rest/checks/runs))).
    Workflow-command annotations (`::warning file=…`) are capped at 10 warnings + 10 errors + 10
    notices per step and 50 per job ([community#26680](https://github.com/orgs/community/discussions/26680)),
    so tzap must rank survivors and cap output (changed lines first).
  - `sarif`: SARIF 2.1.0 for code-scanning upload. That avoids annotation caps, with survivors as
    `result`s at `warning` level. Useful for GitHub Advanced Security users.
  - `agent`: jzap's format verbatim (headline first, survivors and uncovered only, one per line),
    plus `skills/tzap/SKILL.md` installable via `npx skills add`.
- GitHub Action: `uses: huyz0/tzap-action` wrapping `npx tzap run --from origin/${{ github.base_ref }}`,
  with cache restore of `.tzap/cache` keyed on the lockfile hash.

---

## 8. Distribution

| Tool | Pattern | Per-platform payload [measured, npm unpacked] | Platforms | Fallback |
|---|---|---|---|---|
| **oxc-parser** 0.151 | JS wrapper + `optionalDependencies` on 19 `@oxc-parser/binding-*` packages (napi-rs) | 1.6 MB (win32-x64), 2.1 MB (linux-x64-gnu) | darwin, linux gnu/musl, win32 x64/ia32/arm64, android, freebsd, riscv64, s390x, ppc64, openharmony | `@oxc-parser/binding-wasm32-wasi` (2.1 MB) + WebContainer fallback |
| **@swc/core** 1.16 | same pattern, 12 platforms | 28.6 MB (win32-x64), 32.8 MB (linux-x64) | | `@swc/wasm` 20 MB |
| **@biomejs/biome** 2.5 | CLI binary per platform, 8 platforms | 64.7 MB (linux-x64) | | none |
| **typescript** 7.0.2 | JS wrapper + 20 `@typescript/typescript-*` binaries | 27.9 MB (linux-x64) | incl. aix, sunos, loong64, mips64el | wasm build planned in 7.1 |
| **esbuild** 0.28 | 26 `@esbuild/*` binaries | 11.4 MB (linux-x64) | widest | `esbuild-wasm` 14.5 MB |
| **rolldown** 1.2 | napi-rs, 15 platforms | — | | wasm32-wasi |

- The **napi-rs v3** pattern is `optionalDependencies` with `os`/`cpu`/`libc` fields, and a
  wasm32-wasip1-threads package as "a portable fallback when no prebuilt native addon matches the
  host" ([napi-rs wasm docs](https://napi.rs/docs/concepts/webassembly)). It is well trodden but
  has a known failure mode: lockfiles generated on one OS omitting other platforms' optional deps
  (npm/cli#4828-class issues). tzap inherits this through oxc-parser but does not have to *publish*
  a matrix itself under option (a).
- **Windows:** oxc, swc, TS 7 and Biome all ship win32-x64 and win32-arm64. Under option (a) the
  only Windows-specific work is path normalisation (POSIX paths in ids and caches) and process
  spawning. The development machine for this note is Windows and every benchmark above ran
  unmodified.
- **Packaging for tzap (option a):**
  - `tzap`: ESM-only, `"engines": { "node": ">=22.12" }` (the same floor as Vitest 5, oxc-parser and
    Rolldown; Stryker 10 is ≥ 22.0; Babel 8 ≥ 22.18). `bin: tzap`. Library exports `.`
    (programmatic API + `defineConfig`), `./vitest` (Vite plugin + setup file), `./jest`
    (environment + runner). `require(esm)` is unflagged in Node 22.12+, so ESM-only no longer
    strands CJS configs.
  - Framework peers are optional: `vitest`, `jest`, `typescript`, `@vue/compiler-sfc`, `svelte`,
    resolved from the *user's* project.
  - Dependencies: `oxc-parser`, `magic-string`, `oxc-resolver`, a git diff helper. Install size
    stays ~5 MB, against Stryker core's Babel-heavy tree.

---

## 9. Risks and open questions

- **oxc-parser 0.x API churn.** 0.151.0 with near-weekly releases. Raw transfer and lazy mode are
  `experimental*` options, and raw transfer needs Node ≥ 22. Mitigation: wrap in a thin `parse()`
  adapter; pin a minor version; fall back to the default AST if raw transfer is unsupported
  (`rawTransferSupported()`).
- **TS 7 API instability until 7.1 (2026-11-24).** Build the checker behind an interface with TS 6
  and TS 7-unstable backends from day one.
- **Vitest 5 programmatic API is young.** Config resolution changed in 5.0. Keep the Vitest adapter
  thin, and pin a peer range.
- **Schemata type widening and `@ts-nocheck`.** If users run `vitest --typecheck` or `tsc` as part
  of tests, the instrumented files must not leak into it. Serve them only through the transform
  hook, never write them to disk.

---

## Recommendation

**Engine language: TypeScript on Node (ESM-only, Node ≥ 22.12). No Rust and no Go in v1.**
The reasoning is jzap's ADR transposed. User tests must run in the JS runtime, and so must mutant
switching, per-test coverage and runner integration, so a JS component is mandatory. The two
remaining CPU sinks are already native through dependencies: parsing through oxc's napi binding
(measured 3.5–7x faster than Babel, 2–5x faster end to end), and type-checking through TypeScript
7's Go binary (8–12x faster than TS 6 [claimed]), which no language can reach in-process except
through `go:linkname` shims. A Rust or Go core would own ~1% of a diff run while adding a language
boundary and a release matrix.

**Parser: `oxc-parser`** (napi-rs, wasm32-wasi fallback), with the TS-ESTree AST, raw transfer
when supported, and UTF-16 spans. Babel stays as an emergency fallback only.

**Codegen / source maps: span splicing with `magic-string`**, emitting *the original dialect*
(TS stays TS, TSX stays TSX, `.vue` stays `.vue`), with `generateMap({ hires: 'boundary' })` and
maps composed by Vite/Jest transforms downstream. Rules: expression-level schemata only; copy
original operand text into mutant branches (linear, not exponential); inserted code must be
erasable-syntax-safe; add `// @ts-nocheck` to instrumented output that is served in memory only.
Vue, Svelte and Astro go through each framework's own parser for script offsets, into a single
file-level MagicString.

**Type-check strategy:** avoid type-invalid mutants syntactically, check survivors only by default,
group non-interacting mutants, and run TS 7 through `typescript/unstable/sync` behind an adapter
with a TS 6 (`@typescript/typescript6`) fallback for project references. Move to the stable 7.1
API after 2026-11-24.

**Mutant identity:** `hash(relPath, scopePath, operator, normalizedText, ordinal)`. Result reuse
is keyed on the enclosing-function hash plus covering tests' transitive module-graph hashes, the
lockfile, configs, snapshots, env allowlist and tool versions. This is strictly more than Stryker's
(file, mutator, location, replacement) + diff-match-patch relocation.

**Packaging:** one `tzap` package (ESM, `bin`, exports `.`, `./vitest`, `./jest`), with
framework peers resolved from the user's project. Reporters: `console`, `json`, `elements`
(mutation-testing-elements), `github` (Checks API, batched 50 at a time, ranked), `sarif`,
`agent` + `skills/tzap/SKILL.md`. Seam: a versioned project-model JSON (`tzap model`).

**Revisit if:**

1. Profiling on a real monorepo shows tzap-owned work (parse, instrument, graph hashing, cache
   I/O) exceeding **~10% of wall clock**, most plausibly on cold full-repo runs with tens of
   thousands of files. Then add an optional `@tzap/native` napi-rs addon built on the *same* oxc
   crates (`oxc_parser` + `oxc_semantic` + span edits in Rust), behind the existing `parse()` /
   `instrument()` interface. Nothing else changes.
2. TypeScript 7.1+ publishes a **stable, public Go API** (not `internal/`), *and* profiling shows
   RPC overhead in the checker path dominating. Then consider a Go checker sidecar. It would still
   be a sidecar, not the engine.
3. oxc-parser stalls (releases stop for more than 3 months, or VoidZero backing ends), or a
   syntax gap blocks real projects. Fall back to Babel 8 behind the same adapter.
4. A watch/IDE mode needs sub-50 ms cold starts and a warm daemon is impossible. Node startup
   (estimated ~40–60 ms, unmeasured here) plus module loading is then the floor, and a native launcher becomes worth pricing.
5. Bun or Deno become the dominant runtime for a target audience's *test suites*. Add runner
   adapters; the engine stays on Node.
