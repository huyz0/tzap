import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { sumTo } from '../src/loops.ts';

// Under `node --test` each file runs in its own process: these run before this file's first test
// and after its last, and never while another file's tests run.
const g = globalThis as { __lifecycle?: string };
let base = 0;
before(() => {
  g.__lifecycle = 'open';
  base = sumTo(2);
});
before((_t, done) => {
  setImmediate(done);
});
after(async () => {
  await new Promise((r) => setImmediate(r));
  delete g.__lifecycle;
});

test('runs inside its file hooks', () => {
  assert.equal(g.__lifecycle, 'open');
  assert.equal(base + sumTo(1), 4);
});
