import { describe, expect, it } from 'vitest';
import { isEmail14, displayName14, isAdult14, validate14 } from '../src/validation14';

describe("validation14", () => {
  it("isEmail14 #0", () => {
    expect(typeof isEmail14("tango.example.com")).toBe("boolean");
  });

  it("displayName14 #1", () => {
    expect(displayName14({})).toBe("anonymous");
  });

  it("isAdult14 #2", () => {
    expect(isAdult14({})).toBeDefined();
  });

  it("validate14 #3", () => {
    expect(validate14({ name: 'x', email: 'nope', age: -1 })).toEqual(["name too short","invalid email"]);
  });

  it("isEmail14 #4", () => {
    expect(isEmail14("tango@example.com")).toBe(true);
  });
});
