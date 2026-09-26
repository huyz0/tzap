import { describe, expect, it } from 'vitest';
import { rateOf02, isHigh02, inRegion02, SUMMARY02 } from '../src/table02';

describe("table02", () => {
  it("rateOf02 #0", () => {
    expect(rateOf02('none')).toBe(-1);
  });

  it("isHigh02 #1", () => {
    expect(isHigh02("zulu")).toBe(false);
  });

  it("inRegion02 #2", () => {
    expect(inRegion02('north').length).toBeGreaterThan(0);
  });

  it("SUMMARY02 #3", () => {
    expect(typeof SUMMARY02.high).toBe("number");
  });

  it("rateOf02 #4", () => {
    expect(typeof rateOf02("delta")).toBe("number");
  });
});
