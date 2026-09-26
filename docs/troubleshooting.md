# Troubleshooting

The failures people actually hit, most common first. Each one tzap can detect produces a message
naming what it looked at; this page says what to do about it. `npx tzap run --dry-run` prints the
packages, runner, files in scope and changed lines without analysing anything, and shows most
configuration problems at once.

## Every mutant in a package is uncovered

**With a warning that tests import the package but never reach its source.** The tests load the
package's built output (`dist/`), so the instrumented source never runs. Point the package's
`exports` (or `main`) at its source for tests, or alias it in the Vitest config:

```ts
// vitest.config.ts
export default defineConfig({ resolve: { alias: { '@acme/lib': new URL('../lib/src/index.ts', import.meta.url).pathname } } });
```

**Without a warning.** The package's tests are in another package: analyse them together by
running from the workspace root, or listing both with `--filter`.

## A test "fails with no mutant applied"

Reported as a baseline failure, and excluded from every verdict: a test that already fails
would "kill" every mutant it touches. Run your own test command; if it passes there and fails
under tzap, the difference is in how the runner was started. tzap sets `VITEST`, `TEST` and
`NODE_ENV=test` as the Vitest CLI does, runs from the package directory, and uses the config the
model names (`npx tzap model` shows it). A plugin that reads other environment variables in its
config hook is the usual cause; set them in the package's `env` in a project model.

## "N tests behave differently when repeated"

tzap runs each test twice during coverage. A test that fails the second time, or takes a
different path, depends on state its first run left behind — a module-level counter, a memo, a
cache. tzap does not trust warm verdicts from such a test and decides the mutants only it covers
in isolation, which is slower. Not a bug in your tests, but resetting module state in a
`beforeEach` makes the run faster.

## "Mutants re-decided in isolation"

A control run of a test (no mutant active) failed next to mutant runs, or a mutant was never
reached in the warm run although coverage said it was. Both mean the warm run's verdict could
have been decided by leftover state or by the order tests ran in; the isolated run decides it
instead. Order-dependent tests (one test using what another left behind) are the usual cause.

## Nothing is in scope on a pull request

`actions/checkout` fetches one commit, so the base branch does not exist in the clone. Use
`fetch-depth: 0`. tzap exits 2 naming the ref it could not resolve.

## Timeouts

A mutant that makes a loop run forever is stopped by counting loop iterations, not by the clock:
the limit is ten times what the unmutated test needed, so a slow machine cannot turn it into a
false result. A mutant that leaves a promise pending forever fails the test by the runner's own
test timeout (5 s in Vitest by default); a project with many such mutants runs faster with a
lower `testTimeout`. A mutant that blocks synchronously outside instrumented code is caught by a
wall-clock backstop that restarts the runner.

## Worker threads

Where a Vitest config sets no `pool`, `execArgv` or `projects`, tzap runs the tests in worker
threads rather than Vitest's default forked processes: a thread starts several times faster,
and tzap starts one for every test file of every isolated run. A configured pool is always kept.

Some suites cannot run in threads: `process.chdir`, some native addons, code that relies on
being the main thread. If anything fails in tzap's baseline run in threads — a red test, a test
file that does not load, an unhandled error, a crash — tzap says so (`the baseline is not clean
in worker threads; using the project's own pool`) and runs that package in Vitest's default
pool instead. The check is the baseline: a suite that passes in threads but depends on a
process-only behaviour only when a mutant is active would not be caught by it. If you suspect
that, or to skip the attempt, set `pool: 'forks'` in the config or pass `--keep-pool`.

## Snapshots

tzap never writes snapshots: a mutant that changes a snapshot fails the assertion and is
killed, and nothing on disk changes.

## `ERR_MODULE_NOT_FOUND` for a workspace package under tzap only

The package is not linked into `node_modules`: run your package manager's install at the
workspace root.
