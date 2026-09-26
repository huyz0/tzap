import { describe, expect, it } from 'vitest';
import { Box, isShape, totalArea } from '../src/shapes';

describe('shapes', () => {
  it('counts', () => {
    expect(new Box([1, 2]).count).toBe(2);
  });
  it('sums areas', () => {
    expect(totalArea([{ kind: 'square', size: 2 }, { kind: 'circle', size: 1 }])).toBe(7);
  });
  it('recognises shapes', () => {
    expect(isShape({ kind: 'circle', size: 1 })).toBe(true);
  });
});
