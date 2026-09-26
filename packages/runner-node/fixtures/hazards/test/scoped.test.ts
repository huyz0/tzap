import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { sumTo } from '../src/loops.ts';

// Under `node --test` each file runs in its own process: these hooks see only this file's tests.
let seen = 0;
beforeEach((t) => {
  if (!t.filePath?.endsWith('scoped.test.ts')) throw new Error(`hook leaked into ${t.name}`);
  seen++;
});
afterEach((t, done) => {
  if (!t.filePath?.endsWith('scoped.test.ts')) throw new Error(`hook leaked into ${t.name}`);
  done();
});

test('sees its own hooks', () => {
  assert.ok(seen >= 1);
  assert.equal(sumTo(3), 6);
});
