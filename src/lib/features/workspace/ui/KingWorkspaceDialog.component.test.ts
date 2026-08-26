import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import KingWorkspaceDialog from './KingWorkspaceDialog.svelte';

test('creates King with the selected launch profile', async () => {
  const user = userEvent.setup();
  const close = vi.fn();
  const onCreate = vi.fn().mockResolvedValue(true);
  render(KingWorkspaceDialog, {
    launchProfiles: [
      { id: 'codex', name: 'Codex', command: 'codex' },
      { id: 'claude', name: 'Claude', command: 'claude' },
    ],
    creating: false,
    errorMessage: '',
    close,
    onCreate,
  });

  await user.selectOptions(screen.getByLabelText('Launch profile'), 'claude');
  await user.click(screen.getByRole('button', { name: 'Create King workspace' }));

  expect(onCreate).toHaveBeenCalledWith('claude');
  expect(close).toHaveBeenCalledOnce();
});

test('allows a shell-only King when no launch profile exists', async () => {
  const user = userEvent.setup();
  const onCreate = vi.fn().mockResolvedValue(false);
  render(KingWorkspaceDialog, {
    launchProfiles: [],
    creating: false,
    errorMessage: 'Unable to create King',
    close: vi.fn(),
    onCreate,
  });

  expect(screen.getByRole('alert')).toHaveTextContent('Unable to create King');
  await user.click(screen.getByRole('button', { name: 'Create King workspace' }));
  expect(onCreate).toHaveBeenCalledWith(null);
});
