import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DEVELOPMENT_STATE_MARKER_FILE,
  prepareDevelopmentEnvironment,
  prepareDevelopmentStateCopy,
} from './development-state.ts';
import { CURRENT_STATE_LAYOUT_VERSION, runStateMigrations, STATE_LAYOUT_FILE } from './state-migrations.ts';

async function temporaryRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vampire-development-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function createSourceState(root: string): Promise<string> {
  const source = join(root, 'source-state');
  await mkdir(join(source, 'composer-history', 'workspaces'), { recursive: true });
  await mkdir(join(source, 'worktrees', 'workspace-1'), { recursive: true });
  await mkdir(join(source, 'automation-requests'), { recursive: true });
  await writeFile(
    join(source, 'sessions.json'),
    JSON.stringify({
      version: 1,
      workspaces: [
        {
          id: 'workspace-1',
          tmuxSession: 'vampire-workspace-1',
          cwd: '/projects/workspace-1',
          createdAt: 1,
          lastActiveAt: 1,
        },
      ],
    })
  );
  await writeFile(join(source, 'workspace-1.note.md'), '# Exact note without a trailing newline');
  await writeFile(join(source, 'status-plugins.json'), '{"version":1,"plugins":[]}\n');
  await writeFile(join(source, 'terminal-input-settings.json'), '{"version":2,"mode":"compose","slashHandoff":true}\n');
  await writeFile(join(source, 'composer-history', 'settings.json'), '{"version":1,"enabled":true,"limit":20}\n');
  await writeFile(join(source, 'composer-history', 'workspaces', 'workspace-1.json'), '{"version":1,"prompts":[]}\n');
  await writeFile(join(source, 'worktrees', 'workspace-1', 'tracked.txt'), 'must not be copied');
  await writeFile(join(source, 'automation-requests', 'request.ready.json'), 'must not be copied');
  await writeFile(join(source, 'sessions.json.stale.tmp'), 'must not be copied');
  return source;
}

test('copies legacy state and migrates only the fresh development copy into layout v1', async (t) => {
  const root = await temporaryRoot(t);
  const source = await createSourceState(root);
  const target = join(root, 'development-state');

  const result = await prepareDevelopmentStateCopy({ sourceDirectory: source, targetDirectory: target, now: 10 });

  assert.equal(
    await readFile(join(target, 'workspaces', 'workspace-1', 'note.md'), 'utf8'),
    '# Exact note without a trailing newline'
  );
  await assert.rejects(readFile(join(target, 'sessions.json')), { code: 'ENOENT' });
  assert.match(await readFile(join(target, 'registry.json'), 'utf8'), /workspace-1/);
  assert.equal(await readFile(join(source, 'workspace-1.note.md'), 'utf8'), '# Exact note without a trailing newline');
  await assert.rejects(readFile(join(source, DEVELOPMENT_STATE_MARKER_FILE)), { code: 'ENOENT' });
  await assert.rejects(readFile(join(source, STATE_LAYOUT_FILE)), { code: 'ENOENT' });
  await assert.rejects(readFile(join(target, 'worktrees', 'workspace-1', 'tracked.txt')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(target, 'automation-requests', 'request.ready.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(target, 'sessions.json.stale.tmp')), { code: 'ENOENT' });

  const marker = JSON.parse(await readFile(join(target, DEVELOPMENT_STATE_MARKER_FILE), 'utf8')) as {
    kind: string;
    createdAt: string;
    layoutVersion: number;
    files: Array<{ path: string; bytes: number; sha256: string }>;
  };
  assert.equal(marker.kind, 'vampire-development-state');
  assert.equal(marker.createdAt, new Date(10).toISOString());
  assert.equal(marker.layoutVersion, CURRENT_STATE_LAYOUT_VERSION);
  assert.equal(
    (JSON.parse(await readFile(join(target, STATE_LAYOUT_FILE), 'utf8')) as { layoutVersion: number }).layoutVersion,
    CURRENT_STATE_LAYOUT_VERSION
  );
  assert.deepEqual(
    marker.files.map((file) => file.path),
    [
      'composer-history/settings.json',
      'composer-history/workspaces/workspace-1.json',
      'sessions.json',
      'status-plugins.json',
      'terminal-input-settings.json',
      'workspace-1.note.md',
    ]
  );
  assert.ok(marker.files.every((file) => file.bytes > 0 && /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.equal(result.fileCount, marker.files.length);
  assert.equal(result.attempts, 1);
  assert.equal(result.layoutVersion, CURRENT_STATE_LAYOUT_VERSION);
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.includes('.staging')),
    []
  );
});

test('preserves an existing valid migration ledger when copying upgraded state', async (t) => {
  const root = await temporaryRoot(t);
  const source = await createSourceState(root);
  const target = join(root, 'development-state');
  await runStateMigrations({ stateDirectory: source, now: () => 1_000 });
  const sourceLayout = await readFile(join(source, STATE_LAYOUT_FILE), 'utf8');

  const result = await prepareDevelopmentStateCopy({ sourceDirectory: source, targetDirectory: target, now: 2_000 });

  assert.equal(result.layoutVersion, CURRENT_STATE_LAYOUT_VERSION);
  assert.equal(await readFile(join(target, STATE_LAYOUT_FILE), 'utf8'), sourceLayout);
  assert.equal(await readFile(join(source, STATE_LAYOUT_FILE), 'utf8'), sourceLayout);
});

test('retries an online snapshot when state changes without exposing a partial target', async (t) => {
  const root = await temporaryRoot(t);
  const source = await createSourceState(root);
  const target = join(root, 'development-state');
  const updatedStatusValue = {
    version: 1,
    plugins: [
      {
        id: 'updated',
        name: 'Updated',
        enabled: true,
        intervalMs: 1_000,
        source: { type: 'command', command: 'printf updated' },
      },
    ],
  };
  const updatedStatus = `${JSON.stringify(updatedStatusValue)}\n`;

  const result = await prepareDevelopmentStateCopy({
    sourceDirectory: source,
    targetDirectory: target,
    beforeSourceVerification: async (attempt) => {
      if (attempt === 1) await writeFile(join(source, 'status-plugins.json'), updatedStatus);
    },
  });

  assert.equal(result.attempts, 2);
  assert.equal(
    await readFile(join(target, 'global', 'status-widgets.json'), 'utf8'),
    `${JSON.stringify(updatedStatusValue, null, 2)}\n`
  );
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.includes('.staging')),
    []
  );
});

test('leaves no target or staging data when online state never settles', async (t) => {
  const root = await temporaryRoot(t);
  const source = await createSourceState(root);
  const target = join(root, 'development-state');

  await assert.rejects(
    prepareDevelopmentStateCopy({
      sourceDirectory: source,
      targetDirectory: target,
      maximumAttempts: 2,
      beforeSourceVerification: async (attempt) => {
        await writeFile(join(source, 'status-plugins.json'), `{"version":1,"attempt":${attempt}}\n`);
      },
    }),
    /kept changing across 2 online snapshot attempts/i
  );

  await assert.rejects(readFile(join(target, 'sessions.json')), { code: 'ENOENT' });
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.includes('.staging')),
    []
  );
});

test('never overwrites an existing development target or accepts overlapping paths', async (t) => {
  const root = await temporaryRoot(t);
  const source = await createSourceState(root);
  const existingTarget = join(root, 'existing');
  await mkdir(existingTarget);
  await writeFile(join(existingTarget, 'keep.txt'), 'keep');

  await assert.rejects(
    prepareDevelopmentStateCopy({ sourceDirectory: source, targetDirectory: existingTarget }),
    /must not already exist/i
  );
  assert.equal(await readFile(join(existingTarget, 'keep.txt'), 'utf8'), 'keep');
  await assert.rejects(
    prepareDevelopmentStateCopy({ sourceDirectory: source, targetDirectory: join(source, 'copy') }),
    /must not overlap/i
  );
});

test('rejects symlinks in copied state instead of following them', async (t) => {
  const root = await temporaryRoot(t);
  const source = await createSourceState(root);
  const outside = join(root, 'outside.json');
  await writeFile(outside, '{"secret":true}\n');
  await symlink(outside, join(source, 'linked.note.md'));

  await assert.rejects(
    prepareDevelopmentStateCopy({ sourceDirectory: source, targetDirectory: join(root, 'development-state') }),
    /symbolic link/i
  );
});

test('development startup requires an explicit marked non-production state directory', async (t) => {
  const root = await temporaryRoot(t);
  const homeDirectory = join(root, 'home');
  const liveState = join(homeDirectory, '.vampire');
  await mkdir(liveState, { recursive: true });
  await writeFile(join(liveState, 'sessions.json'), '{"version":1,"workspaces":[]}\n');

  await assert.rejects(prepareDevelopmentEnvironment({}, { homeDirectory }), /VAMPIRE_STATE_DIR/i);
  await assert.rejects(
    prepareDevelopmentEnvironment({ VAMPIRE_STATE_DIR: liveState }, { homeDirectory }),
    /production state directory/i
  );

  const unmarked = join(root, 'unmarked');
  await mkdir(unmarked);
  await assert.rejects(
    prepareDevelopmentEnvironment({ VAMPIRE_STATE_DIR: unmarked }, { homeDirectory }),
    /development state marker/i
  );

  const developmentState = join(root, 'development-state');
  const copy = await prepareDevelopmentStateCopy({ sourceDirectory: liveState, targetDirectory: developmentState });
  const env: NodeJS.ProcessEnv = { VAMPIRE_STATE_DIR: developmentState };
  const prepared = await prepareDevelopmentEnvironment(env, { homeDirectory });

  assert.equal(prepared.stateDirectory, copy.stateDirectory);
  assert.match(prepared.tmuxSocketName, /^vampire-dev-[a-f0-9]{16}$/);
  assert.equal(env.VAMPIRE_TMUX_SOCKET_NAME, prepared.tmuxSocketName);
  assert.equal(env.VAMPIRE_SAFE_DEVELOPMENT, '1');
});

test('development startup resolves symlinks before comparing with the production state path', async (t) => {
  const root = await temporaryRoot(t);
  const homeDirectory = join(root, 'home');
  const liveState = join(homeDirectory, '.vampire');
  const alias = join(root, 'live-alias');
  await mkdir(liveState, { recursive: true });
  await symlink(liveState, alias);

  await assert.rejects(
    prepareDevelopmentEnvironment({ VAMPIRE_STATE_DIR: alias }, { homeDirectory }),
    /production state directory|symbolic link/i
  );
});

test('development startup rejects a malformed copy manifest', async (t) => {
  const root = await temporaryRoot(t);
  const source = await createSourceState(root);
  const developmentState = join(root, 'development-state');
  await prepareDevelopmentStateCopy({ sourceDirectory: source, targetDirectory: developmentState });
  const markerPath = join(developmentState, DEVELOPMENT_STATE_MARKER_FILE);
  const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
    files: Array<{ path: string; bytes: number; sha256: string }>;
  };
  marker.files[0]!.path = '../sessions.json';
  await writeFile(markerPath, `${JSON.stringify(marker)}\n`);

  await assert.rejects(
    prepareDevelopmentEnvironment({ VAMPIRE_STATE_DIR: developmentState }, { homeDirectory: join(root, 'home') }),
    /development state marker is invalid/i
  );
});
