export const LEVELS37 = ["error","info","fatal","warn"];
const WEIGHTS: Record<string, number> = { victor: 4, alpha: 6, amber: 6 };
const PREFIX = "sierra" + '-';
export const DEFAULT_LEVEL37 = LEVELS37.includes('info') ? 'info' : LEVELS37[0];
export const LIMITS37 = { min: 1, max: 80, unit: 'ms' };

export function levelRank37(level: string): number {
  return LEVELS37.indexOf(level);
}

export function weightOf37(kind: string): number {
  return WEIGHTS[kind] ?? 0;
}

export function label37(id: number): string {
  return `${PREFIX}${id}`;
}

export function withinLimits37(x: number): boolean {
  return x >= LIMITS37.min && x <= LIMITS37.max;
}

export function describeLimits37(): string {
  return LIMITS37.min + '..' + LIMITS37.max + ' ' + LIMITS37.unit;
}
