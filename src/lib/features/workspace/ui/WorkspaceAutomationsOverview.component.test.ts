import { render, screen, waitFor } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { queryCache } from '~/lib/shared/api/query-cache.ts';
import type { WorkspaceAutomation } from '~/lib/shared/contracts/workspace-automations.ts';
import type { ManagedWorkspace } from '~/lib/shared/contracts/workspace.ts';
import WorkspaceAutomationsOverview from './WorkspaceAutomationsOverview.svelte';

const workspace: ManagedWorkspace = {
  id: 'workspace-1',
  tmuxSession: 'vampire-workspace-1',
  cwd: '/tmp/vampire',
  workspaceLabel: 'Vampire',
  createdAt: 1,
  lastActiveAt: 1,
  notePreview: '',
  favoriteCommands: [],
  startupProfileId: null,
  lastOutputAt: null,
  state: 'running',
  attachedClients: 0,
  foregroundProcess: null,
  terminals: [],
  isGitRepository: true,
};
const emptyWorkspace: ManagedWorkspace = {
  ...workspace,
  id: 'workspace-2',
  tmuxSession: 'vampire-workspace-2',
  cwd: '/tmp/empty',
  workspaceLabel: 'Empty project',
};

const automation: WorkspaceAutomation = {
  id: 'automation-1',
  kind: 'custom',
  name: 'Daily review',
  prompt: 'Review the current work.',
  schedule: { type: 'interval', intervalMs: 24 * 60 * 60_000, startAt: Date.now() + 60_000 },
  enabled: true,
  nextRunAt: Date.now() + 60_000,
  createdAt: 1,
  updatedAt: 1,
  lastAttemptAt: null,
  lastRunAt: null,
  lastOutcome: null,
  lastError: null,
};

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => queryCache.clear());

test('manages every workspace automation from one overview', async () => {
  const user = userEvent.setup();
  const onManage = vi.fn();
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (init?.method === 'PATCH') {
      return json({ automation: { ...automation, enabled: false, updatedAt: 2 } });
    }
    if (init?.method === 'DELETE') return json({ ok: true });
    return json({
      groups: [
        { workspaceId: workspace.id, automations: [automation] },
        { workspaceId: emptyWorkspace.id, automations: [] },
      ],
    });
  });

  render(WorkspaceAutomationsOverview, { workspaces: [workspace, emptyWorkspace], onManage });

  expect(await screen.findByRole('heading', { name: 'Vampire' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Empty project' })).toBeVisible();
  expect(screen.getByText('1 active · 1 of 2 workspaces configured.')).toBeVisible();
  expect(screen.getByText('No automations yet. Open this workspace to create one.')).toBeVisible();

  await user.click(screen.getByRole('button', { name: 'Manage automations for Empty project' }));
  expect(onManage).toHaveBeenCalledWith(emptyWorkspace);

  await user.click(screen.getByRole('button', { name: 'Pause Daily review' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Resume Daily review' })).toBeVisible());
  expect(JSON.parse(String(requests.find((request) => request.init?.method === 'PATCH')?.init?.body))).toEqual({
    enabled: false,
  });

  await user.click(screen.getByRole('button', { name: 'Edit Daily review' }));
  expect(onManage).toHaveBeenCalledWith(workspace, automation.id);

  await user.click(screen.getByRole('button', { name: 'Delete Daily review' }));
  await waitFor(() => expect(screen.queryByText('Daily review')).not.toBeInTheDocument());
  expect(requests.some((request) => request.init?.method === 'DELETE')).toBe(true);
});
