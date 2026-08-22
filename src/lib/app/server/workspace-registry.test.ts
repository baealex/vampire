import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  readManagedLaunchProfiles,
  WorkspaceMutationError,
  updateManagedLaunchProfiles,
  updateManagedStartupProfile,
  updateManagedWorkspaceStartup,
} from './workspace-registry.ts';
import {
  readWorkspaceStore,
  WORKSPACE_STATE_VERSION,
  writeWorkspaceStore,
} from '~/lib/features/workspace/server/workspace-store.ts';

test('deleting a global profile clears workspace selections without blocking the deletion', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-global-profiles-'));
  const previousStateDirectory = process.env.VAMPIRE_STATE_DIR;
  process.env.VAMPIRE_STATE_DIR = directory;
  t.after(async () => {
    if (previousStateDirectory === undefined) delete process.env.VAMPIRE_STATE_DIR;
    else process.env.VAMPIRE_STATE_DIR = previousStateDirectory;
    await rm(directory, { recursive: true, force: true });
  });

  await writeWorkspaceStore({
    version: WORKSPACE_STATE_VERSION,
    launchProfiles: [{ id: 'codex', name: 'Codex', command: 'codex' }],
    workspaces: [
      {
        id: 'workspace-1',
        tmuxSession: 'vampire-workspace-1',
        cwd: tmpdir(),
        createdAt: 1,
        lastActiveAt: 1,
        automations: [],
        favoriteCommands: [],
        startupProfileId: 'codex',
      },
    ],
  });

  const update = await updateManagedLaunchProfiles([{ id: 'claude', name: 'Claude', command: 'claude' }]);
  assert.deepEqual(update, {
    launchProfiles: [{ id: 'claude', name: 'Claude', command: 'claude' }],
    clearedWorkspaceIds: ['workspace-1'],
  });
  assert.deepEqual(await readManagedLaunchProfiles(), update.launchProfiles);
  assert.equal((await readWorkspaceStore()).workspaces[0]?.startupProfileId, null);

  assert.equal(await updateManagedStartupProfile('workspace-1', 'claude'), 'claude');
  await assert.rejects(
    () => updateManagedStartupProfile('workspace-1', 'missing'),
    (error) => error instanceof WorkspaceMutationError && error.reason === 'invalid-startup-profile'
  );
});

test('saving from a workspace updates the shared cache and its local selection atomically', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-workspace-profiles-'));
  const previousStateDirectory = process.env.VAMPIRE_STATE_DIR;
  process.env.VAMPIRE_STATE_DIR = directory;
  t.after(async () => {
    if (previousStateDirectory === undefined) delete process.env.VAMPIRE_STATE_DIR;
    else process.env.VAMPIRE_STATE_DIR = previousStateDirectory;
    await rm(directory, { recursive: true, force: true });
  });

  await writeWorkspaceStore({
    version: WORKSPACE_STATE_VERSION,
    launchProfiles: [{ id: 'old', name: 'Old profile', command: 'old-command' }],
    workspaces: ['workspace-1', 'workspace-2'].map((id, index) => ({
      id,
      tmuxSession: `vampire-workspace-${index + 1}`,
      cwd: tmpdir(),
      createdAt: index + 1,
      lastActiveAt: index + 1,
      automations: [],
      favoriteCommands: [],
      startupProfileId: 'old',
    })),
  });

  const update = await updateManagedWorkspaceStartup('workspace-1', {
    launchProfiles: [{ id: 'new', name: 'New profile', command: 'new-command' }],
    startupProfileId: 'new',
  });
  assert.deepEqual(update, {
    launchProfiles: [{ id: 'new', name: 'New profile', command: 'new-command' }],
    startupProfileId: 'new',
    clearedWorkspaceIds: ['workspace-2'],
  });
  const stored = await readWorkspaceStore();
  assert.deepEqual(stored.launchProfiles, update.launchProfiles);
  assert.equal(stored.workspaces.find((workspace) => workspace.id === 'workspace-1')?.startupProfileId, 'new');
  assert.equal(stored.workspaces.find((workspace) => workspace.id === 'workspace-2')?.startupProfileId, null);

  await assert.rejects(
    () =>
      updateManagedWorkspaceStartup('workspace-1', {
        launchProfiles: [],
        startupProfileId: 'missing',
      }),
    (error) => error instanceof WorkspaceMutationError && error.reason === 'invalid-startup-profile'
  );
  assert.deepEqual(await readWorkspaceStore(), stored);
});
