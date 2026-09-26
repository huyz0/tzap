# Performance

Every published number, how it was taken, and what it does not show. Generated reports:
[tools/bench/report.md](../tools/bench/report.md) and
[tools/bench/results/bench-report-windows.txt](../tools/bench/results/bench-report-windows.txt);
raw data in `tools/bench/results/raw-windows.json`.

## How

- **Fixture**: `fixtures/bench-vitest`, generated from a fixed seed by `tools/bench/generate.mjs`:
  40 modules and 200 tests with a mix of strong, weak and missing assertions (1,495 mutants),
  and a static-heavy variant (1,214 mutants, 831 of them reached while modules load).
- **Both tools on the same copy**, with Vitest 4.1.11 (StrykerJS's Vitest runner does not work
  on Vitest 5, stryker-js#6210), StrykerJS 10.0.0 at concurrency 10 — its fastest, measured at
  1, 4 and 10 — and tzap with `--no-arid`, so both mutate exactly the same inventory.
- **Runs**: tzap 5, StrykerJS 3, interleaved so load drift hits both; median with min–max,
  never a best run; a ratio only with n ≥ 3 on both sides.
- **Machine**: Windows 11, i5-13600KF (20 threads), Node 26.7, a developer machine, not an
  isolated bench host. Process spawn is ~35 ms here and 2–3x cheaper on Linux, which moves
  StrykerJS more than tzap. Compare numbers within one report only.

## Results

| # | Scenario | tzap | StrykerJS | Ratio | Inventory (shared) |
|---|---|---:|---:|---:|---|
| S1 | Full run, cold | 4.13 s (3.63–4.41) | 29.41 s (28.24–30.73) | **7.1x** | 1,495 / 1,495 (1,495) |
| S3 | 10-line diff, cold | 0.79 s (0.76–1.28) | 3.53 s (3.14–4.24) | **4.5x** | 21 / 17 (17) |
| S4 | Same diff, warm cache | 0.19 s (0.18–0.20) | — | — | 21, all cached |
| S5 | Nothing changed, warm cache | 0.39 s (0.29–0.55) | 7.79 s (6.69–8.29) | **19.9x** | 1,495 / 1,495 |
| S6 | One-line change, warm cache | 1.79 s (1.45–2.72) | 8.77 s (7.10–9.95) | 4.9x | 1,495 / 1,495 |
| S9 | Static-heavy, cold | 13.07 s (12.78–14.00) | 20.94 s (20.86–21.82) | 1.6x | 1,214 / 1,214 (1,214) |

Build `a1a4249`; background load 9–20% during the run. StrykerJS measured ~13% slower on S1
here than in the previous quiet-machine report (29.4 s against 26.0 s), so read S1 as 6–7x:
at the earlier StrykerJS time it is 6.3x. tzap's own gain is not in doubt — the same build
comparison is 8.18 s before and 4.13 s after, under the heavier load.

### What the last round of profiling changed

The previous report (build `9f9af41`) had tzap at 8.18 s on S1, 1.47 s on S3, 2.98 s on S6
and 18.84 s on S9. Three changes, each found by profiling, account for the difference:

- **Worker threads.** Vitest's default pool starts a process for every test file of every run,
  and isolation needs a fresh start per file per mutant. Per-file work in an isolated run was
  ~40 ms; the run around it cost ~300 ms more. Where a project's config leaves the pool unset,
  tzap now uses threads, and falls back to the project's pool if the baseline is not clean in
  them (`--keep-pool` to opt out). Same verdicts on the bench fixture: 6.0 s to 3.7 s alone.
- **Isolated re-checks run only the covering tests, and stop at the first kill.** On remeda
  one test file waits on real timers for 3 s; every mutant confirmed in isolation ran it in
  full.
- **An unhandled error is charged to the mutant of the file Vitest attributes it to**, instead
  of re-running every mutant of the run alone.

On the parity corpus the same changes took es-toolkit from 16.0 s to 6.6 s, superjson from
32.8 s to 20.8 s and remeda from 88.9 s to 57.5 s — remeda had been slower than StrykerJS
(74.3 s) and no longer is. The parity gate passes on the new build.

S2 (Jest), S7 (monorepo) and S8 (frontend) are declared and skipped: the generator emits one
Vitest package. The Jest runner and the frontend fixtures exist; the benchmark variants do not.

## Where tzap wins, and where it does not

- **The warm path is the lead.** A mutant try costs 37–180 µs once a runner is up, in every
  runner. Most of a full run is now fixed cost: a runner boot, a coverage pass that runs every
  test twice, and the isolated runs for static mutants and state-exposed survivors.
- **The cache is the biggest multiple (S5, 20x):** nothing changed means no runner starts.
- **Static mutants are where tzap is closest to StrykerJS (S9, 1.6x).** Each needs a run with
  fresh modules, which is what StrykerJS does for every mutant; packing one per test file per
  run and parallel lanes are what keep tzap ahead at all.
- **S6 re-runs 23 mutants where StrykerJS re-runs none.** An edit invalidates every mutant in
  the edited file whose tests import it; StrykerJS reuses results unless the mutant's own text
  changed, which is faster and unsound when a mutant's behaviour depends on a changed callee.

## Kill criteria

| Scenario | Required | Measured | Verdict |
|---|---|---:|---|
| S1 full run | ≥ 3x | 7.1x | **met** |
| S3 10-line diff | ≥ 10x | 4.5x | **not met** |

S3's criterion assumed a suite whose dry run is expensive — the cost StrykerJS pays for every
diff and tzap narrows away. On this fixture StrykerJS's whole dry run takes 0.4 s, so there is
little to narrow away, and tzap's fixed floor (a runner boot and a coverage pass of the tests
that can reach the change) dominates. The criterion is recorded as unmet; a diff benchmark on a
corpus project with a real suite is the measurement that would settle it.

## What building it taught about speed

- **Survivor confirmation has a real price, and a targeted rule pays it only where needed.**
  Confirming every warm survivor in isolation took S1 from ~6 s to ~15 s; confirming only those
  whose tests can reach module state keeps the soundness (superjson still shows every masked
  survivor caught) at 8 s.
- **A round of a runner should load only the files it needs.** Before that fix, every round of a
  10-line diff loaded all 40 test files: ~2 s per round regardless of work.
- **More parallel sessions is not faster.** Eight isolation lanes measured slower than four:
  each costs a runner boot and they contend for the same cores.
- **A benchmark on a busy machine measures the machine.** An early S1 run under 60% background
  load reported tzap at 6.0 s and StrykerJS at 39 s; on a quiet machine StrykerJS takes 26 s.
  The previous report came from a quiet machine; this one ran at 9–20% background load, and
  says so next to the ratio it affects.

## Reproducing

```bash
pnpm build
node tools/bench/generate.mjs --check      # the fixture is what the seed produces
node tools/bench/bench.mjs                 # all scenarios; --only S1,S3 --runs 5 to narrow
node tools/bench/render.mjs                # tools/bench/report.md
```
