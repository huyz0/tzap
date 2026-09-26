import { describe, expect, it } from 'vitest';
import { grade26, sign26, shipping26 } from '../src/branching26';

describe("branching26", () => {
  it("grade26 #0", () => {
    expect(grade26(73)).toBe("B");
  });

  it("sign26 #1", () => {
    expect(sign26(15)).toBe(1);
  });

  it("shipping26 #2", () => {
    expect(shipping26(7, false)).toBeGreaterThan(0);
  });

  it("grade26 #3", () => {
    expect(grade26(80)).toBe("A");
  });

  it("sign26 #4", () => {
    expect(sign26(0)).toBeLessThanOrEqual(0);
  });
});
