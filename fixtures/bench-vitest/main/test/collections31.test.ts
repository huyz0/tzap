import { describe, expect, it } from 'vitest';
import { multiplesOf2_31, doubled31, total31, unique31, countByLength31 } from '../src/collections31';

describe("collections31", () => {
  it("multiplesOf2_31 #0", () => {
    expect(multiplesOf2_31([13,27,20,13,29,14])).toEqual([20,14]);
  });

  it("doubled31 #1", () => {
    expect(doubled31([5,3,9])).toEqual([10,6,18]);
  });

  it("total31 #2", () => {
    expect(total31([9,28,16,44])).toBe(97);
  });

  it("unique31 #3", () => {
    expect(unique31(["cedar","romeo","sierra","delta","maple","mango"])).toEqual(["cedar","delta","mango","maple","romeo","sierra"]);
  });

  it("countByLength31 #4", () => {
    expect(countByLength31(["papa","oscar","victor","mango","amber","papa"])).toEqual({"4":2,"5":3,"6":1});
  });
});
