import { describe, expect, it } from 'vitest';
import { CONFIG, FIRST, RATE, label } from '../src/constants';

describe('constants', () => {
  it('has the rate', () => {
    expect(RATE).toBe(100);
  });
  it('has the retries', () => {
    expect(CONFIG.retries).toBe(3);
  });
  it('labels', () => {
    expect(label(2)).toMatchInlineSnapshot(`"item-2"`);
  });
  it('labels the first', () => {
    expect(FIRST).toBe('item-1');
  });
});
