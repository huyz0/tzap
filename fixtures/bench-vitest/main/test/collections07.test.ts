import { describe, expect, it } from 'vitest';
import { multiplesOf4_07, doubled07, total07, unique07, countByLength07, range07 } from '../src/collections07';

describe("collections07", () => {
  it("multiplesOf4_07 #0", () => {
    expect(multiplesOf4_07([9,19,13,30,24,12]).length).toBeGreaterThan(0);
  });

  it("doubled07 #1", () => {
    expect(doubled07([2,2,7])).toEqual([4,4,14]);
  });

  it("total07 #2", () => {
    expect(total07([])).toBeLessThanOrEqual(0);
  });

  it("unique07 #3", () => {
    expect(Array.isArray(unique07(["onyx","alpha","oscar","bravo","maple"]))).toBe(true);
  });

  it("countByLength07 #4", () => {
    expect(typeof countByLength07(["kilo","delta","zulu","onyx","bravo","bravo"])).toBe("object");
  });
});
