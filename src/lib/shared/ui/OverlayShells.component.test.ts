import { render, screen, waitFor } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { createRawSnippet } from 'svelte';
import { expect, test, vi } from 'vitest';
import DropdownMenuShell from './DropdownMenuShell.svelte';
import PopoverShell from './PopoverShell.svelte';

const trigger = createRawSnippet(() => ({ render: () => '<span>Open</span>' }));

test('opens and dismisses a dropdown from the keyboard, then restores trigger focus', async () => {
  const user = userEvent.setup();
  const onOpenChange = vi.fn();

  render(DropdownMenuShell, {
    triggerLabel: 'Workspace actions',
    onOpenChange,
    trigger,
    children: createRawSnippet(() => ({ render: () => '<p>Available actions</p>' })),
  });

  const triggerButton = screen.getByRole('button', { name: 'Workspace actions' });
  triggerButton.focus();
  await user.keyboard('{Enter}');

  expect(await screen.findByText('Available actions')).toBeInTheDocument();
  expect(onOpenChange).toHaveBeenCalledWith(true);

  await user.keyboard('{Escape}');

  await waitFor(() => expect(screen.queryByText('Available actions')).not.toBeInTheDocument());
  expect(onOpenChange).toHaveBeenLastCalledWith(false);
  expect(triggerButton).toHaveFocus();
});

test('opens and dismisses a popover from the keyboard, then restores trigger focus', async () => {
  const user = userEvent.setup();
  const onOpenChange = vi.fn();

  render(PopoverShell, {
    triggerLabel: 'System status',
    onOpenChange,
    trigger,
    children: createRawSnippet(() => ({ render: () => '<p>CPU usage</p>' })),
  });

  const triggerButton = screen.getByRole('button', { name: 'System status' });
  triggerButton.focus();
  await user.keyboard('{Enter}');

  expect(await screen.findByText('CPU usage')).toBeInTheDocument();
  expect(onOpenChange).toHaveBeenCalledWith(true);

  await user.keyboard('{Escape}');

  await waitFor(() => expect(screen.queryByText('CPU usage')).not.toBeInTheDocument());
  expect(onOpenChange).toHaveBeenLastCalledWith(false);
  expect(triggerButton).toHaveFocus();
});
