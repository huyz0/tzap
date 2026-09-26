import { describe, expect, it } from 'vitest';
import { levelRank21, label21, withinLimits21, describeLimits21, DEFAULT_LEVEL21 } from '../src/constants21';

describe("constants21", () => {
  it("levelRank21 #0", () => {
    expect(levelRank21('nope')).toBe(-1);
  });

  it("label21 #1", () => {
    expect(typeof label21(746)).toBe("string");
  });

  it("withinLimits21 #2", () => {
    expect(withinLimits21(15)).toBe(true);
  });

  it("describeLimits21 #3", () => {
    expect(describeLimits21()).toBe("3..94 ms");
  });

  it("DEFAULT_LEVEL21 #4", () => {
    expect(typeof DEFAULT_LEVEL21).toBe("string");
  });
});
