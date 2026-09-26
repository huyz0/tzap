import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { widenScope } from '../src/scope.js';

const root = mkdtempSync(path.join(tmpdir(), 'tzap-scope-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(
  path.join(root, 'a.ts'),
  [
    'export const top = 1;', // 1
    'export function outer(x: number) {', // 2
    '  const inner = (y: number) => {', // 3
    '    return y * 2;', // 4
    '  };', // 5
    '  return inner(x) + 1;', // 6
    '}', // 7
    'export const last = 2;', // 8
  ].join('\n'),
);
writeFileSync(path.join(root, 'broken.ts'), 'export function (\n');
writeFileSync(path.join(root, 'C.vue'), '<script setup>\nconst a = 1;\n</script>\n');

const widen = (files: Record<string, Array<[number, number]>>, g: 'line' | 'function' | 'file') => Object.fromEntries(widenScope(root, new Map(Object.entries(files)), g));

describe('widenScope', () => {
  it('leaves line scope as it is', () => {
    expect(widen({ 'a.ts': [[4, 4]] }, 'line')).toEqual({ 'a.ts': [[4, 4]] });
  });

  it('grows a changed line to the innermost function holding it', () => {
    expect(widen({ 'a.ts': [[4, 4]] }, 'function')).toEqual({ 'a.ts': [[3, 5]] });
    expect(widen({ 'a.ts': [[6, 6]] }, 'function')).toEqual({ 'a.ts': [[2, 7]] });
    // Outside any function a line stays itself; separate ranges stay separate.
    expect(widen({ 'a.ts': [[1, 1], [8, 8]] }, 'function')).toEqual({ 'a.ts': [[1, 1], [8, 8]] });
    // Ranges that meet are merged.
    expect(widen({ 'a.ts': [[1, 1], [6, 6]] }, 'function')).toEqual({ 'a.ts': [[1, 7]] });
  });

  it('takes a changed file whole', () => {
    expect(widen({ 'a.ts': [[4, 4]] }, 'file')).toEqual({ 'a.ts': [[1, 8]] });
  });

  it('never loses a changed line: files it cannot read or parse keep their lines', () => {
    expect(widen({ 'gone.ts': [[2, 3]], 'broken.ts': [[1, 1]], 'C.vue': [[2, 2]] }, 'function')).toEqual({
      'gone.ts': [[2, 3]],
      'broken.ts': [[1, 1]],
      'C.vue': [[2, 2]],
    });
  });
});
