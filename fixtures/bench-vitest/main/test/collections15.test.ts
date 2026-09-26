import { describe, expect, it } from 'vitest';
import { multiplesOf4_15, doubled15, total15, unique15, countByLength15, range15 } from '../src/collections15';

describe("collections15", () => {
  it("multiplesOf4_15 #0", () => {
    expect(Array.isArray(multiplesOf4_15([7,8,2,7,18,4]))).toBe(true);
  });

  it("doubled15 #1", () => {
    expect(doubled15([2,5,4])).toEqual([4,10,8]);
  });

  it("total15 #2", () => {
    expect(typeof total15([30,8,31,1])).toBe("number");
  });

  it("unique15 #3", () => {
    expect(unique15(["mango","papa","oscar","bravo"]).length).toBeGreaterThan(0);
  });

  it("countByLength15 #4", () => {
    expect(countByLength15(["amber","papa","oscar","cedar","maple"])).toEqual({"4":1,"5":4});
  });
});
