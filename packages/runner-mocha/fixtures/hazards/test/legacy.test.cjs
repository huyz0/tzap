const assert = require('node:assert/strict');
const { double } = require('../src/legacy.cjs');

it('doubles', () => {
  assert.equal(double(21), 42);
});
