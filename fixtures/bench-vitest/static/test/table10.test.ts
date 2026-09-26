import { describe, expect, it } from 'vitest';
import { rateOf10, isHigh10, inRegion10, SUMMARY10 } from '../src/table10';

describe("table10", () => {
  it("rateOf10 #0", () => {
    expect(typeof rateOf10("victor")).toBe("number");
  });

  it("isHigh10 #1", () => {
    expect(isHigh10("oscar")).toBe(false);
  });

  it("inRegion10 #2", () => {
    expect(Array.isArray(inRegion10('north'))).toBe(true);
  });

  it("SUMMARY10 #3", () => {
    expect(SUMMARY10).toEqual({"rows":14,"high":3,"name":"table-10","regions":"east|north|south|west"});
  });

  it("rateOf10 #4", () => {
    expect(rateOf10('none')).toBe(-1);
  });
});
