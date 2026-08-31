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
import { listManagedWorkspaceAutomations } from './workspace-automations.server.ts';
import { createManagedWorkspaceAutomation, queueManagedWorkspaceAgentPrompt } from './workspace-automations.server.ts';
import { WORKSPACE_STATE_VERSION } from './workspace-store.server.ts';

const run = promisify(execFile);

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
  const support = await ensureWorkspaceAutomationAgentSupport('workspace-1', 1_000);
  assert.match(support.requestPath, /automation-requests\/[^/]+\.draft\.json$/);
  assert.equal(support.guidePath, join(directory, 'agent-guides', 'workspace-automation.md'));
  assert.match(await readFile(support.guidePath, 'utf8'), /type: 'weekly'/);
  assert.match(await readFile(support.requestPath, 'utf8'), /"workspaceId": "workspace-1"/);
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
  const request = JSON.parse(await readFile(support.requestPath, 'utf8'));
  request.automation = {
    name: 'Weekday review',
    prompt: 'Review the current work.',
    schedule: {
      type: 'weekly',
      weekdays: [1, 2, 3, 4, 5],
      hour: 9,
      minute: 0,
      timeZone: 'Asia/Seoul',
      startAt: 1_000,
    },
  };
  await writeFile(support.requestPath, JSON.stringify(request));
  const command = support.applyCommand.match(/^node '([^']+)' '([^']+)' '([^']+)'$/);
  assert.ok(command);
  await run(process.execPath, [command[1], command[2], command[3]]);
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
  const request = JSON.parse(await readFile(support.requestPath, 'utf8'));
  request.automation.name = 'Idempotent request';
  request.automation.prompt = 'Review work once.';
  await writeFile(support.requestPath, JSON.stringify(request));
  const command = support.applyCommand.match(/^node '([^']+)' '([^']+)' '([^']+)'$/);
  assert.ok(command);
  await run(process.execPath, [command[1], command[2], command[3]]);
  const staged = await readFile(command[3], 'utf8');
  await importWorkspaceAutomationAgentRequests();
  await writeFile(command[3], staged);
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
  const request = JSON.parse(await readFile(support.requestPath, 'utf8'));
  request.automation.name = 'Final custom automation';
  request.automation.prompt = 'Use the final visible slot.';
  await writeFile(support.requestPath, JSON.stringify(request));
  const command = support.applyCommand.match(/^node '([^']+)' '([^']+)' '([^']+)'$/);
  assert.ok(command);
  await run(process.execPath, [command[1], command[2], command[3]]);
  assert.deepEqual(
    (await importWorkspaceAutomationAgentRequests()).map((result) => result.status),
    ['imported']
  );
  assert.equal((await listManagedWorkspaceAutomations('workspace-1')).length, 32);
});

test('an in-flight request reserves the final custom automation slot', async (t) => {
  await createState(t);
  for (let index = 0; index < 31; index += 1) {
    await createManagedWorkspaceAutomation('workspace-1', {
      name: `Existing ${index}`,
      prompt: 'Existing automation.',
      schedule: { type: 'once', runAt: 10_000 + index },
    });
  }
  const reserved = await reserveWorkspaceAutomationAgentSupport('workspace-1', 2_000);
  await assert.rejects(
    reserveWorkspaceAutomationAgentSupport('workspace-1', 2_001),
    (error) => error instanceof Error && /up to 32/.test(error.message)
  );
  await assert.rejects(
    createManagedWorkspaceAutomation('workspace-1', {
      name: 'Manual final automation',
      prompt: 'Try to consume the reserved slot.',
      schedule: { type: 'once', runAt: 20_000 },
    }),
    (error) => error instanceof Error && /up to 32/.test(error.message)
  );
  await discardWorkspaceAutomationAgentSupport(reserved);
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
  const request = JSON.parse(await readFile(support.requestPath, 'utf8'));
  request.automation.name = 'Crash-safe final automation';
  request.automation.prompt = 'Import while draft and ready coexist.';
  await writeFile(support.requestPath, JSON.stringify(request));
  const command = support.applyCommand.match(/^node '([^']+)' '([^']+)' '([^']+)'$/);
  assert.ok(command);
  await link(support.requestPath, command[3]);

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

test('the apply command rejects duplicate weekly weekdays before staging', async (t) => {
  await createState(t);
  const support = await ensureWorkspaceAutomationAgentSupport('workspace-1', 1_000);
  const request = JSON.parse(await readFile(support.requestPath, 'utf8'));
  request.automation.name = 'Invalid weekly request';
  request.automation.prompt = 'Do something.';
  request.automation.schedule = {
    type: 'weekly',
    weekdays: [1, 1],
    hour: 9,
    minute: 0,
    timeZone: 'UTC',
    startAt: 1_000,
  };
  await writeFile(support.requestPath, JSON.stringify(request));
  const command = support.applyCommand.match(/^node '([^']+)' '([^']+)' '([^']+)'$/);
  assert.ok(command);
  await assert.rejects(run(process.execPath, [command[1], command[2], command[3]]), /weekly schedule is invalid/);
});

test('the importer rejects a staged request whose workspace id was changed', async (t) => {
  await createState(t);
  const support = await ensureWorkspaceAutomationAgentSupport('workspace-1', 1_000);
  const request = JSON.parse(await readFile(support.requestPath, 'utf8'));
  request.workspaceId = 'another-workspace';
  request.automation.name = 'Cross-workspace request';
  request.automation.prompt = 'Do something.';
  await writeFile(support.requestPath, JSON.stringify(request));
  const command = support.applyCommand.match(/^node '([^']+)' '([^']+)' '([^']+)'$/);
  assert.ok(command);
  await run(process.execPath, [command[1], command[2], command[3]]);
  const [result] = await importWorkspaceAutomationAgentRequests();
  assert.equal(result?.status, 'rejected');
  assert.match(result?.error ?? '', /does not belong/);
  assert.deepEqual(await listManagedWorkspaceAutomations('workspace-1'), []);
});
