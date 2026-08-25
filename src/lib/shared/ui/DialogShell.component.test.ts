import { render, screen, waitFor } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { createRawSnippet } from 'svelte';
import { expect, test, vi } from 'vitest';
import AlertDialogShell from './AlertDialogShell.svelte';
import DialogShell from './DialogShell.svelte';

test('focuses the first input when the dialog opens', async () => {
  render(DialogShell, {
    title: 'Create item',
    close: vi.fn(),
    children: createRawSnippet(() => ({
      render: () => '<input aria-label="Item name" type="text">',
    })),
  });

  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Item name' })).toHaveFocus());
});

test('focuses the first input when an alert dialog opens', async () => {
  render(AlertDialogShell, {
    title: 'Rename item',
    close: vi.fn(),
    children: createRawSnippet(() => ({
      render: () => '<input aria-label="New name" type="text">',
    })),
  });

  await waitFor(() => expect(screen.getByRole('textbox', { name: 'New name' })).toHaveFocus());
});

test('lets the user dismiss a dialog with Escape', async () => {
  const user = userEvent.setup();
  const close = vi.fn();

  render(DialogShell, {
    title: 'Workspace settings',
    close,
    children: createRawSnippet(() => ({ render: () => '<p>Settings</p>' })),
  });

  await user.keyboard('{Escape}');

  expect(close).toHaveBeenCalledTimes(1);
});

test('keeps a dialog open while closing is disabled', async () => {
  const user = userEvent.setup();
  const close = vi.fn();

  render(DialogShell, {
    title: 'Saving workspace',
    close,
    closeDisabled: true,
    children: createRawSnippet(() => ({ render: () => '<p>Saving</p>' })),
  });

  expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
  await user.keyboard('{Escape}');

  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog', { name: 'Saving workspace' })).toBeInTheDocument();
});
