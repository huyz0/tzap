import { describe, expect, it } from 'vitest';
import { count, label, orDefault, pick } from '../src/logic';

describe('logic', () => {
  it('picks', () => {
    expect(pick(undefined, 'x')).toBe('x');
  });
  it('defaults', () => {
    expect(orDefault(0, 7)).toBe(7);
  });
  it('counts', () => {
    expect(count(new Map([['a', 2]]), 'a')).toBe(2);
  });
  it('labels', () => {
    expect(label('x')).toBe('x');
  });
});
