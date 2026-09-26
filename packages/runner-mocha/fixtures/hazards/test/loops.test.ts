import assert from 'node:assert/strict';
import { later, limit, sumTo } from '../src/loops.ts';

describe('sums', () => {
  let base = 0;
  beforeEach(() => {
    base = sumTo(3);
  });
  afterEach(() => {
    base = -1;
  });
  it('uses the hook', () => {
    assert.equal(base, 6);
  });
  it('dup', () => {
    assert.equal(sumTo(4), 10);
  });
  it('dup', () => {
    assert.equal(sumTo(1), 1);
  });
  it.skip('is skipped', () => {
    assert.fail('never');
  });
  it('is pending');
});

describe('settling', () => {
  it('settles', async () => {
    assert.equal(await later(2), 2);
  });
});

it('spins to a limit', () => {
  const L = limit(false);
  let i = 0;
  while (i < L) i++;
  assert.equal(i, 3);
});
