import { render, screen, waitFor } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import type { LaunchProfile, ManagedWorkspace } from '~/lib/shared/contracts/workspace.ts';
import WorkspaceSettings from './WorkspaceSettings.svelte';

function workspace(overrides: Partial<ManagedWorkspace> = {}): ManagedWorkspace {
  return {
    id: 'workspace-1',
    tmuxSession: 'vampire-workspace-1',
    cwd: '/tmp/workspace-1',
    createdAt: 1,
    lastActiveAt: 1,
    notePreview: '',
    favoriteCommands: [],
    startupProfileId: 'profile-1',
    lastOutputAt: 1,
    state: 'running',
    attachedClients: 0,
    foregroundProcess: null,
    terminals: [],
    isGitRepository: false,
    ...overrides,
  };
}

function profile(name: string, command = 'pnpm dev'): LaunchProfile {
  return { id: 'profile-1', name, command };
}

test('accepts clean profile updates but does not overwrite a local draft', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onSave = vi.fn(async () => ({ ok: true }));
  const currentWorkspace = workspace();
  const view = render(WorkspaceSettings, {
    workspace: currentWorkspace,
    profiles: [profile('Original profile')],
    onClose,
    onSave,
  });
  const name = screen.getByRole('textbox', { name: 'Name' });

  await view.rerender({
    workspace: currentWorkspace,
    profiles: [profile('Updated elsewhere')],
    onClose,
    onSave,
  });
  await waitFor(() => expect(name).toHaveValue('Updated elsewhere'));

  await user.clear(name);
  await user.type(name, 'Local draft');
  await view.rerender({
    workspace: currentWorkspace,
    profiles: [profile('Newer server value')],
    onClose,
    onSave,
  });

  expect(name).toHaveValue('Local draft');
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
});

test('keeps a rejected settings draft open and submits it again on retry', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onSave = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, error: 'Settings storage is unavailable.' })
    .mockResolvedValueOnce({ ok: true });
  render(WorkspaceSettings, {
    workspace: workspace(),
    profiles: [profile('Development')],
    onClose,
    onSave,
  });
  const command = screen.getByRole('textbox', { name: 'Command' });

  await user.clear(command);
  await user.type(command, 'pnpm test');
  await user.click(screen.getByRole('button', { name: 'Save changes' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('Settings storage is unavailable.');
  expect(command).toHaveValue('pnpm test');
  expect(onClose).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Save changes' }));

  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(onSave).toHaveBeenCalledTimes(2);
  expect(onSave).toHaveBeenLastCalledWith({
    launchProfiles: [profile('Development', 'pnpm test')],
    startupProfileId: 'profile-1',
  });
});
