import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  findWorkspaceConnection,
  readWorkspaceStore,
  type WorkspaceStore,
  WORKSPACE_STATE_VERSION,
  writeWorkspaceStore,
} from '~/lib/features/workspace/server/workspace-store.server.ts';
import { writeStructuredWorkspaceState } from '~/lib/server/workspace-state-files.ts';

test('finds the terminal and workspace registered for a workspace ID', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-workspace-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'sessions.json');
  const id = 'e272a1ce-550a-48a6-8d4a-5ef1cef1b46';
  await writeFile(
    file,
    JSON.stringify({
      version: WORKSPACE_STATE_VERSION,
      workspaces: [{ id, tmuxSession: 'vampire-e272a1ce', cwd: '/tmp/workspace', createdAt: 1 }],
    })
  );

  assert.deepEqual(await findWorkspaceConnection(id, file), {
    tmuxSession: 'vampire-e272a1ce',
    cwd: '/tmp/workspace',
  });
  const stored = await readWorkspaceStore(file);
  assert.equal(stored.workspacePreferences, undefined);
  assert.deepEqual(stored.launchProfiles, []);
  assert.equal(stored.workspaces[0]?.startupProfileId, null);
  assert.deepEqual(stored.workspaces[0]?.automations, []);
  assert.equal('composerPromptHistory' in stored.workspaces[0]!, false);
  assert.equal(await findWorkspaceConnection('47b7cc7d-b47e-4ab7-a1ee-f462eb779c46', file), undefined);
});

test('does not trust malformed workspace state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-workspace-state-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'sessions.json');
  await writeFile(file, JSON.stringify({ version: WORKSPACE_STATE_VERSION, workspaces: [{ id: 'broken' }] }));

  assert.equal(await findWorkspaceConnection('broken', file), undefined);
});

test('uses the organized registry and ownership files after layout migration', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-workspace-structured-state-'));
  const previousStateDirectory = process.env.VAMPIRE_STATE_DIR;
  process.env.VAMPIRE_STATE_DIR = directory;
  t.after(async () => {
    if (previousStateDirectory === undefined) delete process.env.VAMPIRE_STATE_DIR;
    else process.env.VAMPIRE_STATE_DIR = previousStateDirectory;
    await rm(directory, { recursive: true, force: true });
  });
  const state: WorkspaceStore = {
    version: WORKSPACE_STATE_VERSION,
    launchProfiles: [],
    defaultStartupProfileId: null,
    workspaces: [
      {
        id: 'organized',
        tmuxSession: 'vampire-organized',
        cwd: '/tmp/organized',
        createdAt: 1,
        lastActiveAt: 1,
        automations: [],
        favoriteCommands: ['pnpm dev'],
        startupProfileId: null,
      },
    ],
  };
  await writeStructuredWorkspaceState(state, { stateDirectory: directory, revision: 'revision-1' });

  assert.deepEqual(await findWorkspaceConnection('organized'), {
    tmuxSession: 'vampire-organized',
    cwd: '/tmp/organized',
  });
  const updated = { ...state, workspaces: [{ ...state.workspaces[0]!, favoriteCommands: ['pnpm test'] }] };
  await writeWorkspaceStore(updated);
  assert.deepEqual((await readWorkspaceStore()).workspaces[0]?.favoriteCommands, ['pnpm test']);
  assert.match(await readFile(join(directory, 'workspaces', 'organized', 'background.json'), 'utf8'), /pnpm test/);
  await assert.rejects(readFile(join(directory, 'sessions.json')), { code: 'ENOENT' });
});

test('reads compatibility session-shaped state as workspace state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-workspace-store-compatibility-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'sessions.json');
  const id = 'compatibility-workspace';
  await writeFile(
    file,
    JSON.stringify({
      version: WORKSPACE_STATE_VERSION,
      sessions: [{ id, tmuxSession: 'vampire-compatibility', cwd: '/tmp/compatibility', createdAt: 1 }],
      workspacePreferences: { sessionOrderMode: 'manual', manualSessionOrder: [id, id] },
    })
  );

  const store = await readWorkspaceStore(file);
  assert.equal(store.workspaces[0]?.id, id);
  assert.deepEqual(store.workspacePreferences, {
    workspaceOrderMode: 'manual',
    manualWorkspaceOrder: [id],
  });
  assert.deepEqual(await findWorkspaceConnection(id, file), {
    tmuxSession: 'vampire-compatibility',
    cwd: '/tmp/compatibility',
  });
});

test('migrates compatibility workspaces without inventing command favorites', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-workspace-store-favorites-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'sessions.json');
  const workspace = {
    id: 'favorite-workspace',
    tmuxSession: 'vampire-favorite-store-test',
    cwd: tmpdir(),
    createdAt: 1,
    lastActiveAt: 1,
  };

  await writeFile(file, JSON.stringify({ version: WORKSPACE_STATE_VERSION, workspaces: [workspace] }));
  assert.deepEqual((await readWorkspaceStore(file)).workspaces[0]?.favoriteCommands, []);

  await writeFile(
    file,
    JSON.stringify({
      version: WORKSPACE_STATE_VERSION,
      workspaces: [{ ...workspace, favoriteCommands: ['pnpm dev'] }],
    })
  );
  assert.deepEqual((await readWorkspaceStore(file)).workspaces[0]?.favoriteCommands, ['pnpm dev']);
});

test('moves compatibility workspace launch profiles into the shared profile list', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-workspace-store-launch-profiles-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'sessions.json');
  await writeFile(
    file,
    JSON.stringify({
      version: WORKSPACE_STATE_VERSION,
      workspaces: [
        {
          id: 'launch-profiles',
          tmuxSession: 'vampire-launch-profiles',
          cwd: tmpdir(),
          createdAt: 1,
          launchProfiles: [
            { id: 'codex', name: ' Codex ', command: ' codex ' },
            { id: 'broken', name: 'Broken\nProfile', command: 'ignored' },
          ],
          defaultLaunchProfileId: 'codex',
          autoStartDefaultProfile: true,
        },
      ],
    })
  );

  const store = await readWorkspaceStore(file);
  assert.deepEqual(store.launchProfiles, [{ id: 'codex', name: 'Codex', command: 'codex' }]);
  assert.equal(store.workspaces[0]?.startupProfileId, 'codex');
});

test('preserves managed worktree identity without changing compatibility workspaces', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-workspace-store-worktree-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'sessions.json');
  await writeFile(
    file,
    JSON.stringify({
      version: WORKSPACE_STATE_VERSION,
      workspaces: [
        {
          id: 'worktree-workspace',
          tmuxSession: 'vampire-worktree',
          cwd: '/tmp/state/worktrees/fix-login',
          repositoryPath: '/tmp/project',
          workspaceLabel: 'Fix login',
          worktreeBranch: 'vampire/fix-login-01234567',
          createdAt: 1,
        },
        {
          id: 'compatibility-workspace',
          tmuxSession: 'vampire-compatibility',
          cwd: '/tmp/compatibility',
          createdAt: 2,
        },
      ],
    })
  );

  const [worktree, compatibility] = (await readWorkspaceStore(file)).workspaces;
  assert.equal(worktree.repositoryPath, '/tmp/project');
  assert.equal(worktree.workspaceKind, 'worktree');
  assert.equal(worktree.workspaceLabel, 'Fix login');
  assert.equal(worktree.worktreeBranch, 'vampire/fix-login-01234567');
  assert.equal(compatibility.repositoryPath, undefined);
  assert.equal(compatibility.workspaceKind, undefined);
  assert.equal(compatibility.workspaceLabel, undefined);
  assert.equal(compatibility.worktreeBranch, undefined);
});

test('normalizes shared workspace order preferences without changing the state version', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-workspace-store-preferences-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'sessions.json');
  await writeFile(
    file,
    JSON.stringify({
      version: WORKSPACE_STATE_VERSION,
      workspaces: [],
      workspacePreferences: {
        workspaceOrderMode: 'manual',
        manualWorkspaceOrder: ['workspace-2', 'workspace-1', 'workspace-2'],
      },
    })
  );

  assert.deepEqual((await readWorkspaceStore(file)).workspacePreferences, {
    workspaceOrderMode: 'manual',
    manualWorkspaceOrder: ['workspace-2', 'workspace-1'],
  });

  await writeFile(
    file,
    JSON.stringify({
      version: WORKSPACE_STATE_VERSION,
      workspaces: [],
      workspacePreferences: { workspaceOrderMode: 'manual', manualWorkspaceOrder: [42] },
    })
  );
  await assert.rejects(() => readWorkspaceStore(file), /Vampire workspace registry is unreadable/);
});
