import { describe, expect, it } from 'vitest';
import { multiplesOf3_07, doubled07, total07, unique07, countByLength07, range07 } from '../src/collections07';

describe("collections07", () => {
  it("multiplesOf3_07 #0", () => {
    expect(multiplesOf3_07([17,6,1,21,9,18])).toEqual([6,21,9,18]);
  });

  it("doubled07 #1", () => {
    expect(Array.isArray(doubled07([6,5,7]))).toBe(true);
  });

  it("total07 #2", () => {
    expect(total07([5,22,15,3])).toBeGreaterThan(0);
  });

  it("unique07 #3", () => {
    expect(unique07(["victor","onyx","zulu","ivory","ivory"])).toEqual(["ivory","onyx","victor","zulu"]);
  });

  it("countByLength07 #4", () => {
    expect(countByLength07(["tango","mango","romeo","coral","bravo","echo"])).toEqual({"4":1,"5":5});
  });
});
