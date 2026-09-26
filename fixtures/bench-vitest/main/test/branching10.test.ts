import { describe, expect, it } from 'vitest';
import { grade10, sign10, canRent10, shipping10 } from '../src/branching10';

describe("branching10", () => {
  it("grade10 #0", () => {
    expect(grade10(48).length).toBeGreaterThan(0);
  });

  it("sign10 #1", () => {
    expect(typeof sign10(46)).toBe("number");
  });

  it("canRent10 #2", () => {
    expect(canRent10(60, true)).toBeDefined();
  });

  it("shipping10 #3", () => {
    expect(shipping10(12, false)).toBe(5);
  });

  it("grade10 #4", () => {
    expect(typeof grade10(71)).toBe("string");
  });
});
