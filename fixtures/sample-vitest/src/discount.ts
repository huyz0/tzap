export function discountedPrice(price: number, percent: number): number {
  if (percent < 0 || percent > 100) {
    throw new RangeError('percent out of range');
  }
  if (percent > 50) {
    return price / 2;
  }
  return price - (price * percent) / 100;
}

export function isFree(price: number): boolean {
  return price === 0;
}
