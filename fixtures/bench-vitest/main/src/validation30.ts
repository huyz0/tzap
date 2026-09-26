export interface User30 {
  name?: string;
  email?: string;
  age?: number;
  tags?: string[];
}

export function isEmail30(s: string): boolean {
  return /^\S+@\S+$/.test(s);
}

export function displayName30(u: User30): string {
  return u.name?.trim() || 'anonymous';
}

export function isAdult30(u: User30): boolean {
  return (u.age ?? 0) >= 18;
}

export function hasTag30(u: User30, tag: string): boolean {
  return u.tags?.includes(tag) ?? false;
}

export function validate30(u: User30): string[] {
  const errors: string[] = [];
  if (!u.name || u.name.length < 4) {
    errors.push('name too short');
  }
  if (u.email !== undefined && !isEmail30(u.email)) {
    errors.push('invalid email');
  }
  return errors;
}
