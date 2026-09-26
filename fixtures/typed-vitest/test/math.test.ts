import { describe, expect, it } from 'vitest';
import { double, steps, sumSquares } from '../src/math';

describe('math', () => {
  it('doubles', () => {
    expect(double(4)).toBe(8);
  });
  it('sums squares', () => {
    expect(sumSquares([1, 2, 3])).toBe(14);
  });
  it('steps', () => {
    expect(steps[0]!(1)).toBe(2);
  });
});
