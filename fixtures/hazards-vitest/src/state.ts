// Module state that outlives a test: a warm engine that reuses this module across mutants
// must not let one mutant's leftovers decide another's verdict.
let calls = 0;

export function nextId(): number {
  calls += 1;
  return calls;
}

const memo = new Map<number, number>();

export function square(n: number): number {
  const hit = memo.get(n);
  if (hit !== undefined) return hit;
  const v = n * n;
  memo.set(n, v);
  return v;
}
