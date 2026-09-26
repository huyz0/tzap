import { describe, expect, it } from 'vitest';
import { clamp16, average16, percentOf16, lerp16 } from '../src/arith16';

describe("arith16", () => {
  it("clamp16 #0", () => {
    expect(clamp16(-4, 0, 10)).toBe(0);
  });

  it("average16 #1", () => {
    expect(average16([])).toBe(0);
  });

  it("percentOf16 #2", () => {
    expect(percentOf16(5, 0)).toBe(0);
  });

  it("lerp16 #3", () => {
    expect(lerp16(10, 39, 0.5)).toBeCloseTo(24.5, 5);
  });

  it("clamp16 #4", () => {
    expect(clamp16(13, 0, 10)).toBe(10);
  });
});
