let cache: string | undefined;

export function memo(): string {
  if (cache === undefined) {
    cache = 'computed';
  }
  return cache;
}
