/** The engine's public options, events and the coverage facts it hands the cache. */
import type { AnalysisResult, MutantDescriptor, MutantResult, TestInfo } from '@tzap/model';
import type { LineRange, MutantFilter } from '@tzap/instrument';
import type { RunnerFactory } from '@tzap/protocol';

export type EngineKind = 'warm' | 'reference';

export interface EngineOptions {
  engine?: EngineKind;
  /** Enabled mutator names; default all. */
  mutators?: readonly string[];
  filters?: ReadonlyArray<{ name: string; filter: MutantFilter }>;
  /**
   * Re-decide warm survivors in isolation before reporting them. A warm try can be masked by
   * state an earlier run of the same test left behind: a mutant that removes a registration
   * survives because the registration is still there from the run before. Kills need no second
   * look — a test failed with the mutant active — but a survivor is what people act on.
   * `'auto'` (the default) confirms the survivors whose tests can reach module state, `true`
   * every survivor, `false` none (faster, and a masked kill can then pass as a survivor).
   */
  verifySurvivors?: boolean | 'auto';
  /** Opt-in reductions: see InstrumentInput.reduce. */
  reduce?: { onePerLine?: boolean; equivalence?: boolean };
  /** Changed lines per root-relative file. Undefined: everything is in scope. Files absent from the map are out of scope. */
  lines?: ReadonlyMap<string, readonly LineRange[]>;
  /** Runner factories by runner kind. */
  runners: Readonly<Record<string, RunnerFactory>>;
  /** Worker count passed to each runner. */
  workers?: number;
  /**
   * Let runners use worker threads where the project has not chosen how its tests run (default
   * true). A package whose baseline is not clean in threads falls back to its own setting.
   */
  preferThreads?: boolean;
  /** Concurrent sessions for the reference engine. */
  concurrency?: number;
  /** Previously killing test per mutant id, from the cache: tried first. */
  previousKillers?: ReadonlyMap<string, string>;
  /** Verdicts to reuse, keyed by mutant id (decided by the cache). */
  reuse?: (m: MutantDescriptor, coverage: MutantCoverage) => MutantResult | undefined;
  /**
   * Set when nothing that could change a verdict has changed since the cache was written: if
   * every mutant is found, no test runs at all.
   */
  unchanged?: { lookup(m: MutantDescriptor): MutantResult | undefined; tests: TestInfo[]; red: AnalysisResult['redTests'] };
  onEvent?: (e: EngineEvent) => void;
  /**
   * Type-checks mutants: returns, per mutant number, the first diagnostic for each mutant the
   * checker rejects. `survivors` checks mutants the tests did not detect; `all` checks every
   * placed mutant before any test runs, so type-invalid ones never run.
   */
  typecheck?: { mode: 'survivors' | 'all'; check: (mutants: readonly MutantDescriptor[], root: string) => Promise<Map<number, string>> };
  tzapVersion: string;
  /** Scratch directory for instrumented sources and runner files. Default: a new one, removed at the end. */
  tmpDir?: string;
}

export type EngineEvent =
  | { type: 'phase'; phase: string }
  | { type: 'inventory'; files: number; mutants: number; placed: number }
  | { type: 'coverage'; tests: number; red: number }
  | { type: 'narrowed'; pkg: string; files: number; of: number }
  | { type: 'round'; round: number; tries: number; ms: number }
  | { type: 'progress'; decided: number; total: number }
  | { type: 'warning'; message: string }
  | { type: 'info'; message: string };

/** What the coverage run says about one mutant, handed to the cache so it can decide reuse. */
export interface MutantCoverage {
  static: boolean;
  /** Global test keys that reach the mutant. */
  tests: string[];
  /** Import-closure hash per global test key. */
  closures: ReadonlyMap<string, string>;
  /**
   * Static mutants: every test an isolated run would run against it (all green tests of every
   * file that reached it). Its verdict holds while exactly these run and none of them changed.
   */
  ran?: string[];
}
