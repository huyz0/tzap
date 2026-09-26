/** Declared non-void return: `() => undefined` is a type error. */
export const double = (n: number): number => n * 2;

/** Inferred return used as a number in the same file: `() => undefined` is a type error here. */
export const square = (n: number) => n * n;

export const sumSquares = (xs: number[]): number => xs.map(square).reduce((a, b) => a + b, 0);

/** Declared void return: `() => undefined` type-checks. */
export const report = (msg: string): void => {
  console.log(msg);
};

/** Contextually typed callbacks. */
export const steps: Array<(n: number) => number> = [(n) => n + 1, (n) => n - 1];

/** A callback whose result is ignored. */
export function each(xs: number[], f: (n: number) => void): void {
  xs.forEach((x) => f(x));
}

/** Inferred return, never used in a typed position: `() => undefined` type-checks. */
export const shout = (s: string) => s.toUpperCase();

/** Declared non-void return, but nothing gives the binding a type or calls it: `() => undefined` type-checks. */
export const trimmed = (s: string): string => s.trim();
