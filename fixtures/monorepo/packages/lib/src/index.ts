export function applyTax(amount: number, rate: number): number {
  return Math.round(amount * (1 + rate));
}

export function isBulk(quantity: number): boolean {
  return quantity >= 10;
}
