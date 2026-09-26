import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../src/index.js';

const files = (patch: string, opts?: Parameters<typeof parseUnifiedDiff>[1]) =>
  Object.fromEntries(parseUnifiedDiff(patch, opts).files);

describe('parseUnifiedDiff', () => {
  it('reads a git patch, stripping a/ b/ by default and merging adjacent lines', () => {
    const patch = [
      'diff --git a/src/x.ts b/src/x.ts',
      'index 1111111..2222222 100644',
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      '@@ -2,3 +2,4 @@ function f() {',
      ' ctx',
      '-old',
      '+new1',
      '+new2',
      ' ctx',
      '@@ -10 +11 @@',
      '-a',
      '+b',
      '',
    ].join('\n');
    expect(files(patch)).toEqual({ 'src/x.ts': [[3, 4], [11, 11]] });
    expect(parseUnifiedDiff(patch).description).toBe('changes in the patch (1 file, 3 lines)');
  });

  it('reads a diff -u patch with timestamps and no prefixes', () => {
    const patch = [
      '--- old/calc.ts\t2026-09-01 10:00:00.000000000 +0200',
      '+++ new/calc.ts\t2026-09-02 11:00:00.000000000 +0200',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
    ].join('\n');
    expect(files(patch)).toEqual({ 'new/calc.ts': [[2, 2]] });
    expect(files(patch, { stripPrefix: 1 })).toEqual({ 'calc.ts': [[2, 2]] });
  });

  it('stripPrefix counts path components like patch -p', () => {
    const patch = '--- a/pkg/src/x.ts\n+++ b/pkg/src/x.ts\n@@ -0,0 +1 @@\n+x\n';
    expect(files(patch, { stripPrefix: 1 })).toEqual({ 'pkg/src/x.ts': [[1, 1]] });
    expect(files(patch, { stripPrefix: 2 })).toEqual({ 'src/x.ts': [[1, 1]] });
    expect(files(patch, { stripPrefix: 0 })).toEqual({ 'b/pkg/src/x.ts': [[1, 1]] });
  });

  it('treats +++ and --- inside a hunk as content, not file headers', () => {
    const patch = [
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,4 +1,4 @@',
      ' a',
      '--- y;',
      '+++ i;',
      ' b',
      '-c',
      '+C',
    ].join('\n');
    expect(files(patch)).toEqual({ 'x.ts': [[2, 2], [4, 4]] });
  });

  it('handles CRLF patches, "\\ No newline" markers and blank context lines', () => {
    const patch = [
      '--- a/x.ts', '+++ b/x.ts', '@@ -1,3 +1,3 @@', ' a', '', '-c', '\\ No newline at end of file', '+C', '\\ No newline at end of file',
      '--- a/y.ts', '+++ b/y.ts', '@@ -1 +1 @@', '-p', '+q',
    ].join('\r\n');
    expect(files(patch)).toEqual({ 'x.ts': [[3, 3]], 'y.ts': [[1, 1]] });
  });

  it('new files, deleted files, binaries and pure renames', () => {
    const patch = [
      'diff --git a/new.ts b/new.ts', 'new file mode 100644', 'index 0000000..1111111',
      '--- /dev/null', '+++ b/new.ts', '@@ -0,0 +1,3 @@', '+1', '+2', '+3',
      'diff --git a/gone.ts b/gone.ts', 'deleted file mode 100644',
      '--- a/gone.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-1', '-2',
      'diff --git a/img.png b/img.png', 'index 1..2 100644', 'Binary files a/img.png and b/img.png differ',
      'diff --git a/old.ts b/moved.ts', 'similarity index 100%', 'rename from old.ts', 'rename to moved.ts',
      'diff --git a/o.ts b/r.ts', 'similarity index 90%', 'rename from o.ts', 'rename to r.ts',
      '--- a/o.ts', '+++ b/r.ts', '@@ -5 +5 @@', '-x', '+y',
    ].join('\n');
    expect(files(patch)).toEqual({ 'new.ts': [[1, 3]], 'r.ts': [[5, 5]] });
  });

  it('a pure deletion marks the line that follows it', () => {
    // Zero context: "+3,0" names the line before the deletion point.
    const u0 = '--- a/x.ts\n+++ b/x.ts\n@@ -4,2 +3,0 @@\n-a\n-b\n';
    expect(files(u0)).toEqual({ 'x.ts': [[4, 4]] });
    // With context the following line is the trailing context line.
    const u1 = '--- a/x.ts\n+++ b/x.ts\n@@ -3,4 +3,2 @@\n c\n-a\n-b\n d\n';
    expect(files(u1)).toEqual({ 'x.ts': [[4, 4]] });
    // Deleting the first line.
    expect(files('--- a/x.ts\n+++ b/x.ts\n@@ -1 +0,0 @@\n-a\n')).toEqual({ 'x.ts': [[1, 1]] });
  });

  it('a deletion at end of file marks the new last line', () => {
    // With context, a deletion followed by nothing is known to be at end of file.
    const ctx = '--- a/x.ts\n+++ b/x.ts\n@@ -8,3 +8,1 @@\n h\n-i\n-j\n';
    expect(files(ctx)).toEqual({ 'x.ts': [[8, 8]] });
    // Zero context cannot tell; lineCount clamps it.
    const u0 = '--- a/x.ts\n+++ b/x.ts\n@@ -9,2 +8,0 @@\n-i\n-j\n';
    expect(files(u0, { lineCount: () => 8 })).toEqual({ 'x.ts': [[8, 8]] });
    expect(files(u0)).toEqual({ 'x.ts': [[9, 9]] });
  });

  it('decodes C-quoted paths and paths with spaces', () => {
    const patch = [
      'diff --git "a/src/caf\\303\\251 \\"q\\".ts" "b/src/caf\\303\\251 \\"q\\".ts"',
      '--- "a/src/caf\\303\\251 \\"q\\".ts"', '+++ "b/src/caf\\303\\251 \\"q\\".ts"', '@@ -1 +1 @@', '-a', '+b',
      'diff --git a/my file.ts b/my file.ts',
      '--- a/my file.ts\t', '+++ b/my file.ts\t', '@@ -2 +2 @@', '-a', '+b',
    ].join('\n');
    expect(files(patch)).toEqual({ 'src/café "q".ts': [[1, 1]], 'my file.ts': [[2, 2]] });
  });

  it('reports paths relative to root and drops the rest', () => {
    const patch = '+++ b/packages/a/x.ts\n@@ -0,0 +1 @@\n+x\n+++ b/packages/b/y.ts\n@@ -0,0 +1 @@\n+y\n';
    expect(files(patch, { root: 'packages/a' })).toEqual({ 'x.ts': [[1, 1]] });
    expect(files(patch, { root: './packages\\a\\' })).toEqual({ 'x.ts': [[1, 1]] });
    expect(files(patch, { root: '.' })).toEqual({ 'packages/a/x.ts': [[1, 1]], 'packages/b/y.ts': [[1, 1]] });
  });
});
