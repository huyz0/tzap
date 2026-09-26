const FACTOR = 6;
const OFFSET = 8;

export function scale00(x: number): number {
  return x * FACTOR + OFFSET;
}

export function clamp00(x: number, lo: number, hi: number): number {
  if (x < lo) {
    return lo;
  }
  if (x > hi) {
    return hi;
  }
  return x;
}

export function average00(xs: number[]): number {
  if (xs.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const x of xs) {
    sum += x;
  }
  return sum / xs.length;
}

export function percentOf00(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

export function lerp00(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
