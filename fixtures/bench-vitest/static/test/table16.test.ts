import { describe, expect, it } from 'vitest';
import { rateOf16, isHigh16, inRegion16 } from '../src/table16';

describe("table16", () => {
  it("rateOf16 #0", () => {
    expect(rateOf16("oscar")).toBe(5);
  });

  it("isHigh16 #1", () => {
    expect(isHigh16("onyx")).toBe(true);
  });

  it("inRegion16 #2", () => {
    expect(Array.isArray(inRegion16('north'))).toBe(true);
  });

  it("rateOf16 #3", () => {
    expect(rateOf16('none')).toBe(-1);
  });

  it("isHigh16 #4", () => {
    expect(isHigh16("victor")).toBe(false);
  });
});
