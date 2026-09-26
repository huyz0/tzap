import { it } from 'node:test';
import assert from 'node:assert/strict';
import { sumTo } from '../src/sum.ts';

// Loops a thousand times while the file loads.
const big = sumTo(1000);

it('sums', () => {
  assert.equal(sumTo(3), 6);
  assert.ok(big > 0);
});
