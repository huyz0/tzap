import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isFree } from '../src/free.ts';

test('skips itself', (t) => {
  t.skip('not today');
});

test('throws from a timer', async () => {
  if (!isFree(0)) setTimeout(() => { throw new Error('late'); }, 0);
  await new Promise((r) => setTimeout(r, 20));
});

test('exits', () => {
  if (!isFree(0)) process.exit(1);
  assert.equal(isFree(1), false);
});
