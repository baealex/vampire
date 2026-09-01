import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { link, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  discardWorkspaceAutomationAgentSupport,
  ensureWorkspaceAutomationAgentSupport,
  importWorkspaceAutomationAgentRequests,
  reserveWorkspaceAutomationAgentSupport,
} from './workspace-automation-agent-support.server.ts';
import { WORKSPACE_AUTOMATION_DRAFT_RESERVATION_MS } from './workspace-automation-request-files.server.ts';
import {
  createManagedWorkspaceAutomation,
  listManagedWorkspaceAutomations,
  queueManagedWorkspaceAgentPrompt,
  updateManagedWorkspaceAutomation,
} from './workspace-automations.server.ts';
import { WORKSPACE_STATE_VERSION } from './workspace-store.server.ts';

const run = promisify(execFile);

type AgentAutomationConfiguration = {
  name: string;
  prompt: string;
  enabled: boolean;
  schedule:
    | { type: 'once'; runAt: number }
    | { type: 'interval'; intervalMs: number; startAt: number }
    | {
        type: 'weekly';
        weekdays: number[];
        hour: number;
        minute: number;
        timeZone: string;
        startAt: number;
      };
};

type AgentAutomationSnapshot = AgentAutomationConfiguration & {
  id: string;
  updatedAt: number;
};

type AgentAutomationRequest = {
  version: number;
  workspaceId: string;
  requestId: string;
  preparedAt?: number;
  currentAutomations?: AgentAutomationSnapshot[];
  operation?: unknown;
  automation?: Omit<AgentAutomationConfiguration, 'enabled'>;
};

function createOperation(automation: Partial<AgentAutomationConfiguration> = {}): {
  type: 'create';
  automation: AgentAutomationConfiguration;
} {
  return {
    type: 'create',
    automation: {
      name: 'Daily review',
      prompt: 'Review the current work.',
      enabled: true,
      schedule: { type: 'once', runAt: 10_000 },
      ...automation,
    },
  };
}

async function readAgentRequest(support: { requestPath: string }): Promise<AgentAutomationRequest> {
  return JSON.parse(await readFile(support.requestPath, 'utf8')) as AgentAutomationRequest;
}

function applyArguments(support: { applyCommand: string }): [string, string, string] {
  const command = support.applyCommand.match(/^node '([^']+)' '([^']+)' '([^']+)'$/);
  assert.ok(command);
  return [command[1], command[2], command[3]];
}

async function stageAgentRequest(
  support: { requestPath: string; applyCommand: string },
  request: AgentAutomationRequest
): Promise<[string, string, string]> {
  await writeFile(support.requestPath, JSON.stringify(request));
  const command = applyArguments(support);
  await run(process.execPath, command);
  return command;
}

async function createState(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-automation-agent-'));
  const previous = process.env.VAMPIRE_STATE_DIR;
  process.env.VAMPIRE_STATE_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.VAMPIRE_STATE_DIR;
    else process.env.VAMPIRE_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(
    join(directory, 'sessions.json'),
    JSON.stringify({
      version: WORKSPACE_STATE_VERSION,
      workspaces: [
        { id: 'workspace-1', tmuxSession: 'vampire-workspace-1', cwd: tmpdir(), createdAt: 1, lastActiveAt: 1 },
      ],
    })
  );
  return directory;
}

test('materializes an isolated automation draft, guide, and apply command', async (t) => {
  const directory = await createState(t);
  const existing = await createManagedWorkspaceAutomation(
    'workspace-1',
    {
      name: 'Existing review',
      prompt: 'Preserve this automation.',
      schedule: { type: 'interval', intervalMs: 60_000, startAt: 2_000 },
    },
    500
  );
  const support = await ensureWorkspaceAutomationAgentSupport('workspace-1', 1_000);
  assert.match(support.requestPath, /automation-requests\/[^/]+\.draft\.json$/);
  assert.equal(support.guidePath, join(directory, 'agent-guides', 'workspace-automation.md'));
  const guide = await readFile(support.guidePath, 'utf8');
  assert.match(guide, /Create or update one automation/);
  assert.match(guide, /type: 'weekly'/);
  assert.match(guide, /not delete/);
  const request = await readAgentRequest(support);
  assert.equal(request.version, 2);
  assert.equal(request.workspaceId, 'workspace-1');
  assert.equal(request.preparedAt, 1_000);
  assert.equal(request.operation, null);
  assert.deepEqual(request.currentAutomations, [
    {
      id: existing.id,
      updatedAt: existing.updatedAt,
      name: 'Existing review',
      prompt: 'Preserve this automation.',
      enabled: true,
      schedule: { type: 'interval', intervalMs: 60_000, startAt: 2_000 },
    },
  ]);
  assert.match(support.applyCommand, /apply-workspace-automation\.mjs/);
});

test('concurrent agent requests receive different draft paths', async (t) => {
  await createState(t);
  const first = await ensureWorkspaceAutomationAgentSupport('workspace-1', 1_000);
  const second = await ensureWorkspaceAutomationAgentSupport('workspace-1', 2_000);
  assert.notEqual(first.requestPath, second.requestPath);
  assert.notEqual(first.applyCommand, second.applyCommand);
});

test('discard removes an unqueued draft without touching shared support files', async (t) => {
  await createState(t);
  const support = await ensureWorkspaceAutomationAgentSupport('workspace-1', 1_000);
  await discardWorkspaceAutomationAgentSupport(support);
  await assert.rejects(
    readFile(support.requestPath, 'utf8'),
    (error) => (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
  assert.match(await readFile(support.guidePath, 'utf8'), /workspace automation agent guide/);
});

test('the apply command stages a valid request and the runner imports it', async (t) => {
  await createState(t);
  const support = await ensureWorkspaceAutomationAgentSupport('workspace-1', 1_000);
  const request = await readAgentRequest(support);
  request.operation = createOperation({
    name: 'Weekday review',
    schedule: {
      type: 'weekly',
      weekdays: [1, 2, 3, 4, 5],
      hour: 9,
      minute: 0,
      timeZone: 'Asia/Seoul',
      startAt: 1_000,
    },
  });
  await stageAgentRequest(support, request);
  assert.deepEqual(
    (await importWorkspaceAutomationAgentRequests()).map((result) => result.status),
    ['imported']
  );
  const [automation] = await listManagedWorkspaceAutomations('workspace-1');
  assert.equal(automation?.name, 'Weekday review');
  assert.equal(automation?.schedule.type, 'weekly');
});

test('re-importing the same request id does not create a duplicate automation', async (t) => {
  await createState(t);
  const support = await ensureWorkspaceAutomationAgentSupport('workspace-1', 1_000);
  const request = await readAgentRequest(support);
  request.operation = createOperation({
    name: 'Idempotent request',
    prompt: 'Review work once.',
  });
  const command = await stageAgentRequest(support, request);
  const staged = await readFile(command[2], 'utf8');
  await importWorkspaceAutomationAgentRequests();
  await writeFile(command[2], staged);
  await importWorkspaceAutomationAgentRequests();
  assert.equal((await listManagedWorkspaceAutomations('workspace-1')).length, 1);
});

test('a hidden agent action does not consume the final custom automation slot', async (t) => {
  await createState(t);
  for (let index = 0; index < 31; index += 1) {
    await createManagedWorkspaceAutomation('workspace-1', {
      name: `Existing ${index}`,
      prompt: 'Existing automation.',
      schedule: { type: 'once', runAt: 10_000 + index },
    });
  }
  await queueManagedWorkspaceAgentPrompt(
    'workspace-1',
    { actionId: 'automation', name: 'Automation request', prompt: 'Create the final automation.' },
    2_000
  );
  const support = await ensureWorkspaceAutomationAgentSupport('workspace-1', 2_000);
  const request = await readAgentRequest(support);
  request.operation = createOperation({
    name: 'Final custom automation',
    prompt: 'Use the final visible slot.',
  });
  await stageAgentRequest(support, request);
  assert.deepEqual(
    (await importWorkspaceAutomationAgentRequests()).map((result) => result.status),
    ['imported']
  );
  assert.equal((await listManagedWorkspaceAutomations('workspace-1')).length, 32);
});

test('an unchosen agent request does not reserve a custom automation slot', async (t) => {
  await createState(t);
  for (let index = 0; index < 31; index += 1) {
    await createManagedWorkspaceAutomation('workspace-1', {
      name: `Existing ${index}`,
      prompt: 'Existing automation.',
      schedule: { type: 'once', runAt: 10_000 + index },
    });
  }
  const reserved = await reserveWorkspaceAutomationAgentSupport('workspace-1', 2_000);
  await createManagedWorkspaceAutomation('workspace-1', {
    name: 'Manual final automation',
    prompt: 'Use the slot while the agent decides between create and update.',
    schedule: { type: 'once', runAt: 20_000 },
  });
  assert.equal((await listManagedWorkspaceAutomations('workspace-1')).length, 32);
  await discardWorkspaceAutomationAgentSupport(reserved);
});

test('an in-flight create operation reserves the final custom automation slot', async (t) => {
  await createState(t);
  for (let index = 0; index < 31; index += 1) {
    await createManagedWorkspaceAutomation('workspace-1', {
      name: `Existing ${index}`,
      prompt: 'Existing automation.',
      schedule: { type: 'once', runAt: 10_000 + index },
    });
  }
  const reserved = await reserveWorkspaceAutomationAgentSupport('workspace-1', 2_000);
  const request = await readAgentRequest(reserved);
  request.operation = createOperation({ name: 'Reserved final automation' });
  await writeFile(reserved.requestPath, JSON.stringify(request));

  const updateCandidate = await reserveWorkspaceAutomationAgentSupport('workspace-1', 2_001);
  await assert.rejects(
    createManagedWorkspaceAutomation('workspace-1', {
      name: 'Manual final automation',
      prompt: 'Try to consume the reserved create slot.',
      schedule: { type: 'once', runAt: 20_000 },
    }),
    (error) => error instanceof Error && /up to 32/.test(error.message)
  );
  await Promise.all([
    discardWorkspaceAutomationAgentSupport(reserved),
    discardWorkspaceAutomationAgentSupport(updateCandidate),
  ]);
  await createManagedWorkspaceAutomation('workspace-1', {
    name: 'Manual final automation',
    prompt: 'Use the released slot.',
    schedule: { type: 'once', runAt: 20_000 },
  });
});

test('draft and ready files for one request consume one reservation at the final slot', async (t) => {
  await createState(t);
  for (let index = 0; index < 31; index += 1) {
    await createManagedWorkspaceAutomation('workspace-1', {
      name: `Existing ${index}`,
      prompt: 'Existing automation.',
      schedule: { type: 'once', runAt: 10_000 + index },
    });
  }
  const support = await reserveWorkspaceAutomationAgentSupport('workspace-1', 2_000);
  const request = await readAgentRequest(support);
  request.operation = createOperation({
    name: 'Crash-safe final automation',
    prompt: 'Import while draft and ready coexist.',
  });
  await writeFile(support.requestPath, JSON.stringify(request));
  const command = applyArguments(support);
  await link(support.requestPath, command[2]);

  assert.deepEqual(
    (await importWorkspaceAutomationAgentRequests()).map((result) => result.status),
    ['imported']
  );
  assert.equal((await listManagedWorkspaceAutomations('workspace-1')).length, 32);
  await assert.rejects(readFile(support.requestPath, 'utf8'), { code: 'ENOENT' });
});

test('an abandoned draft releases its reservation after 24 hours', async (t) => {
  await createState(t);
  for (let index = 0; index < 31; index += 1) {
    await createManagedWorkspaceAutomation('workspace-1', {
      name: `Existing ${index}`,
      prompt: 'Existing automation.',
      schedule: { type: 'once', runAt: 10_000 + index },
    });
  }
  const support = await reserveWorkspaceAutomationAgentSupport('workspace-1', 2_000);
  const request = await readAgentRequest(support);
  request.operation = createOperation({ name: 'Abandoned create' });
  await writeFile(support.requestPath, JSON.stringify(request));
  const expired = new Date(Date.now() - WORKSPACE_AUTOMATION_DRAFT_RESERVATION_MS - 1_000);
  await utimes(support.requestPath, expired, expired);

  await createManagedWorkspaceAutomation('workspace-1', {
    name: 'Manual final automation',
    prompt: 'Use the expired reservation.',
    schedule: { type: 'once', runAt: 20_000 },
  });
  assert.equal((await listManagedWorkspaceAutomations('workspace-1')).length, 32);
  await assert.rejects(readFile(support.requestPath, 'utf8'), { code: 'ENOENT' });
});

test('the agent can update one automation without replacing its identity or history', async (t) => {
  await createState(t);
  const existing = await createManagedWorkspaceAutomation(
    'workspace-1',
    {
      name: 'Morning review',
      prompt: 'Review current work.',
      schedule: { type: 'once', runAt: 10_000 },
    },
    1_000
  );
  const support = await ensureWorkspaceAutomationAgentSupport('workspace-1', 2_000);
  const request = await readAgentRequest(support);
  const snapshot = request.currentAutomations?.[0];
  assert.ok(snapshot);
  request.operation = {
    type: 'update',
    automationId: snapshot.id,
    expectedUpdatedAt: snapshot.updatedAt,
    automation: {
      name: 'Weekday review',
      prompt: 'Review current work and continue the next useful task.',
      enabled: false,
      schedule: {
        type: 'weekly',
        weekdays: [1, 2, 3, 4, 5],
        hour: 9,
        minute: 30,
        timeZone: 'Asia/Seoul',
        startAt: 2_000,
      },
    },
  };
  await stageAgentRequest(support, request);

  assert.deepEqual(
    (await importWorkspaceAutomationAgentRequests()).map((result) => result.status),
    ['imported']
  );
  const [updated] = await listManagedWorkspaceAutomations('workspace-1');
  assert.equal(updated?.id, existing.id);
  assert.equal(updated?.createdAt, existing.createdAt);
  assert.equal(updated?.name, 'Weekday review');
  assert.equal(updated?.prompt, 'Review current work and continue the next useful task.');
  assert.equal(updated?.enabled, false);
  assert.deepEqual(updated?.schedule, {
    type: 'weekly',
    weekdays: [1, 2, 3, 4, 5],
    hour: 9,
    minute: 30,
    timeZone: 'Asia/Seoul',
    startAt: 2_000,
  });
});

test('the importer rejects an update when the automation changed after the snapshot', async (t) => {
  await createState(t);
  await createManagedWorkspaceAutomation(
    'workspace-1',
    {
      name: 'Original review',
      prompt: 'Review original work.',
      schedule: { type: 'once', runAt: 10_000 },
    },
    1_000
  );
  const support = await ensureWorkspaceAutomationAgentSupport('workspace-1', 2_000);
  const request = await readAgentRequest(support);
  const snapshot = request.currentAutomations?.[0];
  assert.ok(snapshot);
  request.operation = {
    type: 'update',
    automationId: snapshot.id,
    expectedUpdatedAt: snapshot.updatedAt,
    automation: {
      ...snapshot,
      name: 'Stale agent update',
    },
  };
  await updateManagedWorkspaceAutomation(
    'workspace-1',
    snapshot.id,
    {
      name: 'Newer manual update',
      prompt: 'Keep the newer settings.',
      schedule: { type: 'interval', intervalMs: 60_000, startAt: 20_000 },
    },
    3_000
  );
  await stageAgentRequest(support, request);

  const [result] = await importWorkspaceAutomationAgentRequests();
  assert.equal(result?.status, 'rejected');
  assert.match(result?.error ?? '', /changed after the agent request was prepared/);
  const [current] = await listManagedWorkspaceAutomations('workspace-1');
  assert.equal(current?.name, 'Newer manual update');
  assert.equal(current?.prompt, 'Keep the newer settings.');
});

test('a full workspace still accepts an agent update without consuming another slot', async (t) => {
  await createState(t);
  for (let index = 0; index < 32; index += 1) {
    await createManagedWorkspaceAutomation(
      'workspace-1',
      {
        name: `Existing ${index}`,
        prompt: 'Existing automation.',
        schedule: { type: 'once', runAt: 10_000 + index },
      },
      1_000 + index
    );
  }
  const support = await reserveWorkspaceAutomationAgentSupport('workspace-1', 2_000);
  const request = await readAgentRequest(support);
  const snapshot = request.currentAutomations?.find((automation) => automation.name === 'Existing 0');
  assert.ok(snapshot);
  request.operation = {
    type: 'update',
    automationId: snapshot.id,
    expectedUpdatedAt: snapshot.updatedAt,
    automation: { ...snapshot, name: 'Updated at capacity' },
  };
  await stageAgentRequest(support, request);

  assert.deepEqual(
    (await importWorkspaceAutomationAgentRequests()).map((result) => result.status),
    ['imported']
  );
  const automations = await listManagedWorkspaceAutomations('workspace-1');
  assert.equal(automations.length, 32);
  assert.equal(
    automations.some((automation) => automation.name === 'Updated at capacity'),
    true
  );
});

test('the importer rejects an agent create when the workspace became full', async (t) => {
  await createState(t);
  for (let index = 0; index < 32; index += 1) {
    await createManagedWorkspaceAutomation('workspace-1', {
      name: `Existing ${index}`,
      prompt: 'Existing automation.',
      schedule: { type: 'once', runAt: 10_000 + index },
    });
  }
  const support = await reserveWorkspaceAutomationAgentSupport('workspace-1', 2_000);
  const request = await readAgentRequest(support);
  request.operation = createOperation({ name: 'One too many' });
  await stageAgentRequest(support, request);

  const [result] = await importWorkspaceAutomationAgentRequests();
  assert.equal(result?.status, 'rejected');
  assert.match(result?.error ?? '', /up to 32/);
  assert.equal((await listManagedWorkspaceAutomations('workspace-1')).length, 32);
});

test('a staged version-one create remains importable during an upgrade', async (t) => {
  await createState(t);
  const support = await ensureWorkspaceAutomationAgentSupport('workspace-1', 1_000);
  const request = await readAgentRequest(support);
  request.version = 1;
  request.automation = {
    name: 'Legacy request',
    prompt: 'Import a request prepared by the previous version.',
    schedule: { type: 'once', runAt: 10_000 },
  };
  delete request.preparedAt;
  delete request.currentAutomations;
  delete request.operation;
  await stageAgentRequest(support, request);

  assert.deepEqual(
    (await importWorkspaceAutomationAgentRequests()).map((result) => result.status),
    ['imported']
  );
  const [automation] = await listManagedWorkspaceAutomations('workspace-1');
  assert.equal(automation?.name, 'Legacy request');
  assert.equal(automation?.enabled, true);
});

test('the apply command rejects duplicate weekly weekdays before staging', async (t) => {
  await createState(t);
  const support = await ensureWorkspaceAutomationAgentSupport('workspace-1', 1_000);
  const request = await readAgentRequest(support);
  request.operation = createOperation({
    name: 'Invalid weekly request',
    prompt: 'Do something.',
    schedule: {
      type: 'weekly',
      weekdays: [1, 1],
      hour: 9,
      minute: 0,
      timeZone: 'UTC',
      startAt: 1_000,
    },
  });
  await writeFile(support.requestPath, JSON.stringify(request));
  await assert.rejects(run(process.execPath, applyArguments(support)), /weekly schedule is invalid/);
});

test('the importer rejects a staged request whose workspace id was changed', async (t) => {
  await createState(t);
  const support = await ensureWorkspaceAutomationAgentSupport('workspace-1', 1_000);
  const request = await readAgentRequest(support);
  request.workspaceId = 'another-workspace';
  request.operation = createOperation({
    name: 'Cross-workspace request',
    prompt: 'Do something.',
  });
  await stageAgentRequest(support, request);
  const [result] = await importWorkspaceAutomationAgentRequests();
  assert.equal(result?.status, 'rejected');
  assert.match(result?.error ?? '', /does not belong/);
  assert.deepEqual(await listManagedWorkspaceAutomations('workspace-1'), []);
});
