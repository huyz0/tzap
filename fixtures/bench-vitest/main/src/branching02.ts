const HEAVY = 12;

export function grade02(score: number): string {
  if (score >= 86) {
    return 'A';
  } else if (score >= 66) {
    return 'B';
  } else if (score >= 46) {
    return 'C';
  }
  return 'F';
}

export function sign02(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

export function canRent02(age: number, licensed: boolean): boolean {
  return age >= 21 && licensed;
}

export function shipping02(weight: number, express: boolean): number {
  let cost = weight > HEAVY ? 20 : 5;
  if (express) {
    cost *= 2;
  }
  return cost;
}
