import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import Button from './Button.svelte';

const emptyChildren = () => undefined;

test('keeps button variants and activation in the shared component', async () => {
  const user = userEvent.setup();
  const onclick = vi.fn();

  render(Button, {
    variant: 'primary',
    size: 'lg',
    ariaLabel: 'Save changes',
    onclick,
    children: emptyChildren,
  });

  const button = screen.getByRole('button', { name: 'Save changes' });
  expect(button).toHaveClass('vampire-button', 'vampire-button--primary', 'vampire-button--lg');

  await user.click(button);

  expect(onclick).toHaveBeenCalledTimes(1);
});

test('exposes disabled state through the shared button component', () => {
  render(Button, {
    variant: 'danger-outline',
    disabled: true,
    ariaLabel: 'Remove workspace',
    children: emptyChildren,
  });

  expect(screen.getByRole('button', { name: 'Remove workspace' })).toBeDisabled();
});
