import { describe, expect, it } from 'vitest';
import { sumTo11, countAtLeast11, fib11, indexOfMax11 } from '../src/loops11';

describe("loops11", () => {
  it("sumTo11 #0", () => {
    expect(sumTo11(10)).toBe(55);
  });

  it("countAtLeast11 #1", () => {
    expect(countAtLeast11([1,8,0,6,9,12], 15)).toBe(0);
  });

  it("fib11 #2", () => {
    expect(fib11(1)).toBe(1);
  });

  it("indexOfMax11 #3", () => {
    expect(indexOfMax11([89,78,57,96,97])).toBe(4);
  });

  it("sumTo11 #4", () => {
    expect(sumTo11(0)).toBe(0);
  });
});
