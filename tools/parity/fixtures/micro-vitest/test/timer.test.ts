import { expect, it } from 'vitest';
import { fire } from '../src/timer';

it('fires', async () => {
  expect(fire()).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 20));
});
