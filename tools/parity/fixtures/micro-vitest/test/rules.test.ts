import { expect, it } from 'vitest';
import { FIRST } from '../src/rules';

it('names the first rule', () => {
  expect(FIRST).toBe('first');
});
