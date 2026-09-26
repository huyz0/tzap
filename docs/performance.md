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
| S1 | Full run, cold | 8.18 s (6.79–8.87) | 26.04 s (24.91–26.70) | **3.2x** | 1,495 / 1,495 (1,495) |
| S3 | 10-line diff, cold | 1.47 s (0.99–1.72) | 4.87 s (4.55–4.99) | **3.3x** | 21 / 17 (17) |
| S4 | Same diff, warm cache | 0.19 s | — | — | 21, all cached |
| S5 | Nothing changed, warm cache | 0.29 s (0.29–0.30) | 7.27 s (6.68–8.04) | **24.9x** | 1,495 / 1,495 |
| S6 | One-line change, warm cache | 2.98 s (2.46–3.18) | 7.51 s (6.91–7.51) | 2.5x | 1,495 / 1,495 |
| S9 | Static-heavy, cold | 18.84 s (17.80–26.85) | 23.43 s (22.77–23.66) | 1.2x | 1,214 / 1,214 (1,214) |

S2 (Jest), S7 (monorepo) and S8 (frontend) are declared and skipped: the generator emits one
Vitest package. The Jest runner and the frontend fixtures exist; the benchmark variants do not.

## Where tzap wins, and where it does not

- **The warm path is the lead.** A mutant try costs 37–180 µs once a runner is up, in every
  runner. Most of a full run is now fixed cost: a runner boot, a coverage pass that runs every
  test twice, and the isolated runs for static mutants and state-exposed survivors.
- **The cache is the biggest multiple (S5, 25x):** nothing changed means no runner starts.
- **Static mutants are where tzap is closest to StrykerJS (S9, 1.2x).** Each needs a run with
  fresh modules, which is what StrykerJS does for every mutant; packing one per test file per
  run and parallel lanes are what keep tzap ahead at all.
- **S6 re-runs 23 mutants where StrykerJS re-runs none.** An edit invalidates every mutant in
  the edited file whose tests import it; StrykerJS reuses results unless the mutant's own text
  changed, which is faster and unsound when a mutant's behaviour depends on a changed callee.

## Kill criteria

| Scenario | Required | Measured | Verdict |
|---|---|---:|---|
| S1 full run | ≥ 3x | 3.2x | **met** |
| S3 10-line diff | ≥ 10x | 3.3x | **not met** |

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
  Every figure above comes from the quiet run.

## Reproducing

```bash
pnpm build
node tools/bench/generate.mjs --check      # the fixture is what the seed produces
node tools/bench/bench.mjs                 # all scenarios; --only S1,S3 --runs 5 to narrow
node tools/bench/render.mjs                # tools/bench/report.md
```
