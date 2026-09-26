/** State one analysis shares between its phases, and the small rules they all apply. */
import type { MutantDescriptor, MutantResult, PackageModel, TestInfo } from '@tzap/model';
import type { RunnerSession, Try } from '@tzap/protocol';
import type { EngineEvent, EngineOptions } from './options.js';

export interface TestRecord extends TestInfo {
  key: string;
  closure?: string;
  pkg: string;
  runnerId: string;
  hits: Map<number, number>;
  loops: number;
  red?: string;
  /**
   * Something the test can reach may keep mutable state between runs, so a warm survival could be
   * a masked kill and is confirmed in isolation (`verifySurvivors: auto`).
   */
  stateful?: boolean;
  /** Behaves differently when repeated warm: warm tries it decides cannot be trusted. */
  stateSensitive?: string;
}

/** A covered, non-static mutant waiting for the warm engine. */
export interface Pending {
  d: MutantDescriptor;
  /** Every covering test, in the order they are tried. */
  tests: string[];
  /** The covering tests the warm engine may try: those that are not state-sensitive. */
  warm: string[];
  cursor: number;
  completed: number;
}

/** A mutant for the isolated path, with the tests the warm engine meant for it. */
export interface IsolatedMutant {
  d: MutantDescriptor;
  tests: string[];
}

/** What the execution phases share: the coverage run's facts, the sessions, and the verdicts. */
export interface EngineRun {
  options: EngineOptions;
  emit: (e: EngineEvent) => void;
  root: string;
  /** Packages with a test runner, in model order. */
  runnerPackages: PackageModel[];
  /** Verdicts by mutant number. `Pending` marks one waiting for its isolated run. */
  results: Map<number, MutantResult>;
  /** Every test the coverage run reported, by global key. */
  tests: Map<string, TestRecord>;
  green: TestRecord[];
  /** Green tests by the site they reach. */
  siteTests: Map<number, TestRecord[]>;
  /** Site -> `pkgId\0testFile` of the files that reached it outside tests, while loading. */
  staticSites: Map<number, Set<string>>;
  /** The keys of the green tests an isolated run of a static mutant runs: its files' tests. */
  staticRan(d: MutantDescriptor): string[];
  /** The warm session of each package. */
  warm: Map<string, RunnerSession>;
  sessionFor(pkg: PackageModel, isolate?: boolean, workers?: number): RunnerSession;
  nextRunId(): number;
  /** Packages whose suite reports unhandled errors with no mutant active: there they carry no signal. */
  noisyUnhandled: Set<string>;
  /** Packages whose warm session already runs every test file in modules of its own. */
  isolatesFiles: Set<string>;
  /** Packages whose runner can activate a different static mutant in each test file. */
  staticPerFile: Set<string>;
  /** Loop back-edges each test file (normPath'd) took while loading. */
  loadLoops: Map<string, number>;
  /**
   * The backstop's silence window: how long no worker may start or finish a try before one is
   * declared stuck. Loops and repeated evaluation are caught long before by counting; this is
   * for a mutant that blocks outside instrumented code.
   */
  silenceMs: number;
  /** Placed mutants: the progress total. */
  total: number;
}

/** Mutants with a verdict; one waiting for its isolated run is not decided yet. */
export function decidedCount(run: EngineRun): number {
  let n = 0;
  for (const r of run.results.values()) if (r.status !== 'Pending') n++;
  return n;
}

/**
 * Fastest-first ordering by measured duration, coarsely: durations jitter from run to run, and an
 * order that follows the jitter changes which test is credited with a kill. Everything under 50 ms
 * is one class; above that, one class per factor of ten. Finer classes (5 ms, then per doubling)
 * still reordered millisecond tests on a loaded machine: a garbage collection or a busy neighbour
 * lifts a 1 ms test past 5 ms, never past 50.
 */
export function speedClass(ms: number | undefined): number {
  return ms === undefined || ms < 50 ? 0 : 1 + Math.floor(Math.log10(ms / 50));
}

const HIT_FACTOR = 100;
const HIT_FLOOR = 1000;
const LOOP_FACTOR = 10;
const LOOP_FLOOR = 100_000;

/** A try's hit and loop limits: well above what the unmutated test needed, with floors. */
export function limitsFor(t: TestRecord, site: number): Pick<Try, 'N' | 'L'> {
  return {
    N: Math.max(HIT_FLOOR, HIT_FACTOR * (t.hits.get(site) ?? 1)),
    L: Math.max(LOOP_FLOOR, LOOP_FACTOR * t.loops),
  };
}

/** An unmutated try. Controls bracket each test's mutant tries in a warm round. */
export function control(t: TestRecord): Try {
  return { m: -1, N: Infinity, L: Math.max(LOOP_FLOOR, LOOP_FACTOR * t.loops) };
}

/**
 * Closes sessions, all of them whatever any one does: a session that fails to close must neither
 * leave the others running nor replace the analysis's own result or error.
 */
export async function closeAll(sessions: Iterable<RunnerSession>): Promise<void> {
  await Promise.allSettled([...sessions].map((s) => s.close()));
}

/** Adds `value` to the set under `key`, creating it. */
export function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(value);
}

/** Wall-clock milliseconds per phase. */
export class Timer {
  readonly timings: Record<string, number> = {};
  private phase: string | undefined;
  private t = performance.now();
  start(phase: string) {
    this.stop();
    this.phase = phase;
    this.t = performance.now();
  }
  stop() {
    if (this.phase) this.timings[this.phase] = Math.round((this.timings[this.phase] ?? 0) + performance.now() - this.t);
    this.phase = undefined;
  }
}
