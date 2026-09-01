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
    composerPromptPreview: null,
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

const profiles: LaunchProfile[] = [
  { id: 'profile-1', name: 'Codex', command: 'codex' },
  { id: 'profile-2', name: 'Claude', command: 'claude' },
];

test('accepts an external selection update but preserves a local selection draft', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onSave = vi.fn(async () => ({ ok: true }));
  const onManageProfiles = vi.fn();
  const view = render(WorkspaceSettings, {
    workspace: workspace(),
    profiles,
    onClose,
    onSave,
    onManageProfiles,
  });

  await view.rerender({
    workspace: workspace({ startupProfileId: 'profile-2' }),
    profiles,
    onClose,
    onSave,
    onManageProfiles,
  });
  await waitFor(() => expect(screen.getByRole('radio', { name: /Claude/ })).toBeChecked());

  await user.click(screen.getByRole('radio', { name: /No startup profile/ }));
  await view.rerender({
    workspace: workspace({ startupProfileId: 'profile-1' }),
    profiles,
    onClose,
    onSave,
    onManageProfiles,
  });

  expect(screen.getByRole('radio', { name: /No startup profile/ })).toBeChecked();
});

test('keeps a rejected selection open and submits it again on retry', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onSave = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, error: 'Settings storage is unavailable.' })
    .mockResolvedValueOnce({ ok: true });
  render(WorkspaceSettings, {
    workspace: workspace(),
    profiles,
    onClose,
    onSave,
    onManageProfiles: vi.fn(),
  });

  await user.click(screen.getByRole('radio', { name: /Claude/ }));
  await user.click(screen.getByRole('button', { name: 'Save selection' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('Settings storage is unavailable.');
  expect(onClose).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Save selection' }));

  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(onSave).toHaveBeenCalledTimes(2);
  expect(onSave).toHaveBeenLastCalledWith('profile-2');
});

test('opens shared profile management from the workspace selector', async () => {
  const user = userEvent.setup();
  const onManageProfiles = vi.fn();
  render(WorkspaceSettings, {
    workspace: workspace(),
    profiles,
    onClose: vi.fn(),
    onSave: vi.fn(async () => ({ ok: true })),
    onManageProfiles,
  });

  await user.click(screen.getByRole('button', { name: 'Manage' }));
  expect(onManageProfiles).toHaveBeenCalledOnce();
});
