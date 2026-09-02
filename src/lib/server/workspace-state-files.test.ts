import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { WorkspaceStore } from '~/lib/shared/contracts/workspace-store.ts';
import {
  readStructuredWorkspaceState,
  prepareStructuredWorkspaceStateRemoval,
  recoverStructuredWorkspaceState,
  WORKSPACE_STATE_TRANSACTION_FILE,
  writeStructuredWorkspaceState,
} from './workspace-state-files.ts';

function exampleState(label = 'Example'): WorkspaceStore {
  return {
    version: 1,
    workspacePreferences: { workspaceOrderMode: 'manual', manualWorkspaceOrder: ['workspace-1'] },
    launchProfiles: [{ id: 'development', name: 'Development', command: 'pnpm dev' }],
    defaultStartupProfileId: 'development',
    workspaces: [
      {
        id: 'workspace-1',
        tmuxSession: 'vampire-workspace-1',
        cwd: '/projects/example',
        workspaceKind: 'directory',
        workspaceLabel: label,
        createdAt: 10,
        lastActiveAt: 20,
        automations: [],
        favoriteCommands: ['pnpm dev'],
        startupProfileId: 'development',
        composerTemplate: '{{prompt}}',
      },
    ],
  };
}

async function temporaryState(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-structured-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('stores each ownership domain in its final file and round-trips the aggregate state', async (t) => {
  const directory = await temporaryState(t);
  const state = exampleState();

  await writeStructuredWorkspaceState(state, { stateDirectory: directory, revision: 'revision-1', now: 1_000 });

  assert.deepEqual(await readStructuredWorkspaceState(directory), state);
  const registry = JSON.parse(await readFile(join(directory, 'registry.json'), 'utf8')) as {
    workspaces: Array<Record<string, unknown>>;
  };
  assert.deepEqual(Object.keys(registry.workspaces[0]!).sort(), [
    'createdAt',
    'cwd',
    'id',
    'lastActiveAt',
    'tmuxSession',
    'workspaceKind',
    'workspaceLabel',
  ]);
  assert.deepEqual(
    (
      JSON.parse(await readFile(join(directory, 'workspaces', 'workspace-1', 'background.json'), 'utf8')) as {
        favoriteCommands: string[];
      }
    ).favoriteCommands,
    ['pnpm dev']
  );
  assert.equal(
    (
      JSON.parse(await readFile(join(directory, 'workspaces', 'workspace-1', 'settings.json'), 'utf8')) as {
        startupProfileId: string;
      }
    ).startupProfileId,
    'development'
  );
  assert.deepEqual((await readdir(join(directory, 'global'))).sort(), ['launch-profiles.json', 'settings.json']);
  await assert.rejects(readFile(join(directory, WORKSPACE_STATE_TRANSACTION_FILE)), { code: 'ENOENT' });
});

test('replays a durable transaction after failure before the registry commit', async (t) => {
  const directory = await temporaryState(t);
  await mkdir(join(directory, 'registry.json'));

  await assert.rejects(
    writeStructuredWorkspaceState(exampleState(), {
      stateDirectory: directory,
      revision: 'revision-1',
      now: 1_000,
    })
  );
  assert.match(await readFile(join(directory, WORKSPACE_STATE_TRANSACTION_FILE), 'utf8'), /revision-1/);

  await rm(join(directory, 'registry.json'), { recursive: true });
  assert.equal(await recoverStructuredWorkspaceState(directory), true);
  assert.deepEqual(await readStructuredWorkspaceState(directory), exampleState());
  await assert.rejects(readFile(join(directory, WORKSPACE_STATE_TRANSACTION_FILE)), { code: 'ENOENT' });
});

test('fails closed on corrupt recovery data without replacing a committed registry', async (t) => {
  const directory = await temporaryState(t);
  await writeStructuredWorkspaceState(exampleState(), { stateDirectory: directory, revision: 'revision-1' });
  const registryPath = join(directory, 'registry.json');
  const committedRegistry = await readFile(registryPath, 'utf8');
  await writeFile(
    join(directory, WORKSPACE_STATE_TRANSACTION_FILE),
    '{"version":1,"id":"00000000-0000-0000-0000-000000000000","createdAt":"1970-01-01T00:00:00.000Z","files":[]}'
  );

  await assert.rejects(readStructuredWorkspaceState(directory), /recovery data is unreadable/i);
  assert.equal(await readFile(registryPath, 'utf8'), committedRegistry);
});

test('removes a known workspace directory only after its registry entry is committed away', async (t) => {
  const directory = await temporaryState(t);
  await writeStructuredWorkspaceState(exampleState(), { stateDirectory: directory, revision: 'revision-1' });
  const removeWorkspace = await prepareStructuredWorkspaceStateRemoval('workspace-1', directory);
  await assert.rejects(removeWorkspace(), /remains registered/i);
  await writeStructuredWorkspaceState(
    { version: 1, launchProfiles: [], defaultStartupProfileId: null, workspaces: [] },
    { stateDirectory: directory, revision: 'revision-2' }
  );

  await removeWorkspace();

  await assert.rejects(readFile(join(directory, 'workspaces', 'workspace-1', 'settings.json')), { code: 'ENOENT' });
  assert.deepEqual((await readStructuredWorkspaceState(directory)).workspaces, []);
});
