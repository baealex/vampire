import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  effectiveWorkspaceKingControl,
  findWorkspaceConnection,
  readWorkspaceStore,
  type StoredWorkspace,
  WORKSPACE_STATE_VERSION,
} from '~/lib/features/workspace/server/workspace-store.ts';

test('resolves King control by checkout even for a legacy duplicate registration', () => {
  const workspace = (id: string): StoredWorkspace => ({
    id,
    tmuxSession: `session-${id}`,
    cwd: `/project/${id}`,
    checkoutKey: 'shared-checkout',
    createdAt: 1,
    lastActiveAt: 1,
    automations: [],
    favoriteCommands: [],
    startupProfileId: null,
  });
  const controller = workspace('controller');
  controller.kingControl = {
    state: 'king',
    reason: 'Owner handoff',
    requestedAt: 1,
    changedAt: 2,
    lastAction: 'granted',
    notifiedAt: 2,
    handoffSnapshot: null,
  };
  const duplicate = workspace('duplicate');

  assert.equal(effectiveWorkspaceKingControl([controller, duplicate], duplicate)?.state, 'king');
});

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
  assert.equal(await findWorkspaceConnection('47b7cc7d-b47e-4ab7-a1ee-f462eb779c46', file), undefined);
});

test('does not trust malformed workspace state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-workspace-state-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'sessions.json');
  await writeFile(file, JSON.stringify({ version: WORKSPACE_STATE_VERSION, workspaces: [{ id: 'broken' }] }));

  assert.equal(await findWorkspaceConnection('broken', file), undefined);
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

test('preserves the managed King workspace identity', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-workspace-store-king-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'sessions.json');
  await writeFile(
    file,
    JSON.stringify({
      version: WORKSPACE_STATE_VERSION,
      launchProfiles: [{ id: 'codex', name: 'Codex', command: 'codex' }],
      workspaces: [
        {
          id: 'king',
          tmuxSession: 'vampire-king',
          cwd: '/tmp/state/king',
          workspaceKind: 'king',
          workspaceLabel: 'King',
          createdAt: 1,
          startupProfileId: 'codex',
          automations: [
            {
              id: 'king-bootstrap',
              kind: 'king-bootstrap',
              name: 'Initialize King',
              prompt: 'Read KING.md',
              schedule: { type: 'once', runAt: 1 },
              enabled: true,
              nextRunAt: 1,
              createdAt: 1,
              updatedAt: 1,
              lastAttemptAt: null,
              lastRunAt: null,
              lastOutcome: null,
              lastError: null,
            },
          ],
        },
      ],
    })
  );

  const king = (await readWorkspaceStore(file)).workspaces[0];
  assert.equal(king?.workspaceKind, 'king');
  assert.equal(king?.workspaceLabel, 'King');
  assert.equal(king?.startupProfileId, 'codex');
  assert.equal(king?.automations[0]?.kind, 'king-bootstrap');
});

test('drops a hidden King bootstrap from a non-King workspace', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-workspace-store-regular-bootstrap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'sessions.json');
  await writeFile(
    file,
    JSON.stringify({
      version: WORKSPACE_STATE_VERSION,
      launchProfiles: [],
      workspaces: [
        {
          id: 'regular',
          tmuxSession: 'vampire-regular',
          cwd: '/tmp/regular',
          workspaceKind: 'directory',
          createdAt: 1,
          automations: [
            {
              id: 'king-bootstrap',
              kind: 'king-bootstrap',
              name: 'Hidden bootstrap',
              prompt: 'Do something hidden',
              schedule: { type: 'once', runAt: 1 },
              enabled: true,
              nextRunAt: 1,
              createdAt: 1,
              updatedAt: 1,
              lastAttemptAt: null,
              lastRunAt: null,
              lastOutcome: null,
              lastError: null,
            },
          ],
        },
      ],
    })
  );

  assert.deepEqual((await readWorkspaceStore(file)).workspaces[0]?.automations, []);
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
