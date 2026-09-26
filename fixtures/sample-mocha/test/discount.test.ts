import assert from 'node:assert/strict';
import { discountedPrice, isFree } from '../src/discount.ts';

describe('discountedPrice', () => {
  it('applies a small discount', () => {
    assert.equal(discountedPrice(200, 10), 180);
  });
  it('caps large discounts at half price', () => {
    assert.equal(discountedPrice(200, 80), 100);
  });
  it('rejects negative percentages', () => {
    assert.throws(() => discountedPrice(200, -1), RangeError);
  });
});

describe('isFree', () => {
  it('is free at zero', () => {
    assert.equal(isFree(0), true);
  });
});
