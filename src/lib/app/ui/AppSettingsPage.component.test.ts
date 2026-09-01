import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import {
  TERMINAL_INPUT_MODE_STORAGE_KEY,
  TERMINAL_SLASH_HANDOFF_STORAGE_KEY,
  terminalInputPreferences,
} from '~/lib/features/terminal/model/input-preferences.svelte.ts';
import type { LaunchProfile, ManagedWorkspace } from '~/lib/shared/contracts/workspace.ts';
import AppSettingsPage from './AppSettingsPage.svelte';

const profiles: LaunchProfile[] = [
  { id: 'codex', name: 'Codex', command: 'codex' },
  { id: 'claude', name: 'Claude', command: 'claude' },
];

const workspace: ManagedWorkspace = {
  id: 'workspace-1',
  tmuxSession: 'vampire-workspace-1',
  cwd: '/tmp/workspace',
  createdAt: 1,
  lastActiveAt: 1,
  notePreview: '',
  favoriteCommands: [],
  startupProfileId: 'codex',
  lastOutputAt: null,
  state: 'running',
  attachedClients: 0,
  foregroundProcess: null,
  terminals: [],
  isGitRepository: false,
};

function renderSettings(onSaveLaunchProfiles = vi.fn(async () => ({ ok: true }))) {
  const onManageAutomations = vi.fn();
  return {
    onSaveLaunchProfiles,
    onManageAutomations,
    view: render(AppSettingsPage, {
      launchProfiles: profiles,
      defaultStartupProfileId: 'codex',
      workspaces: [workspace],
      close: vi.fn(),
      onSaveLaunchProfiles,
      onManageAutomations,
      onManageWidgets: vi.fn(),
      onBusyChange: vi.fn(),
      onDirtyChange: vi.fn(),
    }),
  };
}

test('opens server-wide automation management from Server tools', async () => {
  const user = userEvent.setup();
  const { onManageAutomations } = renderSettings();

  await user.click(screen.getByRole('button', { name: 'Manage all automations' }));

  expect(onManageAutomations).toHaveBeenCalledOnce();
});

beforeEach(() => {
  window.localStorage.clear();
  terminalInputPreferences.setMode('terminal');
  terminalInputPreferences.setSlashHandoff(true);
});

test('persists the Compose-first and slash handoff browser preferences', async () => {
  const user = userEvent.setup();
  renderSettings();

  await user.click(screen.getByRole('radio', { name: /Compose first/ }));
  await user.click(screen.getByRole('checkbox', { name: /Open the terminal/ }));

  expect(window.localStorage.getItem(TERMINAL_INPUT_MODE_STORAGE_KEY)).toBe('compose');
  expect(window.localStorage.getItem(TERMINAL_SLASH_HANDOFF_STORAGE_KEY)).toBe('false');
});

test('applies a changed default profile to every workspace on save', async () => {
  const user = userEvent.setup();
  const { onSaveLaunchProfiles } = renderSettings();

  await user.selectOptions(screen.getByRole('combobox'), 'claude');
  await user.click(screen.getByRole('button', { name: 'Save profiles' }));

  expect(onSaveLaunchProfiles).toHaveBeenCalledWith(profiles, 'claude', true);
  expect(await screen.findByText('Default updated for 1 workspace.')).toBeVisible();
});

test('saves profile edits without overwriting workspace selections when the default is unchanged', async () => {
  const user = userEvent.setup();
  const { onSaveLaunchProfiles } = renderSettings();
  const commands = screen.getAllByRole('textbox', { name: 'Command' });

  await user.clear(commands[0]);
  await user.type(commands[0], 'codex --search');
  await user.click(screen.getByRole('button', { name: 'Save profiles' }));

  expect(onSaveLaunchProfiles).toHaveBeenCalledWith(
    [{ id: 'codex', name: 'Codex', command: 'codex --search' }, profiles[1]],
    'codex',
    false
  );
});
