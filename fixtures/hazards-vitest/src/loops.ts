export function sumTo(n: number): number {
  let s = 0;
  for (let i = 1; i <= n; i++) {
    s += i;
  }
  return s;
}

export function countDown(n: number): number {
  let steps = 0;
  while (n > 0) {
    n--;
    steps++;
  }
  return steps;
}
