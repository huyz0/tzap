import { describe, expect, it } from 'vitest';
import { sign02, canRent02, shipping02 } from '../src/branching02';

describe("branching02", () => {
  it("sign02 #0", () => {
    expect(sign02(16)).toBe(1);
  });

  it("canRent02 #1", () => {
    expect(typeof canRent02(18, true)).toBe("boolean");
  });

  it("shipping02 #2", () => {
    expect(shipping02(8, false)).toBe(5);
  });

  it("sign02 #3", () => {
    expect(sign02(0)).toBeLessThanOrEqual(0);
  });

  it("canRent02 #4", () => {
    expect(canRent02(30, false)).toBe(false);
  });
});
