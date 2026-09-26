import { describe, expect, it } from 'vitest';
import { normPath, sameHits } from '../src/index.js';

describe('sameHits', () => {
  it('holds when every site is hit the same number of times', () => {
    expect(sameHits([], [])).toBe(true);
    expect(sameHits([[0, 1], [3, 2]], [[0, 1], [3, 2]])).toBe(true);
  });

  it('fails on a different count, a different site or a missing site', () => {
    expect(sameHits([[0, 1]], [[0, 2]])).toBe(false);
    expect(sameHits([[0, 1]], [[1, 1]])).toBe(false);
    expect(sameHits([[0, 1], [1, 1]], [[0, 1]])).toBe(false);
  });
});

describe('normPath', () => {
  it('uses forward slashes', () => {
    expect(normPath('a\\b\\c.ts')).toBe('a/b/c.ts');
  });
});
