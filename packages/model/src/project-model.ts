/** Version of the project-model document. A different major is refused rather than guessed at. */
export const MODEL_SCHEMA_VERSION = 1;

/**
 * Everything the engine needs to know about a project, and nothing about how it was found.
 * Produced by `tzap model` (discovery) or written by hand; all paths are relative to `root`
 * unless absolute, and use forward slashes.
 */
export interface ProjectModel {
  schemaVersion: typeof MODEL_SCHEMA_VERSION;
  /** Absolute path of the repository or workspace root. */
  root: string;
  packages: PackageModel[];
  scope?: ScopeSpec;
  cache?: CacheSpec;
  reporters?: string[];
}

export type RunnerKind = 'vitest' | 'jest' | 'node' | 'mocha';

export interface RunnerSpec {
  kind: RunnerKind;
  /** Runner config file, relative to the model root. Optional: the runner's own lookup applies. */
  config?: string;
  /** Version found at discovery time, recorded so a cache can refuse a different one. */
  version?: string;
}

export interface PackageModel {
  /** Stable identifier, usually the package name. */
  id: string;
  /** Package directory, relative to the model root. */
  root: string;
  /** Globs, relative to the package root, of files to mutate. */
  sources: string[];
  /** Globs, relative to the package root, excluded from `sources`. */
  exclude?: string[];
  /**
   * Test-file globs relative to the package root. Absent means the runner's own configuration
   * decides; an empty list means the package has no tests (a mutation source only).
   */
  tests?: string[];
  tsconfig?: string;
  /** Absent for a package that has no tests of its own. */
  runner?: RunnerSpec;
  env?: Record<string, string>;
}

export type Granularity = 'line' | 'function' | 'file';

export type ScopeSpec =
  | { kind: 'full' }
  | {
      kind: 'diff';
      /** A git ref, or `-Empty-` for the empty tree. Default `HEAD`. */
      from?: string;
      /** A git ref, or `-Local-` for the working tree including staged changes. Default `-Local-`. */
      to?: string;
      /** A unified diff file used instead of git. */
      patch?: string;
      granularity?: Granularity;
    };

export interface CacheSpec {
  dir: string;
}
