export interface User38 {
  name?: string;
  email?: string;
  age?: number;
  tags?: string[];
}

export function isEmail38(s: string): boolean {
  return /^\S+@\S+$/.test(s);
}

export function displayName38(u: User38): string {
  return u.name?.trim() || 'anonymous';
}

export function isAdult38(u: User38): boolean {
  return (u.age ?? 0) >= 18;
}

export function hasTag38(u: User38, tag: string): boolean {
  return u.tags?.includes(tag) ?? false;
}

export function validate38(u: User38): string[] {
  const errors: string[] = [];
  if (!u.name || u.name.length < 3) {
    errors.push('name too short');
  }
  if (u.email !== undefined && !isEmail38(u.email)) {
    errors.push('invalid email');
  }
  return errors;
}
