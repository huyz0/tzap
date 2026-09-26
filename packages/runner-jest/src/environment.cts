/**
 * The tzap test environment: a subclass of whatever environment the project configured (node,
 * jsdom, a custom one), created by a generated shim. It runs outside the test VM, in the host
 * process (`runInBand`), and drives everything through jest-circus's `handleTestEvent`.
 *
 * How many mutants run in one Jest run (see docs/spikes/B-jest-warm.md): jest-circus re-runs a
 * failed test immediately, with its full beforeEach -> body -> afterEach cycle, while
 * `RETRY_TIMES` allows and the test has errors. At `run_start` tzap sets the retry budget to the
 * longest plan in the file and `RETRY_IMMEDIATELY`; at `test_start` it activates the try's mutant
 * (`test.invocations` numbers the tries); at `test_done` it records the outcome and then either
 * leaves the test failed (pushing a marker error if it passed) so circus runs the next try, or,
 * after the last try, clears the errors so the test reports green.
 *
 * Jest 29's circus has no `RETRY_IMMEDIATELY`: it runs a failed test's retries after the other
 * tests of its describe block. Every retry is still the full cycle, so the same handler works; a
 * test's first try runs in its place, the rest after its siblings' first tries.
 */
import type { TzapRuntime } from '@tzap/runtime';
import runtime = require('@tzap/runtime');
import type { TestOutcome, Try, TryOutcome } from '@tzap/protocol';
import path = require('node:path');
import type { RunState, StateKey } from './shared.cjs';

const { beginTry, drainHits, endTry, install } = runtime;
const STATE_KEY: StateKey = '__tzapJestRun';
const runState = () => (globalThis as unknown as Record<StateKey, RunState | undefined>)[STATE_KEY];

/** Thrown into a try whose mutant was already killed in this run. */
const SKIP = 'tzap: skipped, mutant already killed in this run';
/** Thrown into a coverage repeat when the first run reached no mutant. */
const NO_REPEAT = 'tzap: not repeated, the first run reached no mutant';
/** Keeps a passing try "failed" so circus's retry loop runs the next one. */
const NEXT = 'tzap: next try';

const RETRY_TIMES = Symbol.for('RETRY_TIMES');
const RETRY_IMMEDIATELY = Symbol.for('RETRY_IMMEDIATELY');
const LOG_ERRORS_BEFORE_RETRY = Symbol.for('LOG_ERRORS_BEFORE_RETRY');
const WAIT_BEFORE_RETRY = Symbol.for('WAIT_BEFORE_RETRY');

/**
 * The marker errors are made once: a new Error per try would capture (and Jest would source-map)
 * a stack every time, which measured as half the cost of a try.
 */
const marker = (m: string) => Object.assign(new Error(m), { stack: m });
const SKIP_ERROR = marker(SKIP);
const NO_REPEAT_ERROR = marker(NO_REPEAT);
const NEXT_ERROR = marker(NEXT);

interface CircusTest {
  type: 'test';
  name: string;
  mode?: string;
  concurrent?: boolean;
  parent: CircusBlock;
  errors: unknown[];
  invocations: number;
}
interface CircusBlock {
  type: 'describeBlock';
  name: string;
  mode?: string;
  parent?: CircusBlock;
  children: Array<CircusBlock | CircusTest>;
}
interface CircusState {
  rootDescribeBlock: CircusBlock;
  maxConcurrency: number;
}
interface CircusEvent {
  name: string;
  test?: CircusTest;
}

interface Rec {
  id: string;
  name: string;
  /** Tries planned for this test; coverage plans two unmutated ones. */
  plan: Try[];
  tries: Array<[number, TryOutcome, string?]>;
  ran: boolean;
  started: number;
  duration: number;
  hits?: Array<[number, number]>;
  hits2?: Array<[number, number]>;
  loops?: number;
  red?: string;
  repeatFail?: string;
  /** Coverage: the first run passed and reached no mutant, so the second is skipped (as in runner-vitest). */
  noRepeat?: boolean;
}

type Env = new (...args: any[]) => {
  global: Record<string | symbol, unknown>;
  handleTestEvent?(event: CircusEvent, state: CircusState): unknown;
};

const ANSI = /\u001b\[[0-9;]*m/g;

function message(e: unknown): string {
  const err = Array.isArray(e) ? e[0] : e;
  const m = err instanceof Error || (typeof err === 'object' && err !== null && 'message' in err) ? String((err as Error).message) : String(err);
  const s = m.replace(ANSI, '');
  return s.length > 300 ? `${s.slice(0, 297)}...` : s;
}

/** As @tzap/protocol's sameHits: this module runs inside Jest's CommonJS sandbox, which cannot load that one. */
function sameHits(a: Array<[number, number]>, b: Array<[number, number]>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]![0] !== b[i]![0] || a[i]![1] !== b[i]![1]) return false;
  return true;
}

const slash = (p: string) => p.replace(/\\/g, '/');

/** Returns the project's environment class extended with tzap's event handling. */
function extend(Base: Env): Env {
  return class TzapEnvironment extends Base {
    private readonly tzapRun: RunState | undefined;
    private readonly tzapFile: string;
    private readonly rt: TzapRuntime;
    private readonly recs = new Map<CircusTest, Rec>();
    private readonly outside = new Map<number, number>();

    constructor(...args: any[]) {
      super(...args);
      const context = args[1] as { testPath: string };
      this.tzapFile = slash(context.testPath);
      this.tzapRun = runState();
      // The runtime lives on the test VM's global, where instrumented code looks for it.
      this.rt = install(this.global as Record<string, unknown>);
      // Static: active before setupFiles and the test file evaluate anything.
      if (this.tzapRun?.mode === 'static') runtime.activateStatic(this.rt, this.tzapRun.staticMutant, this.tzapRun.staticLimit);
    }

    async handleTestEvent(event: CircusEvent, state: CircusState): Promise<void> {
      if (super.handleTestEvent) await super.handleTestEvent(event, state);
      const run = this.tzapRun;
      if (!run) return;
      switch (event.name) {
        case 'run_start':
          this.onRunStart(run, state);
          break;
        case 'test_start':
          this.onTestStart(run, event.test!);
          break;
        case 'test_done':
          this.onTestDone(run, event.test!);
          break;
        case 'run_finish':
          this.onRunFinish(run);
          break;
      }
    }

    private collectOutside(): void {
      for (const [site, n] of drainHits(this.rt)) this.outside.set(site, (this.outside.get(site) ?? 0) + n);
    }

    private onRunStart(run: RunState, state: CircusState): void {
      // Hits so far belong to module evaluation and collection of this file: static.
      this.collectOutside();
      const rel = slash(path.relative(run.rootDir, this.tzapFile));
      const seen = new Map<string, number>();
      let most = 1;
      const walk = (block: CircusBlock, names: string[]) => {
        for (const child of block.children) {
          if (child.type === 'describeBlock') {
            walk(child, [...names, child.name]);
            continue;
          }
          // Jest 29 starts a concurrent test's body once, ahead of the loop, and a retry awaits
          // that same promise again: only the first try would run. Such tests run in sequence.
          if (run.jestMajor < 30) child.concurrent = false;
          const name = [...names, child.name].join(' > ');
          const n = seen.get(name) ?? 0;
          seen.set(name, n + 1);
          const id = `${rel}::${name}${n > 0 ? ` #${n + 1}` : ''}`;
          let plan: Try[] | undefined;
          if (run.mode === 'coverage') {
            if (child.mode !== 'skip' && child.mode !== 'todo') plan = [{ m: -1, N: Infinity, L: Infinity }, { m: -1, N: Infinity, L: Infinity }];
          } else {
            plan = run.plan[id];
            if (!plan || plan.length === 0) {
              plan = undefined;
              if (child.mode !== 'todo') child.mode = 'skip';
            }
          }
          const rec: Rec = { id, name, plan: plan ?? [], tries: [], ran: false, started: 0, duration: 0 };
          this.recs.set(child, rec);
          if (plan) most = Math.max(most, plan.length);
        }
      };
      walk(state.rootDescribeBlock, []);
      // Every try of a test runs back to back; any retry setting of the suite's own is replaced.
      this.global[RETRY_TIMES] = most - 1;
      this.global[RETRY_IMMEDIATELY] = true;
      this.global[LOG_ERRORS_BEFORE_RETRY] = false;
      this.global[WAIT_BEFORE_RETRY] = 0;
      // Hit counters and the active mutant are global: concurrent tests would mix them.
      state.maxConcurrency = 1;
    }

    private onTestStart(run: RunState, test: CircusTest): void {
      const rec = this.recs.get(test);
      if (!rec || rec.plan.length === 0) return;
      const i = test.invocations - 1;
      rec.ran = true;
      if (run.mode === 'coverage') {
        this.collectOutside();
        endTry(this.rt);
        rec.started = performance.now();
        // The repeat of a test that reached no mutant decides nothing: an error before the hooks,
        // so circus runs neither beforeEach nor the body.
        if (i > 0 && rec.noRepeat) test.errors.push(NO_REPEAT_ERROR);
        return;
      }
      const tr = rec.plan[i];
      if (!tr) return;
      rec.started = performance.now();
      // m === -1 is a control try: the test unmutated, bracketing the mutant tries so the engine
      // can tell a test that fails because of its context from one that fails because of a mutant.
      if (run.mode === 'mutate' && tr.m >= 0 && run.killed.has(tr.m)) {
        this.rt.a = -1;
        // An error before the hooks: circus skips beforeEach and the body, runs afterEach.
        test.errors.push(SKIP_ERROR);
        return;
      }
      run.progress(rec.id, tr.m);
      beginTry(this.rt, run.mode === 'static' ? run.staticMutant : tr.m, tr.N, tr.L);
    }

    private onTestDone(run: RunState, test: CircusTest): void {
      const rec = this.recs.get(test);
      if (!rec || rec.plan.length === 0) return;
      const i = test.invocations - 1;
      const failed = test.errors.length > 0;
      if (run.mode === 'coverage') {
        const hits = drainHits(this.rt);
        if (i === 0) {
          rec.hits = hits;
          rec.loops = this.rt.l;
          rec.duration = performance.now() - rec.started;
          if (failed) rec.red = message(test.errors[0]);
          else if (hits.length === 0) rec.noRepeat = true;
        } else if (rec.noRepeat) {
          // Not repeated.
        } else {
          rec.hits2 = hits;
          // Passed once, failed when repeated: the test is not repeatable. Not a red test.
          if (failed && rec.red === undefined && rec.repeatFail === undefined) rec.repeatFail = message(test.errors[0]);
        }
        endTry(this.rt);
      } else {
        const tr = rec.plan[i];
        if (tr) {
          const reached = this.rt.n > 0;
          const { hung } = endTry(this.rt);
          if (run.mode === 'static') runtime.activateStatic(this.rt, run.staticMutant, run.staticLimit);
          if (i === 0) rec.duration = performance.now() - rec.started;
          const msg = failed ? message(test.errors[0]) : undefined;
          let outcome: TryOutcome;
          if (msg === SKIP) outcome = 'X';
          else if (hung) outcome = 'T';
          else if (run.mode === 'mutate' && tr.m >= 0 && !reached) outcome = 'U';
          else outcome = failed ? 'K' : 'S';
          if ((outcome === 'K' || outcome === 'T') && tr.m >= 0) run.killed.add(tr.m);
          rec.tries.push(outcome === 'K' && msg !== undefined ? [tr.m, outcome, msg] : [tr.m, outcome]);
        }
      }
      if (i < rec.plan.length - 1) {
        // circus retries while the test has errors: keep it "failed" for the next try.
        if (test.errors.length === 0) test.errors.push(NEXT_ERROR);
      } else {
        // Last try: the test reports green; its verdicts are in tzap's record, not Jest's.
        test.errors.length = 0;
      }
    }

    private onRunFinish(run: RunState): void {
      this.collectOutside();
      if (run.mode === 'coverage') run.staticHits.set(this.tzapFile, [...this.outside].sort((a, b) => a[0] - b[0]));
      this.outside.clear();
      for (const rec of this.recs.values()) {
        const out: TestOutcome = {
          id: rec.id,
          name: rec.name,
          file: this.tzapFile,
          state: !rec.ran ? 'skip' : rec.red !== undefined ? 'fail' : 'pass',
          duration: rec.duration,
        };
        if (run.mode === 'coverage') {
          if (rec.red !== undefined) out.message = rec.red;
          if (rec.hits) out.hits = rec.hits;
          if (rec.loops !== undefined) out.loops = rec.loops;
          if (rec.repeatFail !== undefined) out.stateSensitive = `fails when repeated: ${rec.repeatFail}`;
          else if (rec.hits && rec.hits2 && !sameHits(rec.hits, rec.hits2)) out.stateSensitive = 'takes a different path when repeated';
        } else if (rec.plan.length > 0) {
          // A try that never ran (a beforeAll failed, say) decided nothing: unreached.
          if (run.mode === 'mutate') for (let i = rec.tries.length; i < rec.plan.length; i++) {
            const m = rec.plan[i]!.m;
            rec.tries.push(m >= 0 ? [m, 'U'] : [m, 'K', 'tzap: control try did not run']);
          }
          out.tries = rec.tries;
        }
        run.tests.push(out);
      }
    }
  };
}

export = { extend };
