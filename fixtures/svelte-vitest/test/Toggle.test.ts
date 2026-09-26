import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, it } from 'vitest';
import Toggle from '../src/Toggle.svelte';

it('flips on click', async () => {
  render(Toggle, { props: { label: 'Wifi' } });
  const b = screen.getByRole('button');
  expect(b.textContent).toBe('Wifi: off');
  await fireEvent.click(b);
  expect(b.textContent).toBe('Wifi: on');
});
