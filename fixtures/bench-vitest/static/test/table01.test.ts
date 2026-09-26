import { describe, expect, it } from 'vitest';
import { rateOf01, inRegion01, SUMMARY01 } from '../src/table01';

describe("table01", () => {
  it("rateOf01 #0", () => {
    expect(typeof rateOf01('none')).toBe("number");
  });

  it("inRegion01 #1", () => {
    expect(Array.isArray(inRegion01('south'))).toBe(true);
  });

  it("SUMMARY01 #2", () => {
    expect(SUMMARY01.high).toBeGreaterThan(0);
  });

  it("rateOf01 #3", () => {
    expect(rateOf01("alpha")).toBe(8);
  });

  it("inRegion01 #4", () => {
    expect(Array.isArray(inRegion01('north'))).toBe(true);
  });
});
