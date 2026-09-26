/** A position in a source file. Both 1-based, as in the mutation-testing-elements schema. */
export interface Position {
  line: number;
  column: number;
}

export interface Location {
  start: Position;
  end: Position;
}

/**
 * The status set is the mutation-testing-elements schema's own, so that no translation layer can
 * drift between what tzap decides and what every existing viewer shows.
 */
export type MutantStatus =
  | 'Killed'
  | 'Survived'
  | 'NoCoverage'
  | 'Timeout'
  | 'CompileError'
  | 'RuntimeError'
  | 'Ignored'
  | 'Pending';

export const MUTANT_STATUSES: readonly MutantStatus[] = [
  'Killed',
  'Survived',
  'NoCoverage',
  'Timeout',
  'CompileError',
  'RuntimeError',
  'Ignored',
  'Pending',
];

/** A mutant as the inventory knows it, before anything has run. */
export interface MutantDescriptor {
  /**
   * Stable identity: a hash of (file, enclosing scope path, mutator, original text,
   * replacement, ordinal within the scope). Survives edits elsewhere in the file.
   */
  id: string;
  /** Run-local number, the value the instrumented switch compares against. Not stable. */
  num: number;
  /** Path relative to the model root, forward slashes. */
  file: string;
  mutatorName: string;
  location: Location;
  /** Source text that replaces the original at `location`. */
  replacement: string;
  /** Original source text at `location`. */
  original: string;
  description?: string;
  /** Instrumentation site whose coverage counter decides whether this mutant is reached. */
  site: number;
  /** Set when the mutant was dropped before running, with the reason in `statusReason`. */
  ignoredBy?: string;
}

export interface MutantResult extends MutantDescriptor {
  status: MutantStatus;
  statusReason?: string;
  /** Reached only while a module evaluated, never inside a test. */
  static?: boolean;
  killedBy?: string[];
  coveredBy?: string[];
  testsCompleted?: number;
  /** Milliseconds spent deciding this mutant. Excluded from determinism comparisons. */
  duration?: number;
  /** True when the verdict came from the incremental cache. */
  cached?: boolean;
}

export function compareMutants(a: MutantDescriptor, b: MutantDescriptor): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  const d =
    a.location.start.line - b.location.start.line ||
    a.location.start.column - b.location.start.column ||
    a.location.end.line - b.location.end.line ||
    a.location.end.column - b.location.end.column;
  if (d !== 0) return d;
  if (a.mutatorName !== b.mutatorName) return a.mutatorName < b.mutatorName ? -1 : 1;
  if (a.replacement !== b.replacement) return a.replacement < b.replacement ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
