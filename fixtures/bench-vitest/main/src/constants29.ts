export const LEVELS29 = ["debug","error","fatal","info"];
const WEIGHTS: Record<string, number> = { maple: 5, bravo: 8, lima: 6 };
const PREFIX = "cedar" + '-';
export const DEFAULT_LEVEL29 = LEVELS29.includes('info') ? 'info' : LEVELS29[0];
export const LIMITS29 = { min: 2, max: 56, unit: 'ms' };

export function levelRank29(level: string): number {
  return LEVELS29.indexOf(level);
}

export function weightOf29(kind: string): number {
  return WEIGHTS[kind] ?? 0;
}

export function label29(id: number): string {
  return `${PREFIX}${id}`;
}

export function withinLimits29(x: number): boolean {
  return x >= LIMITS29.min && x <= LIMITS29.max;
}

export function describeLimits29(): string {
  return LIMITS29.min + '..' + LIMITS29.max + ' ' + LIMITS29.unit;
}
