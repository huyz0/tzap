export interface Address {
  city: string;
  zip: string;
}

export interface User {
  name: string;
  nickname?: string;
  address: Address | null;
  tags: string[];
}

/** Optional chaining on a nullable receiver: removing `?.` is a type error. */
export function cityOf(user: User): string {
  return user.address?.city ?? 'unknown';
}

/** Optional call on an optional property: removing `?.` is a type error. */
export function displayName(user: User): string {
  return user.nickname?.trim() || user.name;
}

/** Optional chaining on a non-nullable receiver: removing `?.` type-checks. */
export function tagCount(user: User): number {
  return user.tags?.length ?? 0;
}

/** Non-nullable parameter, element access. */
export function firstTag(tags: string[]): string | undefined {
  return tags?.[0];
}

/** Nullable parameter with a declared union type. */
export function zipOf(address: Address | undefined): string {
  return address?.zip ?? '';
}
