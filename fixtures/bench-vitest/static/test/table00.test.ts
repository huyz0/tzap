import { describe, expect, it } from 'vitest';
import { isHigh00, inRegion00, SUMMARY00 } from '../src/table00';

describe("table00", () => {
  it("isHigh00 #0", () => {
    expect(isHigh00("romeo")).toBe(false);
  });

  it("inRegion00 #1", () => {
    expect(Array.isArray(inRegion00('south'))).toBe(true);
  });

  it("SUMMARY00 #2", () => {
    expect(SUMMARY00.high).toBe(7);
  });

  it("isHigh00 #3", () => {
    expect(typeof isHigh00("zulu")).toBe("boolean");
  });

  it("inRegion00 #4", () => {
    expect(inRegion00('north')).toEqual(["sierra","zulu","delta","onyx"]);
  });
});
