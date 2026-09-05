import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  backgroundCommandContainsInlineSecret,
  ensureWorkspaceBackgroundAgentSupport,
  importWorkspaceBackgroundAgentRequests,
} from './workspace-background-agent-support.server.ts';
import { readWorkspaceStore, WORKSPACE_STATE_VERSION, writeWorkspaceStore } from './workspace-store.server.ts';

const run = promisify(execFile);

type BackgroundRequest = {
  version: number;
  workspaceId: string;
  requestId: string;
  preparedAt: number;
  currentFavoriteCommands: string[];
  operation: null | { add: string[]; remove: string[] };
};

async function createState(t: test.TestContext, favoriteCommands = ['pnpm dev']): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-background-agent-'));
  const previous = process.env.VAMPIRE_STATE_DIR;
  process.env.VAMPIRE_STATE_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.VAMPIRE_STATE_DIR;
    else process.env.VAMPIRE_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  await writeWorkspaceStore({
    version: WORKSPACE_STATE_VERSION,
    launchProfiles: [],
    workspaces: [
      {
        id: 'workspace-1',
        tmuxSession: 'vampire-workspace-1',
        cwd: tmpdir(),
        createdAt: 1,
        lastActiveAt: 1,
        automations: [],
        favoriteCommands,
        startupProfileId: null,
      },
    ],
  });
  return directory;
}

async function readRequest(path: string): Promise<BackgroundRequest> {
  return JSON.parse(await readFile(path, 'utf8')) as BackgroundRequest;
}

function applyArguments(command: string): [string, string, string] {
  const match = command.match(/^node '([^']+)' '([^']+)' '([^']+)'$/);
  assert.ok(match);
  return [match[1], match[2], match[3]];
}

async function stageRequest(
  support: { requestPath: string; applyCommand: string },
  request: BackgroundRequest
): Promise<[string, string, string]> {
  await writeFile(support.requestPath, `${JSON.stringify(request, null, 2)}\n`);
  const command = applyArguments(support.applyCommand);
  await run(process.execPath, command);
  return command;
}

test('materializes only the current Background favorites in an isolated draft', async (t) => {
  const directory = await createState(t, ['pnpm dev', 'pnpm test --watch']);
  const support = await ensureWorkspaceBackgroundAgentSupport('workspace-1', 2_000);

  assert.match(support.requestPath, /agent-support\/requests\/background\/[^/]+\.draft\.json$/);
  assert.equal(support.guidePath, join(directory, 'agent-support', 'guides', 'workspace-background.md'));
  assert.match(support.applyPath, /apply-workspace-background\.mjs$/);
  const request = await readRequest(support.requestPath);
  assert.deepEqual(request, {
    version: 1,
    workspaceId: 'workspace-1',
    requestId: request.requestId,
    preparedAt: 2_000,
    currentFavoriteCommands: ['pnpm dev', 'pnpm test --watch'],
    operation: null,
  });
  const serialized = await readFile(support.requestPath, 'utf8');
  assert.doesNotMatch(serialized, /tmuxSession|cwd|automations/);
  const guide = await readFile(support.guidePath, 'utf8');
  assert.match(guide, /Preserve existing commands/);
  assert.match(guide, /explicitly asks to remove/);
  assert.match(guide, /Saving a favorite never runs the command/);
});

test('the apply command validates and atomically imports add and remove operations', async (t) => {
  await createState(t, ['pnpm dev', 'pnpm lint --watch']);
  const support = await ensureWorkspaceBackgroundAgentSupport('workspace-1', 2_000);
  const request = await readRequest(support.requestPath);
  request.operation = { add: ['pnpm test --watch'], remove: ['pnpm lint --watch'] };
  await stageRequest(support, request);

  assert.deepEqual(
    (await importWorkspaceBackgroundAgentRequests()).map((result) => result.status),
    ['imported']
  );
  assert.deepEqual((await readWorkspaceStore()).workspaces[0]?.favoriteCommands, ['pnpm dev', 'pnpm test --watch']);
});

test('re-importing an applied request is idempotent', async (t) => {
  await createState(t);
  const support = await ensureWorkspaceBackgroundAgentSupport('workspace-1', 2_000);
  const request = await readRequest(support.requestPath);
  request.operation = { add: ['pnpm test --watch'], remove: [] };
  const command = await stageRequest(support, request);
  const staged = await readFile(command[2], 'utf8');

  await importWorkspaceBackgroundAgentRequests();
  await writeFile(command[2], staged);
  assert.deepEqual(
    (await importWorkspaceBackgroundAgentRequests()).map((result) => result.status),
    ['imported']
  );
  assert.deepEqual((await readWorkspaceStore()).workspaces[0]?.favoriteCommands, ['pnpm dev', 'pnpm test --watch']);
});

test('the importer rejects a stale snapshot without replacing a concurrent favorite change', async (t) => {
  await createState(t);
  const support = await ensureWorkspaceBackgroundAgentSupport('workspace-1', 2_000);
  const request = await readRequest(support.requestPath);
  request.operation = { add: ['pnpm test --watch'], remove: [] };
  await stageRequest(support, request);

  const state = await readWorkspaceStore();
  state.workspaces[0]!.favoriteCommands = ['pnpm dev', 'pnpm check --watch'];
  await writeWorkspaceStore(state);

  const [result] = await importWorkspaceBackgroundAgentRequests();
  assert.equal(result?.status, 'rejected');
  assert.match(result?.error ?? '', /changed after this request was prepared/);
  assert.deepEqual((await readWorkspaceStore()).workspaces[0]?.favoriteCommands, ['pnpm dev', 'pnpm check --watch']);
});

test('inline secret values are refused while environment references remain allowed', async (t) => {
  await createState(t);
  assert.equal(backgroundCommandContainsInlineSecret('API_TOKEN=literal pnpm dev'), true);
  assert.equal(backgroundCommandContainsInlineSecret('API_TOKEN=$API_TOKEN pnpm dev'), false);
  assert.equal(backgroundCommandContainsInlineSecret('pnpm dev --token literal'), true);

  const support = await ensureWorkspaceBackgroundAgentSupport('workspace-1', 2_000);
  const request = await readRequest(support.requestPath);
  request.operation = { add: ['API_TOKEN=literal pnpm dev'], remove: [] };
  await writeFile(support.requestPath, JSON.stringify(request));
  const [script, draft, ready] = applyArguments(support.applyCommand);
  await assert.rejects(run(process.execPath, [script, draft, ready]), /inline secret/);
  await assert.rejects(readFile(ready, 'utf8'), { code: 'ENOENT' });
  assert.deepEqual((await readWorkspaceStore()).workspaces[0]?.favoriteCommands, ['pnpm dev']);
});
