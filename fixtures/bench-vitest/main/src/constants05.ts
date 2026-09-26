export const LEVELS05 = ["warn","debug","error","info"];
const WEIGHTS: Record<string, number> = { victor: 4, oscar: 10, echo: 9 };
const PREFIX = "cedar" + '-';
export const DEFAULT_LEVEL05 = LEVELS05.includes('info') ? 'info' : LEVELS05[0];
export const LIMITS05 = { min: 1, max: 97, unit: 'ms' };

export function levelRank05(level: string): number {
  return LEVELS05.indexOf(level);
}

export function weightOf05(kind: string): number {
  return WEIGHTS[kind] ?? 0;
}

export function label05(id: number): string {
  return `${PREFIX}${id}`;
}

export function withinLimits05(x: number): boolean {
  return x >= LIMITS05.min && x <= LIMITS05.max;
}

export function describeLimits05(): string {
  return LIMITS05.min + '..' + LIMITS05.max + ' ' + LIMITS05.unit;
}
