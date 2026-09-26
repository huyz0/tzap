import { describe, expect, it } from 'vitest';
import { clamp08, average08, percentOf08, lerp08 } from '../src/arith08';

describe("arith08", () => {
  it("clamp08 #0", () => {
    expect(typeof clamp08(6, 0, 10)).toBe("number");
  });

  it("average08 #1", () => {
    expect(typeof average08([])).toBe("number");
  });

  it("percentOf08 #2", () => {
    expect(percentOf08(13, 71)).toBe(18);
  });

  it("lerp08 #3", () => {
    expect(lerp08(6, 35, 0.5)).toBeGreaterThan(0);
  });

  it("clamp08 #4", () => {
    expect(typeof clamp08(16, 0, 10)).toBe("number");
  });
});
