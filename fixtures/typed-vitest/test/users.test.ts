import { describe, expect, it } from 'vitest';
import { cityOf, displayName, tagCount, type User } from '../src/users';

const ada: User = { name: 'Ada', address: { city: 'London', zip: 'N1' }, tags: ['math'] };
const bob: User = { name: 'Bob', nickname: ' B ', address: null, tags: [] };

describe('users', () => {
  it('reads the city', () => {
    expect(cityOf(ada)).toBe('London');
    expect(cityOf(bob)).toBe('unknown');
  });
  it('prefers the nickname', () => {
    expect(displayName(bob)).toBe('B');
    expect(displayName(ada)).toBe('Ada');
  });
  it('counts tags', () => {
    expect(tagCount(ada)).toBe(1);
  });
});
