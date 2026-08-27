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
  setManagedWorkspaceAutomationEnabled,
} from '~/lib/features/workspace/server/workspace-automations.server.ts';
import {
  readWorkspaceStore,
  WORKSPACE_STATE_VERSION,
  writeWorkspaceStore,
} from '~/lib/features/workspace/server/workspace-store.server.ts';

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

test('keeps owner automations paused while King holds the workspace writer lease', async (t) => {
  await createStoredWorkspace(t);
  const now = Date.UTC(2026, 7, 20, 9, 0, 0);
  const automation = await createManagedWorkspaceAutomation(
    'workspace-1',
    {
      name: 'Owner automation',
      prompt: 'Continue the owner workflow.',
      schedule: { type: 'once', runAt: now },
    },
    now
  );
  const state = await readWorkspaceStore();
  state.workspaces[0]!.kingControl = {
    state: 'king',
    reason: 'Owner handoff',
    requestedAt: now,
    changedAt: now,
    lastAction: 'granted',
    notifiedAt: now,
    handoffSnapshot: null,
  };
  await writeWorkspaceStore(state);

  assert.deepEqual(await listDueManagedWorkspaceAutomations(now), []);
  let prepared = false;
  assert.equal(
    await dispatchManagedWorkspaceAutomation('workspace-1', automation.id, now, async () => {
      prepared = true;
      return async () => undefined;
    }),
    'not-ready'
  );
  assert.equal(prepared, false);
  assert.equal((await listManagedWorkspaceAutomations('workspace-1'))[0]?.enabled, true);
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

test('delivers the King bootstrap internally without exposing user mutation controls', async (t) => {
  await createStoredWorkspace(t);
  const now = Date.UTC(2026, 7, 20, 9, 0, 0);
  const state = await readWorkspaceStore();
  state.workspaces[0]!.workspaceKind = 'king';
  state.workspaces[0]!.automations = [
    {
      id: 'king-bootstrap',
      kind: 'king-bootstrap',
      name: 'Initialize King',
      prompt: 'Read KING.md',
      schedule: { type: 'once', runAt: now },
      enabled: true,
      nextRunAt: now,
      createdAt: now,
      updatedAt: now,
      lastAttemptAt: null,
      lastRunAt: null,
      lastOutcome: null,
      lastError: null,
    },
  ];
  await writeWorkspaceStore(state);

  assert.deepEqual(await listManagedWorkspaceAutomations('workspace-1'), []);
  assert.deepEqual(await listDueManagedWorkspaceAutomations(now), [
    { workspaceId: 'workspace-1', automationId: 'king-bootstrap', dueAt: now },
  ]);
  await assert.rejects(
    () => setManagedWorkspaceAutomationEnabled('workspace-1', 'king-bootstrap', false, now),
    /Automation was not found/
  );
  await assert.rejects(
    () => deleteManagedWorkspaceAutomation('workspace-1', 'king-bootstrap'),
    /Automation was not found/
  );
});
