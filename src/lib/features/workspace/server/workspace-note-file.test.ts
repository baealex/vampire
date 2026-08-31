import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import {
  migrateManagedWorkspaceNotes,
  queueManagedWorkspaceNoteUpdate,
} from '~/lib/features/workspace/server/workspace-automations.server.ts';
import {
  managedWorkspaceNoteMigrationBackupPath,
  managedWorkspaceNotePath,
} from '~/lib/features/workspace/server/workspace-note-file.server.ts';
import { installWorkspaceAutomationRunner } from '~/lib/app/server/workspace-automation-runner.server.ts';
import { ensureWorkspaceAutomationAgentSupport } from '~/lib/features/workspace/server/workspace-automation-agent-support.server.ts';
import {
  findManagedWorkspaceNote,
  removeManagedWorkspace,
  updateManagedWorkspaceNote,
} from '~/lib/app/server/workspace-registry.server.ts';
import {
  readWorkspaceStateFile,
  readWorkspaceStore,
  WORKSPACE_STATE_VERSION,
  writeWorkspaceStore,
} from '~/lib/features/workspace/server/workspace-store.server.ts';

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

test('the note agent action uses only the custom instructions and exposes the live note path', async (t) => {
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
  const instructions = 'Keep the existing wording and add only the current deployment blocker.';
  const queued = await queueManagedWorkspaceNoteUpdate('workspace-1', instructions, 1_000);
  assert.equal(queued.notePath, notePath);
  assert.equal(await readFile(notePath, 'utf8'), 'Existing context\n');
  assert.match(queued.automation.prompt, new RegExp(instructions.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(queued.automation.prompt, /first non-empty line|level-two headings|## Next|## Done/);
  assert.match(queued.automation.prompt, new RegExp(notePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await assert.rejects(queueManagedWorkspaceNoteUpdate('workspace-1', '   ', 1_001), /Agent instructions/);
  await writeFile(notePath, '## Done\n\nBuilt the automation queue.\n\n## Next\n\nVerify the UI.\n');
  assert.equal(
    await findManagedWorkspaceNote('workspace-1'),
    '## Done\n\nBuilt the automation queue.\n\n## Next\n\nVerify the UI.'
  );
  await unlink(notePath);
  assert.equal(await findManagedWorkspaceNote('workspace-1'), '');
});

test('startup migration preserves notes from the legacy sessions collection before removing the JSON mirror', async (t) => {
  const { stateDirectory } = await useTemporaryStateDirectory(t, 'vampire-note-migration-');
  await writeFile(managedWorkspaceNotePath('workspace-one'), 'Stale file from before rollback\n');
  await writeFile(managedWorkspaceNotePath('workspace-two'), '');
  await writeFile(
    join(stateDirectory, 'sessions.json'),
    JSON.stringify({
      version: WORKSPACE_STATE_VERSION,
      sessions: [
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
        {
          id: 'workspace-three',
          tmuxSession: 'vampire-three',
          cwd: '/tmp/three',
          createdAt: 3,
          note: 'Compatibility three',
        },
      ],
    })
  );

  assert.equal(await migrateManagedWorkspaceNotes(), 3);
  assert.equal(await readFile(managedWorkspaceNotePath('workspace-one'), 'utf8'), 'Stale file from before rollback\n');
  assert.equal(await readFile(managedWorkspaceNotePath('workspace-two'), 'utf8'), 'Compatibility two\n');
  assert.equal(await readFile(managedWorkspaceNotePath('workspace-three'), 'utf8'), 'Compatibility three\n');
  const backup = (await readWorkspaceStateFile(managedWorkspaceNoteMigrationBackupPath())) as {
    sessions: Array<{ note?: string }>;
  };
  assert.deepEqual(
    backup.sessions.map((workspace) => workspace.note),
    ['Compatibility one', 'Compatibility two', 'Compatibility three']
  );
  const migrated = (await readWorkspaceStateFile()) as {
    sessions?: unknown;
    workspaces: Array<{ note?: string }>;
  };
  assert.equal(migrated.sessions, undefined);
  assert.equal(migrated.workspaces.length, 3);
  assert.equal(
    migrated.workspaces.some((workspace) => 'note' in workspace),
    false
  );
  assert.equal(await migrateManagedWorkspaceNotes(), 0);

  await writeFile(managedWorkspaceNotePath('workspace-two'), 'Latest from the file\n');
  assert.deepEqual((await readWorkspaceStore()).workspaces[1]?.automations, []);
});

test('startup migration also preserves notes from the compatibility workspaces collection', async (t) => {
  const { stateDirectory } = await useTemporaryStateDirectory(t, 'vampire-workspace-note-migration-');
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
          note: 'Compatibility workspace note',
        },
      ],
    })
  );

  assert.equal(await migrateManagedWorkspaceNotes(), 1);
  assert.equal(await readFile(managedWorkspaceNotePath('workspace-one'), 'utf8'), 'Compatibility workspace note\n');
  const migrated = (await readWorkspaceStateFile()) as { workspaces: Array<{ note?: string }> };
  assert.equal('note' in migrated.workspaces[0]!, false);
});

test('a compatibility JSON note blocks migration when its note file cannot be created', async (t) => {
  const { stateDirectory } = await useTemporaryStateDirectory(t, 'vampire-note-fallback-');
  await writeFile(
    join(stateDirectory, 'sessions.json'),
    JSON.stringify({
      version: WORKSPACE_STATE_VERSION,
      sessions: [
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

  await assert.rejects(installWorkspaceAutomationRunner(), /not a regular file/);
  await assert.rejects(updateManagedWorkspaceNote('blocked-note', 'Still editable'), /not a regular file/);
  const raw = (await readWorkspaceStateFile()) as { sessions: Array<{ note?: string }> };
  assert.equal(raw.sessions[0]?.note, 'Compatibility value');
});

test('removing a workspace deletes its note and pending automation requests', async (t) => {
  const { stateDirectory } = await useTemporaryStateDirectory(t, 'vampire-note-removal-');
  const storedWorkspace = {
    id: 'workspace-remove-note',
    tmuxSession: 'vampire-remove-note',
    cwd: tmpdir(),
    createdAt: 1,
    lastActiveAt: 1,
    automations: [],
    favoriteCommands: [],
    startupProfileId: null,
  };
  await writeWorkspaceStore({
    version: WORKSPACE_STATE_VERSION,
    launchProfiles: [],
    workspaces: [storedWorkspace],
  });
  await updateManagedWorkspaceNote(storedWorkspace.id, 'Delete this note with the workspace.');
  const notePath = managedWorkspaceNotePath(storedWorkspace.id);
  const automationSupport = await ensureWorkspaceAutomationAgentSupport(storedWorkspace.id);

  await removeManagedWorkspace(storedWorkspace.id);

  assert.equal((await readWorkspaceStore()).workspaces.length, 0);
  await assert.rejects(readFile(notePath, 'utf8'), { code: 'ENOENT' });
  await assert.rejects(readFile(automationSupport.requestPath, 'utf8'), { code: 'ENOENT' });

  await writeWorkspaceStore({
    version: WORKSPACE_STATE_VERSION,
    launchProfiles: [],
    workspaces: [storedWorkspace],
  });
  await mkdir(notePath);

  await assert.rejects(removeManagedWorkspace(storedWorkspace.id), /not a regular file/);
  assert.equal((await readWorkspaceStore()).workspaces.length, 1);
  assert.equal((await readFile(join(stateDirectory, 'sessions.json'), 'utf8')).includes(storedWorkspace.id), true);
});

test('compatibility workspace identifiers cannot escape the Vampire state directory', async (t) => {
  const { stateDirectory } = await useTemporaryStateDirectory(t, 'vampire-note-path-');
  const path = managedWorkspaceNotePath('../../outside');
  assert.equal(dirname(path), stateDirectory);
  assert.match(basename(path), /^[a-f0-9]{64}\.note\.md$/);
});
