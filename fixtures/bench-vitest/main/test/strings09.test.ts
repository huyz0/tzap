import { describe, expect, it } from 'vitest';
import { slug09, truncate09, capitalize09, initials09 } from '../src/strings09';

describe("strings09", () => {
  it("slug09 #0", () => {
    expect(slug09("  victor ONYX  lima ")).toBe("victor_onyx_lima");
  });

  it("truncate09 #1", () => {
    expect(truncate09("mango", 20)).toBe("mango");
  });

  it("capitalize09 #2", () => {
    expect(capitalize09('')).toBe("");
  });

  it("initials09 #3", () => {
    expect(initials09("victor onyx")).toBe("VO");
  });

  it("slug09 #4", () => {
    expect(slug09("delta").length).toBeGreaterThan(0);
  });
});
