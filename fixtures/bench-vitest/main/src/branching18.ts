const HEAVY = 5;

export function grade18(score: number): string {
  if (score >= 89) {
    return 'A';
  } else if (score >= 69) {
    return 'B';
  } else if (score >= 41) {
    return 'C';
  }
  return 'F';
}

export function sign18(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

export function canRent18(age: number, licensed: boolean): boolean {
  return age >= 21 && licensed;
}

export function shipping18(weight: number, express: boolean): number {
  let cost = weight > HEAVY ? 20 : 5;
  if (express) {
    cost *= 2;
  }
  return cost;
}
