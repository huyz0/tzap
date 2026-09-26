// Mutants that look type-invalid from the source alone and are not: no shipped rule may drop them.

interface X {
  b: number;
}

// `a` is narrowed by the guard: `a?.b` -> `a.b` compiles.
export function narrowed(a?: X): number {
  if (!a) return 0;
  return a?.b ?? 1;
}

// A destructured parameter shadows the outer nullable `p`.
const p: X | undefined = undefined;
export function shadowed({ p }: { p: X }): number {
  return p?.b ?? p.b;
}
export const outer = p;

// A generic alias that admits void: the empty body compiles.
type MaybePromise<T> = T | Promise<T>;
export function logs(): MaybePromise<void> {
  console.log('logged');
}
export const typed: () => MaybePromise<void> = () => logs();

// `cfg.a` inside `use` reads the parameter, not the literal: `{ a: 1 }` -> `{}` compiles.
const cfg = { a: 1 };
export function use(cfg: { a: number }): number {
  return cfg.a;
}
export const text = JSON.stringify(cfg);

// `!(a ?? b)` -> `(a ?? b)` keeps its parentheses where `??` meets `&&`.
export function mixed(a: boolean | undefined, b: boolean, c: boolean): boolean {
  return !(a ?? b) && c;
}

// An arrow returning a parenthesised object: `() => undefined` compiles where the type allows it.
export const make = (n: number): { n: number } | undefined => ({ n });
