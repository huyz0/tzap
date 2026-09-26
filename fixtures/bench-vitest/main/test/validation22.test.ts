import { describe, expect, it } from 'vitest';
import { isEmail22, isAdult22, hasTag22, validate22 } from '../src/validation22';

describe("validation22", () => {
  it("isEmail22 #0", () => {
    expect(typeof isEmail22("maple@example.com")).toBe("boolean");
  });

  it("isAdult22 #1", () => {
    expect(typeof isAdult22({ age: 54 })).toBe("boolean");
  });

  it("hasTag22 #2", () => {
    expect(hasTag22({ tags: ['x', "maple"] }, "maple")).toBeDefined();
  });

  it("validate22 #3", () => {
    expect(validate22({ name: "maple", email: 'a@b.io', age: 30 })).toEqual([]);
  });

  it("isEmail22 #4", () => {
    expect(isEmail22("maple.example.com")).toBe(false);
  });
});
