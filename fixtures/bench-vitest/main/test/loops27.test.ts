import { describe, expect, it } from 'vitest';
import { sumTo27, countAtLeast27, fib27, indexOfMax27 } from '../src/loops27';

describe("loops27", () => {
  it("sumTo27 #0", () => {
    expect(sumTo27(0)).toBe(0);
  });

  it("countAtLeast27 #1", () => {
    expect(countAtLeast27([10,12,3,16,17,18], 13)).toBe(3);
  });

  it("fib27 #2", () => {
    expect(fib27(1)).toBe(1);
  });

  it("indexOfMax27 #3", () => {
    expect(indexOfMax27([59,91,91,49,75])).toBe(1);
  });

  it("sumTo27 #4", () => {
    expect(sumTo27(3)).toBe(6);
  });
});
