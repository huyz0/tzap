# Using tzap

tzap changes your code in small, realistic ways — flips a comparison, swaps an operator, empties
a block — runs your tests against each change, and reports every change they fail to notice.
Each surviving mutant is a specific line where a bug could hide from your tests.

## Install

tzap is not on the npm registry yet. Until it is, build the package from this repository and
install the tarball:

```bash
git clone https://github.com/huyz0/tzap && cd tzap
pnpm install && pnpm build && pnpm bundle   # writes dist-npm/tzap
(cd dist-npm/tzap && npm pack)               # writes tzap-<version>.tgz
cd /path/to/your/project && npm install --save-dev /path/to/tzap/dist-npm/tzap/tzap-*.tgz
```

Once published, `npm install --save-dev tzap` replaces all of that.

Node 22.12 or later. tzap uses the test runner already in your project — Vitest, Jest, node:test
or Mocha (see [compatibility.md](compatibility.md)) — and resolves it from your project, so it
runs your tests exactly as your own test command does.

## Run it

From the package you want to analyse:

```bash
npx tzap run
```

```
tzap: 37 mutants in 2 files (37 to run)
tzap: coverage from 5 tests
tzap: round 1: 33 tries in 110 ms
tzap: round 2: 12 tries in 103 ms

Surviving mutants (6):
  src/discount.ts
    line 5: replaced percent > 50 with percent >= 50 [EqualityOperator]
      if (percent > 50) {
    line 12: replaced price === 0 with true [ConditionalExpression]
      return price === 0;
  ...

  killed            28
  survived           6
  no coverage        3
  --------------------
  total             37

Mutation score 75.7% (test strength 82.4%, ignoring uncovered mutants)
```

Read a survivor as a missing assertion: `percent > 50` became `percent >= 50` and every test
still passed, so nothing tests a discount of exactly 50%.

- **Mutation score** — detected mutants over all valid ones.
- **Test strength** — the same, ignoring mutants no test reaches. A low score with high strength
  means code is untested; a high score with low strength would be unusual.

## Only what a change touched

The fast path, and the one to use on pull requests:

```bash
npx tzap run --from origin/main --to -Local-     # everything on this branch, committed or not
npx tzap run                                      # the default scope is the whole package
npx tzap run --from HEAD                          # uncommitted work only (to defaults to -Local-)
npx tzap run --patch change.diff                  # a unified diff, no git needed
```

`-Local-` is the working tree including staged and unstaged changes and untracked files;
`-Empty-` is the empty tree, so `--from -Empty-` selects every line. `A...B` diffs against the
merge base.

**The range only selects which lines to mutate. The analysis always runs against the code on
disk; nothing is checked out.** Build or save first.

A mutant is selected when the code it changes overlaps a changed line. Statement-level mutants
(emptying a block, a `switch` case) are selected only when the line they start on changed, so an
edit inside a function does not put "delete the whole body" on every changed function.

Only the tests that can reach the changed files run in the coverage phase, so a one-line PR
does not pay for the whole suite — the cost StrykerJS pays even with `--mutate` line ranges.

## Reports

```bash
npx tzap run -r console,html,json -o reports/tzap
```

| Reporter | Output |
|---|---|
| `console` | the summary above (default) |
| `agent` | survivors and uncovered mutants only, one per line — for coding agents |
| `json` | tzap's full native report, `tzap.json` |
| `elements` | [mutation-testing-elements](https://github.com/stryker-mutator/mutation-testing-elements) JSON, `mutation.json`: the schema StrykerJS writes, so its viewer and dashboard work |
| `html` | a self-contained page with the standard mutation-testing viewer, `mutation.html` |
| `github` | GitHub Actions annotations on the survivors' lines (at most 10, GitHub's limit per step) |
| `sarif` | SARIF 2.1.0 for code scanning, `tzap.sarif` |
| `markdown` | a pull-request comment, `tzap.md` |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | the run met its bar |
| 1 | it did not: the score is below `--threshold`, or `--fail-on-survivors` and a mutant survived |
| 2 | a usage error: a bad flag, an unknown ref, an invalid model |
| 3 | the analysis itself failed, including any mutant whose analysis broke (`RuntimeError`) |

## Options

```text
-m, --model FILE          a project model instead of discovery
    --from REF --to REF   diff scope
    --patch FILE          diff scope from a unified diff
-r, --reporters LIST      see above
-o, --out-dir DIR         where report files go (default reports/tzap)
    --threshold PCT       exit 1 below this mutation score
    --fail-on-survivors   exit 1 if any mutant survives
    --mutators LIST       only these mutators (see mutators.md)
    --no-arid             also mutate logging calls (see mutators.md)
    --workers N           the test runner's worker count
    --keep-pool           run Vitest in its default pool (forks) even where the config leaves
                          the pool unset; see troubleshooting.md, "Worker threads"
    --cache-dir DIR       reuse verdicts that are provably still valid
    --engine reference    one fresh process per mutant: slow, and the correctness oracle
    --dry-run             print what would be analysed, and stop
-q, --quiet               no progress output
```

## The incremental cache

```bash
npx tzap run --cache-dir .tzap/cache
```

When nothing that could change a verdict has changed, every verdict comes from the cache and no
test runs. When something did, a verdict is reused only when it provably still holds:

- a **killed** mutant, when the test that killed it still reaches it and nothing that test can
  import has changed;
- a **surviving** mutant, when exactly the same tests reach it and nothing any of them can import
  has changed.

"Can import" is a static import graph, widened to everything when a file imports something it
computes at run time. The cache records the Node version, runner version, tzap version and
settings that wrote it, and ignores itself under different ones. It is plain text; commit it or
cache it in CI.

## Monorepos

Run from the workspace root to analyse every package in one run — a library with no tests of
its own is killed by the tests of the packages that use it:

```bash
cd my-monorepo && npx tzap run
```

Run from inside a package to analyse just that one. `--filter pkg-a,pkg-b` picks packages by
name or directory.

A root `vitest.config.ts` with `test.projects` is recognised: one run covers every project.

If tzap warns that tests *import a package but never reach its source*, the package resolves to
its built output (`dist/`), and every mutant in it would look uncovered. Point its
`package.json` `exports` at its source for tests, or alias it to `src/` in the Vitest config.

## CI

```yaml
# .github/workflows/mutation.yml
on: pull_request
jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }     # the diff needs the base branch's history
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npx tzap run --from origin/${{ github.base_ref }} --to HEAD -r github,markdown
```

Or the action in this repository: `uses: huyz0/tzap@v0` — see [action.yml](../action.yml).

## With a coding agent

```bash
npx skills add huyz0/tzap
```

Then ask it to check whether a change is actually tested. The skill is
[skills/tzap/SKILL.md](../skills/tzap/SKILL.md); read it before installing. For agent-shaped output
from any run, `-r agent` prints only the findings.

## A project model

Discovery reads workspace manifests, `package.json` files and runner configs and computes a
**project model**. `npx tzap model` prints it; save and edit it, and pass it with `-m` when
discovery gets something wrong:

```json
{
  "schemaVersion": 1,
  "root": ".",
  "packages": [
    { "id": "@acme/app", "root": "packages/app", "sources": ["src/**/*.ts"], "runner": { "kind": "vitest" } },
    { "id": "@acme/lib", "root": "packages/lib", "sources": ["src/**/*.ts"], "tests": [] }
  ]
}
```

A bug report is "attach the model": it reproduces a run with no discovery involved.
