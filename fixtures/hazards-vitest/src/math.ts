export function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

export function describeSign(n: number): string {
  if (n > 0) return 'positive';
  if (n < 0) return 'negative';
  return 'zero';
}
