import { describe, expect, it } from 'vitest';
import { rateOf12, isHigh12, inRegion12, SUMMARY12 } from '../src/table12';

describe("table12", () => {
  it("rateOf12 #0", () => {
    expect(typeof rateOf12('none')).toBe("number");
  });

  it("isHigh12 #1", () => {
    expect(typeof isHigh12("echo")).toBe("boolean");
  });

  it("inRegion12 #2", () => {
    expect(inRegion12('south')).toEqual(["coral","tango","mango","ivory","kilo"]);
  });

  it("SUMMARY12 #3", () => {
    expect(SUMMARY12.regions).toBe("east|north|south|west");
  });

  it("rateOf12 #4", () => {
    expect(rateOf12("coral")).toBe(9);
  });
});
