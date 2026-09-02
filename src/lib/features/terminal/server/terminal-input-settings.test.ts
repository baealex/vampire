import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  managedTerminalInputSettingsPath,
  readManagedTerminalInputSettings,
  TerminalInputSettingsError,
  updateManagedTerminalInputSettings,
} from './terminal-input-settings.server.ts';

test('stores terminal input behavior once for the server', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-terminal-input-settings-'));
  const previousStateDirectory = process.env.VAMPIRE_STATE_DIR;
  t.after(async () => {
    if (previousStateDirectory === undefined) delete process.env.VAMPIRE_STATE_DIR;
    else process.env.VAMPIRE_STATE_DIR = previousStateDirectory;
    await rm(directory, { recursive: true, force: true });
  });
  process.env.VAMPIRE_STATE_DIR = directory;

  assert.deepEqual(await readManagedTerminalInputSettings(), {
    mode: 'terminal',
    slashHandoff: true,
  });

  const settings = {
    mode: 'compose' as const,
    slashHandoff: false,
  };
  assert.deepEqual(await updateManagedTerminalInputSettings(settings), settings);
  assert.deepEqual(await readManagedTerminalInputSettings(), settings);
  assert.equal(managedTerminalInputSettingsPath(), join(directory, 'global', 'terminal-input.json'));
  assert.equal(
    (JSON.parse(await readFile(managedTerminalInputSettingsPath(), 'utf8')) as { version: number }).version,
    2
  );
});

test('rejects malformed terminal input settings', async () => {
  await assert.rejects(
    updateManagedTerminalInputSettings({ mode: 'compose', slashHandoff: null }),
    TerminalInputSettingsError
  );
});

test('reads version-one input mode settings without retaining global Composer affixes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-terminal-input-settings-v1-'));
  const previousStateDirectory = process.env.VAMPIRE_STATE_DIR;
  t.after(async () => {
    if (previousStateDirectory === undefined) delete process.env.VAMPIRE_STATE_DIR;
    else process.env.VAMPIRE_STATE_DIR = previousStateDirectory;
    await rm(directory, { recursive: true, force: true });
  });
  process.env.VAMPIRE_STATE_DIR = directory;
  await updateManagedTerminalInputSettings({ mode: 'terminal', slashHandoff: true });
  await writeFile(
    managedTerminalInputSettingsPath(),
    JSON.stringify({
      version: 1,
      mode: 'compose',
      slashHandoff: false,
      composePrefix: 'legacy prefix',
      composePostfix: 'legacy postfix',
    })
  );

  assert.deepEqual(await readManagedTerminalInputSettings(), { mode: 'compose', slashHandoff: false });
});
