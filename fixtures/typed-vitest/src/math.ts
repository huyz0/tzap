/** Declared non-void return: returning `undefined` is a type error. */
export const double = (n: number): number => n * 2;

/** Inferred return used as a number in the same file: returning `undefined` is a type error here. */
export const square = (n: number) => n * n;

export const sumSquares = (xs: number[]): number => xs.map(square).reduce((a, b) => a + b, 0);

/** Declared void return: returning `undefined` type-checks. */
export const report = (msg: string): void => {
  console.log(msg);
};

/** Contextually typed callbacks. */
export const steps: Array<(n: number) => number> = [(n) => n + 1, (n) => n - 1];

/** A callback whose result is ignored. */
export function each(xs: number[], f: (n: number) => void): void {
  xs.forEach((x) => f(x));
}

/** Inferred return, never used in a typed position: returning `undefined` type-checks. */
export const shout = (s: string) => s.toUpperCase();

/** Declared non-void return: returning `undefined` is a type error, with nothing else to catch it. */
export const trimmed = (s: string): string => s.trim();

/** Bound to a function type that returns a number: returning `undefined` is a type error. */
export const inc: (n: number) => number = (n) => n + 1;

/** Async, bound to a function type returning `Promise<void>`: still a promise, so it type-checks. */
export const settle: (n: number) => Promise<void> = async (n) => void (await Promise.resolve(n));

/** Inferred return used as a string only by the test: returning `undefined` breaks the test file alone. */
export const label = (n: number) => `#${n}`;

/** Async with a declared `Promise<void>`: returning `undefined` still returns a promise, and type-checks. */
export const flush = async (): Promise<void> => void (await Promise.resolve());
