import type { MutantResult, MutantStatus } from './mutant.js';

export interface TestInfo {
  /** Stable id from the runner adapter. */
  id: string;
  /** Full name, suites joined by " > ". */
  name: string;
  /** Test file relative to the model root. */
  file: string;
  /** Milliseconds the test took in the coverage run. */
  duration?: number;
  /**
   * Hash of the test file and every file it can import: the cache's key for "nothing this test
   * can reach has changed".
   */
  closure?: string;
}

export interface SourceFile {
  language: string;
  source: string;
}

/** The complete record of one analysis: the native JSON report, and every reporter's input. */
export interface AnalysisResult {
  tzapVersion: string;
  root: string;
  files: Record<string, SourceFile>;
  mutants: MutantResult[];
  tests: TestInfo[];
  /** Tests that failed with no mutant active, excluded from selection. */
  redTests: Array<TestInfo & { message: string }>;
  config: {
    engine: string;
    typecheck: 'off' | 'survivors' | 'all';
    mutators: string[];
    filters: string[];
    scope: string;
  };
  /** Phase timings in milliseconds. The only part of a report allowed to differ between runs. */
  timings: Record<string, number>;
}

export interface Score {
  total: number;
  killed: number;
  survived: number;
  noCoverage: number;
  timeout: number;
  compileError: number;
  runtimeError: number;
  ignored: number;
  pending: number;
  detected: number;
  undetected: number;
  covered: number;
  valid: number;
  invalid: number;
  /** detected / valid, as a percentage; NaN when nothing is valid. */
  mutationScore: number;
  /** detected / covered: test strength, ignoring mutants no test reaches. */
  mutationScoreBasedOnCoveredCode: number;
}

/**
 * The mutation-testing-elements metric definitions, exactly: Timeout counts as detected;
 * CompileError and RuntimeError are outside both denominators, since the tests were never given
 * the chance to detect them; Ignored is outside everything but the total.
 */
export function score(mutants: ReadonlyArray<{ status: MutantStatus }>): Score {
  const c: Record<MutantStatus, number> = {
    Killed: 0,
    Survived: 0,
    NoCoverage: 0,
    Timeout: 0,
    CompileError: 0,
    RuntimeError: 0,
    Ignored: 0,
    Pending: 0,
  };
  for (const m of mutants) c[m.status]++;
  const detected = c.Killed + c.Timeout;
  const undetected = c.Survived + c.NoCoverage;
  const covered = detected + c.Survived;
  const valid = detected + undetected;
  const invalid = c.CompileError + c.RuntimeError;
  return {
    total: mutants.length,
    killed: c.Killed,
    survived: c.Survived,
    noCoverage: c.NoCoverage,
    timeout: c.Timeout,
    compileError: c.CompileError,
    runtimeError: c.RuntimeError,
    ignored: c.Ignored,
    pending: c.Pending,
    detected,
    undetected,
    covered,
    valid,
    invalid,
    mutationScore: valid === 0 ? NaN : (detected / valid) * 100,
    mutationScoreBasedOnCoveredCode: covered === 0 ? NaN : (detected / covered) * 100,
  };
}

/**
 * Whether a mutation score meets a threshold. A run with nothing to score (no valid mutant: a
 * diff that touched no mutable code) meets any threshold: there is nothing its tests missed.
 */
export function meetsThreshold(mutationScore: number, threshold: number): boolean {
  return Number.isNaN(mutationScore) || mutationScore >= threshold;
}

export function languageOf(file: string): string {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'tsx':
      return 'tsx';
    case 'jsx':
      return 'jsx';
    case 'vue':
      return 'vue';
    case 'svelte':
      return 'svelte';
    default:
      return 'javascript';
  }
}
