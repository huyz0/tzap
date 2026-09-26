import { describe, expect, it } from 'vitest';
import { isEmail38, displayName38, isAdult38, hasTag38, validate38 } from '../src/validation38';

describe("validation38", () => {
  it("isEmail38 #0", () => {
    expect(isEmail38("mango.example.com")).toBe(false);
  });

  it("displayName38 #1", () => {
    expect(displayName38({})).toBe("anonymous");
  });

  it("isAdult38 #2", () => {
    expect(isAdult38({})).toBe(false);
  });

  it("hasTag38 #3", () => {
    expect(hasTag38({ tags: ['x', "mango"] }, "mango")).toBe(true);
  });

  it("validate38 #4", () => {
    expect(validate38({ name: 'x', email: 'nope', age: -1 })).toEqual(["name too short","invalid email"]);
  });
});
