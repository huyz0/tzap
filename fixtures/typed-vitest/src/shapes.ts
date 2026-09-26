export interface Shape {
  kind: 'circle' | 'square';
  size: number;
}

export class Box {
  constructor(private readonly items: number[]) {}

  /** Emptying a getter's body: a getter must return a value. */
  get count(): number {
    return this.items.length;
  }
}

/** An unannotated arrow called with an argument in this file: `() => undefined` takes none. */
const area = (s: Shape) => (s.kind === 'circle' ? 3 * s.size * s.size : s.size * s.size);

export function totalArea(shapes: Shape[]): number {
  return shapes.reduce((sum, s) => sum + area(s), 0);
}

/** `satisfies` a type with required properties. */
export const origin = { kind: 'circle', size: 0 } satisfies Shape;

/** A type predicate must return a boolean. */
export function isShape(x: unknown): x is Shape {
  return typeof x === 'object' && x !== null && 'kind' in x;
}

/** A callback slot on a parameter declared optional: calling it without `?.` is a type error. */
export function notify(done?: () => void): void {
  done?.();
}
