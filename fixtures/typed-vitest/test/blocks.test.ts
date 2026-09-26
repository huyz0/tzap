import { describe, expect, it } from 'vitest';
import { clamp, parity, sign } from '../src/blocks';

describe('blocks', () => {
  it('clamps', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
  });
  it('signs', () => {
    expect(sign(3)).toBe(1);
  });
  it('parity', () => {
    expect(parity(2)).toBe('even');
  });
});
