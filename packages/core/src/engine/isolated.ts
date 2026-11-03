/**
 * The isolated path: static mutants, the ones whose warm verdict could not be trusted, and the
 * whole reference engine.
 *
 * Each mutant is active before any module evaluates, in a session that isolates test files, and
 * every green test of every file that could reach it runs, in the file's own order, so no test is
 * deprived of the tests it follows. Killed when any of them fails.
 *
 * With `fresh` (the reference engine) each mutant gets a session of its own and nothing is shared.
 * Otherwise mutants are packed: every test file has its own module graph, so one run can activate
 * a different mutant in each file, and mutants whose files do not overlap share a run. Runs go out
 * to several sessions at once.
 */
import os from 'node:os';
import path from 'node:path';
import type { MutantDescriptor, MutantResult } from '@tzap/model';
import { normPath, type RunnerSession, type RunResult, type Try } from '@tzap/protocol';
import { relativeTo } from '../files.js';
import { addTo, closeAll, decidedCount, limitsFor, speedClass, type EngineRun, type IsolatedMutant, type TestRecord } from './run.js';

interface Item {
  d: MutantDescriptor;
  isStatic: boolean;
  files: Map<string, Set<string>>; // package id -> normPath'd test files
  coveredBy: Set<string>;
  /** The tests that judge the mutant here: its covering tests, or the part a confirmation re-runs. */
  judgedBy: Set<string>;
  /** Covering tests that already decided the mutant warm, and are not run again. */
  decidedWarm: number;
  killedBy?: string;
  message?: string;
  timeout: boolean;
  tested: number;
  /** Tests a run was asked to try this mutant against. */
  planned: number;
}

/** One run of one package, assigning each of its test files at most one mutant. */
interface Job {
  pkgId: string;
  assign: Map<string, Item>;
}

type Parts = Array<{ it: Item; files: Map<string, Set<string>> }>;

/** What a job's run needs besides the job: a session, and a way to drop it once it is spent. */
interface Lane {
  session: () => Promise<RunnerSession>;
  retire: () => void;
}

export async function isolatedRuns(run: EngineRun, list: IsolatedMutant[], fresh: boolean): Promise<void> {
  if (list.length === 0) return;
  const items = list
    .slice()
    .sort((a, b) => a.d.num - b.d.num)
    .map(({ d, tests, confirm }) => itemFor(run, d, tests, confirm));

  // Green tests by package and normalised file, in discovery order.
  const testsByFile = new Map<string, TestRecord[]>();
  for (const t of run.green) {
    const k = `${t.pkg}\0${normPath(path.resolve(run.root, t.file))}`;
    let l = testsByFile.get(k);
    if (!l) testsByFile.set(k, (l = []));
    l.push(t);
  }

  const buildJobs = (parts: Parts): Job[] => {
    const jobs: Job[] = [];
    for (const pkg of run.runnerPackages) {
      const packs = !fresh && run.staticPerFile.has(pkg.id);
      const open: Job[] = [];
      for (const { it, files } of parts) {
        const fs = files.get(pkg.id);
        if (!fs?.size) continue;
        let job = packs ? open.find((j) => ![...fs].some((f) => j.assign.has(f))) : undefined;
        if (!job) open.push((job = { pkgId: pkg.id, assign: new Map() }));
        for (const f of fs) job.assign.set(f, it);
      }
      jobs.push(...open);
    }
    return jobs;
  };

  const runJob = (job: Job, lane: Lane) => runIsolatedJob(run, job, lane, testsByFile, items);

  /**
   * One package's jobs at a time, in package order. A mutant has at most one job per package, so
   * within a package no two lanes race over it; a mutant killed in an earlier package is skipped
   * in a later one whatever the timing, and the test credited never depends on it.
   */
  const runByPackage = async (all: Job[]) => {
    for (const pkg of run.runnerPackages) {
      const mine = all.filter((j) => j.pkgId === pkg.id);
      if (mine.length > 0) await runJobs(run, mine, fresh, runJob);
    }
  };
  // Each pass after the first holds only the static mutants no earlier pass killed.
  for (const [i, pass] of passes(run, items, testsByFile, fresh).entries()) {
    const alive = pass.filter((p) => !p.it.killedBy);
    if (alive.length === 0) continue;
    // Each of these runs once per file it reaches: in a module the whole suite loads, a run of
    // most of the suite per mutant. Said, so a long isolated phase is not a silent one.
    if (i > 0) {
      const runs = alive.reduce((n, p) => n + [...p.files.values()].reduce((a, f) => a + f.size, 0), 0);
      run.emit({ type: 'info', message: `static mutants, wave ${i}: ${alive.length} not killed yet, ${runs} test file runs` });
    }
    await runByPackage(buildJobs(alive));
  }

  for (const it of items) run.results.set(it.d.num, verdict(it));
  run.emit({ type: 'progress', decided: decidedCount(run), total: run.total });
}

/**
 * The test files that could reach a mutant, and the tests that cover it. A warm survivor's
 * confirmation runs only the files of the tests it re-runs: no other file can change its verdict.
 */
function itemFor(run: EngineRun, d: MutantDescriptor, keys: string[], confirm?: string[]): Item {
  const isStatic = run.staticSites.has(d.site);
  const files = new Map<string, Set<string>>();
  const reaching = run.siteTests.get(d.site) ?? [];
  const confirming = confirm !== undefined && !isStatic;
  const fileOf = (t: TestRecord) => addTo(files, t.pkg, normPath(path.resolve(run.root, t.file)));
  for (const key of confirming ? confirm : keys) fileOf(run.tests.get(key)!);
  if (!confirming) for (const t of reaching) fileOf(t);
  if (isStatic) {
    for (const key of run.staticSites.get(d.site)!) {
      const [pkgId, file] = key.split('\0') as [string, string];
      addTo(files, pkgId, normPath(file));
    }
  }
  const coveredBy = new Set<string>(keys);
  for (const t of reaching) coveredBy.add(t.key);
  // A static mutant is judged by every test of the files that load it.
  if (isStatic) for (const k of run.staticRan(d)) coveredBy.add(k);
  const judgedBy = confirming ? new Set(confirm) : coveredBy;
  return { d, isStatic, files, coveredBy, judgedBy, decidedWarm: confirming ? coveredBy.size - judgedBy.size : 0, timeout: false, tested: 0, planned: 0 };
}

/** The first wave of a static mutant's files that call into its module, and how each next one grows. */
const FIRST_WAVE = 8;
const WAVE_GROWTH = 4;

/**
 * A static mutant is live in every file that loads its module, and any one of them failing kills
 * it; most static mutants break loading outright. So in a warm run each is first tried in one
 * file, its likeliest killer. Different mutants take different files where they can, so the first
 * pass packs into few runs.
 *
 * A survivor of the first pass must still run in every other file that loads its module before it
 * can be called a survivor, and in a module the whole suite imports that is most of the suite, once
 * per mutant. So the rest come in waves, each a pass of its own for the mutants no earlier pass
 * killed: first the files whose tests call into the mutant's own module at runtime, the ones that
 * use what it computed while loading, those reaching most of the module first, in waves of 8, 32,
 * 128, ... files; then every other file that loads it. A kill ends a mutant's waves; a survivor
 * runs in every file, as before. The reference engine keeps one pass.
 */
function passes(run: EngineRun, items: Item[], testsByFile: Map<string, TestRecord[]>, fresh: boolean): Parts[] {
  const out: Parts[] = [[]];
  const fileClass = new Map<string, number>();
  for (const [k, ts] of testsByFile) fileClass.set(k, speedClass(ts.reduce((a, t) => a + (t.duration ?? 0), 0)));
  const used = new Set<string>();
  /** Per source file: how many of its sites each test file (`pkgId\0normPath`) reaches at runtime. */
  const callers = new Map<string, Map<string, number>>();
  const callersOf = (source: string) => {
    let reach = callers.get(source);
    if (reach) return reach;
    callers.set(source, (reach = new Map()));
    for (const [site, ts] of run.siteTests) {
      if (run.siteFile.get(site) !== source) continue;
      for (const k of new Set(ts.map((t) => `${t.pkg}\0${normPath(path.resolve(run.root, t.file))}`))) reach.set(k, (reach.get(k) ?? 0) + 1);
    }
    return reach;
  };
  const add = (pass: number, it: Item, xs: Array<{ pkgId: string; f: string }>) => {
    const files = new Map<string, Set<string>>();
    for (const x of xs) addTo(files, x.pkgId, x.f);
    (out[pass] ??= []).push({ it, files });
  };
  for (const it of items) {
    const all = [...it.files].flatMap(([pkgId, fs]) => [...fs].map((f) => ({ pkgId, f, k: `${pkgId}\0${f}` })));
    if (fresh || !it.isStatic || all.length < 2 || !all.every((x) => run.staticPerFile.has(x.pkgId))) {
      out[0]!.push({ it, files: it.files });
      continue;
    }
    const inBody = new Set((run.siteTests.get(it.d.site) ?? []).map((t) => `${t.pkg}\0${normPath(path.resolve(run.root, t.file))}`));
    const calls = callersOf(it.d.file);
    const rank = (x: { k: string }) => [inBody.has(x.k) ? 0 : calls.has(x.k) ? 1 : 2, -(calls.get(x.k) ?? 0), fileClass.get(x.k) ?? 0] as const;
    const order = (a: { k: string }, b: { k: string }) => {
      const [ra, rb] = [rank(a), rank(b)];
      return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2] || (a.k < b.k ? -1 : 1);
    };
    all.sort(order);
    const pick = all.find((x) => !used.has(x.k)) ?? all[0]!;
    used.add(pick.k);
    add(0, it, [pick]);
    const rest = all.filter((x) => x !== pick);
    const near = rest.filter((x) => rank(x)[0] < 2);
    let pass = 1;
    for (let at = 0, size = FIRST_WAVE; at < near.length; at += size, size *= WAVE_GROWTH) add(pass++, it, near.slice(at, at + size));
    const far = rest.filter((x) => rank(x)[0] === 2);
    if (far.length > 0) add(pass, it, far);
  }
  return out;
}

async function runIsolatedJob(run: EngineRun, job: Job, lane: Lane, testsByFile: Map<string, TestRecord[]>, items: Item[]): Promise<void> {
  // A mutant killed by an earlier job needs no more runs.
  for (const [f, it] of [...job.assign]) if (it.killedBy) job.assign.delete(f);
  if (job.assign.size === 0) return;
  const plan: Record<string, Try[]> = {};
  const staticPlan: Record<string, number> = {};
  const files: string[] = [];
  for (const [f, it] of job.assign) {
    // A static mutant is live from the moment the file loads: every test of the file judges it.
    // Any other mutant is judged by the tests that reach it, and the worker skips the tests after
    // the last of those.
    const all = testsByFile.get(`${job.pkgId}\0${f}`) ?? [];
    const ts = it.isStatic ? all : all.filter((t) => it.judgedBy.has(t.key));
    if (ts.length === 0) continue;
    staticPlan[f] = it.d.num;
    files.push(path.resolve(run.root, ts[0]!.file));
    for (const t of ts) plan[t.runnerId] = [{ m: it.d.num, ...limitsFor(t, it.d.site) }];
    it.planned += ts.length;
  }
  if (files.length === 0) return;
  const byNum = new Map([...job.assign.values()].map((it) => [it.d.num, it]));
  const single = byNum.size === 1 ? [...byNum.keys()][0] : undefined;
  /** Decides each of the job's mutants in a run of its own. */
  const oneByOne = async () => {
    for (const it of byNum.values()) await runIsolatedJob(run, { pkgId: job.pkgId, assign: new Map([...job.assign].filter(([, x]) => x === it)) }, lane, testsByFile, items);
  };
  const s = await lane.session();
  const res = await s.run({
    id: run.nextRunId(),
    mode: 'static',
    plan,
    files,
    ...(run.staticPerFile.has(job.pkgId) ? { staticPlan } : {}),
    ...(single !== undefined ? { staticMutant: single } : {}),
    // Ten times what the unmutated files needed while loading, with a floor.
    staticLimit: Math.max(1_000_000, 10 * Math.max(0, ...Object.keys(staticPlan).map((f) => run.loadLoops.get(f) ?? 0))),
    budgetMs: run.silenceMs,
  });
  if (res.timedOut) {
    lane.retire();
    const hung = new Set((res.inFlight ?? []).map((x) => x.mutant));
    // Stuck before any try began — a mutant looping while a module loads — in a run shared by
    // several mutants: nothing says which. Decide each on its own.
    if (hung.size === 0 && byNum.size > 1) return oneByOne();
    for (const it of byNum.values()) {
      if (hung.has(it.d.num) || byNum.size === 1) {
        it.timeout = true;
        it.killedBy = 'wall-clock backstop';
        it.message = 'wall-clock backstop';
      }
    }
    // The rest of the job is decided again, without the hung mutants.
    const rest: Job = { pkgId: job.pkgId, assign: new Map([...job.assign].filter(([, it]) => !it.killedBy)) };
    if (rest.assign.size > 0 && rest.assign.size < job.assign.size) await runIsolatedJob(run, rest, lane, testsByFile, items);
    return;
  }
  if (res.unhandledErrors?.length && !run.noisyUnhandled.has(job.pkgId)) {
    // Several mutants shared the run and the error names no file: decide each alone to see whose it is.
    if (!creditUnhandled(job.pkgId, res, byNum, staticPlan)) return oneByOne();
  }
  creditRun(run, job.pkgId, res, byNum, staticPlan, single);
  // Isolated verdicts enter the results at the end: until then, count the kills so far.
  run.emit({ type: 'progress', decided: decidedCount(run) + items.filter((it) => it.killedBy).length, total: run.total });
}

/**
 * Credits a run's unhandled errors. Each file of the run has its own mutant and its own modules:
 * an error the runner attributes to a file is that file's mutant's, as `vitest run` would report
 * it. Alone in the run, the mutant owns every error: the suite fails with it. Returns false when
 * several mutants shared the run and an error names no file of theirs.
 */
function creditUnhandled(pkgId: string, res: RunResult, byNum: Map<number, Item>, staticPlan: Record<string, number>): boolean {
  const errors = res.unhandledErrors!;
  const kill = (it: Item, error: string) => {
    if (it.killedBy) return;
    it.killedBy = `${pkgId}::unhandled error`;
    it.message = `unhandled error during the run: ${error}`;
  };
  if (byNum.size === 1) {
    kill([...byNum.values()][0]!, errors[0]!);
    return true;
  }
  const owners = errors.map((_, i) => {
    const f = res.unhandledErrorFiles?.[i];
    return f ? byNum.get(Number(staticPlan[normPath(f)] ?? NaN)) : undefined;
  });
  if (!owners.every((o) => o !== undefined)) return false;
  owners.forEach((it, i) => kill(it!, errors[i]!));
  return true;
}

/** Credits file load failures and failed tries to the mutants of the run. */
function creditRun(run: EngineRun, pkgId: string, res: RunResult, byNum: Map<number, Item>, staticPlan: Record<string, number>, single: number | undefined): void {
  const fileMutant = new Map(Object.entries(staticPlan));
  for (const f of res.files) {
    if (!f.error) continue;
    const it = byNum.get(fileMutant.get(normPath(f.file)) ?? single ?? -1);
    if (it && !it.killedBy) {
      it.killedBy = `${pkgId}::${relativeTo(run.root, f.file)}`;
      it.message = `test file failed to load: ${f.error}`;
      // The loop guard stopped a mutant that never finished loading the module.
      if (/declared hung/.test(f.error)) it.timeout = true;
    }
  }
  // Of the tests that killed a mutant in this run, the lowest id is credited: the order they
  // report in depends on scheduling.
  const decided = new Set([...byNum.values()].filter((it) => it.killedBy));
  for (const t of res.tests) {
    for (const [m, outcome, msg] of t.tries ?? []) {
      const it = byNum.get(m);
      if (!it) continue;
      it.tested++;
      const key = `${pkgId}::${t.id}`;
      if ((outcome === 'K' || outcome === 'T') && !decided.has(it) && (!it.killedBy || key < it.killedBy)) {
        it.killedBy = key;
        it.timeout = outcome === 'T';
        it.message = msg;
      }
    }
  }
}

/** Runs one package's jobs on as many lanes, each with sessions of its own, as fill the machine. */
async function runJobs(run: EngineRun, jobs: Job[], fresh: boolean, runJob: (job: Job, lane: Lane) => Promise<void>): Promise<void> {
  const { options } = run;
  const cores = os.availableParallelism();
  // A run keeps about one worker busy per test file it holds, so the lanes that fill the machine
  // are the cores over the average files per run: few when runs are wide, more when each run holds
  // a file or two. Another lane costs a runner boot, so there is one only for every six runs, and
  // never more than half the cores.
  const avgFiles = jobs.reduce((a, j) => a + j.assign.size, 0) / Math.max(1, jobs.length);
  const autoLanes = Math.max(1, Math.min(Math.round(cores / Math.max(1, avgFiles)), Math.floor(cores / 2), Math.ceil(jobs.length / 6)));
  const lanes = Math.max(1, options.concurrency ?? (fresh ? 1 : autoLanes));
  const workersPerSession = Math.max(1, Math.floor(cores / lanes));
  const pkgById = new Map(run.runnerPackages.map((p) => [p.id, p]));
  const queue = jobs.slice();
  /** A lane that failed stops the others taking jobs: the analysis is over. */
  let failed = false;
  const lane = async (laneIndex: number) => {
    const sessions = new Map<string, RunnerSession>();
    try {
      for (let job = queue.shift(); job && !failed; job = queue.shift()) {
        const { pkgId } = job;
        const pkg = pkgById.get(pkgId)!;
        // The first lane reuses the warm session when that already isolates files.
        const reuseWarm = !fresh && laneIndex === 0 && run.isolatesFiles.has(pkgId);
        const session = async () => {
          const pool = reuseWarm ? run.warm : sessions;
          let s = pool.get(pkgId);
          if (!s) {
            s = reuseWarm ? run.sessionFor(pkg) : run.sessionFor(pkg, true, workersPerSession);
            // Registered before it starts, so a start that fails after forking is still closed.
            pool.set(pkgId, s);
            await s.start();
          }
          return s;
        };
        const retire = () => {
          if (reuseWarm) run.warm.delete(pkgId);
          sessions.delete(pkgId);
        };
        const tj = performance.now();
        await runJob(job, { session, retire });
        if (process.env.TZAP_DEBUG) {
          const summary = [...new Set(job.assign.values())].map((it) => `${it.d.num}${it.isStatic ? 's' : 'v'}:${it.killedBy ? 'K' : it.tested}/${it.planned}`).join(',');
          process.stderr.write(`tzap debug: lane ${laneIndex} job ${summary} files=${job.assign.size} ${Math.round(performance.now() - tj)} ms\n`);
        }
        if (fresh) {
          await closeAll(sessions.values());
          sessions.clear();
        }
      }
    } catch (e) {
      failed = true;
      throw e;
    } finally {
      await closeAll(sessions.values());
    }
  };
  // Every lane finishes (and closes its sessions) before the first failure is reported.
  const outcomes = await Promise.allSettled(Array.from({ length: lanes }, (_, i) => lane(i)));
  const rejected = outcomes.find((o) => o.status === 'rejected');
  if (rejected) throw rejected.reason;
}

function verdict(it: Item): MutantResult {
  const base: MutantResult = { ...it.d, status: 'Survived', coveredBy: [...it.coveredBy].sort(), testsCompleted: it.tested + it.decidedWarm, ...(it.isStatic ? { static: true } : {}) };
  if (it.timeout) return { ...base, status: 'Timeout', statusReason: it.message ?? 'declared hung', killedBy: it.killedBy ? [it.killedBy] : [] };
  if (it.killedBy) return { ...base, status: 'Killed', statusReason: it.message, killedBy: [it.killedBy] };
  if (it.planned === 0) return { ...base, status: 'NoCoverage', statusReason: 'no passing test reaches it' };
  // Asked to run and never reported: nothing decided this mutant. Never call that a survival.
  if (it.tested === 0) return { ...base, status: 'RuntimeError', statusReason: 'the mutant was planned against tests that never reported a result' };
  return base;
}
