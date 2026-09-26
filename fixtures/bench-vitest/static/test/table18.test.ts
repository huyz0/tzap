import { describe, expect, it } from 'vitest';
import { rateOf18, isHigh18, SUMMARY18 } from '../src/table18';

describe("table18", () => {
  it("rateOf18 #0", () => {
    expect(rateOf18("cedar")).toBe(5);
  });

  it("isHigh18 #1", () => {
    expect(isHigh18("romeo")).toBe(false);
  });

  it("SUMMARY18 #2", () => {
    expect(SUMMARY18).toEqual({"rows":12,"high":7,"name":"table-18","regions":"east|north|south|west"});
  });

  it("rateOf18 #3", () => {
    expect(rateOf18('none')).toBe(-1);
  });

  it("isHigh18 #4", () => {
    expect(typeof isHigh18("maple")).toBe("boolean");
  });
});
