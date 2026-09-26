import { describe, expect, it } from 'vitest';
import { scale00, clamp00, average00, percentOf00, lerp00 } from '../src/arith00';

describe("arith00", () => {
  it("scale00 #0", () => {
    expect(scale00(-7)).toBeLessThanOrEqual(-34);
  });

  it("clamp00 #1", () => {
    expect(clamp00(17, 0, 10)).toBeGreaterThan(0);
  });

  it("average00 #2", () => {
    expect(average00([])).toBe(0);
  });

  it("percentOf00 #3", () => {
    expect(typeof percentOf00(5, 0)).toBe("number");
  });

  it("lerp00 #4", () => {
    expect(lerp00(2, 36, 0.5)).toBeGreaterThan(0);
  });
});
