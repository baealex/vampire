import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CURRENT_STATE_LAYOUT_VERSION,
  STATE_LAYOUT_FILE,
  STATE_MIGRATION_LOCK_FILE,
  runStateMigrations,
} from './state-migrations.ts';
import { ORGANIZED_STATE_BACKUP_DIRECTORY } from './state-migrations/0001-organize-state-directory.ts';

async function temporaryState(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vampire-state-migrations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, 'state');
  await mkdir(join(stateDirectory, 'composer-history', 'workspaces'), { recursive: true });
  return stateDirectory;
}

async function createLegacyFixture(stateDirectory: string): Promise<string> {
  const sessions = `${JSON.stringify(
    {
      version: 1,
      workspacePreferences: { workspaceOrderMode: 'manual', manualWorkspaceOrder: ['workspace'] },
      launchProfiles: [{ id: 'development', name: 'Development', command: 'pnpm dev' }],
      defaultStartupProfileId: 'development',
      workspaces: [
        {
          id: 'workspace',
          tmuxSession: 'vampire-workspace',
          cwd: '/projects/workspace',
          workspaceLabel: 'Workspace',
          createdAt: 1,
          lastActiveAt: 2,
          automations: [],
          favoriteCommands: ['pnpm dev'],
          startupProfileId: 'development',
        },
      ],
    },
    null,
    2
  )}\n`;
  await mkdir(join(stateDirectory, 'composer-history', 'workspaces'), { recursive: true });
  await mkdir(join(stateDirectory, 'agent-guides'), { recursive: true });
  await mkdir(join(stateDirectory, 'automation-requests'), { recursive: true });
  await writeFile(join(stateDirectory, 'sessions.json'), sessions);
  await writeFile(join(stateDirectory, 'workspace.note.md'), '# Existing note without trailing newline');
  await writeFile(
    join(stateDirectory, 'composer-history', 'settings.json'),
    '{"version":1,"enabled":true,"limit":20}\n'
  );
  await writeFile(
    join(stateDirectory, 'composer-history', 'workspaces', 'workspace.json'),
    '{"version":1,"prompts":[{"id":"prompt-1","text":"Run tests","submittedAt":3}]}\n'
  );
  await writeFile(join(stateDirectory, 'status-plugins.json'), '{"version":1,"plugins":[]}\n');
  await writeFile(
    join(stateDirectory, 'terminal-input-settings.json'),
    '{"version":2,"mode":"compose","slashHandoff":true}\n'
  );
  await writeFile(join(stateDirectory, 'agent-guides', 'guide.md'), 'legacy guide\n');
  await writeFile(join(stateDirectory, 'automation-requests', 'request.draft.json'), '{"draft":true}\n');
  return sessions;
}

test('moves v0.20 state into the ownership layout, keeps a verified backup, and remains idempotent', async (t) => {
  const stateDirectory = await temporaryState(t);
  const sessions = await createLegacyFixture(stateDirectory);

  const first = await runStateMigrations({ stateDirectory, now: () => 1_000 });

  assert.deepEqual(first.applied, ['0001-organize-state-directory']);
  assert.equal(first.layoutVersion, CURRENT_STATE_LAYOUT_VERSION);
  await assert.rejects(readFile(join(stateDirectory, 'sessions.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(stateDirectory, 'workspace.note.md')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(stateDirectory, 'composer-history', 'settings.json')), { code: 'ENOENT' });
  assert.equal(
    await readFile(join(stateDirectory, 'workspaces', 'workspace', 'note.md'), 'utf8'),
    '# Existing note without trailing newline'
  );
  assert.match(
    await readFile(join(stateDirectory, 'workspaces', 'workspace', 'composer-history.json'), 'utf8'),
    /Run tests/
  );
  assert.deepEqual(
    (
      JSON.parse(await readFile(join(stateDirectory, 'workspaces', 'workspace', 'background.json'), 'utf8')) as {
        favoriteCommands: string[];
      }
    ).favoriteCommands,
    ['pnpm dev']
  );
  const registry = JSON.parse(await readFile(join(stateDirectory, 'registry.json'), 'utf8')) as {
    workspaces: Array<Record<string, unknown>>;
  };
  assert.equal('automations' in registry.workspaces[0]!, false);
  assert.equal('favoriteCommands' in registry.workspaces[0]!, false);
  assert.equal('startupProfileId' in registry.workspaces[0]!, false);
  assert.equal(
    await readFile(
      join(stateDirectory, ...ORGANIZED_STATE_BACKUP_DIRECTORY.split('/'), 'legacy', 'sessions.json'),
      'utf8'
    ),
    sessions
  );
  assert.equal(await readFile(join(stateDirectory, 'agent-support', 'guides', 'guide.md'), 'utf8'), 'legacy guide\n');
  assert.equal(
    await readFile(join(stateDirectory, 'agent-support', 'requests', 'automations', 'request.draft.json'), 'utf8'),
    '{"draft":true}\n'
  );
  const layoutPath = join(stateDirectory, STATE_LAYOUT_FILE);
  const firstLayout = await readFile(layoutPath, 'utf8');
  const layout = JSON.parse(firstLayout) as {
    formatVersion: number;
    layoutVersion: number;
    appliedMigrations: Array<{ name: string; checksum: string; appliedAt: string }>;
  };
  assert.equal(layout.formatVersion, 1);
  assert.equal(layout.layoutVersion, CURRENT_STATE_LAYOUT_VERSION);
  assert.deepEqual(
    layout.appliedMigrations.map((migration) => migration.name),
    ['0001-organize-state-directory']
  );
  assert.ok(layout.appliedMigrations.every((migration) => /^[a-f0-9]{64}$/.test(migration.checksum)));
  assert.equal(layout.appliedMigrations[0]!.appliedAt, new Date(1_000).toISOString());

  const second = await runStateMigrations({ stateDirectory, now: () => 2_000 });
  assert.deepEqual(second.applied, []);
  assert.equal(await readFile(layoutPath, 'utf8'), firstLayout);
  assert.equal(
    (await readdir(stateDirectory)).some((name) => name.endsWith('.tmp') || name === STATE_MIGRATION_LOCK_FILE),
    false
  );
});

test('refuses unreadable existing state without creating migration history', async (t) => {
  const stateDirectory = await temporaryState(t);
  const malformed = '{not json';
  await writeFile(join(stateDirectory, 'sessions.json'), malformed);

  await assert.rejects(runStateMigrations({ stateDirectory }), /sessions\.json.*valid JSON/i);
  assert.equal(await readFile(join(stateDirectory, 'sessions.json'), 'utf8'), malformed);
  await assert.rejects(readFile(join(stateDirectory, STATE_LAYOUT_FILE)), { code: 'ENOENT' });
});

test('refuses a changed migration checksum instead of rewriting history', async (t) => {
  const stateDirectory = await temporaryState(t);
  await runStateMigrations({ stateDirectory, now: () => 1_000 });
  const layoutPath = join(stateDirectory, STATE_LAYOUT_FILE);
  const layout = JSON.parse(await readFile(layoutPath, 'utf8')) as {
    appliedMigrations: Array<{ checksum: string }>;
  };
  layout.appliedMigrations[0]!.checksum = '0'.repeat(64);
  const corrupted = `${JSON.stringify(layout, null, 2)}\n`;
  await writeFile(layoutPath, corrupted);

  await assert.rejects(runStateMigrations({ stateDirectory }), /checksum/i);
  assert.equal(await readFile(layoutPath, 'utf8'), corrupted);
});

test('validates state again when the migration history is already current', async (t) => {
  const stateDirectory = await temporaryState(t);
  await createLegacyFixture(stateDirectory);
  await runStateMigrations({ stateDirectory, now: () => 1_000 });
  const layoutPath = join(stateDirectory, STATE_LAYOUT_FILE);
  const layout = await readFile(layoutPath, 'utf8');
  await writeFile(join(stateDirectory, 'registry.json'), '{damaged');

  await assert.rejects(runStateMigrations({ stateDirectory, now: () => 2_000 }), /registry\.json.*unreadable/i);

  assert.equal(await readFile(layoutPath, 'utf8'), layout);
  await assert.rejects(readFile(join(stateDirectory, STATE_MIGRATION_LOCK_FILE)), { code: 'ENOENT' });
});

test('does not enter a state directory while another live migration owns its lock', async (t) => {
  const stateDirectory = await temporaryState(t);
  await writeFile(
    join(stateDirectory, STATE_MIGRATION_LOCK_FILE),
    `${JSON.stringify({
      version: 1,
      token: 'live-lock',
      pid: process.pid,
      hostname: hostname(),
      createdAt: new Date().toISOString(),
    })}\n`
  );

  await assert.rejects(runStateMigrations({ stateDirectory }), /locked.*live process/i);
  await assert.rejects(readFile(join(stateDirectory, STATE_LAYOUT_FILE)), { code: 'ENOENT' });
});

test('archives a lock owned by a dead local process and resumes safely', async (t) => {
  const stateDirectory = await temporaryState(t);
  await writeFile(
    join(stateDirectory, STATE_MIGRATION_LOCK_FILE),
    `${JSON.stringify({
      version: 1,
      token: 'dead-lock',
      pid: 2_147_483_647,
      hostname: hostname(),
      createdAt: new Date(1_000).toISOString(),
    })}\n`
  );

  const result = await runStateMigrations({ stateDirectory, now: () => 2_000 });

  assert.deepEqual(result.applied, ['0001-organize-state-directory']);
  assert.ok((await readdir(stateDirectory)).some((name) => name.startsWith(`${STATE_MIGRATION_LOCK_FILE}.stale-`)));
  await assert.rejects(readFile(join(stateDirectory, STATE_MIGRATION_LOCK_FILE)), { code: 'ENOENT' });
});

test('keeps legacy data and resumes from its backup after an interrupted target install', async (t) => {
  const stateDirectory = await temporaryState(t);
  const sessions = await createLegacyFixture(stateDirectory);
  await mkdir(join(stateDirectory, 'global'), { recursive: true });
  await writeFile(join(stateDirectory, 'global', 'status-widgets.json'), '{"conflict":true}\n');

  await assert.rejects(runStateMigrations({ stateDirectory, now: () => 1_000 }), /different data/i);
  assert.equal(await readFile(join(stateDirectory, 'sessions.json'), 'utf8'), sessions);
  await assert.rejects(readFile(join(stateDirectory, STATE_LAYOUT_FILE)), { code: 'ENOENT' });

  await rm(join(stateDirectory, 'global', 'status-widgets.json'));
  const resumed = await runStateMigrations({ stateDirectory, now: () => 2_000 });
  assert.deepEqual(resumed.applied, ['0001-organize-state-directory']);
  assert.equal(resumed.layoutVersion, CURRENT_STATE_LAYOUT_VERSION);
  await assert.rejects(readFile(join(stateDirectory, 'sessions.json')), { code: 'ENOENT' });
  assert.equal(
    await readFile(
      join(stateDirectory, ...ORGANIZED_STATE_BACKUP_DIRECTORY.split('/'), 'legacy', 'sessions.json'),
      'utf8'
    ),
    sessions
  );
});

test('refuses a damaged migration backup without touching the remaining legacy source', async (t) => {
  const stateDirectory = await temporaryState(t);
  const sessions = await createLegacyFixture(stateDirectory);
  await mkdir(join(stateDirectory, 'global'), { recursive: true });
  const conflict = join(stateDirectory, 'global', 'status-widgets.json');
  await writeFile(conflict, '{"conflict":true}\n');
  await assert.rejects(runStateMigrations({ stateDirectory }), /different data/i);
  await rm(conflict);
  await writeFile(
    join(stateDirectory, ...ORGANIZED_STATE_BACKUP_DIRECTORY.split('/'), 'legacy', 'sessions.json'),
    `[${sessions.slice(1)}`
  );

  await assert.rejects(runStateMigrations({ stateDirectory }), /backup checksum/i);
  assert.equal(await readFile(join(stateDirectory, 'sessions.json'), 'utf8'), sessions);
  await assert.rejects(readFile(join(stateDirectory, STATE_LAYOUT_FILE)), { code: 'ENOENT' });
});

test('absorbs inline compatibility notes and Composer history into workspace-owned files', async (t) => {
  const stateDirectory = await temporaryState(t);
  await writeFile(
    join(stateDirectory, 'sessions.json'),
    JSON.stringify({
      version: 1,
      workspaces: [
        {
          id: 'compatibility',
          tmuxSession: 'vampire-compatibility',
          cwd: '/projects/compatibility',
          createdAt: 1,
          note: 'Do not lose this note',
          composerPromptHistory: [{ id: 'prompt-1', text: 'Do not lose this prompt', submittedAt: 10 }],
        },
      ],
    })
  );

  await runStateMigrations({ stateDirectory, now: () => 1_000 });

  assert.equal(
    await readFile(join(stateDirectory, 'workspaces', 'compatibility', 'note.md'), 'utf8'),
    'Do not lose this note\n'
  );
  assert.match(
    await readFile(join(stateDirectory, 'workspaces', 'compatibility', 'composer-history.json'), 'utf8'),
    /Do not lose this prompt/
  );
  assert.match(
    await readFile(
      join(stateDirectory, ...ORGANIZED_STATE_BACKUP_DIRECTORY.split('/'), 'legacy', 'sessions.json'),
      'utf8'
    ),
    /Do not lose this note/
  );
});

test('retains notes and Composer history for workspaces no longer present in the registry', async (t) => {
  const stateDirectory = await temporaryState(t);
  await createLegacyFixture(stateDirectory);
  await writeFile(join(stateDirectory, 'removed-workspace.note.md'), '# Removed workspace note\n');
  await writeFile(
    join(stateDirectory, 'composer-history', 'workspaces', 'removed-workspace.json'),
    '{"version":1,"prompts":[{"id":"orphan-prompt","text":"Preserve me","submittedAt":4}]}\n'
  );

  await runStateMigrations({ stateDirectory, now: () => 1_000 });

  assert.equal(
    await readFile(join(stateDirectory, 'workspaces', 'removed-workspace', 'note.md'), 'utf8'),
    '# Removed workspace note\n'
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(join(stateDirectory, 'workspaces', 'removed-workspace', 'composer-history.json'), 'utf8')
    ),
    {
      version: 1,
      prompts: [{ id: 'orphan-prompt', text: 'Preserve me', submittedAt: 4 }],
    }
  );
  assert.equal(
    await readFile(
      join(stateDirectory, ...ORGANIZED_STATE_BACKUP_DIRECTORY.split('/'), 'legacy', 'removed-workspace.note.md'),
      'utf8'
    ),
    '# Removed workspace note\n'
  );
});
