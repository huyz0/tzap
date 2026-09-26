import { describe, expect, it } from 'vitest';
import { sumTo03, fib03, indexOfMax03 } from '../src/loops03';

describe("loops03", () => {
  it("sumTo03 #0", () => {
    expect(sumTo03(0)).toBe(0);
  });

  it("fib03 #1", () => {
    expect(fib03(1)).toBeGreaterThan(0);
  });

  it("indexOfMax03 #2", () => {
    expect(indexOfMax03([])).toBeLessThanOrEqual(-1);
  });

  it("sumTo03 #3", () => {
    expect(sumTo03(19)).toBeGreaterThan(0);
  });

  it("fib03 #4", () => {
    expect(typeof fib03(15)).toBe("number");
  });
});
