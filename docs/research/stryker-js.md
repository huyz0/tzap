# StrykerJS: how it works and where the time goes

Research note for tzap. Written 2026-09-26.

- **Subject:** StrykerJS **10.0.0** (released 2026-08-14, [CHANGELOG](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/CHANGELOG.md)). Source read at master commit `f2a49ff` (2026-09-11). All `src` links below are pinned to that commit (`SJ` = `https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf`).
- **Report schema / metrics:** mutation-testing-elements **3.9.0** (`mutation-testing-report-schema`, `mutation-testing-metrics`).
- **Evidence labels:** **[src]** = I read it in source at the pinned commit. **[docs]** = official docs or blog. **[user]** = reported in an issue or third-party source and not re-verified by me. Numbers from [user] sources come from one person's setup; read them as order-of-magnitude.

---

## 0. TL;DR

1. StrykerJS instruments every mutated file **once** using mutant schemata ("mutation switching"). Each mutant is guarded by `stryMutAct_9fa48("id") ? mutated : original`. Every evaluation also calls a coverage counter, `stryCov_9fa48(...)`.
2. The project is copied into **one** sandbox (`.stryker-tmp/sandbox-XXXX`) with `node_modules` symlinked. It then forks `concurrency` Node **child processes** (default `n-1` when n>4). They talk over `process.send` with JSON-serialized messages.
3. A **dry run** collects per-test coverage (`perTest` is the default). Each mutant then runs only the tests that covered it. **Static mutants** (hit at module load, outside any test) run **all** tests in a **fresh environment**. They dominate runtime: Stryker's own blog cites 2% of mutants taking 45% of the time, and 8% taking 83%.
4. Test order inside a mutant is **dry-run order**, not fastest-first or kill-history-first. Bail is on by default for mocha, jasmine, karma and vitest. **Jest cannot bail** (`bail: false` is forced), so every covering test runs for every Jest mutant.
5. Environment reuse depends on the runner:
   - Mocha, Jasmine and Cucumber use **hot reload**: files are loaded once and many mutants run in the same process.
   - Jest re-runs `runCLI` per mutant, and its per-file module registries re-import everything.
   - Vitest reuses one `Vitest` instance but calls `ctx.start()` per mutant, so it re-imports test modules.
   - The command runner spawns the whole command per mutant.
6. The TypeScript checker takes **half the concurrency slots** until checking finishes. It type-checks mutants in-memory via a `SolutionBuilderWithWatch`, grouped by dependency graph. Historically it cost up to 10x; grouping made it 43% faster at 99.1% accuracy. A TS 7 (tsgo) path is experimental in 10.0.
7. Incremental mode diffs the old report against the current code with diff-match-patch. It reuses results when the mutant's own code range and its killing or covering tests are unchanged. It does **not** track changes in non-mutated, non-test files, or in callee files. The dry run is always repeated.
8. There is **no git-diff mode**. `--mutate file:L1-L2` exists, and community scripts turn `git diff -U0` into ranges. Even then the full dry run and the full sandbox copy happen.
9. `stryker serve` (Mutation Server Protocol, used by the VS Code plugin) runs a **cold** `Stryker.run` per request: no warm sandbox, no warm workers.
10. Several open **verdict bugs** matter for an oracle:
    - static mutants plus `testFiles` produce false Survived ([#6144](https://github.com/stryker-mutator/stryker-js/issues/6144), [#6209](https://github.com/stryker-mutator/stryker-js/issues/6209));
    - Vitest 5 breaks the test-name filter, so covered mutants run 0 tests and report Survived ([#6210](https://github.com/stryker-mutator/stryker-js/issues/6210));
    - scores are nondeterministic under load ([#4878](https://github.com/stryker-mutator/stryker-js/issues/4878), [#5284](https://github.com/stryker-mutator/stryker-js/issues/5284)).

---

## 1. Architecture

### 1.1 Packages (monorepo `packages/`, all 10.0.0) [src]

| Package | Role |
|---|---|
| `@stryker-mutator/api` | Plugin contracts: `TestRunner`, `Checker`, `Reporter`, `Ignorer`, `INSTRUMENTER_CONSTANTS`, JSON schema `stryker-core.json` |
| `@stryker-mutator/core` | CLI, config, DI (`typed-inject`), sandbox, worker pools, dry run, mutant planner, incremental differ, reporters (clear-text, progress, dots, html, json, dashboard, event-recorder), `stryker serve` |
| `@stryker-mutator/instrumenter` | Parsers (Babel for JS/TS/TSX; angular-html-parser for `.html`/`.vue` script blocks; svelte), 17 mutators, 3 mutant placers, printers |
| `@stryker-mutator/util` | Shared helpers |
| `jest-runner`, `vitest-runner`, `mocha-runner`, `jasmine-runner`, `karma-runner`, `cucumber-runner`, `tap-runner` | Test runner plugins. `command` runner is built into core |
| `typescript-checker` | Only official checker |
| `create-stryker`, `grunt-stryker` | Init and legacy |

### 1.2 Pipeline

Pipeline phases in [`core/src/process/`](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/core/src/process) [src]:

1. **Prepare** (`1-prepare-executor.ts`). Reads config and crawls the project dir. The crawler is its own recursive `readdir` with an ignore-walk clone, not `git ls-files`. Always ignored: `node_modules`, `.git`, `*.tsbuildinfo`, `.next`, `.nuxt`, `.svelte-kit`, the temp dir, and report files ([project-reader.ts L30-38](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/core/src/fs/project-reader.ts#L30-L38)). It then loads the incremental report.
2. **Instrument** (`2-mutant-instrumenter-executor.ts`). Parses and transforms each file **sequentially in the main process**: a plain `for … await parse` loop in [instrumenter.ts](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/instrumenter/src/instrumenter.ts). It runs preprocessors (`// @ts-nocheck` insertion, tsconfig rewriting) and writes the sandbox.
3. **Dry run** (`3-dry-run-executor.ts`). Runs one worker with `coverageAnalysis`. Computes `net` (sum of test times) and `overhead` (gross minus net), which are later used for timeouts.
4. **Mutation test** (`4-mutation-test-executor.ts`). An RxJS pipeline: plan, then early results (ignored or incremental reuse), then checkers (buffered 10 s, grouped), then the NoCoverage short-cut, then the test-runner pool.

### 1.3 Process model [src]

- **Workers are child processes**, `child_process.fork` in [child-process-proxy.ts L76](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/core/src/child-proxy/child-process-proxy.ts#L76). Env gets `STRYKER_MUTATOR_WORKER=<n>` for port or DB isolation ([docs: parallel-workers](https://stryker-mutator.io/docs/stryker-js/parallel-workers/)). Messages are `JSON.stringify` strings over the IPC channel ([string-utils.ts L22](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/core/src/utils/string-utils.ts#L22)). A 2020 profile attributed 14-35% of *core-process* time to serialization in child-process proxies ([#2417](https://github.com/stryker-mutator/stryker-js/issues/2417), [user]).
- **Concurrency default:** `availableParallelism - 1` if >4 cores, else all cores. A percentage string is allowed since 9.6 ([concurrency-token-provider.ts](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/core/src/concurrent/concurrency-token-provider.ts)).
- **Checkers take half the slots.** When `checkers` is set, checkers get `ceil(c/2)` and test runners `floor(c/2)`. Checker tokens pass to test runners only after *all* checking completes (`freeCheckers`).
- **Worker start-up is throttled.** `MAX_CONCURRENT_INIT = 2` in [pool.ts L21](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/core/src/concurrent/pool.ts#L21). One user measured that starting 12 workers took 21 s at 2-at-a-time vs 7 s at 12-at-a-time ([#5782](https://github.com/stryker-mutator/stryker-js/issues/5782), [user]). The maintainer is considering removing it: it was added for webpack-era Angular with ~40 s start-up.
- **Test-runner decorator chain** ([test-runner/index.ts](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/core/src/test-runner/index.ts)): `RetryRejectedDecorator` → `TimeoutDecorator` → `MaxTestRunnerReuseDecorator` → `ReloadEnvironmentDecorator` → child-process proxy.
  - Retry: `MAX_RETRIES = 2`; on a crash the worker is restarted and the run retried; OOM is logged specially.
  - Timeout: on expiry the worker is **killed and restarted**, and the mutant is marked Timeout.
  - `maxTestRunnerReuse` (default 0 = infinite) restarts a worker after *n* mutant runs. It is a memory-leak workaround.
- **Sandbox** ([sandbox.ts](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/core/src/sandbox/sandbox.ts)):
  - One shared sandbox directory for all workers, not one per worker.
  - Every non-ignored project file is written to `.stryker-tmp/sandbox-*`: `copyFile` for untouched files, `writeFile` for instrumented ones.
  - `node_modules` is symlinked (a junction on Windows).
  - `buildCommand` runs once in the sandbox after instrumentation.
  - `inPlace: true` overwrites the user's files with a backup instead.
  - `ignorePatterns` is documented as *the* fix for "slow Stryker startup" when too many or too-large files get copied ([schema](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/api/schema/stryker-core.json)).
  - Because workers share files, tests that write into the project tree can interfere ([docs](https://stryker-mutator.io/docs/stryker-js/parallel-workers/)).
  - Windows + Jest: a hidden `.stryker-tmp` makes Jest find no tests, so every mutant "survives". Workaround: `tempDirName: stryker-tmp` ([troubleshooting](https://stryker-mutator.io/docs/stryker-js/troubleshooting/)).

### 1.4 `stryker serve` [src]

- Since ~9.x, `stryker serve` speaks the Mutation Server Protocol (`mutation-server-protocol ~0.4.0`, JSON-RPC over stdio or a socket; [stryker-server.ts](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/core/src/stryker-server.ts)). The VS Code extension ([blog 2025-11-07](https://github.com/stryker-mutator/stryker-mutator.github.io/blob/master/blog/2025-11-07-vscode-plugin.mdx)) uses it.
- `discover` instruments only.
- `mutationTest` calls `Stryker.run(...)` from scratch per request, with file ranges turned into `--mutate path:L:C-L:C`.
- **Nothing is kept warm across requests**: sandbox, dry run, and workers are all rebuilt.

---

## 2. Instrumenter

### 2.1 Parsing [src]

[create-parser.ts](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/instrumenter/src/parsers/create-parser.ts) chooses the parser by file extension:

| Extensions | Parser |
|---|---|
| `.js .jsx .mjs .cjs` | Babel with the user's babel config plus a broad plugin list (`mutator.plugins` overrides) |
| `.ts .mts .cts` | Babel TS |
| `.tsx` | Babel TSX |
| `.html .htm .vue` | HTML parser that extracts `<script>` blocks and parses them as JS or TS |
| `.svelte` | Svelte parser. Template expressions are parsed as TS when `lang="ts"` (10.0) |

- **Angular HTML templates are not mutated.** Only script content is. Template mutation is an open request ([#5156](https://github.com/stryker-mutator/stryker-js/issues/5156)).
- Stryker 10 moved to **Babel 8** ([#6104](https://github.com/stryker-mutator/stryker-js/issues/6104)).
- TS is **not** transpiled by Stryker: type annotations stay in the output. The sandbox preprocessor inserts `// @ts-nocheck` and strips other `// @ts-*` directives (`disableTypeChecks`, default true) so the instrumented code does not fail the user's type-checking build step.

### 2.2 Mutation switching encoding [src]

Header prepended to any file that received mutants ([syntax-helpers.ts](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/instrumenter/src/util/syntax-helpers.ts)):

```js
function stryNS_9fa48(){ var g = globalThis…; var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__)
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  … stryNS_9fa48 = retrieveNS; return retrieveNS(); }
function stryCov_9fa48(){ // lazily self-replacing
  var cov = ns.mutantCoverage || (ns.mutantCoverage = { static: {}, perTest: {} });
  function cover(){ var c = cov.static; if (ns.currentTestId) c = cov.perTest[ns.currentTestId] ||= {};
    for (…arguments) c[a[i]] = (c[a[i]] || 0) + 1; } … }
function stryMutAct_9fa48(id){ function isActive(id){
    if (ns.activeMutant === id) { if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit)
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')'); return true; }
    return false; } … }
```

- **Global namespace.** The namespace is `globalThis.__stryker__`; the vitest runner can use `__stryker2__`. Keys (`INSTRUMENTER_CONSTANTS`): `activeMutant`, `currentTestId`, `mutantCoverage`, `hitCount`, `hitLimit`. The env var is `__STRYKER_ACTIVE_MUTANT__`.
- **Mutant IDs** are strings: sequential numbers across the whole run.
- **Coverage is counted as hits, not booleans.** Every evaluation of instrumented code calls `stryCov_9fa48(ids…)` and increments a hash map entry per id. This includes mutant runs, where it writes to `cov.static` whenever `currentTestId` is unset. There is no fast path that disables counting after the dry run: the instrumented code is identical in both phases.

### 2.3 Mutant placers [src]

The traversal ([babel-transformer.ts](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/instrumenter/src/transformers/babel-transformer.ts)) runs in two directions:

- **Going down:**
  - Skip type nodes (`TSInterfaceDeclaration`, `TSTypeAlias`, `TSEnumDeclaration`, `TSAsExpression`, `declare …`, Flow decls), import declarations, and decorators.
  - Register every node that some placer `canPlace`.
  - Run all mutators on the node.
  - Register each mutant at the **nearest ancestor-or-self placement node**, together with a full clone of that node with the mutation applied (`mutant.applied(placementNode)`).
- **Going up (exit):** place all mutants collected for the node, then `path.skip()`.

Placers are tried in order ([mutant-placers/index.ts](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/instrumenter/src/mutant-placers/index.ts)):

1. **expressionMutantPlacer.** Produces `stryMutAct("3") ? m3 : stryMutAct("2") ? m2 : (stryCov("2","3"), original)`.
   - Refuses: object-property keys; interior nodes of member/call/non-null chains (`a.b.c()` is placed at the top of the chain); tagged-template tags; `delete` operands; assignment LHS.
   - Keeps `Function.name`: `const a = function(){}` becomes `function a(){}`, and a named arrow becomes `(() => { const a = () => {}; return a; })()`.
2. **statementMutantPlacer.** Produces `if (stryMutAct("1")) { mutated } else { stryCov("1"); original… }`. A block is re-wrapped in a block, so `let`/`const` scoping is preserved.
3. **switchCaseMutantPlacer.** Wraps a `case` consequent in `if (stryMutAct(id)) {…} else { stryCov(id); …original; break; }`.

Consequences:

- **Nesting multiplies code size.** An expression containing k mutants in its subtree is cloned k+1 times, and the clones nest inside outer placements. Instrumented files are markedly bigger than the source (no published number).
- **Semantic hazards** are handled case by case, not in general:
  - class constructors with `super()` plus parameter properties are not emptied (#2314, #2474);
  - `Symbol('x')`, `require('x')`, dynamic `import()`, and import/export strings are not mutated;
  - Angular signal `input()/model()/output()` option objects and signal-query options are ignored by the `angular` ignorer (they must stay statically analyzable).
- **Placement errors throw.** An unplaceable mutant is a fatal error with a bug-report URL ([throw-placement-error.ts](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/instrumenter/src/mutant-placers/throw-placement-error.ts)).

### 2.4 Mutant filters (new in 10.0) [src]

- A `NodeMutator` may declare `filter(mutantsInScope)`. On exit, if the filter returns false, that mutator's mutants on that node are removed ([#6010](https://github.com/stryker-mutator/stryker-js/issues/6010)).
- The only user today is the new **CallExpression** mutator. It drops a call only if **no other mutant exists in its subtree** (`mutantsInScope.length === 1`), which cuts redundant mutants.

### 2.5 Static mutants [src + docs]

- **Definition.** A mutant is *static* if the dry run saw it in `mutantCoverage.static` (hit with no `currentTestId`), i.e. at module load or in hooks outside a test. A "hybrid" mutant has both static and per-test hits. See [docs: static mutants](https://stryker-mutator.io/docs/mutation-testing-elements/static-mutants/).
- **Planning** ([mutant-test-planner.ts L100-136](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/core/src/mutants/mutant-test-planner.ts#L100-L136)):
  - non-static: run `coveredBy` tests, runtime activation, no reload;
  - static (or hybrid without `ignoreStatic`): run **all tests** (or the `--testFiles` filter), static activation, `reloadEnvironment: true`;
  - static with `ignoreStatic`: `Ignored` (not counted in the score). Hybrid with `ignoreStatic` runs only its per-test coverage.
- **Cost.** Each static mutant needs a fresh module graph. For hot-reload runners (mocha, jasmine, cucumber), that means **killing and re-forking the worker**, then a second restart for the next runtime mutant, because the worker is "contaminated" ([#3462](https://github.com/stryker-mutator/stryker-js/issues/3462)). Mitigation: plans are sorted so `reloadEnvironment` runs go last. The sort buffer is 0 ms, so it only sorts within one synchronous batch.
- **Measured cost:**
  - Sorting static mutants last saved 12% on Stryker core: 4m07s → 3m37s ([#3462](https://github.com/stryker-mutator/stryker-js/issues/3462), [docs/blog]).
  - Ignoring 6% of mutants (the static ones) gave a "50% performance improvement" on Stryker core ([blog v6](https://github.com/stryker-mutator/stryker-mutator.github.io/blob/master/blog/2022-05-04-announcing-stryker-6-expeditious-superior-mutations.mdx)).
  - The blog's example warning: "Detected 255 static mutants (8% of total) that are estimated to take 83% of the time".
  - A Jest user: "Detected 33 static mutants (2% of total) … 45% of the time" ([#4458](https://github.com/stryker-mutator/stryker-js/issues/4458), [user]).
- **Warning rule.** Stryker warns when static mutants take ≥40% of estimated time *and* average ≥2x a runtime mutant ([L263-L313](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/core/src/mutants/mutant-test-planner.ts#L263)).
- **Incremental mode** never re-runs a Survived static mutant when tests change, since it has no per-test coverage ([docs](https://stryker-mutator.io/docs/stryker-js/incremental/); open request [#6119](https://github.com/stryker-mutator/stryker-js/issues/6119)).

---

## 3. Mutator catalog (10.0) [src]

There are **no mutation levels** in StrykerJS. Levels are a Stryker.NET feature. The only "level" is weapon-regex (now v2), which generates Level-1 regex mutations ([regex-mutator.ts L31](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/instrumenter/src/mutators/regex-mutator.ts#L31)). The mutator set is fixed: `mutator.excludedMutations: string[]` removes whole mutators by name.

| Name (config key) | What it produces (source-verified) |
|---|---|
| ArithmeticOperator | `+`↔`-`, `*`↔`/`, `%`→`*`. Skipped when either operand is a string or template literal |
| ArrayDeclaration | `[a,b]`→`[]`, `[]`→`["Stryker was here"]`; `new Array(x)`/`Array(x)`→no args, `Array()`→`Array([])` |
| ArrowFunction | `() => expr` → `() => undefined` (expression bodies only) |
| AssignmentOperator | `+=`↔`-=`, `*=`↔`/=`, `%=`→`*=`, `<<=`↔`>>=`, `&=`↔`\|=`, `&&=`↔`\|\|=`, `??=`→`&&=`. Arithmetic ones are skipped for string RHS |
| BlockStatement | non-empty `{…}` → `{}` (except unsafe constructors) |
| BooleanLiteral | `true`↔`false`; `!x`→`x` |
| CallExpression (**new 10.0**, file `empty-expression-mutator.ts`, [#6012](https://github.com/stryker-mutator/stryker-js/issues/6012)) | call used as a value → `void 0`; call statement → `;`; `throw new X()` → `;`. Not for `super()`. Only if no other mutant is in the subtree |
| ConditionalExpression | loop tests → `false`; `if`/ternary tests → `true` and `false`; boolean sub-expression of `\|\|` → `false`, of `&&` → `true`, else both; `for(;;)` → `for(;false;)`; non-empty `case` → empty consequent |
| EqualityOperator | `<`→`<=`,`>=`; `<=`→`<`,`>`; `>`→`>=`,`<=`; `>=`→`>`,`<`; `==`↔`!=`; `===`↔`!==` |
| LogicalOperator | `&&`↔`\|\|`, `??`→`&&` |
| MethodExpression | removes `charAt, filter, reverse, slice, sort, substr, substring, trim` (`x.trim()`→`x`); swaps `endsWith`↔`startsWith`, `every`↔`some`, `toLowerCase`↔`toUpperCase`, `toLocale*`, `trimEnd`↔`trimStart`, `min`↔`max`, and date setters (`setDate`→`setTime`, `setHours`↔`setMinutes`, …) |
| ObjectLiteral | non-empty `{…}` → `{}` |
| OptionalChaining | `a?.b`→`a.b`, `a?.()`→`a()` (keeps optionality further down the chain) |
| Regex | weapon-regex L1 on regex literals and `new RegExp('…')` |
| StringLiteral | non-empty → `""`, empty → `"Stryker was here!"`, template literal → empty or `Stryker was here!`. Skips imports/exports, JSX attributes, directive-like expression statements, TS literal types, object/class keys, `require()`, `Symbol()`, `import()` |
| UnaryOperator | prefix `+`↔`-`, `~x`→`x` |
| UpdateOperator | `++`↔`--` (prefix and postfix) |

### 3.1 Ignoring mutants [src + docs]

- **Comments.** `// Stryker [disable|restore] [next-line] <all|Mutator,Mutator>[: reason]` ([docs: disable-mutants](https://stryker-mutator.io/docs/stryker-js/disable-mutants/)). Ignored mutants are reported as `Ignored` with the reason. They are filtered out before placement (`collectMutants` drops mutants with an `ignoreReason`), so they add no runtime cost.
- **Ignorer plugins** (since 7.3). `ignorers: ["angular", "<custom>"]`. `Ignorer.shouldIgnore(path) → reason | undefined` is consulted per AST node on the way down, and the ignore applies to the whole subtree ([ignorer-bookkeeper.ts](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/instrumenter/src/transformers/ignorer-bookkeeper.ts)).
- **Line or range scoping.** `--mutate "src/a.ts:5-10"`, or `src/a.ts:5:4-6:4` with inclusive columns ([project-reader.ts L41-49](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/core/src/fs/project-reader.ts#L41-L49)). Out-of-range nodes are `skip()`ped during traversal, so they produce no mutants. **The whole file is still parsed, printed and copied, and the dry run is unchanged.**

---

## 4. Coverage analysis

### 4.1 Modes [docs + src]

`coverageAnalysis` defaults to `perTest`; before v5 the default was `off` ([configuration](https://stryker-mutator.io/docs/stryker-js/configuration/#coverageanalysis-string)).

| Mode | Behavior |
|---|---|
| `off` | Every mutant runs all tests. No NoCoverage status |
| `all` | Mutants never hit get NoCoverage; the rest run all tests |
| `perTest` | Each mutant runs only the tests that hit it; static mutants run all tests |

- **Published speed-ups:**
  - Stryker core at 4.0-beta: `all` 27m20s vs `perTest` 5m55s, a 4.6x difference ([#2417](https://github.com/stryker-mutator/stryker-js/issues/2417) comment by nicojs, 2020-09-03).
  - The v4 blog quotes perTest as "usually between 40% and 60%" faster.
- **Planned removal.** The maintainers plan to deprecate the option and always use perTest ([#5696](https://github.com/stryker-mutator/stryker-js/issues/5696), open).
- **Vitest ignores the setting** and always uses perTest ([docs](https://stryker-mutator.io/docs/stryker-js/vitest-runner/)).
- **Command runner** reports nothing, so effectively `off`.
- **The perTest contract.** Tests must be "able to run independently of each other and in random order". A killing test whose execution depends on state primed by an earlier test can be missed, which gives a false Survived.

### 4.2 Per-runner implementation of `currentTestId` [src]

| Runner | How per-test coverage is attributed | Test filter per mutant | Bail |
|---|---|---|---|
| Jest | Stryker **mixes into the Jest environment class**: sets `currentTestId` on circus `test_start`, clears on `test_done`. Custom `@jest-environment` docblocks must be rewritten to `@stryker-mutator/jest-runner/jest-env/{node,jsdom,jsdom-sixteen}` or wrapped with `mixinJestEnvironment` ([docs](https://stryker-mutator.io/docs/stryker-js/jest-runner/)). Only circus or jasmine2 | `testNamePattern` = regex OR of full test names, plus `--findRelatedTests <sandbox file>` (default on) | **None**: `bail: false` is forced ([jest-override-options.ts](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/jest-runner/src/jest-override-options.ts)). All killers are collected |
| Vitest | Setup file `stryker-setup-<worker>.js` is prepended to every project's `setupFiles`. `beforeEach(({task}) => ns.currentTestId = file#fullName)`. Coverage is shipped back via `suite.meta` in `afterAll` ([stryker-setup.ts](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/vitest-runner/src/stryker-setup.ts)) | `testNamePattern` regex plus the list of test files; `related` = the mutated sandbox file (default on) | vitest `bail: 1` unless `disableBail` |
| Mocha | Root `beforeEach` hook sets `currentTestId = fullTitle()` | `mocha.grep(^(id1)$\|…)` | `suite.bail(true)` recursively |
| Jasmine / Karma | Reporter hooks; karma uses `failFast`/`stopOnSpecFailure`/`oneFailurePerSpec` | spec filter | yes |
| Cucumber | per scenario | scenario filter | yes |
| Tap | per test **file**: spawns `node` per tap file ([tap-test-runner.ts L215](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/tap-runner/src/tap-test-runner.ts#L215)) | file list | optional `tap.forceBail` |
| Command | none | none | n/a |

- **Test order.** `testsByMutantId` is a `Set` filled in dry-run coverage order ([test-coverage.ts](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/core/src/mutants/test-coverage.ts)). There is **no reordering by test duration or by previous kill**. Even in incremental mode, the old killer is used only to decide *reuse*, never to order a rerun.
- **Hit limit (infinite-loop detection):**
  - `hitLimit = 100 × (total dry-run hits of that mutant)` ([L37](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/core/src/mutants/mutant-test-planner.ts#L37)).
  - `stryMutAct` throws once `hitCount > hitLimit`, and the runner reports Timeout via `determineHitLimitReached`.
  - It only catches loops that re-evaluate the mutant switch, and only for mutants with dry-run hits.
- **Timeout per mutant run** ([L184](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/core/src/mutants/mutant-test-planner.ts#L184)): `timeoutFactor (1.5) × netTime(covering tests) + timeoutMS (5000) + overheadMS(dry run)`. `overheadMS` is the dry run's gross minus net *for the whole suite*.
  - For Jest this is large: one user saw net 3,131 ms vs overhead 41,827 ms for 993 tests ([#4458](https://github.com/stryker-mutator/stryker-js/issues/4458), [user]). Every genuinely infinite mutant can therefore burn ~45 s before being killed.
  - A timeout kills and re-forks the worker, which pays full start-up again.
- **Known limits:**
  - hooks outside tests (`beforeAll`, module top level) count as static coverage;
  - Jest per-file environment overrides need manual changes;
  - Vitest browser mode is unsupported and `threads` is the only supported pool ([docs](https://stryker-mutator.io/docs/stryker-js/vitest-runner/));
  - Vitest `related` only follows imports, so tests that reach code over HTTP find nothing. Same for Jest `findRelatedTests` ([troubleshooting](https://stryker-mutator.io/docs/stryker-js/troubleshooting/)).

---

## 5. Test runners and their per-mutant cost

`capabilities().reloadEnvironment` tells core whether the runner can reset module state itself. If it cannot (mocha, jasmine, cucumber), core **re-forks the worker** for static mutants ([reload-environment-decorator.ts](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/core/src/test-runner/reload-environment-decorator.ts)).

| Runner | `reloadEnvironment` | What one mutant run costs [src] |
|---|---|---|
| **mocha** | false (hot reload) | `loadFilesAsync()` **once** per worker; then set `activeMutant`, `grep`, `mocha.run()`. Cheapest path. v6 blog: "a whopping 70% performance improvement" on Stryker core ([blog](https://github.com/stryker-mutator/stryker-mutator.github.io/blob/master/blog/2022-05-04-announcing-stryker-6-expeditious-superior-mutations.mdx)) |
| **jasmine** | false (hot reload) | as mocha |
| **cucumber** | false | as mocha |
| **jest** | true | Full `runCLI({ runInBand: true, findRelatedTests, testNamePattern, config: JSON.stringify(cfg) })` per mutant ([jest-test-adapter.ts L27-L42](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/jest-runner/src/jest-test-adapters/jest-test-adapter.ts#L27-L42)). Jest builds contexts, resolves related tests through the haste map, and gives every test file a fresh module registry, so it **re-imports and re-transforms** (transform cache helps) the module graph each run. The activation env var is set in `process.env`. Hot reload for Jest was requested and closed; it needs a Jest API that does not exist ([#3455](https://github.com/stryker-mutator/stryker-js/issues/3455)). nicojs: "Stryker is slow because jest is slow… We're also currently using the runCLI api… a high-level jest API" ([#3320](https://github.com/stryker-mutator/stryker-js/issues/3320)) |
| **vitest** (≥2.0; `maxWorkers:1` pool on ≥4.1) | true | One `createVitest()` per worker, **reused**. Per mutant: `provide()` mode, mutant and hitLimit; clear `state.filesMap`; set `related` and `testNamePattern`; `await ctx.start(testFiles)` ([vitest-test-runner.ts L220-L250](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/vitest-runner/src/vitest-test-runner.ts#L220-L250)). Vite's transform cache is warm, but test files and their imports are **re-executed in the worker every run** (isolation). `mutantRun` never reads `options.reloadEnvironment`: the "reload" is implicit in re-import ([#6209](https://github.com/stryker-mutator/stryker-js/issues/6209)). Runtime activation happens in a `beforeAll` in the setup file; static activation assigns at setup-file top level (before imports). Reported: 2,637 mutants / 373 tests ≈ 7 min on Vitest 4.1 ([#6210](https://github.com/stryker-mutator/stryker-js/issues/6210), [user]) |
| **karma** | true | Browser round-trip per mutant; page reload for static. Users: 2.5 h for 2.5k mutants on 100 files, concurrency 4, Angular 14 ([#5152](https://github.com/stryker-mutator/stryker-js/issues/5152)); "Slow with Karma & Jasmine in Angular" ([#5462](https://github.com/stryker-mutator/stryker-js/issues/5462)) |
| **tap** | true | Spawns `node <file>` per test file per mutant (the recommended runner for `node:test`, [#5108](https://github.com/stryker-mutator/stryker-js/issues/5108)) |
| **command** (default!) | true | `exec(command)` per mutant with `__STRYKER_ACTIVE_MUTANT__` in env ([command-test-runner.ts](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/core/src/test-runner/command-test-runner.ts)). No coverage, no filter, no bail. This is the documented default `testRunner` |

- **Bun and Deno:** no official runner.
  - Bun: [#4439](https://github.com/stryker-mutator/stryker-js/issues/4439) and [#5424](https://github.com/stryker-mutator/stryker-js/issues/5424) are open. The community plugin `stryker-mutator-bun-runner` lacks perTest filtering, per a user comment. `bun --bun` running Stryker plus the vitest runner needs a Bun fix (oven-sh/bun#41395) ([user]).
  - Deno: no plugin found.
- **`node:test`:** use tap-runner or command.
- **`testFiles`** (9.5): restricts which test files run. It produces the global filter that triggers the static-mutant bug in §10.

---

## 6. TypeScript checker

[typescript-checker.ts](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/typescript-checker/src/typescript-checker.ts), [docs](https://stryker-mutator.io/docs/stryker-js/typescript-checker/). All [src] unless marked.

- **Setup.** Each checker **worker process** builds a full `ts.createSolutionBuilderWithWatch` over an in-memory `HybridFileSystem`, so project references (`--build`) are supported. `init()` fails if the unmutated project has type errors. It forces `allowUnreachableCode: true`, `noUnusedLocals: false`, and `noUnusedParameters: false`.
- **Per check.**
  - Reset the previous mutant's file.
  - Text-splice `mutant.replacement` into the **original** source at `mutant.location`. This is not the instrumented file.
  - Fire the fake watcher.
  - Collect semantic diagnostics from the incremental rebuild.
- **Grouping** (`prioritizePerformanceOverAccuracy`, default true, since 6.4; [create-groups.ts](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/typescript-checker/src/grouping/create-groups.ts)):
  - Mutants in files whose importer-closures do not overlap are checked together in one rebuild.
  - An error is attributed via the file graph. If it maps to more than one mutant, those mutants are re-checked one by one.
  - Mutants are buffered **10 s** (`CHECK_BUFFER_MS`) before grouping.
  - With the option set to `false`, every mutant is its own group.
- **Cost** [docs/blog]:
  - Before grouping: "up to a 10x performance degradation"; "Running StrykerJS on itself took 10x longer".
  - Grouping: "performance increased by 43% while still being 99.1% accurate" on Stryker core ([blog 2023-02-17](https://github.com/stryker-mutator/stryker-mutator.github.io/blob/master/blog/2023-02-17-announcing-faster-typescript-checker.mdx)). Some CompileError mutants then slip through as Survived or Killed.
- **Memory.** Every checker process holds a full TS program: memory is roughly program size × checkers.
- **Throughput coupling.** Checkers take ⌈c/2⌉ of the worker slots until all checking finishes (§1.3). A user saw 8 minutes before the dry run while 5 checker workers started, 2 at a time ([#4458](https://github.com/stryker-mutator/stryker-js/issues/4458), [user]).
- **TS 7 / tsgo.** `typescriptChecker.experimentalNativePreview` (10.0, [#6099](https://github.com/stryker-mutator/stryker-js/issues/6099)) uses `@typescript/native/unstable/sync`. Grouping is **not** supported yet ([#6112](https://github.com/stryker-mutator/stryker-js/issues/6112), [#6110](https://github.com/stryker-mutator/stryker-js/issues/6110)).
- **Hazard.** The checker checks the *mutant in isolation*. Type errors that only appear through schemata never matter, because the runtime file is `@ts-nocheck`. Runtime-only failures surface as RuntimeError.

---

## 7. Incremental mode and diff scoping

[docs: incremental](https://stryker-mutator.io/docs/stryker-js/incremental/), [incremental-differ.ts](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/core/src/mutants/incremental-differ.ts). All [src] unless marked.

- **Mechanics.**
  - `--incremental` reads and writes `reports/stryker-incremental.json`, a full mutation-testing-elements report including `testFiles`.
  - Mutant identity is `relativeFile@startLine:col-endLine:col\nMutator: replacement`.
  - Test identity is `testFile@line:col\nname`.
  - Old locations are remapped to new code with **google diff-match-patch** per file.
- **Reuse rules** (`mutantCanBeReused`):
  - no coverage data at all (e.g. the command runner): reuse **everything**;
  - old status `Ignored`: rerun;
  - `Killed`: reuse if **any** old killing test is unchanged;
  - otherwise: reuse unless a **new** test now covers it.
  - Only mutants whose own code range changed get re-run. Changing callee file B does not invalidate a Survived mutant in A unless a covering test changed or was added.
- **Limits** (docs):
  - Changes outside mutated and test files are invisible: helpers not in `mutate`, dependencies, snapshots, env.
  - Test-change detection quality depends on the runner. Full for Jest, Vitest and Cucumber; file-level for Mocha and Tap; names-only for Jasmine and Karma; nothing for Command.
  - Static mutants never re-run due to test changes.
  - **The dry run is always repeated in full**: "The dry run remains required".
- **Reported effect** (docs example): "3731 of 3965 mutant result(s)" reused, 234 run.
- **Interrupted runs.** Since 10.0 a partial report is saved on Ctrl-C or unexpected exit ([#5986](https://github.com/stryker-mutator/stryker-js/issues/5986)).
- **Churn bug.** Vitest test IDs are nondeterministic, causing ~15k-line diffs of the incremental JSON per run with no code change ([#6004](https://github.com/stryker-mutator/stryker-js/issues/6004), open).
- **`--force`** reruns everything in scope. Combined with `--mutate file:5-7` it updates just those lines in the incremental file.
- **Git diff.** None built in. There is no `--since` in the 10.0 schema; `--since` belongs to Stryker.NET. Community approaches:
  - `stryker-diff-runner` (npm) passes changed *files* to `--mutate`;
  - `stryker-git-checker` ([#2843](https://github.com/stryker-mutator/stryker-js/issues/2843)) abuses the checker API;
  - many repos parse `git diff -U0` hunks into `--mutate "f:a-b,…"` (e.g. [lisa#3896](https://github.com/CodySwannGT/lisa/pull/3896), [copad#372](https://github.com/adriendellagaspera/copad/pull/372)).
  - All of these still pay the full sandbox copy, full instrumentation of touched files, worker start-up and **the full dry run**.

---

## 8. Reporters and metrics

- **Report schema** (mutation-testing-elements 3.9.0, `$id http://stryker-mutator.io/report.schema.json`) [src]:
  - Required top level: `schemaVersion` (pattern `^[12](\.\d+){0,2}$`, Stryker writes `"2"`), `thresholds {high, low}`, `files`.
  - Optional top level: `config`, `testFiles`, `projectRoot`, `performance {setup, initialRun, mutation}` (ms), `framework {name, version, branding, dependencies}`, `system {ci, os, cpu, ram}`.
  - `files[path]`: `{language, source, mutants[]}`.
  - Mutant required fields: `id, mutatorName, location {start{line,column}, end}, status`. Optional: `replacement, description, statusReason, static, coveredBy[], killedBy[], testsCompleted, duration`.
  - `testFiles[path]`: `{source?, tests[{id, name, location?}]}`.
  - Status enum: `Killed | Survived | NoCoverage | CompileError | RuntimeError | Timeout | Ignored | Pending`.
- **Unfilled fields.** StrykerJS core does **not** fill `performance` or per-mutant `duration` ([#5635](https://github.com/stryker-mutator/stryker-js/issues/5635), [#6135](https://github.com/stryker-mutator/stryker-js/issues/6135), both open).
- **Metrics** ([calculateMetrics.ts](https://github.com/stryker-mutator/mutation-testing-elements/blob/master/packages/metrics/src/calculateMetrics.ts), [docs](https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/)):

  | Metric | Formula |
  |---|---|
  | detected | killed + timeout |
  | undetected | survived + noCoverage |
  | covered | detected + survived |
  | valid | detected + undetected |
  | invalid | runtimeErrors + compileErrors |
  | total | valid + invalid + ignored + pending |
  | mutationScore | detected / valid × 100 |
  | mutationScoreBasedOnCoveredCode | detected / covered × 100 |

  **Timeout counts as detected. CompileError, RuntimeError and Ignored are excluded from both denominators.**
- **Status mapping in core** [src]:
  - runner `Error` → `RuntimeError` (e.g. a mutant makes module load throw outside a test);
  - `Killed` carries `killedBy` (all failed tests) and `testsCompleted`;
  - checker failure → `CompileError`;
  - empty test filter → `NoCoverage`.
- **Reporters:** `clear-text`, `progress`, `progress-append-only`, `dots`, `html` (single-file mutation-testing-elements app), `json`, `dashboard` (stryker-mutator.io upload), `event-recorder`. Defaults: `["clear-text","progress","html"]`.
- **Thresholds:** `high`, `low`, and `break`; `break` sets exit code 1.

---

## 9. Performance: measured and reported numbers

| Source | Setup | Numbers |
|---|---|---|
| [#2417](https://github.com/stryker-mutator/stryker-js/issues/2417) [user/maint] | express (1,824 source lines, 11 files, 1,148 tests, mocha 2.6 s) | Stryker 3.3.1: 8m15s; 4.0-beta (schemata): 4m15-4m17s on 16-thread machines; concurrency 1: 33m43s. Timeouts ranged 18-492 between runs of the same code, because the machine was overloaded |
| [#2417](https://github.com/stryker-mutator/stryker-js/issues/2417) (maint) | Stryker core, 4.0-beta | `all` 27m20s vs `perTest` 5m55s |
| v4 blog [docs] | schemata vs per-mutant copy | "somewhere between 20% to 70% speed increase" |
| v6 blog [docs] | hot reload (mocha) on Stryker core | "70% performance improvement"; ignoreStatic (6% of mutants) → "50%" |
| [#3462](https://github.com/stryker-mutator/stryker-js/issues/3462) [maint] | sort static last | 4m07s → 3m37s (−12%) |
| TS checker blog [docs] | Stryker core | old checker ≈10x slower; grouping +43%, 99.1% accurate |
| [#3320](https://github.com/stryker-mutator/stryker-js/issues/3320) [user] | CRA + Jest, 942 tests / 73 s, 5,204 mutants | perTest: 150 mutants in 35 min, ETA ~20 h |
| [#4000](https://github.com/stryker-mutator/stryker-js/issues/4000) [user] | Jest, 2,608 files, ~94k mutants, suite 30 min | dry run ~1 h; ETA **800 h**; OOM or crash after 2-3 h |
| [#4458](https://github.com/stryker-mutator/stryker-js/issues/4458) [user] | Jest, 993 tests, 2,710 mutants | dry run net 3.1 s / overhead 41.8 s; 8 min before dry run (checker start-up) |
| [#5152](https://github.com/stryker-mutator/stryker-js/issues/5152) [user] | Karma, Angular 14 | 2.5k mutants, 100 files, 4 cores: 2.5 h |
| [#5782](https://github.com/stryker-mutator/stryker-js/issues/5782) [user] | 4,210 files, 8,748 mutants, ~3,940 tests, 12 cores | 21 s just to start workers (7 s patched) |
| [#6210](https://github.com/stryker-mutator/stryker-js/issues/6210) [user] | Vitest 4.1, 2,637 mutants, 373 tests | ≈7 min |
| LLMorpheus paper (Tip et al., [arXiv 2404.09952](https://arxiv.org/html/2404.09952), Table 1) [user] | 13 small npm packages | e.g. `q`: 2,111 LOC, 1,058 mutants, **7,075 s**; `delta`: 834 mutants, 2,747 s; `plural`: 180 mutants, 54 s; `spacl-core`: 259 mutants, 1,053 s |
| [#4414](https://github.com/stryker-mutator/stryker-js/issues/4414) [user] | "PIT ≤30 min vs Stryker many hours" | command runner + coverage off; maintainer blames the config |

- **No neutral head-to-head benchmark exists** (StrykerJS vs another JS mutation tool, or vs PIT on comparable code).
- **The perf suite is small and disabled.** `perf/` holds express, lighthouse and angular-cli submodules. Performance tests were **disabled in CI** in June 2026 as flaky ([#6046](https://github.com/stryker-mutator/stryker-js/issues/6046), [#6045](https://github.com/stryker-mutator/stryker-js/issues/6045)).
- **There is no per-phase timing output** ([#6135](https://github.com/stryker-mutator/stryker-js/issues/6135)).

**Official speed advice** (docs: incremental, configuration, parallel-workers):

- use a real runner plugin with `perTest`, not `command`;
- enable `--incremental`;
- narrow `--mutate` (including line ranges);
- `--ignoreStatic`;
- `ignorePatterns` for slow sandbox creation;
- disable the TS checker or keep the default `prioritizePerformanceOverAccuracy: true`;
- tune `concurrency`; the Angular init template suggests half the cores.

There is no dedicated "performance" docs page as of 2026-09; the advice is scattered across those pages.

---

## 10. Correctness caveats relevant to using StrykerJS as an oracle

| Caveat | Mechanism | Status |
|---|---|---|
| **False Survived: static mutants + `testFiles`** | Planner sets `mutantActivation: testFilter ? 'runtime' : 'static'` ([L211](https://github.com/stryker-mutator/stryker-js/blob/f2a49ff02437e3b7fe2682dba808ac93039895bf/packages/core/src/mutants/mutant-test-planner.ts#L211)) although `canHotSwap` accounts for `isStatic`. With a global test filter, static mutants get runtime activation (vitest `beforeAll`), which comes after import, so they are never active | Open, 9.6.1 and 10.0.0 ([#6144](https://github.com/stryker-mutator/stryker-js/issues/6144), [#6209](https://github.com/stryker-mutator/stryker-js/issues/6209)). Verified in source. (Note: #6209's claim that "core never sets `__STRYKER_ACTIVE_MUTANT__`" is wrong. The command runner in core and the jest runner both set it) |
| **False Survived: Vitest 5** | Vitest 5 matches `testNamePattern` against `suite > test`; Stryker joins names with spaces, so 0 tests run. Scores collapse (e.g. 47.36 → 2.96; 92.31 → 0.00) | Open ([#6210](https://github.com/stryker-mutator/stryker-js/issues/6210)); a comment reports static mutants also affected |
| **Nondeterministic scores** | CPU starvation turns mutants into false Timeouts. Vitest runner reuse with concurrency ≥2 flips Killed/Survived (killed 6 vs 13 in the e2e snapshot). Angular/Karma scores vary run to run | Open ([#5284](https://github.com/stryker-mutator/stryker-js/issues/5284), [#4878](https://github.com/stryker-mutator/stryker-js/issues/4878)); express timeouts 18-492 ([#2417](https://github.com/stryker-mutator/stryker-js/issues/2417)) |
| **Hot-reload state leakage** | Mocha, Jasmine and Cucumber keep module state across mutants. A mutant that mutates a module-level cache, singleton or memo (at runtime) can leak into later mutant runs in the same worker. Only *static* mutants trigger a reload | By design ([#3462](https://github.com/stryker-mutator/stryker-js/issues/3462) discusses the static case) |
| **perTest independence assumption** | A mutant covered only via state set up by an earlier test, or in `beforeAll` (counted static), is attributed wrongly: either extra full-suite runs (slow) or a missing killer (false Survived) | Documented requirement |
| **`findRelatedTests` / `vitest.related`** | Import-graph-based. Tests that exercise code over HTTP, dynamic imports or aliases (module-alias) find nothing, so "all mutants survive" | Troubleshooting docs |
| **Jest on Windows hidden dir** | `.stryker-tmp` is hidden, so no tests are found and everything survives | Troubleshooting docs |
| **Hit limit vs genuine hot loops** | `hitLimit = 100 × dry-run hits`. Property-based tests that shrink counterexamples may exceed it and be reported as Timeout, which counts as *detected* | Factor chosen high for this reason (comment in source) |
| **Timeout = detected** | Infinite-loop mutants are killed at `1.5×net + 5000 + overhead`. Under load, slow-but-correct runs become Timeout and inflate the score | Metric definition |
| **Memory runaway** | No per-worker memory cap. `--max-old-space-size` does not bound non-V8 memory. One mutant took a CI box from 2 GB to 60 GB in ~10 s | Open ([#6147](https://github.com/stryker-mutator/stryker-js/issues/6147)) |
| **TS checker grouping** | ~0.9% of CompileError mutants misclassified in performance mode | Documented trade-off |
| **Incremental staleness** | Callee changes, dependency upgrades and snapshot edits do not invalidate reused Survived or Killed results | Documented limitation |
| **RuntimeError excluded from score** | Mutants that crash module load are neither detected nor valid | Metric definition |

**Using it as an oracle for tzap:** pin Vitest < 5 or use Jest or Mocha, avoid `testFiles`, run with low concurrency, and diff per-mutant verdicts keyed by `(file, mutatorName, location, replacement)` (Stryker's own incremental key). Treat Timeout and static-mutant disagreements as soft.

---

## 11. Implications for tzap

### 11.1 Where StrykerJS's time goes (ranked, for a typical Jest or Vitest TS project)

1. **Per-mutant test-framework invocation overhead.**
   - Jest: `runCLI` per mutant, fresh module registry per test file, re-import of the whole graph, no bail. Dry-run overhead reached 13x net test time in a reported case (41.8 s vs 3.1 s).
   - Vitest: `ctx.start()` per mutant, with re-execution of test files and their imports in the worker.
   - Only mocha, jasmine and cucumber avoid this (hot reload).
2. **Static mutants.** Full suite and a full environment reload (a process re-fork for hot-reload runners), plus a second re-fork afterwards. Reports: 2-8% of mutants taking 45-83% of time.
3. **Running all covering tests in dry-run order.** No fastest-first, no last-killer-first, and no bail in Jest. Survived mutants inherently pay for all covering tests; killed ones pay for tests before the killer.
4. **Timeouts.** Each costs `1.5×net + 5 s + suite overhead` plus a worker re-fork. Load-induced false timeouts make it worse.
5. **Fixed start-up per invocation:** full project crawl and copy, sequential Babel instrument and print, 2-at-a-time worker forks, full dry run (even in incremental and range modes), and checker program builds.
6. **TS checker.** Half the workers are diverted until all checks finish, and each has its own full program.
7. **Instrumentation runtime tax.** `stryCov` and `stryMutAct` calls on every evaluation, in every run, including the killing runs. Cloned subtrees enlarge the code.

### 11.2 Levers StrykerJS leaves unused (tzap opportunities, mirrors jzap)

| Lever | StrykerJS today | tzap idea |
|---|---|---|
| **Line-level git-diff scoping** | none (manual `--mutate f:a-b`), full dry run anyway | native `--diff <base>`: map hunks to mutants, **and restrict the dry run to tests whose coverage hits changed files** (cached test→file map) |
| **Kill-test-first ordering** | dry-run order; incremental only reuses | order each mutant's tests by (last killer, then historical kill rate, then duration); early exit on first failure *in every runner, including Jest* |
| **Early exit** | bail per runner; Jest none | tzap-controlled per-test loop, so bail is uniform |
| **Warm daemon** | `stryker serve` re-runs everything cold | persistent daemon holding a transformed module cache, test-file ASTs, per-test coverage map and forked workers; incremental re-instrument per saved file |
| **Incremental cache granularity** | per-mutant reuse; ignores callee changes; always re-dry-runs | content-hash each file plus a per-test file-dependency set; invalidate a mutant when *any* file in its covering tests' dependency closure changed; skip the dry run when nothing covering changed |
| **Static mutants** | full suite plus process re-fork, or ignore | per-test-file module isolation *inside* one warm worker (e.g. `vm.SourceTextModule` / loader-hook-based module registry reset, or vitest-style isolate) so reload ≈ re-evaluate only the affected module subgraph; run only test files that import the module (import graph from the dry run), not the full suite |
| **Runner integration** | wraps high-level runners (`runCLI`, `ctx.start`) | own minimal in-process runner harness (or a thin adapter on vitest's `VitestRunner` / jest-circus internals) so a mutant run = set id, run N test functions, no re-discovery, no config re-parse |
| **Coverage probes** | hit-counting hash increment on every evaluation, always on | boolean probe arrays (typed array index per mutant) and a probe-free "fast" instrumented variant for mutant runs, or disable counting after the dry run |
| **Timeouts** | whole-suite overhead folded into each mutant's budget | per-test timing budgets (`k × that test's dry-run time`), CPU-time based, not wall-clock, to avoid load-induced false Timeouts |
| **Sandbox** | full copy of the project tree per run | no copy: in-memory instrumented modules served via loader hooks (ESM `--import` / `module.register`, CJS `Module._extensions`), or overlay only mutated files |
| **Checker** | separate TS program per checker process, half of slots | optional; single shared incremental program (or tsgo) off the critical path; check lazily only mutants that would otherwise run |
| **Worker start** | 2 concurrent inits | fork all at once; prefork in daemon |
| **Per-phase timing** | not reported (`performance` unset) | fill `performance` and per-mutant `duration` in the schema output from day one; it makes the StrykerJS comparison measurable |
| **Report compatibility** | mutation-testing-elements schema v2 | emit the same schema, so Stryker's HTML report and dashboard work unchanged and verdicts diff one-to-one |

### 11.3 Oracle notes

- **Key mutants identically.** Match Stryker mutants by `(relative file, mutatorName, start/end location, replacement)`; that is exactly Stryker's incremental key. tzap's mutator catalog should replicate §3 (including the 10.0 `CallExpression` filter rule) to get a 1:1 mutant set for differential testing.
- **Configure Stryker for a clean baseline:**
  - Pin `@stryker-mutator/*` 10.0.0.
  - Use Vitest 4.1.x (not 5) or Jest.
  - `concurrency` ≤ physical cores / 2.
  - No `testFiles`.
  - `ignoreStatic: false`.
  - Generous `timeoutMS`.
  - Run twice and treat mutants that flip between runs as noise.
- **Timing baseline.** Use Stryker's own "Done in" plus dry-run net/overhead logs (INFO level). Its report does not carry timings.
