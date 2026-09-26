import { describe, expect, it } from 'vitest';
import { sumTo19, countAtLeast19, fib19, indexOfMax19 } from '../src/loops19';

describe("loops19", () => {
  it("sumTo19 #0", () => {
    expect(sumTo19(0)).toBe(0);
  });

  it("countAtLeast19 #1", () => {
    expect(countAtLeast19([10,11,2,13,9,18], 15)).toBeGreaterThan(0);
  });

  it("fib19 #2", () => {
    expect(typeof fib19(1)).toBe("number");
  });

  it("indexOfMax19 #3", () => {
    expect(indexOfMax19([65,95,73,25,25])).toBe(1);
  });

  it("sumTo19 #4", () => {
    expect(sumTo19(16)).toBeGreaterThan(0);
  });
});
