/**
 * Runs inside Vitest's workers, as the first setup file of every test file. It receives the
 * `vitest` module from a tiny generated shim in the user's project, so this file never resolves
 * `vitest` itself: two copies of Vitest in one worker would register hooks on the wrong runner.
 *
 * How many mutants run in one Vitest run (see docs/spikes/A-vitest-rerun.md): `beforeAll`
 * receives the collected file and sets `repeats` on each planned test; Vitest's repeat loop
 * re-runs beforeEach -> body -> afterEach per repetition and does not stop on failure;
 * `beforeEach` activates the repetition's mutant; `afterEach`, registered first and so run last,
 * records the outcome in `task.meta` and clears the failure so the next repetition starts clean.
 */
import { activateStatic, beginTry, drainHits, endTry, install, type TzapRuntime } from '@tzap/runtime';
import path from 'node:path';
import { threadId } from 'node:worker_threads';
import { normPath, PROGRESS_DIR_ENV, progressWriter, type RunMode, type Try, type TryOutcome } from '@tzap/protocol';

interface Payload {
  runId: number;
  mode: RunMode;
  plan?: Record<string, Try[]>;
  staticMutant?: number;
  staticPlan?: Record<string, number>;
  staticLimit?: number;
}

interface Task {
  id: string;
  name: string;
  type: string;
  mode: string;
  tasks?: Task[];
  repeats?: number;
  retry?: number;
  concurrent?: boolean;
  fails?: boolean;
  promises?: unknown[];
  meta: Record<string, unknown>;
  result?: { state: string; errors?: Array<{ message?: string }>; repeatCount?: number };
}

type Vitest = {
  inject: (key: string) => unknown;
  beforeAll: (fn: (ctx: object, suite: Task) => unknown) => void;
  afterAll: (fn: (ctx: object, suite: Task) => unknown) => void;
  beforeEach: (fn: (ctx: { task: Task }) => unknown) => void;
  afterEach: (fn: (ctx: { task: Task }) => unknown) => void;
};

/** Thrown to skip a repetition whose mutant was already killed by another test in this run. */
const SKIP = 'tzap: skipped, mutant already killed in this run';

interface WorkerState {
  runId: number;
  file: string | undefined;
  killed: Set<number>;
  progress: ReturnType<typeof progressWriter> | null;
}

function workerState(): WorkerState {
  const g = globalThis as unknown as { __tzapWorker?: WorkerState };
  g.__tzapWorker ??= { runId: -1, file: undefined, killed: new Set(), progress: null };
  return g.__tzapWorker;
}

function walk(suite: Task, f: (t: Task) => void): void {
  for (const t of suite.tasks ?? []) {
    if (t.type === 'test') f(t);
    else walk(t, f);
  }
}

/**
 * Stable test ids, as every tzap runner names tests: `file::suite > name`, with ` #n` for the nth
 * test of the same name in a file. Vitest's own ids count positions, so adding a test renames the
 * ones after it; and a report should name the test.
 */
function assignIds(file: Task & { filepath?: string }): void {
  const rel = path.relative(process.cwd(), file.filepath ?? file.name).replace(/\\/g, '/');
  const seen = new Map<string, number>();
  const visit = (suite: Task, names: string[]) => {
    for (const t of suite.tasks ?? []) {
      const here = [...names, t.name];
      if (t.type !== 'test') {
        visit(t, here);
        continue;
      }
      const name = here.join(' > ');
      const n = seen.get(name) ?? 0;
      seen.set(name, n + 1);
      t.meta.tzapId = `${rel}::${name}${n > 0 ? ` #${n + 1}` : ''}`;
    }
  };
  visit(file, []);
}

const idOf = (t: Task) => (typeof t.meta.tzapId === 'string' ? t.meta.tzapId : t.id);

const firstMessage = (t: Task) => {
  const m = t.result?.errors?.[0]?.message;
  return m === undefined ? undefined : m.length > 300 ? `${m.slice(0, 297)}...` : m;
};

export function setup(vitest: Vitest): void {
  const rt: TzapRuntime = install();
  const payload = (vitest.inject('tzap') ?? { runId: 0, mode: 'coverage' }) as Payload;
  const ws = workerState();
  const currentFile = (globalThis as { __vitest_worker__?: { filepath?: string } }).__vitest_worker__?.filepath;
  // A kill skips the mutant's later tries in the same file only. Across files it would depend on
  // which files share a worker, and so would which test is credited with the kill: a report must
  // not change with the worker count.
  if (ws.runId !== payload.runId || ws.file !== currentFile) {
    ws.runId = payload.runId;
    ws.file = currentFile;
    ws.killed = new Set();
  }
  if (ws.progress === null) ws.progress = progressWriter(process.env[PROGRESS_DIR_ENV], `${process.pid}-${threadId}`);
  // Registered first, so it runs before every other hook of the file.
  vitest.beforeAll(({}, file) => assignIds(file));

  if (payload.mode === 'coverage') {
    setupCoverage(vitest, rt);
    return;
  }

  // mutate and static
  const plan = payload.plan ?? {};
  // Static mode: active before the test file imports anything, since this setup file runs first.
  // With a per-file plan, each test file (each with its own module graph) gets its own mutant.
  const staticMutant = payload.staticPlan && currentFile ? (payload.staticPlan[normPath(currentFile)] ?? -1) : (payload.staticMutant ?? -1);
  if (payload.mode === 'static') activateStatic(rt, staticMutant, payload.staticLimit);

  // Vitest parses hook sources: the first parameter must be a destructuring pattern.
  vitest.beforeAll(({}, file) => {
    // Tests that come before a planned one still run, unmutated, as they did in the coverage run:
    // a test often depends on what an earlier one left behind (a registered handler, a filled
    // registry), and skipping them sends it down a different path — which the engine sees as the
    // mutant going unreached, and pays for with an isolated run. Tests after the last planned one
    // cannot affect it and are skipped.
    const all: Task[] = [];
    walk(file, (t) => all.push(t));
    let last = -1;
    all.forEach((t, i) => {
      if (plan[idOf(t)]?.length) last = i;
    });
    all.forEach((t, i) => {
      const tries = plan[idOf(t)];
      if (!tries || tries.length === 0) {
        if (i > last && (t.mode === 'run' || t.mode === 'queued')) t.mode = 'skip';
        t.concurrent = false;
        return;
      }
      t.repeats = tries.length - 1;
      t.retry = 0;
      t.concurrent = false;
      t.meta.tzap = [];
    });
  });

  vitest.beforeEach(({ task }) => {
    const tries = plan[idOf(task)];
    if (!tries) return;
    // Vitest keeps unawaited `expect(...).resolves` promises on the test and awaits them after
    // every repetition: one that a previous try left hanging would time out every later try.
    task.promises = undefined;
    const i = task.result?.repeatCount ?? 0;
    const tr = tries[i]!;
    // m === -1 is a control try: the test unmutated, bracketing the mutant tries so the engine
    // can tell a test that fails because of its context from one that fails because of a mutant.
    // A kill decides the mutant: its remaining tries, warm or isolated, would decide nothing.
    if (tr.m >= 0 && ws.killed.has(tr.m)) {
      rt.a = -1;
      throw new Error(SKIP);
    }
    ws.progress?.(payload.runId, idOf(task), tr.m, false);
    beginTry(rt, payload.mode === 'static' ? staticMutant : tr.m, tr.N, tr.L);
  });

  vitest.afterEach(({ task }) => {
    const tries = plan[idOf(task)];
    if (!tries) return;
    const i = task.result?.repeatCount ?? 0;
    const tr = tries[i]!;
    ws.progress?.(payload.runId, idOf(task), tr.m, true);
    const reached = rt.n > 0;
    const { hung } = endTry(rt);
    if (payload.mode === 'static') activateStatic(rt, staticMutant, payload.staticLimit);
    const failed = task.result?.state === 'fail';
    const message = failed ? firstMessage(task) : undefined;
    let outcome: TryOutcome;
    if (message === SKIP) outcome = 'X';
    else if (hung) outcome = 'T';
    else if (payload.mode === 'mutate' && tr.m >= 0 && !reached) outcome = 'U';
    else outcome = failed !== (task.fails === true) ? 'K' : 'S';
    if ((outcome === 'K' || outcome === 'T') && tr.m >= 0) ws.killed.add(tr.m);
    (task.meta.tzap as Array<[number, TryOutcome, string?]>).push(
      outcome === 'K' && message !== undefined ? [tr.m, outcome, message] : [tr.m, outcome],
    );
    if (task.result && failed) {
      task.result.state = 'pass';
      task.result.errors = undefined;
    }
  });
}

/** Thrown into a coverage test's second run when the first reached no mutant. */
const NO_REPEAT = 'tzap: not repeated, the first run reached no mutant';

/**
 * Coverage runs every test twice in a row. The first run is the coverage; the second shows
 * whether the test behaves the same once the modules it uses are warm. A test whose second run
 * takes a different path, or fails, depends on state its first run left behind (a memo, a
 * counter, a cache), and the warm engine cannot trust mutant tries that such a test decides.
 *
 * A test whose first run passed and reached no mutant decides no warm try, whatever its second
 * run would show: it is planned against no mutant, and static mutants are decided in fresh runs.
 * Its second run is skipped the way a killed mutant's try is, by throwing from this (first)
 * beforeEach, so neither the user's beforeEach hooks nor the body run. In a diff run most tests
 * of the files that reach the change are such tests, and some are slow (real timers).
 */
function setupCoverage(vitest: Vitest, rt: TzapRuntime): void {
  const outside = new Map<number, number>();
  let outsideLoops = 0;
  const collectOutside = () => {
    for (const [site, n] of drainHits(rt)) outside.set(site, (outside.get(site) ?? 0) + n);
    outsideLoops += rt.l;
    rt.l = 0;
  };
  // Vitest parses hook sources: the first parameter must be a destructuring pattern.
  vitest.beforeAll(({}, file) => {
    // Hits so far belong to module evaluation and collection of this file: static.
    collectOutside();
    walk(file, (t) => {
      if (t.mode !== 'run' && t.mode !== 'queued') return;
      t.repeats = 1;
      t.retry = 0;
      // Hit counters are global: tests running concurrently would mix their coverage.
      t.concurrent = false;
    });
  });
  let started = 0;
  vitest.beforeEach(({ task }) => {
    if ((task.result?.repeatCount ?? 0) > 0 && task.meta.tzapNoRepeat === true) throw new Error(NO_REPEAT);
    collectOutside();
    endTry(rt);
    started = performance.now();
  });
  vitest.afterEach(({ task }) => {
    const rep = task.result?.repeatCount ?? 0;
    if (rep > 0 && task.meta.tzapNoRepeat === true) {
      if (task.result) {
        task.result.state = 'pass';
        task.result.errors = undefined;
      }
      return;
    }
    const hits = drainHits(rt);
    if (rep === 0) {
      task.meta.tzapHits = hits;
      task.meta.tzapLoops = rt.l;
      task.meta.tzapDuration = performance.now() - started;
      if (task.result?.state === 'fail') task.meta.tzapRed = true;
      else if (hits.length === 0 && task.fails !== true) task.meta.tzapNoRepeat = true;
    } else {
      task.meta.tzapHits2 = hits;
      if (task.result?.state === 'fail' && task.meta.tzapRed !== true) {
        // Passed once, failed when repeated: the test is not repeatable. Not a red test.
        task.meta.tzapRepeatFail = firstMessage(task) ?? 'failed';
        task.result.state = 'pass';
        task.result.errors = undefined;
      }
    }
    endTry(rt);
  });
  vitest.afterAll(({}, file) => {
    collectOutside();
    file.meta.tzapStatic = [...outside];
    file.meta.tzapLoadLoops = outsideLoops;
    outside.clear();
    outsideLoops = 0;
  });
}
