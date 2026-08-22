import { render, screen, waitFor } from '@testing-library/svelte';
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
