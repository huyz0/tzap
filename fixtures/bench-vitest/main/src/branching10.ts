const HEAVY = 14;

export function grade10(score: number): string {
  if (score >= 88) {
    return 'A';
  } else if (score >= 70) {
    return 'B';
  } else if (score >= 48) {
    return 'C';
  }
  return 'F';
}

export function sign10(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

export function canRent10(age: number, licensed: boolean): boolean {
  return age >= 21 && licensed;
}

export function shipping10(weight: number, express: boolean): number {
  let cost = weight > HEAVY ? 20 : 5;
  if (express) {
    cost *= 2;
  }
  return cost;
}
