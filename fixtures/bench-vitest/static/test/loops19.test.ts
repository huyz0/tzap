import { describe, expect, it } from 'vitest';
import { countAtLeast19, fib19, indexOfMax19 } from '../src/loops19';

describe("loops19", () => {
  it("countAtLeast19 #0", () => {
    expect(typeof countAtLeast19([2,15,15,10,5,10], 9)).toBe("number");
  });

  it("fib19 #1", () => {
    expect(fib19(1)).toBe(1);
  });

  it("indexOfMax19 #2", () => {
    expect(indexOfMax19([])).toBeLessThanOrEqual(-1);
  });

  it("countAtLeast19 #3", () => {
    expect(countAtLeast19([2,15,15,10,5,10], 9)).toBe(4);
  });

  it("fib19 #4", () => {
    expect(fib19(8)).toBe(21);
  });
});
