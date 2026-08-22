import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import ToolbarButton from './ToolbarButton.svelte';

const emptyChildren = () => undefined;

test('exposes its label and forwards user activation', async () => {
  const user = userEvent.setup();
  const onclick = vi.fn();

  render(ToolbarButton, {
    label: 'Open workspace menu',
    text: 'Menu',
    onclick,
    children: emptyChildren,
  });

  const button = screen.getByRole('button', { name: 'Open workspace menu' });
  expect(button).toHaveTextContent('Menu');

  await user.click(button);

  expect(onclick).toHaveBeenCalledTimes(1);
});

test('prevents interaction when disabled', () => {
  render(ToolbarButton, {
    label: 'Unavailable action',
    disabled: true,
    children: emptyChildren,
  });

  expect(screen.getByRole('button', { name: 'Unavailable action' })).toBeDisabled();
});
