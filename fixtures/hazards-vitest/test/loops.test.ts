import { expect, it } from 'vitest';
import { countDown, sumTo } from '../src/loops';

it('sums', () => {
  expect(sumTo(4)).toBe(10);
});

it('counts down', () => {
  expect(countDown(3)).toBe(3);
});
