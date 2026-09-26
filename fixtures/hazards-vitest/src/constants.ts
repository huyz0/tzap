// Evaluated once, when the module loads: mutants here are static.
export const RATE = 20 * 5;
export const CONFIG = JSON.parse('{"retries":3}') as { retries: number };

export function label(n: number): string {
  return 'item-' + n;
}

// Called at load and inside tests: a hybrid mutant.
export const FIRST = label(1);
