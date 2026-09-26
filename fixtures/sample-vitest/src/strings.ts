export const SEPARATOR = ', ';

export function joinNames(names: string[]): string {
  return names.filter((n) => n.trim().length > 0).join(SEPARATOR);
}

export function shout(s: string): string {
  return s.toUpperCase() + '!';
}
