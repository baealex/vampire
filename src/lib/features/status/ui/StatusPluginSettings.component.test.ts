import { render, screen, waitFor } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { queryCache } from '~/lib/shared/api/query-cache.ts';
import type { StatusPlugin } from '~/lib/shared/contracts/status-plugin.ts';
import type { ManagedWorkspace } from '~/lib/shared/contracts/workspace.ts';
import StatusPluginSettings from './StatusPluginSettings.svelte';

const STATUS_PLUGINS_QUERY = 'status/plugins';

function plugin(name: string, command = 'echo ready'): StatusPlugin {
  return {
    id: 'plugin-1',
    name,
    enabled: true,
    intervalMs: 60_000,
    source: { type: 'command', command },
  };
}

function agentWorkspace(
  id: string,
  label: string,
  agentLabel: string,
  lastActiveAt: number,
  terminalAgentLabel: string | null = agentLabel
): ManagedWorkspace {
  return {
    id,
    tmuxSession: `tmux-${id}`,
    cwd: `/projects/${id}`,
    workspaceLabel: label,
    createdAt: 1,
    lastActiveAt,
    notePreview: '',
    composerPromptPreview: null,
    favoriteCommands: [],
    startupProfileId: null,
    lastOutputAt: null,
    state: 'running',
    attachedClients: 1,
    foregroundProcess: { kind: 'command', label: agentLabel },
    terminals: [
      {
        id: `terminal-${id}`,
        index: 0,
        name: 'main',
        active: true,
        lastOutputAt: null,
        foregroundProcess: terminalAgentLabel ? { kind: 'command', label: terminalAgentLabel } : null,
        command: agentLabel,
        startedAt: 1,
        state: 'running',
        exitCode: null,
      },
    ],
    isGitRepository: true,
  };
}

afterEach(() => {
  queryCache.clear();
  vi.restoreAllMocks();
});

test('keeps save actions out of the clean widget list', () => {
  const initial = { plugins: [plugin('Original widget')], presets: [] };
  queryCache.set(STATUS_PLUGINS_QUERY, initial);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(initial), { headers: { 'content-type': 'application/json' } })
  );

  render(StatusPluginSettings, { close: vi.fn() });

  expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
});

test('does not replace an unsaved widget draft with a background refresh', async () => {
  const user = userEvent.setup();
  const initial = { plugins: [plugin('Original widget')], presets: [] };
  queryCache.set(STATUS_PLUGINS_QUERY, initial);
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify(initial), {
        headers: { 'content-type': 'application/json' },
      })
  );
  render(StatusPluginSettings, { close: vi.fn() });

  await waitFor(() => expect(document.querySelector('.status-settings')).toHaveAttribute('aria-busy', 'false'));
  await user.click(screen.getByRole('button', { name: 'Edit Original widget' }));
  const name = screen.getByRole('textbox', { name: 'Name' });
  await user.clear(name);
  await user.type(name, 'Local widget draft');

  queryCache.set(STATUS_PLUGINS_QUERY, {
    plugins: [plugin('Updated on another tab', 'echo external')],
    presets: [],
  });

  expect(name).toHaveValue('Local widget draft');
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
});

test('opens Ask Agent from the workspace process summary when the terminal detail is stale', async () => {
  const user = userEvent.setup();
  const initial = { plugins: [], presets: [] };
  const workspaces = [
    agentWorkspace('workspace-1', 'Project one', 'codex', 1, null),
    agentWorkspace('workspace-2', 'Project two', 'claude', 2),
  ];
  workspaces[0]!.terminals[0]!.state = 'exited';
  workspaces[0]!.foregroundProcess = { kind: 'shell', label: 'zsh' };
  queryCache.set(STATUS_PLUGINS_QUERY, initial);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('/agent-actions/status-widget')) {
      const workspaceId = url.includes('workspace-1') ? 'workspace-1' : 'workspace-2';
      return new Response(
        JSON.stringify({
          action: {
            id: 'status-widget',
            title: 'Create a status widget with an agent',
            description: 'Update the global widget configuration.',
            target: {
              workspaceId,
              workspaceLabel: workspaceId === 'workspace-1' ? 'Project one' : 'Project two',
              agentLabel: workspaceId === 'workspace-1' ? 'codex' : 'claude',
            },
            context: [],
            requestLabel: 'What widget should the agent create?',
            requestPlaceholder: 'Show open reviews.',
            defaultRequest: '',
          },
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify(initial), { headers: { 'content-type': 'application/json' } });
  });
  render(StatusPluginSettings, { close: vi.fn(), workspaceId: 'workspace-1', workspaces });

  await user.click(screen.getByRole('button', { name: 'Ask agent…' }));

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(await screen.findByRole('heading', { name: 'Create a status widget with an agent' })).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: /^Send to/ })).toHaveValue('workspace-1');
  expect(screen.getByRole('textbox', { name: 'What widget should the agent create?' })).toHaveFocus();
});

test('requires unsaved widget changes to be saved before Ask Agent', async () => {
  const user = userEvent.setup();
  const initial = { plugins: [plugin('Original widget')], presets: [] };
  const workspaces = [agentWorkspace('workspace-1', 'Project one', 'codex', 1)];
  queryCache.set(STATUS_PLUGINS_QUERY, initial);
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (_input, init) =>
      new Response(init?.method === 'PUT' ? String(init.body) : JSON.stringify(initial), {
        headers: { 'content-type': 'application/json' },
      })
  );
  render(StatusPluginSettings, { close: vi.fn(), workspaceId: 'workspace-1', workspaces });

  await user.click(screen.getByRole('button', { name: 'Edit Original widget' }));
  await user.type(screen.getByRole('textbox', { name: 'Name' }), ' changed');
  await user.click(screen.getByRole('button', { name: 'Back to status widgets' }));
  expect(screen.getByRole('button', { name: 'Ask agent…' })).toBeEnabled();
  expect(
    screen.getByText('Save changes before asking an agent to update the global widget configuration.')
  ).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Ask agent…' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Save your widget changes before asking an agent.');

  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
});
