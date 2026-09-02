import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import {
  appendManagedWorkspaceComposerPrompt,
  listManagedWorkspaceComposerPrompts,
  managedWorkspaceComposerHistoryPath,
  managedWorkspaceComposerHistorySettingsPath,
  migrateManagedWorkspaceComposerHistories,
  readManagedWorkspaceComposerHistorySettings,
  updateManagedWorkspaceComposerHistorySettings,
  WorkspaceComposerHistoryError,
} from './workspace-composer-history.server.ts';
import { removeManagedWorkspace } from '~/lib/app/server/workspace-registry.server.ts';
import { readWorkspaceStateFile, WORKSPACE_STATE_VERSION } from './workspace-store.server.ts';

async function createStoredWorkspace(t: test.TestContext, legacyHistory?: unknown[]) {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-composer-history-'));
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
          tmuxSession: 'vampire-workspace-history-test',
          cwd: tmpdir(),
          createdAt: 1,
          lastActiveAt: 1,
          ...(legacyHistory ? { composerPromptHistory: legacyHistory } : {}),
        },
      ],
    })
  );
  return directory;
}

test('stores exact Composer prompts outside sessions.json and lists the newest first', async (t) => {
  const directory = await createStoredWorkspace(t);

  await appendManagedWorkspaceComposerPrompt('workspace-1', '  First line\nsecond line  ', 10);
  await appendManagedWorkspaceComposerPrompt('workspace-1', 'Next prompt', 20);

  assert.deepEqual(
    (await listManagedWorkspaceComposerPrompts('workspace-1')).map(({ text, submittedAt }) => ({ text, submittedAt })),
    [
      { text: 'Next prompt', submittedAt: 20 },
      { text: '  First line\nsecond line  ', submittedAt: 10 },
    ]
  );
  const rawState = (await readWorkspaceStateFile()) as { workspaces: Array<Record<string, unknown>> };
  assert.equal('composerPromptHistory' in rawState.workspaces[0]!, false);
  assert.equal(
    managedWorkspaceComposerHistoryPath('workspace-1'),
    join(directory, 'workspaces', 'workspace-1', 'composer-history.json')
  );
  assert.match(await readFile(managedWorkspaceComposerHistoryPath('workspace-1'), 'utf8'), /Next prompt/);
});

test('uses server settings to disable recording and bound each workspace history', async (t) => {
  const directory = await createStoredWorkspace(t);
  assert.deepEqual(await readManagedWorkspaceComposerHistorySettings(), { enabled: true, limit: 20 });

  await updateManagedWorkspaceComposerHistorySettings({ enabled: true, limit: 2 });
  for (let index = 0; index < 4; index += 1) {
    await appendManagedWorkspaceComposerPrompt('workspace-1', `Prompt ${index}`, index);
  }
  assert.deepEqual(
    (await listManagedWorkspaceComposerPrompts('workspace-1')).map((prompt) => prompt.text),
    ['Prompt 3', 'Prompt 2']
  );
  assert.equal(managedWorkspaceComposerHistorySettingsPath(), join(directory, 'global', 'composer-history.json'));

  await updateManagedWorkspaceComposerHistorySettings({ enabled: false, limit: 2 });
  assert.deepEqual(await appendManagedWorkspaceComposerPrompt('workspace-1', 'Not recorded', 5), { saved: false });
  assert.deepEqual(
    (await listManagedWorkspaceComposerPrompts('workspace-1')).map((prompt) => prompt.text),
    ['Prompt 3', 'Prompt 2']
  );
});

test('migrates legacy sessions history only after writing the dedicated file', async (t) => {
  await createStoredWorkspace(t, [
    { id: 'legacy-1', text: 'Legacy prompt', submittedAt: 10 },
    { id: 'legacy-2', text: 'Latest legacy prompt', submittedAt: 20 },
  ]);

  assert.equal(await migrateManagedWorkspaceComposerHistories(), 1);
  assert.deepEqual(
    (await listManagedWorkspaceComposerPrompts('workspace-1')).map((prompt) => prompt.text),
    ['Latest legacy prompt', 'Legacy prompt']
  );
  const migrated = (await readWorkspaceStateFile()) as { workspaces: Array<Record<string, unknown>> };
  assert.equal('composerPromptHistory' in migrated.workspaces[0]!, false);
  assert.equal(await migrateManagedWorkspaceComposerHistories(), 0);
});

test('removing a workspace deletes its dedicated Composer history', async (t) => {
  await createStoredWorkspace(t);
  await appendManagedWorkspaceComposerPrompt('workspace-1', 'Delete with workspace', 10);
  const path = managedWorkspaceComposerHistoryPath('workspace-1');

  await removeManagedWorkspace('workspace-1');

  await assert.rejects(readFile(path, 'utf8'), { code: 'ENOENT' });
});

test('rejects invalid prompts, settings, and unsafe workspace paths', async (t) => {
  const directory = await createStoredWorkspace(t);
  await assert.rejects(
    appendManagedWorkspaceComposerPrompt('workspace-1', '   ', 10),
    (error) => error instanceof WorkspaceComposerHistoryError && error.reason === 'invalid-prompt'
  );
  await assert.rejects(
    appendManagedWorkspaceComposerPrompt('missing', 'Prompt', 10),
    (error) => error instanceof WorkspaceComposerHistoryError && error.reason === 'not-found'
  );
  await assert.rejects(
    updateManagedWorkspaceComposerHistorySettings({ enabled: true, limit: 0 }),
    (error) => error instanceof WorkspaceComposerHistoryError && error.reason === 'invalid-settings'
  );
  const unsafePath = managedWorkspaceComposerHistoryPath('../../outside');
  assert.equal(dirname(dirname(unsafePath)), join(directory, 'workspaces'));
  assert.match(basename(dirname(unsafePath)), /^[a-f0-9]{64}$/);
  assert.equal(basename(unsafePath), 'composer-history.json');
});
