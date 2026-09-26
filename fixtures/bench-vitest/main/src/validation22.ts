export interface User22 {
  name?: string;
  email?: string;
  age?: number;
  tags?: string[];
}

export function isEmail22(s: string): boolean {
  return /^\S+@\S+$/.test(s);
}

export function displayName22(u: User22): string {
  return u.name?.trim() || 'anonymous';
}

export function isAdult22(u: User22): boolean {
  return (u.age ?? 0) >= 18;
}

export function hasTag22(u: User22, tag: string): boolean {
  return u.tags?.includes(tag) ?? false;
}

export function validate22(u: User22): string[] {
  const errors: string[] = [];
  if (!u.name || u.name.length < 3) {
    errors.push('name too short');
  }
  if (u.email !== undefined && !isEmail22(u.email)) {
    errors.push('invalid email');
  }
  return errors;
}
