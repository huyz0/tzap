# Landscape: JS/TS mutation testing, fast mutation engines, and the literature

Research notes for tzap, a fast, diff-aware mutation testing tool for TypeScript and
JavaScript, sibling of [jzap](https://github.com/huyz0/jzap). Dated **2026-09-26**.

Scope: everything *around* StrykerJS — other JS/TS tools alive and dead, fast engines in other
ecosystems and what makes them fast, the academic record that bears on JS/TS, type-aware and
equivalent-mutant filtering, and diff-scoped CI. StrykerJS internals are covered separately.

Conventions used below:

- **Measured** — a number someone ran and published, with the source linked. Numbers marked
  **measured here** were computed for this document from public data (method stated).
- **Claimed** — a README or blog statement with no reproducible harness behind it.
- **Analysis** — this document's own reasoning, not a finding from a source.
- GitHub stars and dates are as of 2026-09-26 via `gh api`; npm downloads are the 30 days to
  2026-09-24 via `api.npmjs.org`.

---

## 1. JS/TS mutation testing tools

### 1.1 The incumbent and its dead predecessors

| Tool | Approach | Diff support | Status |
|---|---|---|---|
| [StrykerJS](https://github.com/stryker-mutator/stryker-js) | Babel AST; mutant schemata ("mutation switching") since 4.0; per-test coverage; worker child processes; runner plugins (Jest, Vitest, Mocha, Jasmine, Karma, tap, Cucumber, command) | `--mutate file:line[:col]-line[:col]` ranges; `--incremental` result reuse; no git integration | 3,147★, v10.0.0 on 2026-08-14. `@stryker-mutator/core` 9.17M downloads/month; vitest-runner 5.95M, typescript-checker 1.88M, jest-runner 1.54M |
| [Mutode](https://github.com/TheSoftwareDesignLab/mutode) ([ISSTA'18 demo](https://dl.acm.org/doi/10.1145/3213846.3229504)) | Regex/AST source mutation, copy project per worker, run `npm test` per mutant | none | Dead: last npm release 1.4.2 on 2018-06-03, 154 downloads/month. Paper evaluated express (4,100 mutants), async (3,636), request (2,073), chalk (330) |
| [mutode2](https://github.com/saifullah73/mutode2) | Mutode plus ML-based mutant selection | none | Student fork, 2022 |
| [grunt-mutation-testing](https://github.com/jimivdw/grunt-mutation-testing) | Grunt plugin, file rewrite per mutant | none | Dead since 2016 (50★, 82 downloads/month) |
| [js-mutation-testing](https://github.com/paysdoc/js-mutation-testing) | Library behind the Grunt plugin | none | Dead since 2016 |
| [Mutandis](https://github.com/saltlab/mutandis) ([ICST'13](https://people.ece.ubc.ca/amesbah/resources/papers/icst13.pdf), [TSE](https://people.ece.ubc.ca/amesbah/resources/papers/mutandis-tse.pdf)) | Research tool: FunctionRank + dynamic invariants steer *where* to mutate; JS/DOM/jQuery/XHR-specific operators | none | Research artefact, last push 2015 |
| mutagen, xavier, benhartley/mutant, [perturb](https://github.com/bttmly/perturb), [AjaxMutator](https://github.com/mzw/RevAjaxMutator) | Assorted 2015–2022 prototypes | none | All abandoned |
| Stryker 1–3 (`stryker`, `stryker-javascript-mutator`, `@stryker-mutator/typescript`) | File-copy per mutant, transpile per mutant | none | Superseded by the 4.0 rewrite |

StrykerJS has no living competitor of comparable reach. Every other tool in the table was dead
before 2021. Downloads are dominated by CI installs, so they overstate active users, but the
two-order-of-magnitude gap to anything else is real.

### 1.2 New entrants, 2024–2026

A wave of small tools appeared in 2026, almost all positioned around **AI coding agents**
("did the agent's tests actually test anything?") rather than around speed. None has traction
yet; they are listed because their *design choices* show where people think Stryker falls short.

| Tool | Written in / parser | Engine | Scope | Status |
|---|---|---|---|---|
| [mutineer](https://github.com/mutineerjs/mutineer) | TS / Babel | Writes each mutant to a `__mutineer__` dir and redirects imports via a Vite plugin (Vitest) or module resolver (Jest); runs only tests that import the mutated file; parallel `tsc` workers flag compile errors | `--changed`, `--changed-with-imports` | 4★, created 2026-03 |
| [mutate4ts (schwammk)](https://github.com/schwammk/mutate4ts) | TS | One mutant at a time in an isolated project copy; LCOV for uncovered; per-file "certified" manifest; later runs mutate only changed *functions* | function-level differential | 0★, 2026-09 |
| [mutate4ts (graffhyrum)](https://github.com/graffhyrum/mutate4ts), [mutate4ts (lukasa1993)](https://github.com/lukasa1993/mutate4ts) | TS compiler API / Bun | In-place rewrite + restore per mutant | `--lines` | toy, 2026 |
| [Mutasaurus](https://github.com/christoshrousis/mutasaurus) | Deno / TS | Deno-native, file rewrite | none | 9★, 2025–26; the only Deno tool found |
| [stryker-js-effect](https://github.com/systemfsoftware/stryker-js-effect) | TS (Effect 4) | Stryker fork; default `vm` runner runs Vitest suites **in-process in a worker thread** via Node module hooks instead of forking child processes | inherits Stryker's | 1★, created 2026-09-13; no published numbers |
| [stryker-mutator-bun-runner](https://github.com/menoncello/stryker-mutator-bun-runner) | TS | Third-party Stryker runner for `bun test` | — | 6★, 8,153 downloads/month; upstream Bun support is still an open issue ([#4439](https://github.com/stryker-mutator/stryker-js/issues/4439), opened 2023-09) |
| [aitg](https://github.com/tzurid25/aitg) | TS | Wrapper: feeds `git diff` line ranges into StrykerJS | changed lines | 0★, 20 downloads/month |
| [Tautest](https://github.com/canblmz1/tautest) | TS | PR-scoped workflow layer over StrykerJS ([#6018](https://github.com/stryker-mutator/stryker-js/issues/6018)) | changed lines | closed without upstream uptake |
| [testtruth](https://github.com/T4LEL/testtruth) | TS / TypeScript parser | Mutates only `--unified=0` diff lines; scores the *same* mutants against new tests and against base-revision tests to detect test weakening | changed lines, two-sided | 169 downloads/month |
| [TestGuard](https://github.com/raccioly/testguard) | JS | "Claim verifier": seven verdicts incl. `NOCOVER`; baseline + delta gate | delta | 2,639 downloads/month |
| [gutcheck](https://github.com/beepometer/gutcheck) | JS | Extreme mutation: replaces each *changed function's* body with a wrong value, then an opposite-signed one ("hollow" vs "one-sided") | changed functions | 5★, 547 downloads/month; ships as a Claude Code Stop hook |
| [ts-quality](https://github.com/tryingET/ts-quality) | JS | `ts-mutate` plus CRAP, invariants, "governance" | changed code | 4★, alpha |
| [js-mutest](https://github.com/ku-plrg-classroom/js-mutest) | TS / acorn | Korea Univ. classroom assignment; Stryker's operator list reimplemented | none | teaching |
| [acoyfellow/mutant](https://github.com/acoyfellow/mutant) | **Rust** | One operator at a time on one file, runs the user's test command | per file | 1★, 2026-08 |
| [togi](https://github.com/Darkroom4364/togi) | **Rust** / tree-sitter (9 languages incl. TS) | File rewrite per mutant, LCOV filter, caching, sharding, SARIF/PR comments | diff-targeted by default | 1★ |
| [agent-mutator](https://github.com/flimble/agent-mutator) | **Rust** / tree-sitter (JS, TS, Python, Rust) | Per-function scoping, JSON for agents | per function | 0★ |

Observations:

- **No oxc- or swc-based JS mutation tool exists.** The Rust-written entrants use tree-sitter and
  shell out to the user's test command per mutant (the mutode model), which forfeits schemata
  and per-test coverage — the two things that made Stryker 4 fast. A Rust frontend buys parse
  speed, which is not where mutation testing spends its time.
- **Nobody except the Stryker fork attacks process overhead.** mutineer (import redirection) and
  stryker-js-effect (in-process worker threads) are the only designs that try to avoid a cold
  process per mutant; neither publishes a benchmark.
- **Diff scoping is the common selling point** (aitg, Tautest, testtruth, gutcheck, togi,
  mutineer, schwammk/mutate4ts) — confirming the demand, but every one of them is either a
  wrapper over Stryker's full dry run or a slow per-mutant process model.
- testtruth's **two-sided scoring** (same mutants, base tests vs head tests) is a genuinely new
  idea for PR review: it detects a PR that weakens tests while keeping CI green.

### 1.3 LLM-based mutation tools

| Work | Language | What it does | Key numbers |
|---|---|---|---|
| [LLMorpheus](https://arxiv.org/abs/2404.09952) (Tip, Bell, Schäfer; GitHub Next; TSE 2025) | **JS/TS** | Replaces code at designated locations with a placeholder and asks an LLM what could go there | 13 npm packages: 6,712 mutants vs StrykerJS's 4,969; 3,237 killed / 3,155 survived / 320 timeout. Manual check of 517 survivors: **20% equivalent** (StrykerJS survivors: **1%**). 7–87 min per run; ≈$0.99–$3.62 per full run. [Repo](https://github.com/githubnext/llmorpheus) archived |
| [ACH](https://arxiv.org/abs/2501.12862) (Meta, FSE 2025 industry) | Kotlin (Android) | Engineer describes a fault class in plain text; LLM writes mutants, an LLM agent filters equivalents, then generates killing tests | 10,795 classes → 9,095 mutants that build and pass → 4,660 (51%) judged non-equivalent → 571 tests. **25% of LLM mutants were trivially syntactically equivalent** (vs a typical 10–15% for rule-based operators). Equivalence agent precision/recall 0.79/0.47, rising to 0.95/0.96 once comments the LLM injected are stripped. Engineers accepted 73% of tests ([Meta blog](https://engineering.fb.com/2025/09/30/security/llms-are-the-key-to-mutation-testing-and-better-compliance/)) |
| [SMART](https://arxiv.org/abs/2603.24560) (2026) | Java | RAG + fine-tuning on real bugs | Compilable rate 88.85% → 90.21%; real-bug detection 92.61% vs 57.86% for the LLMut baseline |
| [Mutahunter](https://github.com/codeintegrity-ai/mutahunter) | language-agnostic | LLM writes mutants, runs test command | 300★, AGPL, last push 2025-04 |
| [LLM equivalent-mutant detection](https://arxiv.org/abs/2607.00511) (2026) | Java, C | Fine-tuned code embeddings beat traditional detectors on 3,302 Java / 1,088 C pairs | no JS data |

No Google publication on LLM-generated mutants was found; Codecov and Qodo ship test
generation, not mutation testing. LLM mutants are **complementary, not a replacement**: they are
realistic and targeted, but far more expensive per mutant, roughly 10% (SMART) to 29%
([Wang et al., TOSEM](https://arxiv.org/abs/2406.09843)) syntactically or type invalid, and far
more often equivalent. For tzap they are a
possible opt-in "deep" tier, not the engine.

---

## 2. Fast mutation engines elsewhere, and what makes them fast

### 2.1 The tools

| Tool | Ecosystem | Speed technique | Diff/incremental | Status |
|---|---|---|---|---|
| [mutmut 3](https://github.com/boxed/mutmut) | Python | **Function-level trampolines** (libcst): each function is renamed, every mutant becomes a whole copy of it, and a dispatcher picks one by name from `MUTANT_UNDER_TEST`. pytest imported **once**, then **`fork()` per mutant** (or a `forkserver` child that imports once and forks workers). A stats run records which tests reach which functions | Re-tests only functions whose source changed; state in `mutants/` | 1,453★, 3.8.0 on 2026-09-12. POSIX only — Windows needs WSL |
| [cargo-mutants](https://mutants.rs/) | Rust | Per-mutant *incremental* rebuild in a copied build dir; parallel jobs; sharding; recommends mold (~20%) / wild (>50%) linkers and a ramdisk ([perf docs](https://mutants.rs/performance.html)) | `--in-diff FILE` | 1,312★, v27.1.0 on 2026-06-02 |
| [gremlins](https://github.com/go-gremlins/gremlins) | Go | Coverage run first; uncovered mutants never executed | `--diff <git-ref>` | 423★ |
| [ooze](https://github.com/gtramontina/ooze) | Go | Runs *as a Go test*; recommends `gotestsum --max-fails=1` because `go test -failfast` does not work across packages | none | 289★ |
| [go-mutesting](https://github.com/zimmski/go-mutesting) (+ [avito fork](https://github.com/avito-tech/go-mutesting)) | Go | File rewrite + `go test` per mutant | forks vary | 676★ original, last push 2024-07 |
| [gomutants](https://github.com/gomutants/gomutants) | Go | **Byte-level overlays** (`go build -overlay`) instead of editing files; per-test coverage routing; content-addressed verdict cache | `--changed-since <ref>` (merge base + uncommitted) | 9★ but benchmarked: warm rerun **~120–150×** faster than cold (cobra 410 s → 2.7 s; prometheus tsdb 2,768 s → 19 s) — *claimed*, on an M1 Pro |
| [Mull](https://github.com/mull-project/mull) | C/C++ (LLVM) | Mutates LLVM IR; all mutants compiled in once (schemata-like), selected at runtime | `gitDiffRef` + `gitProjectRoot` ([docs](https://mull.readthedocs.io/en/latest/IncrementalMutationTesting.html)) | 841★ |
| [mutant](https://github.com/mbj/mutant) | Ruby | Fork per mutant from a preloaded process; test selection by naming convention | `--since <git-ref>`: subjects (methods) whose line range overlaps a diff hunk ([docs](https://github.com/mbj/mutant/blob/main/docs/incremental.md)) | 2,198★. Free for OSS; commercial use $30/dev/month |
| [Stryker.NET](https://stryker-mutator.io/docs/stryker-net/technical-reference/mutant-schemata/) | C# | Schemata via Roslyn; compile errors fixed by **iterative rollback** (compile, drop mutants at error locations, recompile — "usually 1–3 retries") | `--since <target>` (file-level; a changed test file re-tests every mutant it covers), `--with-baseline` stored on disk / Dashboard / Azure / S3 ([config](https://stryker-mutator.io/docs/stryker-net/configuration/)) | 2,089★ |
| Stryker4s | Scala | Schemata via scalameta | — | active |
| [PIT](https://pitest.org/) / [arcmutate](https://www.arcmutate.com/) | JVM | Bytecode, warm minion JVMs, per-test coverage, early exit; history file | free: changed *files*; arcmutate (commercial): changed *lines*, `-Local-`/`-Empty-` | see [jzap prior-art](https://github.com/huyz0/jzap/blob/main/docs/prior-art.md) |
| [jzap](https://github.com/huyz0/jzap) | JVM | Branch-free bytecode schemata (static dispatch call per mutable op); one warm analysis JVM; kill-test-first; loop-count hang detection; content-keyed cache; daemon | line-level `--from/--to`, `-Local-`, `-Empty-`, or a raw unified diff | 0.x, unpublished |

### 2.2 jzap's measured numbers (the sibling's baseline)

From [performance.md](https://github.com/huyz0/jzap/blob/main/docs/performance.md) and
[status.md](https://github.com/huyz0/jzap/blob/main/docs/status.md), on a 40-class / 200-test /
1,080-mutant fixture:

| Measurement | Value |
|---|---|
| Full run vs PIT, one thread | 2.91 s vs 28.09 s — **9.64×** (7.9–8.5× on a 4-core CI runner) |
| Schemata vs per-mutant class redefinition | **6.41×** full run, 10.37× execution phase (3.42× on 4 cores) |
| Profiling fixes (no new features) | execution phase 6,344 → 1,690 ms; JVM recycling every 100 mutants cost 2.9× by discarding JIT warmup (test 4.6 ms cold vs 0.97 ms warm) |
| Diff run, one changed line (6 of 1,080 mutants) | 1.44 s — only 2.0× its own full run, because fixed costs (JVM start, serial coverage phase) dominate |
| Cache warm, no change | 0.42 s; warm daemon 0.17 s |
| One-per-line reduction | 1.4× faster but hides **43 of 125** genuine survivors; was 1.9× before schemata |
| TCE on javac output | drops **nothing** |
| Tests run per mutant | already 1.00–1.11 with kill-test-first + early exit |
| Threads | default is 1 worker: extra workers measured +14% upside vs −45% downside |

The lessons that transfer: once per-mutant cost is small, **fixed costs dominate** (process
start, dry run, coverage), reduction techniques lose value, and parallelism can go negative on CI
hardware. JS has the same shape with worse constants: Node startup plus test-framework import
is typically hundreds of milliseconds, and TypeScript transpilation of a large test graph can be
seconds.

### 2.3 Techniques that transfer to JS, with evidence

1. **Schemata / mutation switching.** Stryker 4 reported **20–70%** overall and 40–60% from
   `perTest` coverage ([announcement](https://angular.love/announcing-stryker-4-0-mutation-switching)).
   On express (1,147 tests, 1,800 LOC) Stryker 3.3.1 took 8:15 and 4.0-beta 4:17
   ([#2417](https://github.com/stryker-mutator/stryker-js/issues/2417)). Academic numbers for
   C: split-stream execution is 3.49× over schemata; AccMut is 2.56× over split-stream and
   **8.95× over schemata** ([AccMut, ISSTA'17](https://arxiv.org/abs/1702.06689)); WinMut adds
   5.57× on top of AccMut ([ASE'21](https://xiongyingfei.github.io/papers/ASE21.pdf)).
   *Analysis:* those beyond-schemata gains need `fork()` at the mutation point, which neither
   V8 nor Windows offers; they are not available to a Node tool.
2. **Granularity of the switch.** Stryker switches at *expression* level with a global
   `activeMutant` lookup; mutmut switches at *function* level. *Analysis, untested:* function-level
   trampolines keep each variant monomorphic for V8's optimiser and never change the declared
   type of an expression, which is exactly what produces Stryker's type-error cascade
   ([#2438](https://github.com/stryker-mutator/stryker-js/issues/2438), §4). The cost is code
   size — one function copy per mutant.
3. **Load once, fork per mutant.** mutmut's `fork`/`forkserver` and Ruby mutant amortise
   interpreter start and import cost. Node has no `fork()`; the nearest equivalents are a warm
   worker pool that re-runs tests in the same module graph (Stryker, stryker-js-effect's worker
   threads) or V8 snapshots. The soundness question jzap solved for statics — module-level state
   leaking between mutants — applies directly to ES module singletons.
4. **Per-test coverage + early exit + kill-test-first ordering.** Universal. jzap measured tests
   run per mutant at 1.00–1.11 once all three are in place, which made block-level coverage not
   worth building.
5. **Overlays instead of file edits.** gomutants uses `go build -overlay`; mutineer redirects
   imports in the Vite/Jest resolver. The JS analogue is a Node module-loader hook
   (`module.register` / `registerHooks`) serving mutated source from memory — no sandbox copy.
6. **Content-addressed verdict caches.** gomutants keys a verdict on the mutated file, the rest of
   its package, and the tests that could reach it, all byte-identical (claimed 120–150× on warm
   reruns). jzap invalidates the whole coverage map on any production change, deliberately,
   because a change elsewhere can alter what reaches a line. StrykerJS incremental reuses
   3,731 of 3,965 results in its own documented example
   ([docs](https://stryker-mutator.io/docs/stryker-js/incremental/)), but does not track
   dependency, config or non-mutated-file changes, and its Vitest runner produced
   non-deterministic test IDs that churned ~15k lines of the baseline per run
   ([#6004](https://github.com/stryker-mutator/stryker-js/issues/6004)).
7. **Grouping mutants per test session.** Simultaneous mutation testing implemented in StrykerJS
   gained only **3%**, because session setup was already cheap; 27% when setup was made
   artificially expensive; 99.9% of verdicts retained
   ([de Roos, U. Twente 2024](https://research.infosupport.com/wp-content/uploads/final-project-final.pdf)).
   Not worth it once a warm runner exists.

---

## 3. The academic record for JS/TS

### 3.1 JS-specific work

**Mutandis** — Mirshokraie, Mesbah, Pattabiraman,
[Efficient JavaScript Mutation Testing, ICST'13](https://people.ece.ubc.ca/amesbah/resources/papers/icst13.pdf)
(best-paper runner-up), extended in
[Guided Mutation Testing for JavaScript Web Applications, TSE](https://people.ece.ubc.ca/amesbah/resources/papers/mutandis-tse.pdf).

- Chooses *where* to mutate before generating: a FunctionRank (PageRank over the dynamic call
  graph, weighted by call frequency) plus cyclomatic complexity picks functions; dynamic
  invariants inferred from execution traces mark variables whose mutation likely changes output.
- JS-specific operators from a survey of common programmer mistakes: add/remove `var`; drop the
  `g` flag from `replace`; drop the radix from `parseInt`; `setTimeout(f)` → `setTimeout(f())`;
  `undefined` ↔ `null`; remove `this`; `(f() !== false)` → `(f())`. Plus DOM operators (swap
  `insertBefore` args, swap `innerHTML`/`innerText`), jQuery (`#` ↔ `.` selectors, drop `$`) and
  XHR (`readyState`/`status` constants).
- **Measured:** on average **7%** equivalent mutants (range: 2–4 per app; worst 10%), versus the
  10–40% commonly cited for unguided generation; over 70% of the faults causing major loss of
  function ranked in the top 20% by FunctionRank.
- Relevance: most of the DOM/jQuery/XHR operators are obsolete; the *parseInt radix*,
  *replace-without-g*, *null/undefined* and *timer callback* operators remain realistic JS faults
  that Stryker does not model. The ranking idea is essentially predictive prioritisation.

**LLMorpheus** (§1.3) is the only other JS-specific mutation paper found, and its most useful
number for tzap is incidental: only **1% of StrykerJS survivors** in 13 packages were equivalent
on manual inspection. That is far lower than the 10–40% folklore, and suggests Stryker's noise
problem is *unproductive* mutants (killable, but not worth a test) rather than strictly
equivalent ones — the distinction Google draws (§3.2).

No empirical study was found that (a) measures StrykerJS operator-level equivalence or
redundancy rates across a JS corpus, (b) measures how many TypeScript mutants are type-invalid,
or (c) applies trivial compiler equivalence to JS. §4 and §5 fill (b) partially from public
data and reason about (c).

### 3.2 Google: diff-scoped, one mutant per line, arid nodes

- [Petrović & Ivanković, State of Mutation Testing at Google, ICSE-SEIP'18](https://research.google.com/pubs/archive/46584.pdf):
  1.1M mutants over the study period, 150,000 surfaced; developer usefulness of surfaced results
  rose from **20% to 80%** as arid rules accumulated. Per-language survival: JavaScript 86,123
  mutants (7%), 13.1% surviving; TypeScript 13,318 (1%), 8.3%. Statement block removal (SBR)
  was 72% of all mutants.
- [Petrović, Ivanković, Fraser, Just, Practical Mutation Testing at Scale, TSE'21](https://arxiv.org/abs/2102.11378):
  - 16,935,148 mutants over 776,740 changelists; 2,110,489 surfaced; 66,798 received feedback.
    **TypeScript: 1,006,531 mutants, 20.8 per CL, 10.8% survive. JavaScript: 908,014, 31.0 per
    CL, 9.4% survive.** 87.5% of all generated mutants are killed.
  - Initially **85% of reported mutants were judged unproductive**. Suppression heuristics
    (arid nodes) took productivity from ~15% to 80% (logging, time/deadline/backoff values and
    config flags alone did most of it), then to 89%. Overall, 82% of surfaced mutants with
    feedback were rated "Please fix".
  - Median mutants per changelist: **820** traditional → **77** one-per-line → **7** arid +
    one-per-line (25th/75th percentiles 3/19).
  - More than 100 arid rules and fuzzy name rules for 200+ function families. The log heuristic
    (call name starts with `log`, or receiver named `logger`) was right on 99 of 100 sampled nodes.
  - Heuristic categories: uncompilable (Go unused-symbol errors), equivalent (`size() == 0` →
    `<= 0`; memoisation cache lookups), unproductive-killable (monitoring counters, `mkdir`,
    flags), and redundant (for `x != nullptr`, the `if (x)`/`if (nullptr)` family).
  - Operator mix: SBR 68.0%, UOI 18.5%, LCR 7.7%, ROR 4.0%, AOR 1.8%.
- [Does mutation testing improve testing practices? ICSE'21](https://arxiv.org/abs/2103.07189):
  ~15M mutants; developers exposed to mutants write more tests and leave fewer surviving mutants
  over time. **Fault coupling:** for **70%** of 1,502 high-priority bugs (C++, Java, Python, Go),
  a fault-coupled mutant would have been reported on the bug-introducing change.

### 3.3 Meta

- [What It Would Take to Use Mutation Testing in Industry — A Study at Facebook (2021)](https://arxiv.org/abs/2010.13464):
  mutation operators *learned* from real bug fixes and incidents (Getafix-style) had a
  **60–70% survival rate**, versus ~15% for Google's generic operators and often under 10% in
  academia. 26 developers: all but two agreed the mutant exposed a testing gap; about half would
  act on it.
- ACH (FSE 2025) — see §1.3. Its two transferable facts: engineers accept tests aimed at
  *specific, described* fault classes, and a cheap syntactic pre-filter (strip comments,
  normalise) removed most of the equivalence classifier's errors.

### 3.4 Cost reduction and validity

- **TCE** — [Papadakis et al., ICSE'15](https://discovery.ucl.ac.uk/1499169/1/Jia_Trivial_Compiler_mutation-testing-papadakis-icse15.pdf):
  compile each mutant with an optimising compiler and compare binaries. On C, discards **>7%**
  of mutants as equivalent and **21%** as duplicates, catching ~30% of all equivalent mutants.
  Weak on Java because javac barely optimises (jzap measured zero drops).
- **Coupling** — [Just et al., FSE'14](https://homes.cs.washington.edu/~rjust/publ/mutants_real_faults_fse_2014.pdf):
  mutant detection correlates with real-fault detection independent of coverage, on 357 real
  faults; 73% of the faults were coupled to common-operator mutants. A later study of 32,002
  mutants and 144 faults found only 9.92% of mutants *strongly* coupled, but 51.03% of faults
  had at least one strongly coupled mutant
  ([Chalmers](https://research.chalmers.se/en/publication/536348)).
- **Subsumption / redundancy** — [Papadakis et al., ISSTA'16](https://dl.acm.org/doi/pdf/10.1145/2931037.2931040):
  subsumed mutants inflate scores and change experimental conclusions; almost all generated
  mutants are redundant with respect to a minimal set.
- **Predictive mutation testing** — [Zhang et al., ISSTA'16](https://lingming.cs.illinois.edu/publications/issta2016.pdf):
  AUC > 0.8 predicting kill/survive from cheap features. But
  [excluding unreached mutants drops cross-project AUC from 0.83 to 0.52](https://arxiv.org/abs/2005.11532),
  worse than random on 27% of projects: most of the signal was "is it covered?", which a
  coverage phase answers exactly. Not worth building.
- **Practitioner survey** — [Mutation Testing in Practice, TSE 2024](https://ieeexplore.ieee.org/document/10472898/):
  104 OSS contributors; high satisfaction across languages and tools, with cost and noise as the
  recurring limits.

---

## 4. Type-aware mutation

### 4.1 How big is the problem? (measured here)

No paper reports how many TypeScript mutants are type-invalid, so this document computed it from
the public [Stryker Dashboard](https://dashboard.stryker-mutator.io) reports that StrykerJS
publishes for its own packages (strict TypeScript, Stryker's default mutators, TypeScript
checker enabled). Method: download
`/api/reports/github.com/<repo>/master?module=<m>` and count `status` per mutant.

| Module | Mutants | CompileError | % |
|---|---|---|---|
| stryker-js `core` | 4,854 | 1,477 | 30.4% |
| stryker-js `instrumenter` | 2,026 | 579 | 28.6% |
| stryker-js `typescript-checker` | 693 | 189 | 27.3% |
| stryker-js `jest-runner` | 441 | 152 | 34.5% |
| stryker-js `vitest-runner` | 356 | 128 | 36.0% |
| stryker-js `util` | 234 | 85 | 36.3% |
| mutation-testing-elements `metrics` | 493 | 181 | 36.7% |
| mutation-testing-elements `elements` | 2,210 | 472 | 21.4% |
| **Total** | **11,307** | **3,263** | **28.9%** |

For comparison, the Go tool gomutants' own dashboard report shows 8.5% compile errors (115 of
1,348).

By mutator, on `core` (the largest sample):

| Mutator | Mutants | CompileError | Survived | Ignored |
|---|---|---|---|---|
| BlockStatement | 1,225 | **536 (43.8%)** | 22 | 6 |
| StringLiteral | 1,002 | 146 (14.6%) | 94 | **121** |
| ConditionalExpression | 982 | 293 (29.8%) | 119 | 2 |
| EqualityOperator | 268 | 38 (14.2%) | 32 | 1 |
| ObjectLiteral | 242 | **168 (69.4%)** | 7 | 11 |
| CallExpression | 222 | 7 (3.2%) | 33 | 2 |
| ArrowFunction | 199 | **114 (57.3%)** | 8 | 5 |
| LogicalOperator | 137 | 58 (42.3%) | 10 | 0 |
| ArrayDeclaration | 135 | 46 (34.1%) | 5 | 10 |
| OptionalChaining | 38 | **33 (86.8%)** | 1 | 0 |
| ArithmeticOperator | 85 | 2 (2.4%) | 1 | 0 |

The same ranking holds on every module: ObjectLiteral (52–69%), OptionalChaining (60–87%),
ArrowFunction (43–57%), BlockStatement (39–44%) and LogicalOperator (42–54%) are the
type-breakers; arithmetic, update, unary and regex operators almost never are. The pattern is
predictable from the types: emptying a block that must return `T`, replacing an object with `{}`
where fields are required, replacing `a?.b` with `a.b` on a possibly-undefined `a`, and turning
`a ?? b` / `a || b` into `a && b` all change the static type.

Caveats: this is one project family, written by the Stryker maintainers in very strict
TypeScript; a looser codebase will produce fewer compile errors. It is still the only public
number, and it says that **roughly three in ten TS mutants a naive generator makes are
unviable**.

### 4.2 How tools deal with it today

- **StrykerJS:** the schemata file would not type-check at all (a mutant changes the declared
  type of an expression, and errors cascade into test files), so Stryker prepends
  `// @ts-nocheck` and strips other type directives
  ([#2438](https://github.com/stryker-mutator/stryker-js/issues/2438); `disableTypeChecks`).
  Type-invalid mutants are therefore *executed* unless the optional
  [TypeScript checker](https://stryker-mutator.io/docs/stryker-js/typescript-checker/) is on;
  it type-checks mutants in groups whose files do not reference each other — **43% faster and
  99.1% accurate** on Stryker's core vs checking one at a time, which had cost **up to 10×**
  ([blog, 2023-02](https://stryker-mutator.io/blog/announcing-faster-typescript-checking/)).
- **Stryker.NET:** generate everything, let Roslyn find errors, roll back offending mutants,
  recompile (1–3 rounds).
- **Google:** heuristics avoid generating uncompilable mutants where cheap (Go unused symbols).
- **mutineer:** parallel `tsc` workers.
- **Nobody** uses the type checker *before* generation to choose type-preserving replacements.
  The only "type-aware operator mutation" literature found is for SMT solvers
  ([Winterer et al.](https://arxiv.org/abs/2004.08799): substitute an operator only with one of
  a compatible signature).

### 4.3 Design space (analysis)

| Option | Cost | Precision |
|---|---|---|
| Execute everything (Stryker default) | ~29% of test executions wasted, plus confusing "killed by TypeError" verdicts that inflate scores | Unsound score: a type-invalid mutant that throws counts as killed |
| Check afterwards with `tsc` (Stryker checker, mutineer) | A full program check per group; seconds each on big projects | Exact |
| Syntactic rules per operator (never `{}` for a typed object literal, never empty a non-void block, never drop `?.`) | Free | Approximate; loses some viable mutants |
| **Type-directed generation**: ask the checker for the contextual type once per site and emit only replacements assignable to it (e.g. `return` of the type's zero value instead of an empty block; `a.b` only if `a` is non-nullable) | One type query per site, on a program already loaded | Near-exact; also yields *more useful* mutants (Google's "return default value" style) |

Type-directed generation is the unclaimed option, and TypeScript makes it cheaper than in most
languages because the checker is an in-process library with a query API. The fast path would
read types once, keep `tsc` only as a validation mode for the test suite, and never execute a
mutant the type system rejects. Whether the viable mutants lost to syntactic rules matter should
be measured, in the jzap style: speed and detection loss reported together.

---

## 5. Equivalent, redundant and noisy mutants in JS

### 5.1 Where the noise comes from

- **Logging and debug calls.** The most-commented request in Stryker's history
  ([#1472](https://github.com/stryker-mutator/stryker-js/issues/1472), 38 comments): one user
  reports that **half of all surviving mutants** were `StringLiteral` or `ObjectLiteral` mutations
  of logger calls — `logger.warn("…", { foo })` yields two unproductive mutants. Users ask for
  global patterns (`console.*`, `logger.*`, the `debug` package, `propTypes`). Stryker answered
  with disable comments (5.4) and ignorer plugins (7.3,
  [docs](https://stryker-mutator.io/docs/stryker-js/disable-mutants/)): opt-in, per project,
  written by the user.
- **StringLiteral** is the largest source of *ignored* mutants in the dashboard data (121 of 178
  on `core`, 136 of 224 on `instrumenter`) — the maintainers themselves suppress it most.
- **Static mutants** (module-initialisation code) cannot be attributed to tests, force full
  reruns, and are costly; Stryker added `ignoreStatic`.
- **Timeouts:** 80 of 4,854 on `core`, 492 of 2,114 on express under Stryker 3.3.1 — mutants that turn
  loops or retries unbounded, killed for a reason unrelated to test quality (jzap filters loop
  counters by default for the same reason).

### 5.2 Arid-node rules translated to JS/TS (analysis)

Google's highest-yield categories map directly:

| Google category | JS/TS instances |
|---|---|
| Logging | `console.*`, `logger.*`/`log.*`, `debug(...)` instances, `pino`/`winston` calls, `process.stderr.write` |
| Time and retries | `setTimeout`/`setInterval` delays, `AbortSignal.timeout(n)`, retry/backoff counts, `Date.now()` arithmetic only used for metrics |
| Config flags and monitoring | metrics counters (`.inc()`, `.observe()`), feature-flag defaults, telemetry spans |
| Memoisation | `if (cache.has(k)) return cache.get(k)` and `??=` caches (removal is equivalent by construction) |
| Unproductive-killable, JS-specific | error-message strings in `throw new Error("…")` (killable only by snapshotting messages), CSS class names and `data-testid` strings, i18n keys, `displayName`, `propTypes`, TS-only constructs erased at runtime (`as`, `satisfies`, type-only imports) |
| Redundant, JS-specific | `x != null` vs `x !== null && x !== undefined`; `a?.b` → `a.b` when `a` is non-null by type; `!!x` in boolean context; `?? `→`||` when the left side is an object type that cannot be falsy |

The last row is where types pay a second time: the redundancy and equivalence rules that Google
implemented soundly used full type information (e.g. `java.util.Collection::size` is never
negative). TypeScript's checker supplies the same facts for JS.

### 5.3 TCE for JavaScript (analysis)

There is no compiler output to compare, but a **minifier is a semantics-preserving normaliser**:
print the original and each mutated function through the same minifier with deterministic
settings (terser, esbuild, oxc-minifier), hash, and drop mutants whose output equals the
original (equivalent) or another mutant's (duplicate). What it can catch: dead-branch edits
under literal conditions, constant-folded arithmetic on literals, duplicate mutants reached by
different operators, and mutants that differ only in erased TypeScript syntax. What it cannot:
anything involving a free variable, because JS coercion forbids folding `x + 0`, `x * 1` or
`x - 0` without type knowledge. Expect a smaller yield than C's 7% + 21% — likely closer to
jzap's zero on javac — so TCE is a cheap, measurable filter, not a headline feature. ACH's
experience (25% of LLM mutants syntactically identical once normalised) argues for doing the
normalisation step regardless.

---

## 6. Diff-based mutation testing in CI

### 6.1 What JS users do today

- **Changed files**: `stryker run --mutate $(git diff --name-only …)` or
  [stryker-diff-runner](https://github.com/tverhoken/stryker-diff-runner). Users report this is
  still slow and forces the break threshold off, because the whole file is mutated
  ([#2843](https://github.com/stryker-mutator/stryker-js/issues/2843)).
- **Changed lines**: since StrykerJS added `--mutate file:start-end`, the maintainers'
  recommendation is to script `git diff` into ranges (#2843). Ranges cannot be combined with
  globs. Wrappers doing this: aitg, Tautest, testtruth; a checker-plugin approach was
  [stryker-git-checker](https://github.com/lbtoma/stryker-git-checker) (student project,
  experimental). The **initial dry run still executes the whole test suite with coverage**,
  whatever the range, so a one-line PR pays the full-suite floor.
- **Reporting**: [mutation-report-action](https://github.com/johanholmerin/mutation-report-action)
  turns the mutation-testing-elements JSON into GitHub annotations; the Stryker Dashboard hosts
  reports and badges; [stryker-baseline-reporter](https://github.com/riezebosch/stryker-baseline-reporter)
  reports only new survivors.
- **Nightly full + PR partial** is the common pattern reported in #2843.

### 6.2 Diff scoping semantics compared

| Tool | Unit selected | Deleted lines | Base | Uncommitted work | Test-only diffs | Diff/source mismatch |
|---|---|---|---|---|---|---|
| arcmutate `+GIT` | changed lines | — | `from`/`to` refs; `-Local-`, `-Empty-` | yes (`-Local-`) | `+GIT_TEST` mode mutates code *covered by* changed tests | analysis runs on current code; range only selects |
| Mull | changed source lines | — | `gitDiffRef` (branch, `HEAD`, `COMMIT^!`) | yes | no | does not check out the ref; old commits mislead |
| cargo-mutants `--in-diff` | mutants whose **span** overlaps added lines ([source](https://github.com/sourcefrog/cargo-mutants/blob/main/src/in_diff.rs)); a function-body replacement's span is the whole body, so any edit inside a function selects it | a deletion marks the next surviving line as affected | any diff file | yes (`git diff`) | ignored: "a diff that only deletes or changes test code won't cause any mutants to run" | **errors** if diff new-text doesn't match the tree |
| gremlins `--diff` | mutants inside changed code | — | git ref | — | — | — |
| Ruby mutant `--since` | **subjects** (methods) whose line range overlaps a hunk | — | git ref | yes | no; indirect changes explicitly not selected | — |
| Stryker.NET `--since` | changed **files**; changed test file → every mutant it covers | — | target branch | — | yes (via coverage) | `ignore-changes-in` globs |
| gomutants `--changed-since` | changed code | — | **merge base** with ref | yes (tracked files) | routes via coverage | — |
| mutmut 3 | changed **functions** (hash) | — | previous run | yes | — | — |
| schwammk/mutate4ts | changed functions vs embedded manifest | — | previous certified run | yes | — | — |
| testtruth | `--unified=0` changed lines | — | `A..B`, `A...B` (merge base) | — | scores base tests vs head tests | — |
| jzap | changed lines (`--scope class` to widen) | — | `--from/--to`, `-Local-`, `-Empty-`, or raw diff | yes | — | — |
| StrykerJS | whatever ranges you pass | — | none (no git) | n/a | incremental mode only | none |

The dimensions a new tool has to decide, each with a precedent:

1. **Granularity**: line (arcmutate, jzap), span-overlap (cargo-mutants), function (mutmut,
   Ruby mutant), file (Stryker.NET, PIT free). Span-overlap is the most principled: a mutant is
   in scope iff the text it replaces intersects the change.
2. **Deletions**: only cargo-mutants handles them explicitly (mark the following line). A pure
   deletion otherwise selects nothing, although it can remove a guard.
3. **Base**: merge base (gomutants, `A...B`) matches what a PR shows; a plain ref over-selects
   when the branch is behind.
4. **Test-only changes**: arcmutate `+GIT_TEST` and Stryker.NET map changed tests to the mutants
   they cover; cargo-mutants deliberately ignores them. testtruth's two-sided scoring is the
   strongest answer to "this PR weakened the tests".
5. **Mismatch**: cargo-mutants refuses a diff that doesn't match the working tree; Mull and
   arcmutate silently analyse current code.

---

## 7. Implications for tzap

### 7.1 The unclaimed position

The JS/TS market is one incumbent and a crowd of prototypes. StrykerJS owns breadth — every
runner, every framework, a report schema and dashboard everyone uses. What nobody offers:

- **Native line/span-level diff scoping with a cost floor proportional to the diff.** Stryker's
  ranges still pay a full-suite dry run; the wrappers inherit that; the per-mutant-process tools
  scale with the diff but pay a cold process per mutant.
- **Type-directed generation.** Nobody uses TypeScript's checker to avoid generating the ~29% of
  mutants it will reject; Stryker executes them (default) or type-checks them afterwards (opt-in,
  up to 10× before grouping).
- **Default-on noise suppression.** Stryker's answer to the single biggest complaint (logging
  noise) is user-written ignore plugins. Google's evidence is that built-in arid rules move
  usefulness from ~15–20% to ~80–89%.
- **A published, reproducible benchmark.** None of the 2026 entrants publishes one; Stryker's
  benchmarks are issue threads from 2020.
- **Windows-native speed.** The fork-based designs (mutmut, Ruby mutant) are POSIX-only; a Node
  design without `fork()` is not.

So the position mirrors jzap's: **free, fast, diff-first, type-aware, low-noise, and emitting
the mutation-testing-elements schema so the Stryker dashboard, HTML report and
annotation actions keep working.** Compete with Stryker on the PR loop, not on runner breadth.

### 7.2 Techniques that transfer, ranked

1. **Diff → span overlap → coverage-selected tests, with no full-suite dry run.** Get per-test
   coverage from a cache keyed by content hash, and run coverage only for tests that could reach
   changed files (import graph first, coverage second). This is where the PR-loop multiples are;
   jzap's own diff run was only 2.0× its full run because fixed costs dominated, and Node's fixed
   costs are larger.
2. **Schemata in a warm, reused runner.** Keep the module graph and transpiled code loaded across
   mutants, switch by a global, and put the soundness gate in place from day one: every fixture
   run both with one fresh runner per mutant and with reuse, verdicts identical, including a
   fixture that leaks module state on purpose. Evaluate function-level trampolines (mutmut) against
   expression-level switching (Stryker) for V8 deopt cost and type-error isolation.
3. **Serve mutated modules from memory via loader hooks**, as mutineer and gomutants' overlays do
   — no sandbox copy of `node_modules`.
4. **Type-directed operators** (§4.3), with a `tsc`-validated mode to measure what they lose.
5. **Built-in arid rules** (§5.2) with a switch to disable them, reported jzap-style: mutants
   removed *and* survivors hidden, on real corpora.
6. **Kill-test-first ordering, early exit, deterministic hang detection** (loop-iteration budgets
   rather than wall-clock, as jzap does) — timeouts are a large share of Stryker verdicts.
7. **Content-addressed cache** that records its toolchain (Node, TypeScript, test runner
   versions) and refuses to read under another, and stable test IDs (Stryker's Vitest IDs were
   not, [#6004](https://github.com/stryker-mutator/stryker-js/issues/6004)).
8. **Minifier-based TCE** as a cheap, measured, off-by-default filter.
9. **Output**: mutation-testing-elements JSON, PR annotations, an agent-oriented reporter, and
   optionally testtruth-style two-sided scoring for test-only changes.

### 7.3 Not worth building (on current evidence)

- A Rust/oxc parser as the headline — parsing is not the bottleneck; the Rust entrants prove
  that a fast parser with a slow runner is still slow. (A native helper for diff/span mapping and
  hashing is fine; it is not the product.)
- Predictive mutation testing — its accuracy was mostly coverage in disguise.
- Simultaneous/grouped mutants — 3% on Stryker once sessions are cheap.
- Split-stream/AccMut-style forking — no `fork()` in V8 or on Windows.
- LLM mutants as the engine — 20% equivalent among LLMorpheus survivors vs 1% for Stryker, plus
  cost and nondeterminism. An opt-in, ACH-style "describe the fault class" tier is plausible later.

### 7.4 Decisions to settle early

- **Runner boundary.** Owning the Vitest/Jest execution loop (like Stryker) versus driving the
  user's test command (like the new entrants). Only the former gets schemata, per-test coverage
  and early exit; it also means tracking Vitest's internals, which just broke Stryker's
  name filter on Vitest 5 ([#6210](https://github.com/stryker-mutator/stryker-js/issues/6210)).
- **Score definition.** Whether type-invalid and runtime-error mutants are outside the score
  (jzap and the mutation-testing-elements schema) or counted killed (Stryker when the checker is
  off, PIT). With ~29% type-invalid, this choice alone moves a TS project's score substantially.
- **Isolation granularity.** Worker threads, child processes, or `vm` contexts, measured against
  module-state leakage with a deliberate-leak fixture.
- **Bun and Deno.** Stryker's Bun support has been an open issue for three years and a
  third-party runner fills it; Deno has one small tool. Either is an opening, but only after Node.

---

## 8. Sources not yet read in full

- Mutandis TSE extension (operator-level numbers beyond ICST'13).
- [Integrating Mutation Testing Into Developer Workflow: An Industrial Case Study (ASE 2024)](https://dl.acm.org/doi/10.1145/3691620.3695273) — paywalled (403).
- [Mutation Testing Optimisations using the Clang Front-end](https://arxiv.org/abs/2210.17215) —
  front-end (AST-level) schemata numbers, relevant to a source-level JS engine.
- [Mutation Analysis with Execution Taints (2024)](https://arxiv.org/abs/2403.01146) — dynamic
  taints plus memoisation to skip redundant post-mutation work.
- [Kill all mutants with Stryker, UvA 2026 lecture](https://github.com/nicojs/presentations/tree/master/uva-2026)
  — the maintainers' current framing of Stryker's limits.
