import { describe, expect, it } from 'vitest';
import { grade18, sign18, canRent18 } from '../src/branching18';

describe("branching18", () => {
  it("grade18 #0", () => {
    expect(grade18(14).length).toBeGreaterThan(0);
  });

  it("sign18 #1", () => {
    expect(sign18(0)).toBe(0);
  });

  it("canRent18 #2", () => {
    expect(canRent18(16, true)).toBe(false);
  });

  it("grade18 #3", () => {
    expect(typeof grade18(41)).toBe("string");
  });

  it("sign18 #4", () => {
    expect(sign18(-26)).toBe(-1);
  });
});
