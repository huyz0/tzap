export const LEVELS13 = ["error","fatal","debug","warn"];
const WEIGHTS: Record<string, number> = { onyx: 2, cedar: 10, amber: 15 };
const PREFIX = "victor" + '-';
export const DEFAULT_LEVEL13 = LEVELS13.includes('info') ? 'info' : LEVELS13[0];
export const LIMITS13 = { min: 0, max: 54, unit: 'ms' };

export function levelRank13(level: string): number {
  return LEVELS13.indexOf(level);
}

export function weightOf13(kind: string): number {
  return WEIGHTS[kind] ?? 0;
}

export function label13(id: number): string {
  return `${PREFIX}${id}`;
}

export function withinLimits13(x: number): boolean {
  return x >= LIMITS13.min && x <= LIMITS13.max;
}

export function describeLimits13(): string {
  return LIMITS13.min + '..' + LIMITS13.max + ' ' + LIMITS13.unit;
}
