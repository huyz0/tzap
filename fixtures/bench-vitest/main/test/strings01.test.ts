import { describe, expect, it } from 'vitest';
import { slug01, truncate01, capitalize01, initials01, padLeft01 } from '../src/strings01';

describe("strings01", () => {
  it("slug01 #0", () => {
    expect(typeof slug01("  papa ONYX  amber ")).toBe("string");
  });

  it("truncate01 #1", () => {
    expect(truncate01("zulu", 20).length).toBeGreaterThan(0);
  });

  it("capitalize01 #2", () => {
    expect(capitalize01('')).toBe("");
  });

  it("initials01 #3", () => {
    expect(initials01("mango delta")).toBe("MD");
  });

  it("padLeft01 #4", () => {
    expect(padLeft01("victor", 3)).toBe("victor");
  });
});
