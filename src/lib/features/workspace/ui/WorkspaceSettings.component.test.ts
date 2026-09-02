import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
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
  await user.click(screen.getByRole('button', { name: 'Save workspace settings' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('Settings storage is unavailable.');
  expect(onClose).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Save workspace settings' }));

  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(onSave).toHaveBeenCalledTimes(2);
  expect(onSave).toHaveBeenLastCalledWith('profile-2', '{{ prompts }}');
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

test('guides variable insertion and previews the exact message sent to the shell', async () => {
  const onSave = vi.fn(async () => ({ ok: true }));
  render(WorkspaceSettings, {
    workspace: workspace({ workspaceLabel: 'Vampire' }),
    profiles,
    onClose: vi.fn(),
    onSave,
    onManageProfiles: vi.fn(),
  });

  const template = screen.getByRole('textbox', { name: 'Template' });
  await fireEvent.input(template, {
    target: { value: 'Workspace: {{ workspace.name }}\nRead AGENTS.md first.\n\n{{ prompts }}' },
  });
  const previewMessage = screen.getByRole('textbox', { name: 'Preview message' });
  await fireEvent.input(previewMessage, { target: { value: 'Implement the request' } });

  const previewOutput = screen.getByText('Sent to the shell').closest('.preview-output')?.querySelector('pre');
  expect(previewOutput?.textContent).toBe('Workspace: Vampire\nRead AGENTS.md first.\n\nImplement the request');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Save workspace settings' }));
  expect(onSave).toHaveBeenCalledWith(
    'profile-1',
    'Workspace: {{ workspace.name }}\nRead AGENTS.md first.\n\n{{ prompts }}'
  );
});

test('prevents saving when the prompt slot is removed and offers an insertion control', async () => {
  const user = userEvent.setup();
  render(WorkspaceSettings, {
    workspace: workspace(),
    profiles,
    onClose: vi.fn(),
    onSave: vi.fn(async () => ({ ok: true })),
    onManageProfiles: vi.fn(),
  });

  const template = screen.getByRole('textbox', { name: 'Template' });
  await user.clear(template);
  await user.type(template, 'Read the workspace instructions first.');

  expect(await screen.findByRole('alert')).toHaveTextContent('Add {{ prompts }}');
  expect(screen.getByRole('button', { name: 'Save workspace settings' })).toBeDisabled();

  await user.click(screen.getByRole('button', { name: /Prompt.*\{\{ prompts \}\}/ }));
  expect(template).toHaveValue('Read the workspace instructions first.{{ prompts }}');
  expect(screen.getByRole('button', { name: 'Save workspace settings' })).toBeEnabled();
});

test('confirms before discarding an edited workspace template', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(WorkspaceSettings, {
    workspace: workspace(),
    profiles,
    onClose,
    onSave: vi.fn(async () => ({ ok: true })),
    onManageProfiles: vi.fn(),
  });

  await fireEvent.input(screen.getByRole('textbox', { name: 'Template' }), {
    target: { value: 'Read AGENTS.md.\n\n{{ prompts }}' },
  });
  await user.click(screen.getByRole('button', { name: 'Close' }));

  expect(screen.getByRole('alertdialog', { name: 'Discard workspace setting changes?' })).toBeVisible();
  expect(onClose).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Discard changes' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});
