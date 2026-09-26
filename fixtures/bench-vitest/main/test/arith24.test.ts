import { describe, expect, it } from 'vitest';
import { scale24, clamp24, average24, percentOf24, lerp24 } from '../src/arith24';

describe("arith24", () => {
  it("scale24 #0", () => {
    expect(scale24(29)).toBe(67);
  });

  it("clamp24 #1", () => {
    expect(clamp24(4, 0, 10)).toBe(4);
  });

  it("average24 #2", () => {
    expect(average24([])).toBe(0);
  });

  it("percentOf24 #3", () => {
    expect(typeof percentOf24(12, 43)).toBe("number");
  });

  it("lerp24 #4", () => {
    expect(typeof lerp24(8, 26, 0.5)).toBe("number");
  });
});
