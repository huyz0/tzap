const { test } = require('node:test');
const assert = require('node:assert/strict');
const { double } = require('../src/legacy.cjs');

test('doubles', () => {
  assert.equal(double(21), 42);
});
