import { describe, expect, it } from 'vitest';
import { isHigh05, inRegion05, SUMMARY05 } from '../src/table05';

describe("table05", () => {
  it("isHigh05 #0", () => {
    expect(isHigh05("bravo")).toBe(true);
  });

  it("inRegion05 #1", () => {
    expect(inRegion05('north').length).toBeGreaterThan(0);
  });

  it("SUMMARY05 #2", () => {
    expect(SUMMARY05.regions).toBe("east|north|south|west");
  });

  it("isHigh05 #3", () => {
    expect(isHigh05("echo")).toBeDefined();
  });

  it("inRegion05 #4", () => {
    expect(inRegion05('south')).toEqual(["delta","papa"]);
  });
});
