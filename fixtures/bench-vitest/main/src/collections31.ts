export function multiplesOf2_31(xs: number[]): number[] {
  return xs.filter((x) => x % 2 === 0);
}

export function doubled31(xs: number[]): number[] {
  return xs.map((x) => x * 2);
}

export function total31(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

export function unique31(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

export function countByLength31(xs: string[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const x of xs) {
    out[x.length] = (out[x.length] ?? 0) + 1;
  }
  return out;
}

export function range31(xs: number[]): { min: number; max: number } | undefined {
  if (xs.length === 0) {
    return undefined;
  }
  return { min: Math.min(...xs), max: Math.max(...xs) };
}
