const FACTOR = 8;
const OFFSET = 1;

export function scale16(x: number): number {
  return x * FACTOR + OFFSET;
}

export function clamp16(x: number, lo: number, hi: number): number {
  if (x < lo) {
    return lo;
  }
  if (x > hi) {
    return hi;
  }
  return x;
}

export function average16(xs: number[]): number {
  if (xs.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const x of xs) {
    sum += x;
  }
  return sum / xs.length;
}

export function percentOf16(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

export function lerp16(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
