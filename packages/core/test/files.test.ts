import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { relativeTo, sourceFiles } from '../src/files.js';

const root = mkdtempSync(path.join(tmpdir(), 'tzap-files-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
for (const f of [
  'pkg/src/a.ts',
  'pkg/src/b.test.ts',
  'pkg/src/c.spec.tsx',
  'pkg/src/__tests__/d.ts',
  'pkg/src/__mocks__/e.ts',
  'pkg/src/types.d.ts',
  'pkg/src/gen/f.ts',
  'pkg/test/helper.ts',
  'pkg/dist/g.js',
  'pkg/node_modules/x/h.ts',
]) {
  mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
  writeFileSync(path.join(root, f), '');
}
const files = (pkg: Parameters<typeof sourceFiles>[1]) => sourceFiles(root, pkg).map((f) => relativeTo(root, f));

describe('sourceFiles', () => {
  it('takes the package’s source globs, minus tests, mocks, declarations and built or installed code', () => {
    expect(files({ id: 'p', root: 'pkg', sources: ['**/*.{ts,tsx,js}'] })).toEqual(['pkg/src/a.ts', 'pkg/src/gen/f.ts']);
  });

  it('applies the package’s excludes, and its own test globs instead of the defaults', () => {
    expect(files({ id: 'p', root: 'pkg', sources: ['src/**/*.ts'], exclude: ['src/gen/**'] })).toEqual(['pkg/src/a.ts']);
    // With its own test globs, a file the defaults would call a test is a source.
    expect(files({ id: 'p', root: 'pkg', sources: ['src/**/*.ts'], tests: ['src/**/*.test.ts'] })).toEqual(['pkg/src/__tests__/d.ts', 'pkg/src/a.ts', 'pkg/src/gen/f.ts']);
  });
});
