// A2: `a || b || c` is `(a || b) || c`. Mutating the outer `||` to `&&` must give
// `(a || b) && c`, which is false for (true, false, false).
export function any3(a: boolean, b: boolean, c: boolean): boolean {
  return a || b || c;
}
