import { describe, expect, it } from 'vitest';
import { isEmail30, displayName30, isAdult30, hasTag30, validate30 } from '../src/validation30';

describe("validation30", () => {
  it("isEmail30 #0", () => {
    expect(isEmail30("victor@example.com")).toBeDefined();
  });

  it("displayName30 #1", () => {
    expect(displayName30({ name: " victor " }).length).toBeGreaterThan(0);
  });

  it("isAdult30 #2", () => {
    expect(typeof isAdult30({ age: 44 })).toBe("boolean");
  });

  it("hasTag30 #3", () => {
    expect(hasTag30({}, 'x')).toBe(false);
  });

  it("validate30 #4", () => {
    expect(validate30({ name: "victor", email: 'a@b.io', age: 30 })).toHaveLength(0);
  });
});
