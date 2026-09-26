import { describe, expect, it } from 'vitest';
import { sumTo35, countAtLeast35, indexOfMax35 } from '../src/loops35';

describe("loops35", () => {
  it("sumTo35 #0", () => {
    expect(typeof sumTo35(0)).toBe("number");
  });

  it("countAtLeast35 #1", () => {
    expect(countAtLeast35([20,6,10,10,3,16], 15)).toBe(2);
  });

  it("indexOfMax35 #2", () => {
    expect(indexOfMax35([22,74,17,63,79])).toBe(4);
  });

  it("sumTo35 #3", () => {
    expect(typeof sumTo35(3)).toBe("number");
  });

  it("countAtLeast35 #4", () => {
    expect(countAtLeast35([20,6,10,10,3,16], 15)).toBe(2);
  });
});
