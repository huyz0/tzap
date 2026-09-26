/** `??` on an optional string: `&&` makes the result `string | undefined`. */
export function pick(a: string | undefined, fallback: string): string {
  return a ?? fallback;
}

/** `||` on numbers: `&&` still yields a number. */
export function orDefault(n: number, d: number): number {
  return n || d;
}

/** Booleans: any swap type-checks. */
export function both(a: boolean, b: boolean): boolean {
  return a && b;
}

/** Map lookup with a default. */
export function count(m: Map<string, number>, k: string): number {
  return m.get(k) ?? 0;
}

/** `||` with a union: `&&` yields `'' | undefined | string`, still not a string. */
export function label(s: string | undefined): string {
  return s || 'none';
}

/** Assignment operators on nullable state. */
export function cached(cache: { value?: string }, make: () => string): string {
  cache.value ??= make();
  return cache.value;
}
