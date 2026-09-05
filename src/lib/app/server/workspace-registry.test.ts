import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  readManagedLaunchProfileSettings,
  readManagedLaunchProfiles,
  WorkspaceMutationError,
  updateManagedLaunchProfiles,
  updateManagedStartupProfile,
  updateManagedWorkspaceSettings,
  updateManagedWorkspaceStartup,
} from './workspace-registry.server.ts';
import {
  readWorkspaceStore,
  WORKSPACE_STATE_VERSION,
  writeWorkspaceStore,
} from '~/lib/features/workspace/server/workspace-store.server.ts';

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
    defaultStartupProfileId: null,
    clearedWorkspaceIds: ['workspace-1'],
    workspaceStartupUpdates: [{ id: 'workspace-1', startupProfileId: null }],
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
    defaultStartupProfileId: null,
    startupProfileId: 'new',
    clearedWorkspaceIds: ['workspace-2'],
    workspaceStartupUpdates: [
      { id: 'workspace-1', startupProfileId: 'new' },
      { id: 'workspace-2', startupProfileId: null },
    ],
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

test('saves a workspace Composer template with its startup profile and rejects unsafe templates atomically', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-workspace-settings-'));
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
        startupProfileId: null,
      },
    ],
  });

  const composerTemplate = 'Date: {{ today }}\n\n{{ prompts }}\n\nRead AGENTS.md before replying.';
  assert.deepEqual(
    await updateManagedWorkspaceSettings('workspace-1', {
      workspaceLabel: 'Vampire',
      startupProfileId: 'codex',
      composerTemplate,
    }),
    {
      workspaceLabel: 'Vampire',
      startupProfileId: 'codex',
      composerTemplate,
    }
  );
  const saved = await readWorkspaceStore();
  assert.equal(saved.workspaces[0]?.workspaceLabel, 'Vampire');
  assert.equal(saved.workspaces[0]?.startupProfileId, 'codex');
  assert.equal(saved.workspaces[0]?.composerTemplate, composerTemplate);

  await assert.rejects(
    () =>
      updateManagedWorkspaceSettings('workspace-1', {
        workspaceLabel: 'Changed after failed save',
        startupProfileId: null,
        composerTemplate: 'The prompt slot is missing.',
      }),
    (error) => error instanceof WorkspaceMutationError && error.reason === 'invalid-composer-template'
  );
  assert.deepEqual(await readWorkspaceStore(), saved);
});

test('changes the shared default atomically for every registered workspace', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-default-profile-'));
  const previousStateDirectory = process.env.VAMPIRE_STATE_DIR;
  process.env.VAMPIRE_STATE_DIR = directory;
  t.after(async () => {
    if (previousStateDirectory === undefined) delete process.env.VAMPIRE_STATE_DIR;
    else process.env.VAMPIRE_STATE_DIR = previousStateDirectory;
    await rm(directory, { recursive: true, force: true });
  });

  const launchProfiles = [
    { id: 'codex', name: 'Codex', command: 'codex' },
    { id: 'claude', name: 'Claude', command: 'claude' },
  ];
  await writeWorkspaceStore({
    version: WORKSPACE_STATE_VERSION,
    launchProfiles,
    defaultStartupProfileId: 'codex',
    workspaces: ['workspace-1', 'workspace-2'].map((id, index) => ({
      id,
      tmuxSession: 'vampire-workspace-' + (index + 1),
      cwd: tmpdir(),
      createdAt: index + 1,
      lastActiveAt: index + 1,
      automations: [],
      favoriteCommands: [],
      startupProfileId: index === 0 ? 'codex' : null,
    })),
  });

  const update = await updateManagedLaunchProfiles(launchProfiles, {
    defaultStartupProfileId: 'claude',
    applyDefaultToAll: true,
  });

  assert.equal(update.defaultStartupProfileId, 'claude');
  assert.deepEqual(update.workspaceStartupUpdates, [
    { id: 'workspace-1', startupProfileId: 'claude' },
    { id: 'workspace-2', startupProfileId: 'claude' },
  ]);
  const stored = await readWorkspaceStore();
  assert.equal(stored.defaultStartupProfileId, 'claude');
  assert.deepEqual(
    stored.workspaces.map((workspace) => workspace.startupProfileId),
    ['claude', 'claude']
  );
  assert.deepEqual(await readManagedLaunchProfileSettings(), {
    launchProfiles,
    defaultStartupProfileId: 'claude',
  });
});
