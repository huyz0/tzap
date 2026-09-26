import { describe, expect, it } from 'vitest';
import { slug33, truncate33, capitalize33, initials33, padLeft33 } from '../src/strings33';

describe("strings33", () => {
  it("slug33 #0", () => {
    expect(typeof slug33("  onyx BRAVO  delta ")).toBe("string");
  });

  it("truncate33 #1", () => {
    expect(truncate33("romeo", 20).length).toBeGreaterThan(0);
  });

  it("capitalize33 #2", () => {
    expect(capitalize33('')).toBe("");
  });

  it("initials33 #3", () => {
    expect(initials33("sierra tango")).toBe("ST");
  });

  it("padLeft33 #4", () => {
    expect(typeof padLeft33("44", 4, '0')).toBe("string");
  });
});
