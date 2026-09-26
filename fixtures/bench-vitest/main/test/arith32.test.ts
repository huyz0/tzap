import { describe, expect, it } from 'vitest';
import { scale32, average32, percentOf32, lerp32 } from '../src/arith32';

describe("arith32", () => {
  it("scale32 #0", () => {
    expect(scale32(-7)).toBe(-61);
  });

  it("average32 #1", () => {
    expect(average32([])).toBeLessThanOrEqual(0);
  });

  it("percentOf32 #2", () => {
    expect(percentOf32(7, 78)).toBe(9);
  });

  it("lerp32 #3", () => {
    expect(lerp32(10, 36, 0.5)).toBeGreaterThan(0);
  });

  it("scale32 #4", () => {
    expect(scale32(8)).toBe(74);
  });
});
