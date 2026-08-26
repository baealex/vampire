import { render, screen, waitFor } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type { WorkspaceTerminal } from '~/lib/shared/contracts/workspace.ts';
import WorkspaceAgentTabs from './WorkspaceAgentTabs.svelte';

function terminal(overrides: Partial<WorkspaceTerminal> = {}): WorkspaceTerminal {
  return {
    id: '@1',
    index: 0,
    name: 'main',
    active: true,
    lastOutputAt: 1,
    foregroundProcess: { kind: 'command', label: 'codex' },
    command: null,
    startedAt: 1,
    state: 'running',
    exitCode: null,
    terminalKind: 'main',
    kingAttemptId: null,
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

test('opens and stops a visible King agent from its workspace', async () => {
  const selected: Array<string | undefined> = [];
  const requests: RequestInit[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') requests.push(init);
      const body = init?.method === 'POST' ? { attempt: { status: 'rejected' } } : { attempts: [], tasks: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    })
  );
  const main = terminal();
  const task = terminal({
    id: '@2',
    index: 1,
    name: 'King task',
    terminalKind: 'king-task',
    kingAttemptId: '11111111-1111-4111-8111-111111111111',
  });
  const user = userEvent.setup();
  render(WorkspaceAgentTabs, {
    workspaceId: 'workspace-1',
    mainTerminal: main,
    taskTerminals: [task],
    selectedTerminalId: task.id,
    onSelect: (terminalId: string | undefined) => selected.push(terminalId),
  });

  expect(screen.getByRole('navigation', { name: 'Workspace agents' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /King 11111111 codex/ })).toHaveAttribute('aria-current', 'page');
  await user.click(screen.getByRole('button', { name: 'Stop King 11111111' }));

  await waitFor(() => expect(requests).toHaveLength(1));
  expect(JSON.parse(String(requests[0]?.body))).toMatchObject({
    action: 'cancel',
    attemptId: task.kingAttemptId,
  });
  expect(selected).toEqual([main.id]);
});

test('shows a King assignment delivered directly into the existing main agent', async () => {
  const attempt = {
    id: '22222222-2222-4222-8222-222222222222',
    taskId: 'task-2',
    workspaceId: 'workspace-1',
    status: 'working',
    deliveryTarget: { tmuxSession: 'worker', terminalId: '@1', agentLabel: 'codex' },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            attempts: [attempt],
            tasks: [{ id: 'task-2', title: 'Inspect the existing workspace' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    )
  );
  const main = terminal();
  render(WorkspaceAgentTabs, {
    workspaceId: 'workspace-1',
    mainTerminal: main,
    taskTerminals: [],
    selectedTerminalId: main.id,
    onSelect: vi.fn(),
  });

  expect(await screen.findByText(/Inspect the existing workspace · working/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Stop Inspect the existing workspace' })).toBeEnabled();
});
