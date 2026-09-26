/** Function body block: emptying it removes the only return. */
export function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) {
    return lo;
  }
  if (n > hi) {
    return hi;
  }
  return n;
}

/** Emptying a branch leaves a path with no return. */
export function sign(n: number): number {
  if (n > 0) {
    return 1;
  } else if (n < 0) {
    return -1;
  } else {
    return 0;
  }
}

/** Void function: every block may be emptied. */
export function total(xs: number[]): void {
  let sum = 0;
  for (const x of xs) {
    sum += x;
  }
  if (sum > 100) {
    console.log('big');
  }
}

/** A variable assigned in a block and used after it: definite assignment. */
export function parity(n: number): string {
  let label: string;
  if (n % 2 === 0) {
    label = 'even';
  } else {
    label = 'odd';
  }
  return label;
}
