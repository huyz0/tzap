import { expect, it } from 'vitest';
import { clamp } from '../src/math';

// Order-dependent on purpose: the second test needs the first to have run.
let low: number | undefined;

it('clamps below', () => {
  low = clamp(-5, 0, 10);
  expect(low).toBe(0);
});

it('remembers the clamped value', () => {
  expect(low! + clamp(15, 0, 10)).toBe(10);
});
