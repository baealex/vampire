import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  KING_WORKSPACE_NAME,
  ensureManagedKingWorkspace,
  KING_BOOTSTRAP_VERSION,
  KING_CONTRACT_REVISION,
  managedKingWorkspacePath,
  reconcileManagedKingWorkspaceContract,
  scheduleKingBootstrapAutomation,
} from './king-workspace.ts';
import { readWorkspaceStore, writeWorkspaceStore } from './workspace-store.ts';

async function useTemporaryStateDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-king-workspace-'));
  const previousStateDirectory = process.env.VAMPIRE_STATE_DIR;
  process.env.VAMPIRE_STATE_DIR = directory;
  t.after(async () => {
    if (previousStateDirectory === undefined) delete process.env.VAMPIRE_STATE_DIR;
    else process.env.VAMPIRE_STATE_DIR = previousStateDirectory;
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('materializes the versioned King operating contract in Vampire-managed storage', async (t) => {
  const stateDirectory = await useTemporaryStateDirectory(t);
  const prepared = await ensureManagedKingWorkspace();

  assert.equal(prepared.cwd, join(stateDirectory, 'king'));
  assert.equal(prepared.cwd, managedKingWorkspacePath());
  assert.equal(prepared.name, KING_WORKSPACE_NAME);
  assert.equal(prepared.bootstrapVersion, KING_BOOTSTRAP_VERSION);
  assert.equal(prepared.contractRevision, KING_CONTRACT_REVISION);

  const instructions = await readFile(prepared.instructionsPath, 'utf8');
  assert.match(instructions, new RegExp(`bootstrap-version: ${KING_BOOTSTRAP_VERSION}`));
  assert.match(instructions, /Plan Result, Decision Request/);
  assert.match(instructions, /Shortlist at most three/i);
  assert.match(instructions, /waiting.*completion/is);
  assert.match(instructions, /recognized main agent/i);
  assert.match(instructions, /without routing on coarse waiting or working inference/i);
  assert.match(instructions, /never create a workspace or worktree/i);
  assert.match(instructions, /never starts a stopped workspace.*writes into a shell.*creates another agent/i);
  assert.match(instructions, /acceptance criteria/i);
  assert.match(prepared.bootstrapPrompt, /KING\.md/);
  assert.match(prepared.bootstrapPrompt, new RegExp(KING_CONTRACT_REVISION));
});

test('repairs stale generated instructions but refuses to follow a replacement symlink', async (t) => {
  const stateDirectory = await useTemporaryStateDirectory(t);
  const prepared = await ensureManagedKingWorkspace();
  await writeFile(prepared.instructionsPath, 'stale instructions\n', 'utf8');

  await ensureManagedKingWorkspace();
  assert.doesNotMatch(await readFile(prepared.instructionsPath, 'utf8'), /stale instructions/);

  const outside = join(stateDirectory, 'outside.md');
  await writeFile(outside, 'keep me\n', 'utf8');
  await rm(prepared.instructionsPath);
  await symlink(outside, prepared.instructionsPath);

  await assert.rejects(() => ensureManagedKingWorkspace(), /regular file/i);
  assert.equal(await readFile(outside, 'utf8'), 'keep me\n');
});

test('keeps exactly one internal bootstrap delivery and resets it for a new King session', () => {
  const first = scheduleKingBootstrapAutomation([], 'Read KING.md', 100);
  assert.equal(first.length, 1);
  assert.deepEqual(first[0], {
    id: 'king-bootstrap',
    kind: 'king-bootstrap',
    name: 'Initialize King',
    prompt: 'Read KING.md',
    schedule: { type: 'once', runAt: 100 },
    enabled: true,
    nextRunAt: 100,
    createdAt: 100,
    updatedAt: 100,
    lastAttemptAt: null,
    lastRunAt: null,
    lastOutcome: null,
    lastError: null,
  });

  const submitted = [{ ...first[0], enabled: false, nextRunAt: null, lastOutcome: 'submitted' as const }];
  const restarted = scheduleKingBootstrapAutomation(submitted, 'Read KING.md v2', 200);
  assert.equal(restarted.length, 1);
  assert.equal(restarted[0]?.prompt, 'Read KING.md v2');
  assert.equal(restarted[0]?.enabled, true);
  assert.equal(restarted[0]?.nextRunAt, 200);
  assert.equal(restarted[0]?.createdAt, 100);
  assert.equal(restarted[0]?.lastOutcome, null);
});

test('reconciles a bundled contract update once when Vampire starts', async (t) => {
  await useTemporaryStateDirectory(t);
  const prepared = await ensureManagedKingWorkspace();
  const oldBootstrap = scheduleKingBootstrapAutomation([], 'Read the old King contract', 100)[0];
  assert.ok(oldBootstrap);
  await writeWorkspaceStore({
    version: 1,
    launchProfiles: [],
    workspaces: [
      {
        id: 'king-1',
        tmuxSession: 'vampire-king-1',
        cwd: '/stale/king/path',
        workspaceKind: 'king',
        workspaceLabel: 'Dracula',
        createdAt: 1,
        lastActiveAt: 1,
        automations: [{ ...oldBootstrap, enabled: false, nextRunAt: null, lastOutcome: 'submitted' }],
        favoriteCommands: [],
        startupProfileId: null,
      },
    ],
  });

  assert.equal(await reconcileManagedKingWorkspaceContract(200), true);
  const migrated = (await readWorkspaceStore()).workspaces[0];
  assert.equal(migrated?.cwd, prepared.cwd);
  assert.equal(migrated?.workspaceLabel, 'King');
  assert.equal(migrated?.automations[0]?.prompt, prepared.bootstrapPrompt);
  assert.equal(migrated?.automations[0]?.enabled, true);
  assert.equal(migrated?.automations[0]?.nextRunAt, 200);

  assert.equal(await reconcileManagedKingWorkspaceContract(300), false);
  assert.equal((await readWorkspaceStore()).workspaces[0]?.automations[0]?.updatedAt, 200);
});
