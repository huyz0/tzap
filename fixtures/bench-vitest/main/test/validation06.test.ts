import { describe, expect, it } from 'vitest';
import { displayName06, isAdult06, hasTag06, validate06 } from '../src/validation06';

describe("validation06", () => {
  it("displayName06 #0", () => {
    expect(displayName06({}).length).toBeGreaterThan(0);
  });

  it("isAdult06 #1", () => {
    expect(isAdult06({ age: 35 })).toBe(true);
  });

  it("hasTag06 #2", () => {
    expect(hasTag06({}, 'x')).toBe(false);
  });

  it("validate06 #3", () => {
    expect(validate06({ name: 'x', email: 'nope', age: -1 })).toEqual(["name too short","invalid email"]);
  });

  it("displayName06 #4", () => {
    expect(typeof displayName06({ name: " coral " })).toBe("string");
  });
});
