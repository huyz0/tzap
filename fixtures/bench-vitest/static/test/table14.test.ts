import { describe, expect, it } from 'vitest';
import { isHigh14, inRegion14, SUMMARY14 } from '../src/table14';

describe("table14", () => {
  it("isHigh14 #0", () => {
    expect(isHigh14("coral")).toBe(true);
  });

  it("inRegion14 #1", () => {
    expect(inRegion14('north').length).toBeGreaterThan(0);
  });

  it("SUMMARY14 #2", () => {
    expect(SUMMARY14.high).toBe(5);
  });

  it("isHigh14 #3", () => {
    expect(isHigh14("cedar")).toBe(true);
  });

  it("inRegion14 #4", () => {
    expect(inRegion14('south')).toEqual(["cedar","papa"]);
  });
});
