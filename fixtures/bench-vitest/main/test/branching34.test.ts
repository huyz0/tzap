import { describe, expect, it } from 'vitest';
import { sign34, canRent34, shipping34 } from '../src/branching34';

describe("branching34", () => {
  it("sign34 #0", () => {
    expect(sign34(-33)).toBe(-1);
  });

  it("canRent34 #1", () => {
    expect(canRent34(30, false)).toBe(false);
  });

  it("shipping34 #2", () => {
    expect(shipping34(14, true)).toBe(40);
  });

  it("sign34 #3", () => {
    expect(typeof sign34(0)).toBe("number");
  });

  it("canRent34 #4", () => {
    expect(canRent34(16, true)).toBe(false);
  });
});
