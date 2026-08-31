import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createManagedWorkspaceAutomation,
  deleteManagedWorkspaceAutomation,
  dispatchManagedWorkspaceAutomation,
  listDueManagedWorkspaceAutomations,
  listManagedWorkspaceAutomations,
  queueManagedWorkspaceAgentPrompt,
  setManagedWorkspaceAutomationEnabled,
} from '~/lib/features/workspace/server/workspace-automations.server.ts';
import { readWorkspaceStore, WORKSPACE_STATE_VERSION } from '~/lib/features/workspace/server/workspace-store.server.ts';

async function createStoredWorkspace(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-automations-'));
  const previousStateDirectory = process.env.VAMPIRE_STATE_DIR;
  process.env.VAMPIRE_STATE_DIR = directory;
  t.after(async () => {
    if (previousStateDirectory === undefined) delete process.env.VAMPIRE_STATE_DIR;
    else process.env.VAMPIRE_STATE_DIR = previousStateDirectory;
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(
    join(directory, 'sessions.json'),
    JSON.stringify({
      version: WORKSPACE_STATE_VERSION,
      workspaces: [
        {
          id: 'workspace-1',
          tmuxSession: 'vampire-workspace-1',
          cwd: tmpdir(),
          createdAt: 1,
          lastActiveAt: 1,
        },
      ],
    })
  );
}

test('a one-time automation stays queued until the agent is ready, then submits once', async (t) => {
  await createStoredWorkspace(t);
  const now = Date.UTC(2026, 7, 20, 9, 0, 0);
  const automation = await createManagedWorkspaceAutomation(
    'workspace-1',
    {
      name: 'Review the work',
      prompt: 'Review the current work and list the next steps.',
      schedule: { type: 'once', runAt: now },
    },
    now
  );

  assert.equal((await listDueManagedWorkspaceAutomations(now)).length, 1);
  assert.equal(
    await dispatchManagedWorkspaceAutomation('workspace-1', automation.id, now, async () => undefined),
    'not-ready'
  );
  assert.equal((await listManagedWorkspaceAutomations('workspace-1'))[0]?.enabled, true);

  const submissions: string[] = [];
  assert.equal(
    await dispatchManagedWorkspaceAutomation(
      'workspace-1',
      automation.id,
      now,
      async (_workspace, current) => async () => {
        submissions.push(current.prompt);
      }
    ),
    'submitted'
  );
  assert.deepEqual(submissions, ['Review the current work and list the next steps.']);

  const [saved] = await listManagedWorkspaceAutomations('workspace-1');
  assert.equal(saved?.enabled, false);
  assert.equal(saved?.nextRunAt, null);
  assert.equal(saved?.lastRunAt, now);
  assert.equal(saved?.lastOutcome, 'submitted');
  assert.deepEqual(await listDueManagedWorkspaceAutomations(now + 1), []);
});

test('agent actions reuse one hidden queue slot without appearing as saved automations', async (t) => {
  await createStoredWorkspace(t);
  const first = await queueManagedWorkspaceAgentPrompt(
    'workspace-1',
    {
      actionId: 'note',
      name: 'Workspace note request',
      prompt: 'First request',
    },
    10_000
  );
  await assert.rejects(
    queueManagedWorkspaceAgentPrompt(
      'workspace-1',
      {
        actionId: 'note',
        name: 'Workspace note request',
        prompt: 'Competing request',
      },
      10_500
    ),
    /already waiting to be delivered/
  );
  assert.equal(
    await dispatchManagedWorkspaceAutomation('workspace-1', first.id, 10_000, async () => async () => undefined),
    'submitted'
  );
  const second = await queueManagedWorkspaceAgentPrompt(
    'workspace-1',
    {
      actionId: 'note',
      name: 'Workspace note request',
      prompt: 'Latest request',
    },
    16_000
  );

  assert.equal(second.id, first.id);
  assert.equal(second.kind, 'agent-action');
  assert.equal(second.agentActionId, 'note');
  assert.equal(second.prompt, 'Latest request');
  assert.deepEqual(await listManagedWorkspaceAutomations('workspace-1'), []);
  const stored = (await readWorkspaceStore()).workspaces[0]?.automations ?? [];
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.prompt, 'Latest request');
  assert.deepEqual(await listDueManagedWorkspaceAutomations(16_000), [
    { workspaceId: 'workspace-1', automationId: first.id, dueAt: 16_000 },
  ]);
});

test('a recurring automation coalesces missed intervals and never catches up repeatedly', async (t) => {
  await createStoredWorkspace(t);
  const startAt = Date.UTC(2026, 7, 20, 9, 0, 0);
  const intervalMs = 60_000;
  const automation = await createManagedWorkspaceAutomation(
    'workspace-1',
    {
      name: 'Check tests',
      prompt: 'Check the test run and handle the next useful step.',
      schedule: { type: 'interval', intervalMs, startAt },
    },
    startAt - intervalMs
  );
  const attemptedAt = startAt + intervalMs * 3 + 15_000;

  assert.equal(
    await dispatchManagedWorkspaceAutomation(
      'workspace-1',
      automation.id,
      attemptedAt,
      async () => async () => undefined
    ),
    'submitted'
  );

  const [saved] = await listManagedWorkspaceAutomations('workspace-1');
  assert.equal(saved?.enabled, true);
  assert.equal(saved?.nextRunAt, startAt + intervalMs * 4);
  assert.equal((await listDueManagedWorkspaceAutomations(attemptedAt)).length, 0);
});

test('a weekly automation runs only on selected local weekdays and keeps its wall-clock time', async (t) => {
  await createStoredWorkspace(t);
  const createdAt = Date.UTC(2026, 7, 31, 0, 0);
  const automation = await createManagedWorkspaceAutomation(
    'workspace-1',
    {
      name: 'Monday and Wednesday review',
      prompt: 'Review current work.',
      schedule: {
        type: 'weekly',
        weekdays: [1, 3],
        hour: 9,
        minute: 30,
        timeZone: 'Asia/Seoul',
        startAt: createdAt,
      },
    },
    createdAt
  );

  assert.equal(automation.nextRunAt, Date.UTC(2026, 7, 31, 0, 30));
  assert.equal(
    await dispatchManagedWorkspaceAutomation(
      'workspace-1',
      automation.id,
      Date.UTC(2026, 7, 31, 0, 30),
      async () => async () => undefined
    ),
    'submitted'
  );
  const [saved] = await listManagedWorkspaceAutomations('workspace-1');
  assert.equal(saved?.nextRunAt, Date.UTC(2026, 8, 2, 0, 30));
});

test('pause, resume, delete, and failed delivery remain durable', async (t) => {
  await createStoredWorkspace(t);
  const now = Date.UTC(2026, 7, 20, 9, 0, 0);
  const automation = await createManagedWorkspaceAutomation(
    'workspace-1',
    {
      name: 'Prepare update',
      prompt: 'Prepare an update.',
      schedule: { type: 'once', runAt: now },
    },
    now
  );

  assert.equal(
    (await setManagedWorkspaceAutomationEnabled('workspace-1', automation.id, false, now + 1)).enabled,
    false
  );
  assert.deepEqual(await listDueManagedWorkspaceAutomations(now + 1), []);
  assert.equal((await setManagedWorkspaceAutomationEnabled('workspace-1', automation.id, true, now + 2)).enabled, true);

  assert.equal(
    await dispatchManagedWorkspaceAutomation('workspace-1', automation.id, now + 2, async () => async () => {
      throw new Error('tmux unavailable');
    }),
    'failed'
  );
  const [failed] = await listManagedWorkspaceAutomations('workspace-1');
  assert.equal(failed?.enabled, false);
  assert.equal(failed?.lastOutcome, 'failed');
  assert.match(failed?.lastError ?? '', /tmux unavailable/);

  await deleteManagedWorkspaceAutomation('workspace-1', automation.id);
  assert.deepEqual(await listManagedWorkspaceAutomations('workspace-1'), []);
  assert.deepEqual((await readWorkspaceStore()).workspaces[0]?.automations, []);
});
