import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import SplitButton from './SplitButton.svelte';

const emptySnippet = () => undefined;

test('keeps the primary action direct and opens auxiliary actions separately', async () => {
  const user = userEvent.setup();
  const onclick = vi.fn();

  const { container } = render(SplitButton, {
    variant: 'navigation',
    primaryLabel: 'New workspace',
    menuLabel: 'More workspace options',
    menuSide: 'top',
    onclick,
    primary: emptySnippet,
    menu: emptySnippet,
  });

  await user.click(screen.getByRole('button', { name: 'New workspace' }));

  expect(onclick).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'More workspace options' })).toBeInTheDocument();
  expect(container.querySelector('[data-direction="top"]')).toBeInTheDocument();
});

test('removes the auxiliary trigger when no secondary action is available', () => {
  render(SplitButton, {
    primaryLabel: 'New workspace',
    menuLabel: 'More workspace options',
    showMenu: false,
    primary: emptySnippet,
    menu: emptySnippet,
  });

  expect(screen.getByRole('button', { name: 'New workspace' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'More workspace options' })).not.toBeInTheDocument();
});

test('points the auxiliary indicator toward a menu below the control', () => {
  const { container } = render(SplitButton, {
    primaryLabel: 'Reopen shell',
    menuLabel: 'Reopen with',
    menuSide: 'bottom',
    primary: emptySnippet,
    menu: emptySnippet,
  });

  expect(container.querySelector('[data-direction="bottom"]')).toBeInTheDocument();
});
