import { describe, expect, it } from 'vitest';
import { sumTo11, countAtLeast11, indexOfMax11 } from '../src/loops11';

describe("loops11", () => {
  it("sumTo11 #0", () => {
    expect(sumTo11(0)).toBe(0);
  });

  it("countAtLeast11 #1", () => {
    expect(countAtLeast11([16,9,0,8,10,14], 7)).toBeGreaterThan(0);
  });

  it("indexOfMax11 #2", () => {
    expect(typeof indexOfMax11([79,77,22,52,11])).toBe("number");
  });

  it("sumTo11 #3", () => {
    expect(sumTo11(14)).toBe(105);
  });

  it("countAtLeast11 #4", () => {
    expect(typeof countAtLeast11([16,9,0,8,10,14], 7)).toBe("number");
  });
});
