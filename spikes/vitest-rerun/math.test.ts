import { describe, it, expect } from 'vitest';
import { add, mul } from '../src/math';
describe('math', () => {
  it('adds', () => { expect(add(2, 3)).toBe(5); });
  it('muls', () => { expect(mul(2, 3)).toBe(6); });
  for (let i = 0; i < 20; i++) it('filler ' + i, () => { expect(add(i, 0)).toBe(i); });
});
