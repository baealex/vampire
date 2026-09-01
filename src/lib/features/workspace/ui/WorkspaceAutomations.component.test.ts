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

  expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'New automation' }));
  expect(screen.getByRole('heading', { name: 'New automation' })).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
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
          title: 'Manage automations with an agent',
          description: 'Vampire supplies safe automation support.',
          target: { workspaceId: WORKSPACE_ID, workspaceLabel: 'Vampire', agentLabel: 'codex' },
          context: [
            { label: 'Automation request', value: '/state/automation-requests/request.draft.json' },
            { label: 'Automation guide', value: '/state/agent-guides/workspace-automation.md' },
          ],
          requestLabel: 'What should the agent create or change?',
          requestPlaceholder: 'Change “Daily review” to weekdays at 9 AM.',
          defaultRequest: '',
        },
      });
    }
    return json({ automations: [] });
  });
  render(WorkspaceAutomations, { workspaceId: WORKSPACE_ID });

  await user.click(screen.getByRole('button', { name: 'Ask agent…' }));
  expect(await screen.findByText('/state/automation-requests/request.draft.json')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'What should the agent create or change?' })).toHaveFocus();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(screen.getByRole('button', { name: 'Ask agent…' })).toHaveFocus();
});

test('edits an existing automation and saves its replacement schedule', async () => {
  const user = userEvent.setup();
  const existing: WorkspaceAutomation = {
    id: 'automation-1',
    kind: 'custom',
    name: 'Morning review',
    prompt: 'Review open work.',
    schedule: { type: 'weekly', weekdays: [1, 3, 5], hour: 9, minute: 0, timeZone: 'Asia/Seoul', startAt: 1 },
    enabled: true,
    nextRunAt: Date.now() + 60_000,
    createdAt: 1,
    updatedAt: 1,
    lastAttemptAt: null,
    lastRunAt: null,
    lastOutcome: null,
    lastError: null,
  };
  queryCache.set(QUERY, { automations: [existing] });
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body));
      return json({ automation: { ...existing, ...body, updatedAt: 2 } });
    }
    return json({ automations: [existing] });
  });
  render(WorkspaceAutomations, { workspaceId: WORKSPACE_ID });

  await user.click(screen.getByRole('button', { name: 'Edit' }));
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Morning review');
  expect(screen.getByRole('combobox', { name: 'Schedule' })).toHaveValue('weekly');
  expect(screen.getByRole('button', { name: 'Mon' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Tue' })).toHaveAttribute('aria-pressed', 'false');
  await user.clear(screen.getByRole('textbox', { name: 'Name' }));
  await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Afternoon review');
  await user.clear(screen.getByLabelText('Time'));
  await user.type(screen.getByLabelText('Time'), '14:30');
  await user.click(screen.getByRole('button', { name: 'Save changes' }));

  await waitFor(() => expect(requests.some((request) => request.init?.method === 'PATCH')).toBe(true));
  const patchRequest = requests.find((request) => request.init?.method === 'PATCH');
  expect(patchRequest?.url).toContain('/automations/automation-1');
  expect(JSON.parse(String(patchRequest?.init?.body))).toMatchObject({
    name: 'Afternoon review',
    schedule: { type: 'weekly', weekdays: [1, 3, 5], hour: 14, minute: 30, timeZone: 'Asia/Seoul' },
  });
  expect(await screen.findByText('Afternoon review')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'New automation' })).toBeInTheDocument();
});

test('round-trips an agent-created interval that is not a whole second', async () => {
  const user = userEvent.setup();
  const existing: WorkspaceAutomation = {
    id: 'automation-precise',
    kind: 'custom',
    name: 'Precise interval',
    prompt: 'Check precise work.',
    schedule: { type: 'interval', intervalMs: 90_001, startAt: Date.now() + 60_000 },
    enabled: true,
    nextRunAt: Date.now() + 60_000,
    createdAt: 1,
    updatedAt: 1,
    lastAttemptAt: null,
    lastRunAt: null,
    lastOutcome: null,
    lastError: null,
  };
  queryCache.set(QUERY, { automations: [existing] });
  let patchBody: Record<string, unknown> | undefined;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    if (init?.method === 'PATCH') {
      patchBody = JSON.parse(String(init.body));
      return json({ automation: { ...existing, ...patchBody } });
    }
    return json({ automations: [existing] });
  });
  render(WorkspaceAutomations, { workspaceId: WORKSPACE_ID });

  await user.click(screen.getByRole('button', { name: 'Edit' }));
  expect(screen.getByRole('spinbutton', { name: 'Repeat every' })).toHaveValue(90_001);
  expect(screen.getByRole('combobox', { name: 'Unit' })).toHaveValue('milliseconds');
  await user.click(screen.getByRole('button', { name: 'Save changes' }));

  await waitFor(() => expect(patchBody).toBeDefined());
  expect(patchBody?.schedule).toMatchObject({ type: 'interval', intervalMs: 90_001 });
});

test('reports an embedded agent submission as busy until it settles', async () => {
  const user = userEvent.setup();
  const busyChanges: boolean[] = [];
  let finishSubmission: (() => void) | undefined;
  queryCache.set(QUERY, { automations: [] });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (init?.method === 'POST') {
      await new Promise<void>((resolve) => (finishSubmission = resolve));
      return json({
        submission: { actionId: 'automation', status: 'queued', queuedAt: 1, prompt: 'Create it.' },
      });
    }
    if (String(input).includes('/agent-actions/automation')) {
      return json({
        action: {
          id: 'automation',
          title: 'Manage automations with an agent',
          description: 'Vampire supplies safe automation support.',
          target: { workspaceId: WORKSPACE_ID, workspaceLabel: 'Vampire', agentLabel: 'codex' },
          context: [],
          requestLabel: 'What should the agent create or change?',
          requestPlaceholder: 'Change “Daily review” to weekdays at 9 AM.',
          defaultRequest: '',
        },
      });
    }
    return json({ automations: [] });
  });
  render(WorkspaceAutomations, { workspaceId: WORKSPACE_ID, onBusyChange: (busy: boolean) => busyChanges.push(busy) });

  await user.click(screen.getByRole('button', { name: 'Ask agent…' }));
  await user.type(
    await screen.findByRole('textbox', { name: 'What should the agent create or change?' }),
    'Create it.'
  );
  await user.click(screen.getByRole('button', { name: 'Send to agent' }));
  await waitFor(() => expect(busyChanges.at(-1)).toBe(true));
  expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();

  finishSubmission?.();
  await waitFor(() => expect(busyChanges.at(-1)).toBe(false));
  expect(screen.getByRole('status')).toHaveTextContent('Automation request sent');
});

test('blocks form submission while a list mutation is pending', async () => {
  const user = userEvent.setup();
  const existing: WorkspaceAutomation = {
    id: 'automation-lock',
    kind: 'custom',
    name: 'Locked task',
    prompt: 'Do not race.',
    schedule: { type: 'once', runAt: Date.now() + 60_000 },
    enabled: true,
    nextRunAt: Date.now() + 60_000,
    createdAt: 1,
    updatedAt: 1,
    lastAttemptAt: null,
    lastRunAt: null,
    lastOutcome: null,
    lastError: null,
  };
  queryCache.set(QUERY, { automations: [existing] });
  let finishDelete: (() => void) | undefined;
  let patchCount = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    if (init?.method === 'DELETE') {
      await new Promise<void>((resolve) => (finishDelete = resolve));
      return json({ ok: true });
    }
    if (init?.method === 'PATCH') {
      patchCount += 1;
      return json({ automation: existing });
    }
    return json({ automations: [existing] });
  });
  render(WorkspaceAutomations, { workspaceId: WORKSPACE_ID });

  await user.click(screen.getByRole('button', { name: 'Edit' }));
  const form = screen.getByRole('textbox', { name: 'Name' }).closest('form');
  await user.click(screen.getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled());
  form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  expect(patchCount).toBe(0);

  finishDelete?.();
  await waitFor(() => expect(screen.queryByText('Locked task')).not.toBeInTheDocument());
});
