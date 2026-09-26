const FACTOR = 2;
const OFFSET = 9;

export function scale24(x: number): number {
  return x * FACTOR + OFFSET;
}

export function clamp24(x: number, lo: number, hi: number): number {
  if (x < lo) {
    return lo;
  }
  if (x > hi) {
    return hi;
  }
  return x;
}

export function average24(xs: number[]): number {
  if (xs.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const x of xs) {
    sum += x;
  }
  return sum / xs.length;
}

export function percentOf24(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

export function lerp24(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
