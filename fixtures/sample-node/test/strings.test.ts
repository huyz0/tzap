import { it } from 'node:test';
import assert from 'node:assert/strict';
import { joinNames } from '../src/strings.ts';

it('joins non-blank names', () => {
  assert.equal(joinNames(['a', ' ', 'b']), 'a, b');
});
