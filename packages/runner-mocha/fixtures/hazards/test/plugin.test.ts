import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import { sumTo } from '../src/loops.ts';

describe('plugin', () => {
  it('runs inside the root hooks', () => {
    assert.equal((globalThis as { rootHook?: string }).rootHook, 'set');
    assert.equal(sumTo(2), 3);
  });
  it('ran the global setup once', () => {
    assert.equal((globalThis as { globalSetups?: number }).globalSetups, 1);
  });
});
