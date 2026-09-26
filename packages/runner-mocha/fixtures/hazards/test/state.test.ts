import assert from 'node:assert/strict';
import { memo } from '../src/state.ts';

it('memoises', () => {
  assert.equal(memo(), 'computed');
});
