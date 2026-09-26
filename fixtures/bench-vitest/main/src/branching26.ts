const HEAVY = 8;

export function grade26(score: number): string {
  if (score >= 80) {
    return 'A';
  } else if (score >= 72) {
    return 'B';
  } else if (score >= 50) {
    return 'C';
  }
  return 'F';
}

export function sign26(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

export function canRent26(age: number, licensed: boolean): boolean {
  return age >= 21 && licensed;
}

export function shipping26(weight: number, express: boolean): number {
  let cost = weight > HEAVY ? 20 : 5;
  if (express) {
    cost *= 2;
  }
  return cost;
}
