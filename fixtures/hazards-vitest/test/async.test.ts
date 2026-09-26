import { expect, it, vi } from 'vitest';
import { debounce, ready } from '../src/async';

it('resolves when ready', async () => {
  await expect(ready(true)).resolves.toBe('ok');
});

it('debounces', () => {
  vi.useFakeTimers();
  const fn = vi.fn();
  const d = debounce(fn, 100);
  d();
  d();
  vi.advanceTimersByTime(150);
  expect(fn).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});
