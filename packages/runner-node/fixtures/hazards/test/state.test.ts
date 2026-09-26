import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memo } from '../src/state.ts';

test('memoises', () => {
  assert.equal(memo(), 'computed');
});
