import { render, screen, waitFor } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import ConfirmDialog from './ConfirmDialog.svelte';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('locks every dismissal path while a destructive action is running', async () => {
  const user = userEvent.setup();
  const action = deferred();
  const close = vi.fn();
  const onConfirm = vi.fn(() => action.promise);

  render(ConfirmDialog, {
    title: 'Delete workspace?',
    description: 'This cannot be undone.',
    confirmLabel: 'Delete workspace',
    busyLabel: 'Deleting…',
    close,
    onConfirm,
  });

  await user.click(screen.getByRole('button', { name: 'Delete workspace' }));

  const confirmButton = screen.getByRole('button', { name: 'Deleting…' });
  const cancelButton = screen.getByRole('button', { name: 'Cancel' });
  const closeButton = screen.getByRole('button', { name: 'Close' });
  expect(confirmButton).toBeDisabled();
  expect(cancelButton).toBeDisabled();
  expect(closeButton).toBeDisabled();

  await user.click(confirmButton);
  await user.click(cancelButton);
  await user.click(closeButton);
  await user.keyboard('{Escape}');

  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(close).not.toHaveBeenCalled();

  action.resolve();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Delete workspace' })).toBeEnabled());
});

test('shows a failed action and lets the user retry it', async () => {
  const user = userEvent.setup();
  const onConfirm = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error('Workspace deletion failed.'))
    .mockResolvedValueOnce();

  render(ConfirmDialog, {
    title: 'Delete workspace?',
    description: 'This cannot be undone.',
    confirmLabel: 'Delete workspace',
    close: vi.fn(),
    onConfirm,
  });

  await user.click(screen.getByRole('button', { name: 'Delete workspace' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('Workspace deletion failed.');
  expect(screen.getByRole('button', { name: 'Delete workspace' })).toBeEnabled();

  await user.click(screen.getByRole('button', { name: 'Delete workspace' }));
  expect(onConfirm).toHaveBeenCalledTimes(2);
});
