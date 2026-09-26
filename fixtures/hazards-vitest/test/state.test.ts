import { expect, it } from 'vitest';
import { nextId, square } from '../src/state';

it('hands out ids starting at one', () => {
  expect(nextId()).toBe(1);
});

it('squares', () => {
  expect(square(3)).toBe(9);
  expect(square(4)).toBe(16);
});
