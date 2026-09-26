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
import { beginTry, drainHits, endTry, install, type TzapRuntime } from '@tzap/runtime';
import { PROGRESS_CHANNEL, type RunMode, type Try, type TryOutcome } from '@tzap/protocol';

interface Payload {
  runId: number;
  mode: RunMode;
  plan?: Record<string, Try[]>;
  staticMutant?: number;
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
  killed: Set<number>;
  channel: { postMessage(m: unknown): void } | undefined;
}

function workerState(): WorkerState {
  const g = globalThis as unknown as { __tzapWorker?: WorkerState };
  g.__tzapWorker ??= { runId: -1, killed: new Set(), channel: undefined };
  return g.__tzapWorker;
}

function walk(suite: Task, f: (t: Task) => void): void {
  for (const t of suite.tasks ?? []) {
    if (t.type === 'test') f(t);
    else walk(t, f);
  }
}

const firstMessage = (t: Task) => {
  const m = t.result?.errors?.[0]?.message;
  return m === undefined ? undefined : m.length > 300 ? `${m.slice(0, 297)}...` : m;
};

export function setup(vitest: Vitest): void {
  const rt: TzapRuntime = install();
  const payload = (vitest.inject('tzap') ?? { runId: 0, mode: 'coverage' }) as Payload;
  const ws = workerState();
  if (ws.runId !== payload.runId) {
    ws.runId = payload.runId;
    ws.killed = new Set();
  }
  if (ws.channel === undefined && typeof BroadcastChannel !== 'undefined') {
    try {
      const BC = (globalThis as unknown as { BroadcastChannel: new (n: string) => { postMessage(m: unknown): void } }).BroadcastChannel;
      ws.channel = new BC(PROGRESS_CHANNEL);
      (ws.channel as unknown as { unref?: () => void }).unref?.();
    } catch {
      ws.channel = undefined;
    }
  }

  if (payload.mode === 'coverage') {
    setupCoverage(vitest, rt);
    return;
  }

  // mutate and static
  const plan = payload.plan ?? {};
  if (payload.mode === 'static') {
    // Active before the test file imports anything: this setup file runs first.
    rt.a = payload.staticMutant ?? -1;
  }

  // Vitest parses hook sources: the first parameter must be a destructuring pattern.
  vitest.beforeAll(({}, file) => {
    walk(file, (t) => {
      const tries = plan[t.id];
      if (!tries || tries.length === 0) {
        if (t.mode === 'run' || t.mode === 'queued') t.mode = 'skip';
        return;
      }
      t.repeats = tries.length - 1;
      t.retry = 0;
      t.concurrent = false;
      t.meta.tzap = [];
    });
  });

  vitest.beforeEach(({ task }) => {
    const tries = plan[task.id];
    if (!tries) return;
    // Vitest keeps unawaited `expect(...).resolves` promises on the test and awaits them after
    // every repetition: one that a previous try left hanging would time out every later try.
    task.promises = undefined;
    const i = task.result?.repeatCount ?? 0;
    const tr = tries[i]!;
    // m === -1 is a control try: the test unmutated, bracketing the mutant tries so the engine
    // can tell a test that fails because of its context from one that fails because of a mutant.
    if (payload.mode === 'mutate' && tr.m >= 0 && ws.killed.has(tr.m)) {
      rt.a = -1;
      throw new Error(SKIP);
    }
    ws.channel?.postMessage([payload.runId, task.id, tr.m]);
    beginTry(rt, payload.mode === 'static' ? (payload.staticMutant ?? -1) : tr.m, tr.N, tr.L);
  });

  vitest.afterEach(({ task }) => {
    const tries = plan[task.id];
    if (!tries) return;
    const i = task.result?.repeatCount ?? 0;
    const tr = tries[i]!;
    const reached = rt.n > 0;
    const { hung } = endTry(rt);
    if (payload.mode === 'static') rt.a = payload.staticMutant ?? -1;
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

/**
 * Coverage runs every test twice in a row. The first run is the coverage; the second shows
 * whether the test behaves the same once the modules it uses are warm. A test whose second run
 * takes a different path, or fails, depends on state its first run left behind (a memo, a
 * counter, a cache), and the warm engine cannot trust mutant tries that such a test decides.
 */
function setupCoverage(vitest: Vitest, rt: TzapRuntime): void {
  const outside = new Map<number, number>();
  const collectOutside = () => {
    for (const [site, n] of drainHits(rt)) outside.set(site, (outside.get(site) ?? 0) + n);
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
  vitest.beforeEach(() => {
    collectOutside();
    endTry(rt);
    started = performance.now();
  });
  vitest.afterEach(({ task }) => {
    const rep = task.result?.repeatCount ?? 0;
    const hits = drainHits(rt);
    if (rep === 0) {
      task.meta.tzapHits = hits;
      task.meta.tzapLoops = rt.l;
      task.meta.tzapDuration = performance.now() - started;
      if (task.result?.state === 'fail') task.meta.tzapRed = true;
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
    outside.clear();
  });
}
