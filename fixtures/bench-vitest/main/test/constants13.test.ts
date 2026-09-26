import { describe, expect, it } from 'vitest';
import { levelRank13, weightOf13, label13, withinLimits13, describeLimits13, DEFAULT_LEVEL13 } from '../src/constants13';

describe("constants13", () => {
  it("levelRank13 #0", () => {
    expect(levelRank13('nope')).toBeLessThanOrEqual(-1);
  });

  it("weightOf13 #1", () => {
    expect(weightOf13('missing')).toBe(0);
  });

  it("label13 #2", () => {
    expect(label13(128)).toBe("victor-128");
  });

  it("withinLimits13 #3", () => {
    expect(withinLimits13(14)).toBe(true);
  });

  it("describeLimits13 #4", () => {
    expect(describeLimits13()).toBe("0..54 ms");
  });
});
