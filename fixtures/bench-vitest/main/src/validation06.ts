export interface User06 {
  name?: string;
  email?: string;
  age?: number;
  tags?: string[];
}

export function isEmail06(s: string): boolean {
  return /^\S+@\S+$/.test(s);
}

export function displayName06(u: User06): string {
  return u.name?.trim() || 'anonymous';
}

export function isAdult06(u: User06): boolean {
  return (u.age ?? 0) >= 18;
}

export function hasTag06(u: User06, tag: string): boolean {
  return u.tags?.includes(tag) ?? false;
}

export function validate06(u: User06): string[] {
  const errors: string[] = [];
  if (!u.name || u.name.length < 3) {
    errors.push('name too short');
  }
  if (u.email !== undefined && !isEmail06(u.email)) {
    errors.push('invalid email');
  }
  return errors;
}
