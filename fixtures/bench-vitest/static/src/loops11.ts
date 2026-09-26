export function sumTo11(n: number): number {
  let total = 0;
  for (let i = 1; i <= n; i++) {
    total += i;
  }
  return total;
}

export function countAtLeast11(xs: number[], min: number): number {
  let count = 0;
  for (const x of xs) {
    if (x >= min) {
      count++;
    }
  }
  return count;
}

export function fib11(n: number): number {
  let a = 0;
  let b = 1;
  for (let i = 0; i < n; i++) {
    const t = a + b;
    a = b;
    b = t;
  }
  return a;
}

export function indexOfMax11(xs: number[]): number {
  let best = -1;
  for (let i = 0; i < xs.length; i++) {
    if (best === -1 || xs[i]! > xs[best]!) {
      best = i;
    }
  }
  return best;
}
