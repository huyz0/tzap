import { describe, expect, it } from 'vitest';
import { discountedPrice, isFree } from '../src/discount';

describe('discountedPrice', () => {
  it('applies a small discount', () => {
    expect(discountedPrice(200, 10)).toBe(180);
  });
  it('caps large discounts at half price', () => {
    expect(discountedPrice(200, 80)).toBe(100);
  });
  it('rejects negative percentages', () => {
    expect(() => discountedPrice(200, -1)).toThrow(RangeError);
  });
});

describe('isFree', () => {
  it('is free at zero', () => {
    expect(isFree(0)).toBe(true);
  });
});
