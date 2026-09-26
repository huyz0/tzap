import { describe, expect, it } from 'vitest';
import { isHigh04, inRegion04, SUMMARY04 } from '../src/table04';

describe("table04", () => {
  it("isHigh04 #0", () => {
    expect(isHigh04("kilo")).toBe(false);
  });

  it("inRegion04 #1", () => {
    expect(inRegion04('north')).toEqual(["zulu","bravo","oscar"]);
  });

  it("SUMMARY04 #2", () => {
    expect(SUMMARY04).toEqual({"rows":10,"high":5,"name":"table-04","regions":"east|north|south|west"});
  });

  it("isHigh04 #3", () => {
    expect(isHigh04("zulu")).toBeDefined();
  });

  it("inRegion04 #4", () => {
    expect(inRegion04('south').length).toBeGreaterThan(0);
  });
});
