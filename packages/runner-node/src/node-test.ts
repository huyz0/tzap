/** The parts of node:test the executor uses, and the test files `node --test` would run. */
import { globSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** The subset of a node:test TestContext the executor reads. */
export interface Ctx {
  name: string;
  fullName: string;
  filePath?: string;
  passed: boolean;
  error: unknown;
}
export type Fn = (...args: unknown[]) => unknown;
export type Register = ((name?: unknown, options?: unknown, fn?: unknown) => unknown) & Record<string, unknown>;
export interface NodeTest extends Register {
  test: Register;
  describe: Register;
  before: (fn: Fn, options?: object) => void;
  after: (fn: Fn, options?: object) => void;
  beforeEach: (fn: Fn, options?: object) => void;
  afterEach: (fn: Fn, options?: object) => void;
  run: (options: object) => NodeJS.ReadableStream & { on(ev: string, f: (e: unknown) => void): unknown; resume(): unknown };
}

/** node:test itself, as the executor's shim wraps it. */
export const real = createRequire(import.meta.url)('node:test') as NodeTest;


/** node:test's default patterns (`--test` with no arguments), with type stripping's extensions. */
const EXT = '{js,mjs,cjs,ts,mts,cts}';
const NODE_TEST_PATTERNS = [
  `**/*.test.${EXT}`,
  `**/*-test.${EXT}`,
  `**/*_test.${EXT}`,
  `**/test-*.${EXT}`,
  `**/test.${EXT}`,
  `**/test/**/*.${EXT}`,
];

/** The test files, sorted: the model's `tests` globs, or node:test's own patterns. */
export function findTestFiles(pkgRoot: string, patterns: readonly string[] | undefined): string[] {
  const globs = patterns && patterns.length > 0 ? patterns : NODE_TEST_PATTERNS;
  const found = new Set<string>();
  for (const g of globs) {
    for (const f of globSync(g, { cwd: pkgRoot, exclude: (p: string) => /(^|[\\/])node_modules([\\/]|$)/.test(p) || /(^|[\\/])\.tzap([\\/]|$)/.test(p) })) {
      if (/(^|[\\/])node_modules[\\/]/.test(f)) continue;
      if (!/\.(c|m)?[jt]s$/.test(f)) continue;
      found.add(path.resolve(pkgRoot, f));
    }
  }
  return [...found].sort();
}

/** Calls a `before`/`after` hook as node:test would: a second parameter is a `done` callback. */
export function callHook(fn: Fn, t: Ctx): Promise<unknown> {
  if (fn.length < 2) return Promise.resolve().then(() => fn.call(t, t));
  return new Promise((resolve, reject) => {
    fn.call(t, t, (err?: unknown) => (err ? reject(err) : resolve(undefined)));
  });
}

/** Calls `then` when the test skips itself through its context (`t.skip()`, `t.todo()`). */
export function onSelfSkip(t: Ctx, then: () => void): void {
  const ctx = t as unknown as Record<string, unknown>;
  for (const m of ['skip', 'todo']) {
    const orig = ctx[m];
    if (typeof orig !== 'function') continue;
    ctx[m] = (...args: unknown[]) => {
      then();
      return (orig as (...a: unknown[]) => unknown).apply(t, args);
    };
  }
}
