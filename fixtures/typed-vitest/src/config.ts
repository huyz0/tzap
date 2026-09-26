export interface Options {
  retries: number;
  timeoutMs: number;
  verbose?: boolean;
}

/** Object literal assigned to a variable of a type with required properties. */
export function defaults(): Options {
  const base: Options = { retries: 3, timeoutMs: 1000 };
  return base;
}

/** An object literal for a type whose properties are all optional: `{}` type-checks. */
export function patchOf(retries?: number): Partial<Options> {
  const patch: Partial<Options> = { retries };
  return patch;
}

/** Returned object literal, the return type has required properties. */
export function merge(a: Options, b: Partial<Options>): Options {
  return { ...a, ...b };
}

/** Record type: `{}` type-checks. */
export function labels(): Record<string, string> {
  return { ok: 'fine', bad: 'broken' };
}

/** Untyped object literal whose shape is used later in the same function. */
export function describe(o: Options): string {
  const parts = { head: `retries=${o.retries}`, tail: `timeout=${o.timeoutMs}` };
  return `${parts.head}, ${parts.tail}`;
}
