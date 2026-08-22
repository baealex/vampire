import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import {
  migrateManagedWorkspaceNotes,
  queueManagedWorkspaceNoteSummary,
} from '~/lib/features/workspace/server/workspace-automations.ts';
import { managedWorkspaceNotePath } from '~/lib/features/workspace/server/workspace-note-file.ts';
import { findManagedWorkspaceNote, updateManagedWorkspaceNote } from '~/lib/app/server/workspace-registry.ts';
import {
  readWorkspaceStateFile,
  readWorkspaceStore,
  WORKSPACE_STATE_VERSION,
} from '~/lib/features/workspace/server/workspace-store.ts';

async function useTemporaryStateDirectory(
  t: test.TestContext,
  prefix: string
): Promise<{
  directory: string;
  stateDirectory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const stateDirectory = join(directory, 'state');
  const previousStateDirectory = process.env.VAMPIRE_STATE_DIR;
  process.env.VAMPIRE_STATE_DIR = stateDirectory;
  t.after(async () => {
    if (previousStateDirectory === undefined) delete process.env.VAMPIRE_STATE_DIR;
    else process.env.VAMPIRE_STATE_DIR = previousStateDirectory;
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(stateDirectory, { recursive: true });
  return { directory, stateDirectory };
}

test('the note summary action exposes the live state-directory note without a JSON mirror', async (t) => {
  const { directory, stateDirectory } = await useTemporaryStateDirectory(t, 'vampire-note-automation-');
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  await writeFile(
    join(stateDirectory, 'sessions.json'),
    JSON.stringify({
      version: WORKSPACE_STATE_VERSION,
      workspaces: [
        {
          id: 'workspace-1',
          tmuxSession: 'vampire-workspace-1',
          cwd: workspace,
          createdAt: 1,
          lastActiveAt: 1,
        },
      ],
    })
  );

  const notePath = managedWorkspaceNotePath('workspace-1');
  assert.equal(notePath, join(stateDirectory, 'workspace-1.note.md'));
  await writeFile(notePath, 'Existing context\n');
  const queued = await queueManagedWorkspaceNoteSummary('workspace-1', 1_000);
  assert.equal(queued.notePath, notePath);
  assert.equal(await readFile(notePath, 'utf8'), 'Existing context\n');
  assert.match(queued.automation.prompt, /Done/);
  assert.match(queued.automation.prompt, /Next/);
  assert.match(
    queued.automation.prompt,
    /Infer the document language from the user's language and the conversation context/
  );
  assert.match(queued.automation.prompt, new RegExp(notePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await writeFile(notePath, '## Done\n\nBuilt the automation queue.\n\n## Next\n\nVerify the UI.\n');
  assert.equal(
    await findManagedWorkspaceNote('workspace-1'),
    '## Done\n\nBuilt the automation queue.\n\n## Next\n\nVerify the UI.'
  );
  await unlink(notePath);
  assert.equal(await findManagedWorkspaceNote('workspace-1'), '');
});

test('startup migration copies every compatibility JSON note once and removes the compatibility mirror', async (t) => {
  const { stateDirectory } = await useTemporaryStateDirectory(t, 'vampire-note-migration-');
  await writeFile(managedWorkspaceNotePath('workspace-one'), 'Stale file from before rollback\n');
  await writeFile(
    join(stateDirectory, 'sessions.json'),
    JSON.stringify({
      version: WORKSPACE_STATE_VERSION,
      workspaces: [
        {
          id: 'workspace-one',
          tmuxSession: 'vampire-one',
          cwd: '/tmp/one',
          createdAt: 1,
          note: 'Compatibility one',
        },
        {
          id: 'workspace-two',
          tmuxSession: 'vampire-two',
          cwd: '/tmp/two',
          createdAt: 2,
          note: 'Compatibility two',
        },
      ],
    })
  );

  assert.equal(await migrateManagedWorkspaceNotes(), 2);
  assert.equal(await readFile(managedWorkspaceNotePath('workspace-one'), 'utf8'), 'Stale file from before rollback\n');
  assert.equal(await readFile(managedWorkspaceNotePath('workspace-two'), 'utf8'), 'Compatibility two\n');
  assert.equal((await readWorkspaceStore()).workspaces.length, 2);
  assert.equal(await migrateManagedWorkspaceNotes(), 0);

  await writeFile(managedWorkspaceNotePath('workspace-two'), 'Latest from the file\n');
  assert.deepEqual((await readWorkspaceStore()).workspaces[1]?.automations, []);
});

test('a compatibility JSON note blocks migration when its note file cannot be created', async (t) => {
  const { stateDirectory } = await useTemporaryStateDirectory(t, 'vampire-note-fallback-');
  await writeFile(
    join(stateDirectory, 'sessions.json'),
    JSON.stringify({
      version: WORKSPACE_STATE_VERSION,
      workspaces: [
        {
          id: 'blocked-note',
          tmuxSession: 'vampire-blocked-note',
          cwd: '/tmp/blocked-note',
          createdAt: 1,
          note: 'Compatibility value',
        },
      ],
    })
  );
  await mkdir(managedWorkspaceNotePath('blocked-note'));

  await assert.rejects(migrateManagedWorkspaceNotes(), /not a regular file/);
  await assert.rejects(updateManagedWorkspaceNote('blocked-note', 'Still editable'), /not a regular file/);
  const raw = (await readWorkspaceStateFile()) as { workspaces: Array<{ note?: string }> };
  assert.equal(raw.workspaces[0]?.note, 'Compatibility value');
});

test('compatibility workspace identifiers cannot escape the Vampire state directory', async (t) => {
  const { stateDirectory } = await useTemporaryStateDirectory(t, 'vampire-note-path-');
  const path = managedWorkspaceNotePath('../../outside');
  assert.equal(dirname(path), stateDirectory);
  assert.match(basename(path), /^[a-f0-9]{64}\.note\.md$/);
});
