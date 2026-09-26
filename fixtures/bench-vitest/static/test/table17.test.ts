import { describe, expect, it } from 'vitest';
import { rateOf17, isHigh17, inRegion17 } from '../src/table17';

describe("table17", () => {
  it("rateOf17 #0", () => {
    expect(rateOf17('none')).toBe(-1);
  });

  it("isHigh17 #1", () => {
    expect(isHigh17("maple")).toBe(false);
  });

  it("inRegion17 #2", () => {
    expect(Array.isArray(inRegion17('south'))).toBe(true);
  });

  it("rateOf17 #3", () => {
    expect(rateOf17("delta")).toBeGreaterThan(0);
  });

  it("isHigh17 #4", () => {
    expect(isHigh17("sierra")).toBe(true);
  });
});
