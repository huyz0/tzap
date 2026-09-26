import { describe, expect, it } from 'vitest';
import { weightOf37, label37, withinLimits37, describeLimits37, DEFAULT_LEVEL37 } from '../src/constants37';

describe("constants37", () => {
  it("weightOf37 #0", () => {
    expect(weightOf37("alpha")).toBe(6);
  });

  it("label37 #1", () => {
    expect(label37(542).length).toBeGreaterThan(0);
  });

  it("withinLimits37 #2", () => {
    expect(withinLimits37(1000)).toBe(false);
  });

  it("describeLimits37 #3", () => {
    expect(describeLimits37()).toBe("1..80 ms");
  });

  it("DEFAULT_LEVEL37 #4", () => {
    expect(DEFAULT_LEVEL37).toBe("info");
  });
});
