/**
 * The contract between the engine and a runner session, and the messages a runner host
 * exchanges with the engine. Zero dependencies beyond the model; payloads are plain data so they
 * survive structured clone and JSON alike.
 */
import type { PackageModel } from '@tzap/model';

/** One attempt at a mutant against one test. */
export interface Try {
  /** Mutant number. */
  m: number;
  /** Limit on the mutant's replacement being evaluated before the try is declared hung. */
  N: number;
  /** Limit on loop back-edges before the try is declared hung. */
  L: number;
}

/**
 * - `coverage`: nothing active; record per-test hits, loop counts, durations and red tests.
 * - `mutate`: warm; per test, try each planned mutant in turn (runtime activation).
 * - `static`: one mutant active before any module evaluates; the named tests run once each.
 */
export type RunMode = 'coverage' | 'mutate' | 'static';

export interface RunRequest {
  id: number;
  mode: RunMode;
  /** Absolute test-file paths to run; undefined runs every test file. */
  files?: string[];
  /** `mutate`: test id -> ordered tries. `static`: test id -> [one try]. Tests not listed are skipped. */
  plan?: Record<string, Try[]>;
  /** `static`: the mutant active for the whole run. */
  staticMutant?: number;
  /**
   * `static`, for runners that isolate every test file: a different mutant per test file, keyed by
   * `normPath` of the file, so one run decides several static mutants.
   */
  staticPlan?: Record<string, number>;
  /** `static`: loop and hit limit outside any test, measured from the unmutated files' loading. */
  staticLimit?: number;
  /** Wall-clock budget for the whole run, after which the session is killed. */
  budgetMs?: number;
}

/**
 * Outcome letter of a try: Killed, Survived, Timeout (declared hung), X (skipped: already killed
 * this round), or U (unreached: the mutant's code never ran during the try, so whatever the test
 * did, the mutant did not decide it — state left by an earlier try, a memo, a cache).
 */
export type TryOutcome = 'K' | 'S' | 'T' | 'X' | 'U';

export interface TestOutcome {
  id: string;
  /** Full name, suites joined by " > ". */
  name: string;
  /** Absolute path of the test file. */
  file: string;
  state: 'pass' | 'fail' | 'skip';
  duration: number;
  /** First failure message, for a test that failed unmutated (coverage) or a static kill. */
  message?: string;
  /** `coverage`: [site, hits] pairs reached inside this test. */
  hits?: Array<[number, number]>;
  /** `coverage`: loop back-edges taken inside this test. */
  loops?: number;
  /**
   * `coverage`: the test ran a second time, warm, and took a different path or failed. Its
   * verdicts in warm mutant runs could be decided by state rather than by the mutant.
   */
  stateSensitive?: string;
  /** `mutate`/`static`: [mutant, outcome, message?] per try, in order. */
  tries?: Array<[number, TryOutcome, string?]>;
}

export interface FileOutcome {
  /** Absolute path of the test file. */
  file: string;
  /** The file failed to load or a hook outside any test failed. */
  error?: string;
  /** `coverage`: sites reached outside any test while this file ran (module evaluation, hooks). */
  staticHits?: Array<[number, number]>;
  /** `coverage`: loop back-edges taken outside any test while this file ran (loading, hooks). */
  loadLoops?: number;
}

export interface RunResult {
  id: number;
  tests: TestOutcome[];
  files: FileOutcome[];
  /**
   * Errors the runner caught outside any test's own result — an exception thrown from a timer
   * after the test that set it finished, an unhandled rejection. They fail the run, but belong to
   * no single try.
   */
  unhandledErrors?: string[];
  /** The session was killed by the wall-clock backstop; `inFlight` names what was running. */
  timedOut?: boolean;
  inFlight?: Array<{ test: string; mutant: number }>;
  durationMs: number;
}

export interface SessionOptions {
  /** Absolute model root. */
  root: string;
  pkg: PackageModel;
  /** Absolute path of a JSON file mapping absolute source paths to instrumented `{ code, map }`. */
  instrumented: string;
  /** Force module isolation between test files (static mutants need it). */
  isolate?: boolean;
  /** Worker count for the runner's own pool. */
  workers?: number;
  /** Absolute scratch directory the session may write to. */
  tmpDir: string;
}

export interface RunnerSession {
  readonly kind: string;
  /**
   * `isolatesFiles`: every test file gets fresh module state on every run (Jest does), so a
   * static mutant can run in this same session rather than in a separately isolated one.
   */
  start(): Promise<{ runnerVersion: string; isolatesFiles?: boolean; staticPerFile?: boolean }>;
  /** Absolute paths of every test file the runner would run. Optional: without it, a diff run cannot narrow its coverage phase. */
  listFiles?(): Promise<string[]>;
  run(request: RunRequest): Promise<RunResult>;
  close(): Promise<void>;
}

export type RunnerFactory = (options: SessionOptions) => RunnerSession;

// --- messages between an engine and a host process ----------------------------------------

export type HostRequest =
  | { type: 'init'; options: SessionOptions }
  | { type: 'run'; request: RunRequest }
  | { type: 'list' }
  | { type: 'close' };

export type HostResponse =
  | { type: 'ready'; runnerVersion: string; isolatesFiles?: boolean }
  | { type: 'result'; result: RunResult }
  | { type: 'files'; files: string[] }
  | { type: 'progress'; runId: number; test: string; mutant: number }
  | { type: 'error'; message: string; during: 'init' | 'run' | 'background' };

/** Name of the BroadcastChannel runner workers report progress on, so a hang can be attributed. */
export const PROGRESS_CHANNEL = 'tzap-progress';

// --- progress files -------------------------------------------------------------------------
//
// A runner worker that a mutant has hung synchronously cannot say so: its event loop is blocked.
// So every worker overwrites a one-line file as each try starts and ends, and the engine side
// reads them when a run goes silent. Files rather than messages, because they work the same for
// worker threads and child processes and need nothing of the runner's own IPC.

/** The one spelling of a path both sides use as a key: forward slashes, and lower case on Windows. */
export function normPath(p: string): string {
  const s = p.replace(/\\/g, '/');
  return typeof process !== 'undefined' && process.platform === 'win32' ? s.toLowerCase() : s;
}

/** Environment variable naming the directory runner workers write progress files into. */
export const PROGRESS_DIR_ENV = 'TZAP_PROGRESS_DIR';

export interface ProgressEntry {
  runId: number;
  test: string;
  mutant: number;
  /** The try finished; the worker is not stuck in it. */
  done: boolean;
  /** Last write, epoch milliseconds. */
  at: number;
}
export { progressWriter, readProgress } from './progress.js';
