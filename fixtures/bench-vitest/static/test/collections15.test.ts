import { describe, expect, it } from 'vitest';
import { multiplesOf4_15, doubled15, total15, unique15, range15 } from '../src/collections15';

describe("collections15", () => {
  it("multiplesOf4_15 #0", () => {
    expect(multiplesOf4_15([23,12,15,26,19,29])).toEqual([12]);
  });

  it("doubled15 #1", () => {
    expect(Array.isArray(doubled15([7,2,5]))).toBe(true);
  });

  it("total15 #2", () => {
    expect(typeof total15([17,50,16,48])).toBe("number");
  });

  it("unique15 #3", () => {
    expect(unique15(["alpha","oscar","zulu","victor","sierra"])).toEqual(["alpha","oscar","sierra","victor","zulu"]);
  });

  it("range15 #4", () => {
    expect(typeof range15([17,-11,0,-4,-13])).toBe("object");
  });
});
