import { describe, expect, it } from 'vitest';
import { slug25, truncate25, capitalize25, initials25, padLeft25 } from '../src/strings25';

describe("strings25", () => {
  it("slug25 #0", () => {
    expect(slug25("  victor TANGO  romeo ")).toBe("victor.tango.romeo");
  });

  it("truncate25 #1", () => {
    expect(truncate25("victor sierra amber", 6)).toBe("vic...");
  });

  it("capitalize25 #2", () => {
    expect(typeof capitalize25('')).toBe("string");
  });

  it("initials25 #3", () => {
    expect(initials25("lima ivory")).toBe("LI");
  });

  it("padLeft25 #4", () => {
    expect(typeof padLeft25("76", 6, '0')).toBe("string");
  });
});
