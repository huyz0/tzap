import { describe, expect, it } from 'vitest';
import { multiplesOf2_23, doubled23, total23, unique23, countByLength23, range23 } from '../src/collections23';

describe("collections23", () => {
  it("multiplesOf2_23 #0", () => {
    expect(multiplesOf2_23([22,20,28,8,22,7]).length).toBeGreaterThan(0);
  });

  it("doubled23 #1", () => {
    expect(Array.isArray(doubled23([2,9,3]))).toBe(true);
  });

  it("total23 #2", () => {
    expect(total23([])).toBe(0);
  });

  it("unique23 #3", () => {
    expect(unique23(["papa","onyx","maple","zulu"])).toEqual(["maple","onyx","papa","zulu"]);
  });

  it("countByLength23 #4", () => {
    expect(countByLength23(["coral","delta","ivory","mango","bravo","onyx"])).toBeDefined();
  });
});
