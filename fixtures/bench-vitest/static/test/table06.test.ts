import { describe, expect, it } from 'vitest';
import { rateOf06, inRegion06, SUMMARY06 } from '../src/table06';

describe("table06", () => {
  it("rateOf06 #0", () => {
    expect(typeof rateOf06('none')).toBe("number");
  });

  it("inRegion06 #1", () => {
    expect(Array.isArray(inRegion06('south'))).toBe(true);
  });

  it("SUMMARY06 #2", () => {
    expect(SUMMARY06.high).toBe(6);
  });

  it("rateOf06 #3", () => {
    expect(typeof rateOf06("delta")).toBe("number");
  });

  it("inRegion06 #4", () => {
    expect(inRegion06('north').length).toBeGreaterThan(0);
  });
});
