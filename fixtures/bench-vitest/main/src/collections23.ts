export function multiplesOf2_23(xs: number[]): number[] {
  return xs.filter((x) => x % 2 === 0);
}

export function doubled23(xs: number[]): number[] {
  return xs.map((x) => x * 2);
}

export function total23(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

export function unique23(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

export function countByLength23(xs: string[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const x of xs) {
    out[x.length] = (out[x.length] ?? 0) + 1;
  }
  return out;
}

export function range23(xs: number[]): { min: number; max: number } | undefined {
  if (xs.length === 0) {
    return undefined;
  }
  return { min: Math.min(...xs), max: Math.max(...xs) };
}
