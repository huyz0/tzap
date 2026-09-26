import { useState } from 'react';

export interface Item {
  name: string;
  price: number;
}

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function Cart({ items }: { items: Item[] }) {
  const [open, setOpen] = useState(false);
  const total = items.reduce((sum, i) => sum + i.price, 0);
  return (
    <div>
      <button onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'} cart</button>
      {open && (
        <ul>
          {items.map((i) => (
            <li key={i.name}>
              {i.name}: {formatPrice(i.price)}
            </li>
          ))}
        </ul>
      )}
      <p>Total: {formatPrice(total)}</p>
      {items.length === 0 && <p>Your cart is empty</p>}
    </div>
  );
}
