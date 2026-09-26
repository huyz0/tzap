/**
 * State shared between the Jest host and the code Jest loads into the same process: the test
 * environment (outside the test VM, in the host's realm) and the transformer. With `runInBand`
 * every test file runs in the host process, so a plain global carries the run's plan in and the
 * outcomes out, and progress goes straight to the host's progress file.
 */
import type { RunMode, TestOutcome, Try } from '@tzap/protocol';

export interface RunState {
  runId: number;
  mode: RunMode;
  plan: Record<string, Try[]>;
  staticMutant: number;
  /** Loop limit while the static mutant is active outside a try; the runtime's default when unset. */
  staticLimit?: number;
  /** The project's Jest major version: 29 or 30. */
  jestMajor: number;
  /** Mutants killed so far in this run, across test files: their later tries are skipped. */
  killed: Set<number>;
  /** Directory test ids are relative to (the project's rootDir). */
  rootDir: string;
  tests: TestOutcome[];
  /** Absolute test-file path (forward slashes) -> sites hit outside any test. */
  staticHits: Map<string, Array<[number, number]>>;
  /** Records that a try started or ended, synchronously: a try that never ends is on record. */
  progress(test: string, mutant: number, done: boolean): void;
}

/** The host-realm global holding the current run's {@link RunState}. */
export type StateKey = '__tzapJestRun';
