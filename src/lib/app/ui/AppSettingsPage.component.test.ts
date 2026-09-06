import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
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
  composerPromptPreview: null,
  favoriteCommands: [],
  startupProfileId: 'codex',
  lastOutputAt: null,
  state: 'running',
  attachedClients: 0,
  foregroundProcess: null,
  terminals: [],
  isGitRepository: false,
};

function renderSettings(
  onSaveLaunchProfiles = vi.fn(async () => ({ ok: true })),
  onSaveComposerHistorySettings = vi.fn(async () => ({ ok: true }))
) {
  const onManageAutomations = vi.fn();
  return {
    onSaveLaunchProfiles,
    onSaveComposerHistorySettings,
    onManageAutomations,
    view: render(AppSettingsPage, {
      launchProfiles: profiles,
      defaultStartupProfileId: 'codex',
      composerHistorySettings: { enabled: true, limit: 20 },
      workspaces: [workspace],
      close: vi.fn(),
      onSaveLaunchProfiles,
      onSaveComposerHistorySettings,
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

test('keeps listening ports out of application settings', () => {
  renderSettings();

  expect(screen.queryByText('Listening ports')).not.toBeInTheDocument();
});

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false }))
  );
});

test('explains Compose-only history and saves its server retention policy', async () => {
  const user = userEvent.setup();
  const { onSaveComposerHistorySettings } = renderSettings();

  expect(
    screen.getByText('Only prompts successfully sent from Compose are saved. Direct terminal input is never recorded.')
  ).toBeVisible();
  const limit = screen.getByRole('spinbutton', { name: 'Prompts saved per workspace' });
  await user.clear(limit);
  await user.type(limit, '12');
  await user.click(screen.getByRole('button', { name: 'Save history settings' }));

  expect(onSaveComposerHistorySettings).toHaveBeenCalledWith({ enabled: true, limit: 12 });
});

test('lists the core keyboard shortcuts as fixed interactions', () => {
  renderSettings();

  expect(screen.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
  expect(screen.getByText('⌘1–0')).toBeVisible();
  expect(screen.getByText('Compose → Terminal')).toBeVisible();
  expect(screen.getByText('⌘ /')).toBeVisible();
  expect(screen.getByText('Ctrl+Alt+H')).toBeVisible();
  expect(screen.queryByText('Ctrl+Alt+P')).not.toBeInTheDocument();
  expect(screen.queryByText('Ctrl+Alt+B')).not.toBeInTheDocument();
  expect(screen.getByText('Switch input')).toBeVisible();
  expect(screen.queryByText(/Ctrl.*Shift.*Enter/i)).not.toBeInTheDocument();
  expect(screen.queryByRole('checkbox', { name: /Compose to Terminal/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Save shortcuts/i })).not.toBeInTheDocument();
});

test('applies a changed default profile to every workspace on save', async () => {
  const user = userEvent.setup();
  const { onSaveLaunchProfiles } = renderSettings();

  await user.selectOptions(screen.getByRole('combobox', { name: /Default for all workspaces/ }), 'claude');
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
