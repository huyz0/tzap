import assert from 'node:assert/strict';
import { sumTo } from '../src/loops.ts';

// Callback-style hooks and bodies: Mocha tells them apart by their arity.
describe('callbacks', () => {
  let base = 0;
  beforeEach(function (done) {
    setImmediate(() => {
      base = sumTo(3);
      done(base === 6 ? undefined : new Error(`the hook computed ${base}`));
    });
  });
  afterEach(function (done) {
    setImmediate(done);
  });
  it('reads what the hook computed', function (done) {
    setImmediate(() => {
      assert.equal(base, 6);
      done();
    });
  });
});

describe('strays', () => {
  it('rejects a promise nobody awaits', function (done) {
    // Not the test's own failure: Mocha fails the running test with it only because the
    // rejection reaches the process.
    if (sumTo(2) !== 3) void Promise.reject(new Error('a stray rejection'));
    setTimeout(done, 20);
  });
});
