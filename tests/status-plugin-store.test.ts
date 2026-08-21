import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  readStatusPluginStore,
  STATUS_PLUGIN_STATE_VERSION,
  writeStatusPluginStore,
  type StatusPluginStore,
} from '../src/lib/features/status/server/status-plugin-store.ts';
import { STATUS_PLUGIN_CPU_COMMAND, STATUS_PLUGIN_MEMORY_COMMAND } from '../src/lib/shared/contracts/status-plugin.ts';

test('starts with CPU and RAM presets and persists an explicitly empty bar', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-status-plugin-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'status-plugins.json');

  assert.deepEqual(
    (await readStatusPluginStore(file)).plugins.map((plugin) => plugin.name),
    ['CPU', 'RAM']
  );
  await writeStatusPluginStore({ version: STATUS_PLUGIN_STATE_VERSION, plugins: [] }, file);
  assert.deepEqual((await readStatusPluginStore(file)).plugins, []);
});

test('round-trips ordered plugin configuration without sharing references', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-status-plugin-roundtrip-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'status-plugins.json');
  const state: StatusPluginStore = {
    version: STATUS_PLUGIN_STATE_VERSION,
    plugins: [
      {
        id: 'clock',
        name: 'Clock',
        enabled: false,
        intervalMs: 30_000,
        source: { type: 'command' as const, command: 'date' },
      },
    ],
  };

  await writeStatusPluginStore(state, file);
  const stored = await readStatusPluginStore(file);
  assert.deepEqual(stored, state);
  stored.plugins[0]!.name = 'Mutated';
  assert.equal((await readStatusPluginStore(file)).plugins[0]!.name, 'Clock');
});

test('converts compatibility native CPU and RAM entries into visible commands', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-status-plugin-compatibility-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'status-plugins.json');
  await writeFile(
    file,
    JSON.stringify({
      version: STATUS_PLUGIN_STATE_VERSION,
      plugins: [
        { id: 'cpu', name: 'CPU', enabled: true, intervalMs: 2_000, source: { type: 'system', metric: 'cpu' } },
        { id: 'ram', name: 'RAM', enabled: true, intervalMs: 2_000, source: { type: 'system', metric: 'memory' } },
      ],
    })
  );

  const stored = await readStatusPluginStore(file);
  assert.deepEqual(
    stored.plugins.map((plugin) => plugin.source.command),
    [STATUS_PLUGIN_CPU_COMMAND, STATUS_PLUGIN_MEMORY_COMMAND]
  );
});

test('refuses malformed status plugin state instead of overwriting it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-status-plugin-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'status-plugins.json');
  await writeFile(
    file,
    JSON.stringify({
      version: STATUS_PLUGIN_STATE_VERSION,
      plugins: [
        { id: 'unsafe', name: 'Unsafe', enabled: true, intervalMs: 1, source: { type: 'command', command: 'date' } },
      ],
    })
  );

  await assert.rejects(readStatusPluginStore(file), /status plugin configuration is unreadable/i);
});
