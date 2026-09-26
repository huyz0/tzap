export function sumTo(n: number): number {
  let s = 0;
  for (let i = 1; i <= n; i++) s += i;
  return s;
}

export function later(v: number): Promise<number> {
  return new Promise((resolve) => {
    if (v >= 0) resolve(v);
  });
}

export function limit(big: boolean): number {
  if (big) {
    return Infinity;
  }
  return 3;
}
