import path from 'node:path';
import { globSync } from 'tinyglobby';
import type { PackageModel } from '@tzap/model';

/** Test files are never mutated: these, unless the package names its own. */
const DEFAULT_TEST_GLOBS = [
  '**/*.{test,spec}.?(c|m)[jt]s?(x)',
  '**/__tests__/**',
  '**/test/**',
  '**/tests/**',
];

/** Never mutated, whatever the model says: installed and built code, declarations, mocks. */
const ALWAYS_EXCLUDED = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/*.d.ts', '**/*.d.mts', '**/*.d.cts', '**/.tzap/**', '**/__mocks__/**'];

export const toPosix = (p: string) => p.replace(/\\/g, '/');

/** Absolute paths of a package's mutable source files, sorted. */
export function sourceFiles(root: string, pkg: PackageModel): string[] {
  const cwd = path.resolve(root, pkg.root);
  const ignore = [...ALWAYS_EXCLUDED, ...(pkg.exclude ?? []), ...(pkg.tests && pkg.tests.length > 0 ? pkg.tests : DEFAULT_TEST_GLOBS)];
  const files = globSync(pkg.sources, { cwd, ignore, absolute: true, onlyFiles: true, dot: false });
  return files.map((f) => path.resolve(f)).sort();
}

/** Path relative to the model root with forward slashes: the identity files are reported under. */
export function relativeTo(root: string, abs: string): string {
  return toPosix(path.relative(root, abs));
}
