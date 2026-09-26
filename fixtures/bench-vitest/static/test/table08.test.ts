import { describe, expect, it } from 'vitest';
import { rateOf08, isHigh08, SUMMARY08 } from '../src/table08';

describe("table08", () => {
  it("rateOf08 #0", () => {
    expect(rateOf08('none')).toBe(-1);
  });

  it("isHigh08 #1", () => {
    expect(isHigh08("kilo")).toBe(true);
  });

  it("SUMMARY08 #2", () => {
    expect(SUMMARY08.high).toBe(8);
  });

  it("rateOf08 #3", () => {
    expect(rateOf08("amber")).toBe(1);
  });

  it("isHigh08 #4", () => {
    expect(isHigh08("delta")).toBe(true);
  });
});
