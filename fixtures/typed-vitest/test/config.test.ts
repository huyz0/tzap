import { describe as group, expect, it } from 'vitest';
import { defaults, describe, merge } from '../src/config';

group('config', () => {
  it('has defaults', () => {
    expect(defaults().retries).toBe(3);
  });
  it('merges', () => {
    expect(merge(defaults(), { retries: 5 }).retries).toBe(5);
  });
  it('describes', () => {
    expect(describe(defaults())).toContain('retries=3');
  });
});
