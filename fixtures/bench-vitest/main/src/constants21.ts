export const LEVELS21 = ["fatal","info","warn","debug"];
const WEIGHTS: Record<string, number> = { ivory: 2, romeo: 8, delta: 12 };
const PREFIX = "papa" + '-';
export const DEFAULT_LEVEL21 = LEVELS21.includes('info') ? 'info' : LEVELS21[0];
export const LIMITS21 = { min: 3, max: 94, unit: 'ms' };

export function levelRank21(level: string): number {
  return LEVELS21.indexOf(level);
}

export function weightOf21(kind: string): number {
  return WEIGHTS[kind] ?? 0;
}

export function label21(id: number): string {
  return `${PREFIX}${id}`;
}

export function withinLimits21(x: number): boolean {
  return x >= LIMITS21.min && x <= LIMITS21.max;
}

export function describeLimits21(): string {
  return LIMITS21.min + '..' + LIMITS21.max + ' ' + LIMITS21.unit;
}
