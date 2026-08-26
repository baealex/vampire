import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  readWorkspaceStore,
  WORKSPACE_STATE_VERSION,
  writeWorkspaceStore,
} from '~/lib/features/workspace/server/workspace-store.ts';
import {
  assertManagedWorkspaceOwnerControl,
  createManagedWorkspace,
  createManagedKingWorkspace,
  launchManagedWorkspaceProfile,
  handOverManagedWorkspaceToKing,
  readManagedLaunchProfiles,
  restartManagedWorkspace,
  releaseManagedWorkspaceKingControl,
  stopAndRemoveManagedWorkspace,
  updateManagedLaunchProfiles,
  updateManagedStartupProfile,
  updateManagedWorkspaceStartup,
  WorkspaceMutationError,
} from './workspace-registry.ts';

const execFile = promisify(execFileCallback);

async function useFakeTmux(t: test.TestContext): Promise<{ stateDirectory: string; tmuxLog: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-king-registry-'));
  const stateDirectory = join(directory, 'state');
  const binDirectory = join(directory, 'bin');
  const tmuxPath = join(binDirectory, 'tmux');
  const tmuxLog = join(directory, 'tmux.log');
  const previousStateDirectory = process.env.VAMPIRE_STATE_DIR;
  const previousPath = process.env.PATH;
  const previousTmuxLog = process.env.FAKE_TMUX_LOG;
  const previousTmuxSession = process.env.FAKE_TMUX_SESSION;
  const previousTmuxCommand = process.env.FAKE_TMUX_COMMAND;
  await mkdir(binDirectory, { recursive: true });
  await writeFile(
    tmuxPath,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_TMUX_LOG"
if [ "$1" = "list-windows" ] && [ -n "$FAKE_TMUX_SESSION" ]; then
  command_name="\${FAKE_TMUX_COMMAND:-zsh}"
  printf '%s\\t1\\t0\\t0\\t@1\\tmain\\t1\\t1\\t%%1\\t%s\\t0\\t%s\\t\\t\\t0\\t0\\n' "$FAKE_TMUX_SESSION" "$command_name" "$command_name"
fi
name=""
previous=""
is_new="0"
for argument in "$@"; do
  if [ "$previous" = "-s" ]; then name="$argument"; fi
  if [ "$argument" = "new-session" ]; then is_new="1"; fi
  previous="$argument"
done
if [ "$is_new" = "1" ]; then
  printf '%s\\t1\\t0\\t0\\t@1\\tmain\\t1\\t1\\t%%1\\tzsh\\t123\\tzsh\\t\\t\\t0\\t0\\n' "$name"
fi
`,
    'utf8'
  );
  await chmod(tmuxPath, 0o755);
  process.env.VAMPIRE_STATE_DIR = stateDirectory;
  process.env.PATH = `${binDirectory}:${previousPath ?? ''}`;
  process.env.FAKE_TMUX_LOG = tmuxLog;
  t.after(async () => {
    if (previousStateDirectory === undefined) delete process.env.VAMPIRE_STATE_DIR;
    else process.env.VAMPIRE_STATE_DIR = previousStateDirectory;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousTmuxLog === undefined) delete process.env.FAKE_TMUX_LOG;
    else process.env.FAKE_TMUX_LOG = previousTmuxLog;
    if (previousTmuxSession === undefined) delete process.env.FAKE_TMUX_SESSION;
    else process.env.FAKE_TMUX_SESSION = previousTmuxSession;
    if (previousTmuxCommand === undefined) delete process.env.FAKE_TMUX_COMMAND;
    else process.env.FAKE_TMUX_COMMAND = previousTmuxCommand;
    await rm(directory, { recursive: true, force: true });
  });
  return { stateDirectory, tmuxLog };
}

test('creates one managed King workspace and schedules its bootstrap after launching the selected profile', async (t) => {
  const { stateDirectory, tmuxLog } = await useFakeTmux(t);
  await writeWorkspaceStore({
    version: WORKSPACE_STATE_VERSION,
    launchProfiles: [{ id: 'codex', name: 'Codex', command: 'codex' }],
    workspaces: [],
  });

  const king = await createManagedKingWorkspace({ launchProfileId: 'codex' });
  assert.equal(king.workspaceKind, 'king');
  assert.equal(king.workspaceLabel, 'King');
  assert.equal(king.cwd, join(stateDirectory, 'king'));
  assert.equal(king.startupProfileId, 'codex');

  const stored = await readWorkspaceStore();
  assert.equal(stored.workspaces.length, 1);
  assert.equal(stored.workspaces[0]?.automations[0]?.kind, 'king-bootstrap');
  assert.equal(stored.workspaces[0]?.automations[0]?.enabled, true);
  assert.match(await readFile(tmuxLog, 'utf8'), /new-session/);
  assert.match(await readFile(tmuxLog, 'utf8'), /send-keys.*codex/s);

  const submitted = await readWorkspaceStore();
  submitted.workspaces[0]!.automations[0] = {
    ...submitted.workspaces[0]!.automations[0]!,
    enabled: false,
    nextRunAt: null,
    lastOutcome: 'submitted',
  };
  await writeWorkspaceStore(submitted);
  await restartManagedWorkspace(king.id);
  const restartedBootstrap = (await readWorkspaceStore()).workspaces[0]?.automations[0];
  assert.equal(restartedBootstrap?.kind, 'king-bootstrap');
  assert.equal(restartedBootstrap?.enabled, true);
  assert.equal(restartedBootstrap?.lastOutcome, null);

  await assert.rejects(
    () => createManagedKingWorkspace({ launchProfileId: null }),
    (error) => error instanceof WorkspaceMutationError && error.reason === 'king-already-exists'
  );
});

test('launches a selected profile only into an idle main shell', async (t) => {
  const { tmuxLog } = await useFakeTmux(t);
  process.env.FAKE_TMUX_SESSION = 'vampire-workspace-1';
  await writeWorkspaceStore({
    version: WORKSPACE_STATE_VERSION,
    launchProfiles: [{ id: 'codex', name: 'Codex', command: 'codex --profile king-worker' }],
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

  await launchManagedWorkspaceProfile('workspace-1', 'codex');
  assert.match(await readFile(tmuxLog, 'utf8'), /send-keys.*codex --profile king-worker/s);

  process.env.FAKE_TMUX_COMMAND = 'codex';
  await assert.rejects(
    () => launchManagedWorkspaceProfile('workspace-1', 'codex'),
    (error) => error instanceof WorkspaceMutationError && error.reason === 'workspace-running'
  );
});

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

test('registers an existing linked worktree without claiming ownership of its directory', async (t) => {
  await useFakeTmux(t);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vampire-external-worktree-')));
  const repository = join(root, 'repository');
  const linkedWorktree = join(root, 'existing-feature');
  const previousRoots = process.env.VAMPIRE_WORKSPACE_ROOTS;
  process.env.VAMPIRE_WORKSPACE_ROOTS = root;
  t.after(async () => {
    if (previousRoots === undefined) delete process.env.VAMPIRE_WORKSPACE_ROOTS;
    else process.env.VAMPIRE_WORKSPACE_ROOTS = previousRoots;
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(repository, { recursive: true });
  await execFile('git', ['init'], { cwd: repository });
  await execFile('git', ['config', 'user.email', 'vampire@example.com'], { cwd: repository });
  await execFile('git', ['config', 'user.name', 'Vampire Test'], { cwd: repository });
  await writeFile(join(repository, 'README.md'), '# Test\n');
  await execFile('git', ['add', 'README.md'], { cwd: repository });
  await execFile('git', ['commit', '-m', 'Initial'], { cwd: repository });
  await execFile('git', ['worktree', 'add', '-b', 'feature/existing', linkedWorktree], { cwd: repository });

  const registered = await createManagedWorkspace({ cwd: linkedWorktree });
  assert.equal(registered.workspaceKind, 'worktree');
  assert.equal(registered.worktreeBranch, 'feature/existing');
  assert.ok(registered.checkoutKey);

  const stored = (await readWorkspaceStore()).workspaces.find((workspace) => workspace.id === registered.id);
  assert.equal(stored?.managedWorktree, false);
  assert.equal(stored?.repositoryPath, repository);

  await stopAndRemoveManagedWorkspace(registered.id);
  assert.equal((await stat(linkedWorktree)).isDirectory(), true);
  assert.equal(
    (await readWorkspaceStore()).workspaces.some((workspace) => workspace.id === registered.id),
    false
  );
});

test('removing King restores manual control and controlled workspaces cannot be removed directly', async (t) => {
  await useFakeTmux(t);
  process.env.FAKE_TMUX_SESSION = 'king-session';
  await writeWorkspaceStore({
    version: WORKSPACE_STATE_VERSION,
    launchProfiles: [],
    workspaces: [
      {
        id: 'worker',
        tmuxSession: 'worker-session',
        cwd: tmpdir(),
        createdAt: 1,
        lastActiveAt: 1,
        automations: [],
        favoriteCommands: [],
        startupProfileId: null,
        kingControl: {
          state: 'king',
          reason: 'Owner handoff',
          requestedAt: 1,
          changedAt: 2,
          lastAction: 'granted',
          notifiedAt: 2,
          handoffSnapshot: null,
        },
      },
      {
        id: 'king',
        tmuxSession: 'king-session',
        cwd: join(process.env.VAMPIRE_STATE_DIR!, 'king'),
        workspaceKind: 'king',
        workspaceLabel: 'King',
        createdAt: 1,
        lastActiveAt: 1,
        automations: [],
        favoriteCommands: [],
        startupProfileId: null,
      },
    ],
  });

  await assert.rejects(
    () => stopAndRemoveManagedWorkspace('worker'),
    (error) => error instanceof WorkspaceMutationError && error.reason === 'king-controlled'
  );

  await stopAndRemoveManagedWorkspace('king');
  const stored = await readWorkspaceStore();
  assert.deepEqual(
    stored.workspaces.map((workspace) => workspace.id),
    ['worker']
  );
  assert.equal(stored.workspaces[0]?.kingControl?.state, 'manual');
  assert.equal(stored.workspaces[0]?.kingControl?.lastAction, 'released');
  assert.equal(stored.workspaces[0]?.kingControl?.notifiedAt, stored.workspaces[0]?.kingControl?.changedAt);
});

test('applies the King writer lease to every workspace registration for the same checkout', async (t) => {
  await useFakeTmux(t);
  const workspace = (id: string) => ({
    id,
    tmuxSession: `session-${id}`,
    cwd: tmpdir(),
    checkoutKey: 'shared-checkout',
    createdAt: 1,
    lastActiveAt: 1,
    automations: [],
    favoriteCommands: [],
    startupProfileId: null,
  });
  await writeWorkspaceStore({
    version: WORKSPACE_STATE_VERSION,
    launchProfiles: [],
    workspaces: [
      workspace('workspace-a'),
      workspace('workspace-b'),
      {
        ...workspace('king'),
        checkoutKey: undefined,
        cwd: join(process.env.VAMPIRE_STATE_DIR!, 'king'),
        workspaceKind: 'king',
        workspaceLabel: 'King',
      },
    ],
  });

  await handOverManagedWorkspaceToKing('workspace-a', 'Use this checkout.', null, 100);
  let stored = await readWorkspaceStore();
  assert.equal(stored.workspaces.find((candidate) => candidate.id === 'workspace-a')?.kingControl?.state, 'king');
  assert.equal(stored.workspaces.find((candidate) => candidate.id === 'workspace-b')?.kingControl?.state, 'king');
  await assert.rejects(
    () => assertManagedWorkspaceOwnerControl('workspace-b'),
    (error) => error instanceof WorkspaceMutationError && error.reason === 'king-controlled'
  );

  await releaseManagedWorkspaceKingControl('workspace-b', 200);
  stored = await readWorkspaceStore();
  assert.equal(stored.workspaces.find((candidate) => candidate.id === 'workspace-a')?.kingControl?.state, 'manual');
  assert.equal(stored.workspaces.find((candidate) => candidate.id === 'workspace-b')?.kingControl?.state, 'manual');
});
