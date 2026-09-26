import { applyTax, isBulk } from '@mono/lib';

export function total(unitPrice: number, quantity: number): number {
  const discount = isBulk(quantity) ? 0.9 : 1;
  return applyTax(unitPrice * quantity * discount, 0.2);
}
