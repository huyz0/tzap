import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { progressWriter, readProgress } from '../src/index.js';

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'tzap-progress-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('progress files', () => {
  it('reports each worker’s latest entry', () => {
    const dir = scratch();
    const a = progressWriter(dir, 'a')!;
    const b = progressWriter(dir, 'b')!;
    a(1, 'test/x.test.ts::first', 3, false);
    a(1, 'test/x.test.ts::first', 3, true);
    b(1, 'test/y.test.ts::second', -1, false);
    const entries = readProgress(dir).sort((x, y) => x.test.localeCompare(y.test));
    expect(entries.map(({ at, ...e }) => e)).toEqual([
      { runId: 1, mutant: 3, done: true, test: 'test/x.test.ts::first' },
      { runId: 1, mutant: -1, done: false, test: 'test/y.test.ts::second' },
    ]);
    expect(entries.every((e) => e.at > 0)).toBe(true);
  });

  it('keeps a test name intact whatever it contains and whatever came before it', () => {
    const dir = scratch();
    const w = progressWriter(dir, 'w')!;
    // Longer than the padded line, and with multi-byte characters: a shorter line written over it
    // must not leave its tail behind.
    w(7, `test/a.test.ts::${'é'.repeat(150)} > ${'x'.repeat(120)}`, 12, false);
    w(7, 'test/a.test.ts::short\twith a tab', 13, false);
    expect(readProgress(dir).map((e) => [e.mutant, e.test])).toEqual([[13, 'test/a.test.ts::short\twith a tab']]);
  });

  it('is off without a directory, and a directory it cannot create turns it off', () => {
    expect(progressWriter(undefined, 'w')).toBeUndefined();
    const file = path.join(scratch(), 'a-file');
    writeFileSync(file, '');
    expect(progressWriter(path.join(file, 'sub'), 'w')).toBeUndefined();
  });

  it('never throws into the test run, even once its file is gone', () => {
    const dir = scratch();
    const w = progressWriter(dir, 'w')!;
    w(1, 't', 1, false);
    rmSync(dir, { recursive: true, force: true });
    // Writes to an unlinked file succeed on POSIX; either way nothing reaches the caller.
    expect(() => {
      for (let i = 0; i < 3; i++) w(1, 't', i, true);
    }).not.toThrow();
  });

  it('reads nothing from a missing directory and ignores other files', () => {
    expect(readProgress(path.join(scratch(), 'missing'))).toEqual([]);
    const dir = scratch();
    writeFileSync(path.join(dir, 'notes.txt'), '1\t2\t1\tx');
    expect(readProgress(dir)).toEqual([]);
  });
});
