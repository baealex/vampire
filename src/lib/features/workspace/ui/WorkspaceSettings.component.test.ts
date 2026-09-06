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

  expect(await screen.findByRole('status')).toHaveTextContent('Workspace settings saved.');
  expect(onClose).not.toHaveBeenCalled();
  expect(onSave).toHaveBeenCalledTimes(2);
  expect(onSave).toHaveBeenLastCalledWith('', 'profile-2', '{{ prompts }}');
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

test('previews template variables with a message placeholder and saves the template', async () => {
  const user = userEvent.setup();
  const onSave = vi.fn(async () => ({ ok: true }));
  render(WorkspaceSettings, {
    workspace: workspace({
      workspaceLabel: 'Vampire',
      composerTemplate: 'Workspace: {{ workspace.name }}\nRead AGENTS.md first.\n\n{{ prompts }}',
    }),
    profiles,
    onClose: vi.fn(),
    onSave,
    onManageProfiles: vi.fn(),
  });

  expect(screen.queryByRole('textbox', { name: 'Compose message' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Preview' }));
  expect(screen.queryByRole('textbox', { name: 'Compose message' })).not.toBeInTheDocument();

  const previewOutput = screen.getByRole('region', { name: 'Template preview' }).querySelector('pre');
  expect(previewOutput?.textContent).toBe('Workspace: Vampire\nRead AGENTS.md first.\n\n[Your message]');
  await fireEvent.input(screen.getByRole('textbox', { name: 'Alias' }), { target: { value: 'Vampire app' } });
  expect(previewOutput?.textContent).toBe('Workspace: Vampire app\nRead AGENTS.md first.\n\n[Your message]');
  await user.click(screen.getByRole('button', { name: 'Save workspace settings' }));
  expect(onSave).toHaveBeenCalledWith(
    'Vampire app',
    'profile-1',
    'Workspace: {{ workspace.name }}\nRead AGENTS.md first.\n\n{{ prompts }}'
  );
});

test('uses the code editor insertion control and rejects a duplicate prompt slot', async () => {
  const user = userEvent.setup();
  render(WorkspaceSettings, {
    workspace: workspace(),
    profiles,
    onClose: vi.fn(),
    onSave: vi.fn(async () => ({ ok: true })),
    onManageProfiles: vi.fn(),
  });

  await user.click(screen.getByRole('button', { name: /Prompt.*\{\{ prompts \}\}/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Use {{ prompts }} exactly once');
  expect(screen.getByRole('button', { name: 'Save workspace settings' })).toBeDisabled();
});

test('reports page-level dirty state and delegates closing to the parent', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onDirtyChange = vi.fn();
  render(WorkspaceSettings, {
    workspace: workspace(),
    profiles,
    onClose,
    onSave: vi.fn(async () => ({ ok: true })),
    onManageProfiles: vi.fn(),
    onDirtyChange,
  });

  await user.type(screen.getByRole('textbox', { name: 'Alias' }), 'Vampire');
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
  await user.click(screen.getByRole('button', { name: 'Close workspace settings' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});
