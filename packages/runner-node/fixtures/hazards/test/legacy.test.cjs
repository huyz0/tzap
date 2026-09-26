const { test } = require('node:test');
const assert = require('node:assert/strict');
const { double } = require('../src/legacy.cjs');

test('doubles', () => {
  assert.equal(globalThis.__lifecycle, undefined, 'a later file\'s before hook ran early');
  assert.equal(double(21), 42);
});
