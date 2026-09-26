import { describe, expect, it } from 'vitest';
import { multiplesOf2_39, doubled39, total39, countByLength39, range39 } from '../src/collections39';

describe("collections39", () => {
  it("multiplesOf2_39 #0", () => {
    expect(Array.isArray(multiplesOf2_39([10,20,13,12,15,24]))).toBe(true);
  });

  it("doubled39 #1", () => {
    expect(doubled39([3,7,6]).length).toBeGreaterThan(0);
  });

  it("total39 #2", () => {
    expect(total39([])).toBe(0);
  });

  it("countByLength39 #3", () => {
    expect(countByLength39(["alpha","oscar","maple","kilo","papa"])).toEqual({"4":2,"5":3});
  });

  it("range39 #4", () => {
    expect(range39([])).not.toBeNull();
  });
});
