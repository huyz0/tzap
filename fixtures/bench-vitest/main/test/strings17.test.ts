import { describe, expect, it } from 'vitest';
import { slug17, truncate17, capitalize17, initials17, padLeft17 } from '../src/strings17';

describe("strings17", () => {
  it("slug17 #0", () => {
    expect(typeof slug17("maple")).toBe("string");
  });

  it("truncate17 #1", () => {
    expect(truncate17("kilo", 20).length).toBeGreaterThan(0);
  });

  it("capitalize17 #2", () => {
    expect(capitalize17('')).toBe("");
  });

  it("initials17 #3", () => {
    expect(initials17("onyx mango")).toBe("OM");
  });

  it("padLeft17 #4", () => {
    expect(padLeft17("21", 6, '0').length).toBeGreaterThan(0);
  });
});
