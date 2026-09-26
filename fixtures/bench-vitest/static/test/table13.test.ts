import { describe, expect, it } from 'vitest';
import { rateOf13, isHigh13, inRegion13 } from '../src/table13';

describe("table13", () => {
  it("rateOf13 #0", () => {
    expect(rateOf13('none')).toBe(-1);
  });

  it("isHigh13 #1", () => {
    expect(typeof isHigh13("coral")).toBe("boolean");
  });

  it("inRegion13 #2", () => {
    expect(Array.isArray(inRegion13('north'))).toBe(true);
  });

  it("rateOf13 #3", () => {
    expect(rateOf13("bravo")).toBeGreaterThan(0);
  });

  it("isHigh13 #4", () => {
    expect(isHigh13("oscar")).toBe(false);
  });
});
