import { expect, it } from 'vitest';
import { copyProps } from '../src/each';

it('copies the listed props', () => {
  expect(copyProps({ a: 1, b: 2 }, {}, ['a'])).toEqual({ a: 1 });
});
