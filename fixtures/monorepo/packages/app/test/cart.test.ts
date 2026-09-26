import { expect, it } from 'vitest';
import { total } from '../src/cart';

it('prices a small order with tax', () => {
  expect(total(10, 2)).toBe(24);
});

it('discounts bulk orders', () => {
  expect(total(10, 10)).toBe(108);
});
