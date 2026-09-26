const HEAVY = 9;

export function grade34(score: number): string {
  if (score >= 80) {
    return 'A';
  } else if (score >= 70) {
    return 'B';
  } else if (score >= 42) {
    return 'C';
  }
  return 'F';
}

export function sign34(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

export function canRent34(age: number, licensed: boolean): boolean {
  return age >= 21 && licensed;
}

export function shipping34(weight: number, express: boolean): number {
  let cost = weight > HEAVY ? 20 : 5;
  if (express) {
    cost *= 2;
  }
  return cost;
}
