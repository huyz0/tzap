import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import { Cart } from '../src/Cart';

afterEach(cleanup);

const items = [
  { name: 'Tea', price: 350 },
  { name: 'Cake', price: 425 },
];

it('shows the total', () => {
  render(<Cart items={items} />);
  expect(screen.getByText('Total: $7.75')).toBeTruthy();
});

it('opens to list the items', () => {
  render(<Cart items={items} />);
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByText('Tea: $3.50')).toBeTruthy();
  expect(screen.getByRole('button').textContent).toBe('Hide cart');
});
