import { expect, it } from 'vitest';
import { any3 } from '../src/logical';

it('is true when only the first is true', () => {
  expect(any3(true, false, false)).toBe(true);
});
