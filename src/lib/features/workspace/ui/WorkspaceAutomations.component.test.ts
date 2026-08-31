import { render, screen, waitFor } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { queryCache } from '~/lib/shared/api/query-cache.ts';
import type { WorkspaceAutomation } from '~/lib/shared/contracts/workspace-automations.ts';
import WorkspaceAutomations from './WorkspaceAutomations.svelte';

const WORKSPACE_ID = 'workspace-automation-ui';
const QUERY = `workspace/${WORKSPACE_ID}/automations`;

afterEach(() => queryCache.clear());

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

test('creates a weekly automation with the selected local weekdays and time', async () => {
  const user = userEvent.setup();
  queryCache.set(QUERY, { automations: [] });
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      const automation: WorkspaceAutomation = {
        id: 'automation-1',
        kind: 'custom',
        ...body,
        enabled: true,
        nextRunAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastAttemptAt: null,
        lastRunAt: null,
        lastOutcome: null,
        lastError: null,
      };
      return json({ automation }, 201);
    }
    return json({ automations: [] });
  });
  render(WorkspaceAutomations, { workspaceId: WORKSPACE_ID });

  await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Weekday review');
  await user.type(screen.getByRole('textbox', { name: 'Prompt' }), 'Review open work.');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Schedule' }), 'weekly');
  await user.clear(screen.getByLabelText('Time'));
  await user.type(screen.getByLabelText('Time'), '09:30');
  await user.click(screen.getByRole('button', { name: 'Add automation' }));

  await waitFor(() => expect(requests.some((request) => request.init?.method === 'POST')).toBe(true));
  const post = requests.find((request) => request.init?.method === 'POST');
  const body = JSON.parse(String(post?.init?.body));
  expect(body.schedule).toMatchObject({
    type: 'weekly',
    weekdays: [1, 2, 3, 4, 5],
    hour: 9,
    minute: 30,
  });
  expect(body.schedule.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
});

test('opens the automation Ask agent flow with its managed request context', async () => {
  const user = userEvent.setup();
  queryCache.set(QUERY, { automations: [] });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('/agent-actions/automation')) {
      return json({
        action: {
          id: 'automation',
          title: 'Create an automation with an agent',
          description: 'Vampire supplies safe automation support.',
          target: { workspaceId: WORKSPACE_ID, workspaceLabel: 'Vampire', agentLabel: 'codex' },
          context: [
            { label: 'Automation request', value: '/state/automation-requests/request.draft.json' },
            { label: 'Automation guide', value: '/state/agent-guides/workspace-automation.md' },
          ],
          requestLabel: 'What should the automation do, and when?',
          requestPlaceholder: 'Every weekday at 9 AM.',
          defaultRequest: '',
        },
      });
    }
    return json({ automations: [] });
  });
  render(WorkspaceAutomations, { workspaceId: WORKSPACE_ID });

  await user.click(screen.getByRole('button', { name: 'Ask agent…' }));
  expect(await screen.findByText('/state/automation-requests/request.draft.json')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'What should the automation do, and when?' })).toBeInTheDocument();
});
