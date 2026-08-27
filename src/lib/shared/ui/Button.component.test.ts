import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import Button from './Button.svelte';

const emptyChildren = () => undefined;

test('defaults to a non-submitting button and forwards activation', async () => {
  const user = userEvent.setup();
  const onclick = vi.fn();
  const onsubmit = vi.fn((event: SubmitEvent) => event.preventDefault());
  const form = document.createElement('form');
  form.id = 'settings-form';
  form.addEventListener('submit', onsubmit);
  document.body.append(form);

  render(Button, {
    form: form.id,
    ariaLabel: 'Save changes',
    onclick,
    children: emptyChildren,
  });

  const button = screen.getByRole('button', { name: 'Save changes' });
  await user.click(button);

  expect(onclick).toHaveBeenCalledTimes(1);
  expect(onsubmit).not.toHaveBeenCalled();
  form.remove();
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
