import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { ensureStatusWidgetAgentSupport } from './status-widget-agent-support.server.ts';

const run = promisify(execFile);

test('materializes the current widget store, guide, and executable validator', async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'vampire-widget-agent-'));
  const previousStateDirectory = process.env.VAMPIRE_STATE_DIR;
  process.env.VAMPIRE_STATE_DIR = stateDirectory;
  t.after(async () => {
    if (previousStateDirectory === undefined) delete process.env.VAMPIRE_STATE_DIR;
    else process.env.VAMPIRE_STATE_DIR = previousStateDirectory;
    await rm(stateDirectory, { recursive: true, force: true });
  });

  const support = await ensureStatusWidgetAgentSupport();
  assert.equal(support.configurationPath, join(stateDirectory, 'status-plugins.json'));
  assert.equal(support.guidePath, join(stateDirectory, 'agent-guides', 'status-widget.md'));
  assert.equal(support.validatorPath, join(stateDirectory, 'agent-guides', 'validate-status-widgets.mjs'));
  assert.match(await readFile(support.guidePath, 'utf8'), /type StatusWidgetStore/);
  assert.match(await readFile(support.guidePath, 'utf8'), /detected automatically/);
  assert.deepEqual(
    ((await readFile(support.configurationPath, 'utf8')).match(/"name": "(?:CPU|RAM)"/g) ?? []).length,
    2
  );

  const valid = await run(process.execPath, [support.validatorPath, support.configurationPath]);
  assert.match(valid.stdout, /Valid Vampire status widget configuration \(2 widgets\)/);

  await writeFile(support.guidePath, 'stale guide\n');
  await ensureStatusWidgetAgentSupport();
  assert.match(await readFile(support.guidePath, 'utf8'), /type StatusWidgetStore/);
});

test('the generated validator rejects malformed widget configuration', async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'vampire-widget-validator-'));
  const previousStateDirectory = process.env.VAMPIRE_STATE_DIR;
  process.env.VAMPIRE_STATE_DIR = stateDirectory;
  t.after(async () => {
    if (previousStateDirectory === undefined) delete process.env.VAMPIRE_STATE_DIR;
    else process.env.VAMPIRE_STATE_DIR = previousStateDirectory;
    await rm(stateDirectory, { recursive: true, force: true });
  });

  const support = await ensureStatusWidgetAgentSupport();
  await writeFile(
    support.configurationPath,
    JSON.stringify({
      version: 1,
      plugins: [
        {
          id: 'broken',
          name: 'Broken',
          enabled: true,
          intervalMs: 1,
          source: { type: 'command', command: 'printf ready' },
        },
      ],
    })
  );
  await assert.rejects(run(process.execPath, [support.validatorPath, support.configurationPath]), /supported range/);
});
