import { describe, expect, it } from 'vitest';
import { clamp, describeSign } from '../src/math';

describe.concurrent('clamp', () => {
  it('keeps values inside', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
  it('caps above', () => {
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe('signs', () => {
  it.each([
    [1, 'positive'],
    [-1, 'negative'],
  ])('describes %i', (n, expected) => {
    expect(describeSign(n)).toBe(expected);
  });
  it('works', () => {
    expect(describeSign(0)).toBe('zero');
  });
  it('works', () => {
    expect(describeSign(2)).toBe('positive');
  });
  it.fails('does not call zero negative', () => {
    expect(describeSign(0)).toBe('negative');
  });
});
