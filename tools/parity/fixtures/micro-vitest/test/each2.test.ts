import { expect, it } from 'vitest';
import { handlers } from '../src/each2';

it('copies the listed error props', () => {
  expect(handlers[0]!(new Error('x'), ['message'])).toEqual({ name: 'Error', message: 'x' });
});
