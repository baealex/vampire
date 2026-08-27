import assert from 'node:assert/strict';
import test from 'node:test';
import { StatusPluginRuntime } from '~/lib/features/status/server/status-plugin-runtime.server.ts';
import type { StatusPluginCommandOptions } from '~/lib/features/status/server/status-plugin-command.server.ts';
import {
  STATUS_PLUGIN_STATE_VERSION,
  type StatusPluginStore,
} from '~/lib/features/status/server/status-plugin-store.server.ts';
import {
  STATUS_PLUGIN_CPU_COMMAND,
  STATUS_PLUGIN_MEMORY_COMMAND,
  type StatusPluginSnapshot,
} from '~/lib/shared/contracts/status-plugin.ts';

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for status plugin runtime.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('starts one execution, prevents overlap, and broadcasts output without command source', async () => {
  let executions = 0;
  let releaseFirst: (() => void) | undefined;
  const snapshots: StatusPluginSnapshot[][] = [];
  const runCommand = async (_command: string, options: StatusPluginCommandOptions = {}) => {
    executions += 1;
    if (executions === 1) {
      await new Promise<void>((resolve, reject) => {
        releaseFirst = resolve;
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    return { stdout: `${executions * 10}%\nWindow usage`, stderr: '' };
  };
  const runtime = new StatusPluginRuntime((update) => snapshots.push(update), {
    readStore: async () => ({
      version: STATUS_PLUGIN_STATE_VERSION,
      plugins: [
        {
          id: 'usage',
          name: 'Usage',
          enabled: true,
          intervalMs: 1_000,
          source: { type: 'command', command: 'usage-command' },
        },
      ],
    }),
    runCommand,
    configRefreshIntervalMs: 10_000,
  });

  await Promise.all([runtime.start(), runtime.start(), runtime.start()]);
  await waitFor(() => executions === 1);
  await Promise.all([runtime.refreshConfiguration(), runtime.refreshConfiguration()]);
  assert.equal(runtime.runNow('usage'), false);
  assert.equal(runtime.runNow('usage'), false);
  assert.equal(executions, 1);

  releaseFirst?.();
  await waitFor(() => runtime.snapshots()[0]?.state === 'ready');
  assert.deepEqual(runtime.snapshots()[0], {
    id: 'usage',
    name: 'Usage',
    state: 'ready',
    text: '10%',
    menu: [{ type: 'item', text: 'Window usage' }],
    updatedAt: runtime.snapshots()[0]!.updatedAt,
  });
  assert.equal('source' in runtime.snapshots()[0]!, false);
  assert.equal(runtime.runNow('usage'), true);
  await waitFor(() => runtime.snapshots()[0]?.text === '20%');
  assert.equal(executions, 2);
  assert.equal(snapshots.at(-1)?.[0]?.text, '20%');

  runtime.stop();
  const stoppedAt = executions;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(executions, stoppedAt);
});

test('runs CPU and RAM through the same ordered runtime contract', async () => {
  const runtime = new StatusPluginRuntime(() => undefined, {
    readStore: async () => ({
      version: STATUS_PLUGIN_STATE_VERSION,
      plugins: [
        {
          id: 'ram',
          name: 'Memory',
          enabled: true,
          intervalMs: 2_000,
          source: { type: 'command', command: STATUS_PLUGIN_MEMORY_COMMAND },
        },
        {
          id: 'cpu',
          name: 'Processor',
          enabled: true,
          intervalMs: 2_000,
          source: { type: 'command', command: STATUS_PLUGIN_CPU_COMMAND },
        },
      ],
    }),
    runCommand: async (command) => ({
      stdout:
        command === STATUS_PLUGIN_CPU_COMMAND
          ? JSON.stringify({ text: '≈12%', progress: 12 })
          : JSON.stringify({ text: '34%', progress: 34 }),
      stderr: '',
    }),
    configRefreshIntervalMs: 10_000,
  });

  await runtime.start();
  await waitFor(
    () => runtime.snapshots().length === 2 && runtime.snapshots().every((snapshot) => snapshot.state === 'ready')
  );
  assert.deepEqual(
    runtime.snapshots().map(({ id, name, text }) => ({ id, name, text })),
    [
      { id: 'ram', name: 'Memory', text: '34%' },
      { id: 'cpu', name: 'Processor', text: '≈12%' },
    ]
  );
  runtime.stop();
});

test('reloads configuration when the last client disconnects during a state read', async () => {
  let reads = 0;
  let releaseFirstRead: (() => void) | undefined;
  const state: StatusPluginStore = {
    version: STATUS_PLUGIN_STATE_VERSION,
    plugins: [
      {
        id: 'cpu',
        name: 'CPU',
        enabled: true,
        intervalMs: 2_000,
        source: { type: 'command', command: STATUS_PLUGIN_CPU_COMMAND },
      },
    ],
  };
  const runtime = new StatusPluginRuntime(() => undefined, {
    readStore: async () => {
      reads += 1;
      if (reads === 1)
        await new Promise<void>((resolve) => {
          releaseFirstRead = resolve;
        });
      return state;
    },
    runCommand: async () => ({ stdout: '≈9%', stderr: '' }),
    configRefreshIntervalMs: 10_000,
  });

  const firstStart = runtime.start();
  await waitFor(() => reads === 1);
  runtime.stop();
  await runtime.start();
  assert.equal(reads, 2);
  releaseFirstRead?.();
  await firstStart;
  await waitFor(() => runtime.snapshots()[0]?.text === '≈9%');
  runtime.stop();
});

test('runs every enabled plugin once when saved configuration changes', async () => {
  let plugins = [
    { id: 'one', name: 'One', enabled: true, intervalMs: 60_000, source: { type: 'command' as const, command: 'one' } },
    { id: 'two', name: 'Two', enabled: true, intervalMs: 60_000, source: { type: 'command' as const, command: 'two' } },
  ];
  const executions = new Map<string, number>();
  const runtime = new StatusPluginRuntime(() => undefined, {
    readStore: async () => ({ version: STATUS_PLUGIN_STATE_VERSION, plugins }),
    runCommand: async (command) => {
      executions.set(command, (executions.get(command) ?? 0) + 1);
      return { stdout: command, stderr: '' };
    },
    configRefreshIntervalMs: 10_000,
  });

  await runtime.start();
  await waitFor(() => [...executions.values()].reduce((sum, count) => sum + count, 0) === 2);
  plugins = [...plugins].reverse();
  await runtime.refreshConfiguration();
  await waitFor(() => [...executions.values()].reduce((sum, count) => sum + count, 0) === 4);
  assert.deepEqual(
    runtime.snapshots().map((snapshot) => snapshot.id),
    ['two', 'one']
  );
  assert.deepEqual(Object.fromEntries(executions), { one: 2, two: 2 });
  runtime.stop();
});

test('reuses a recent server result when every browser disconnects and reconnects', async () => {
  let executions = 0;
  const runtime = new StatusPluginRuntime(() => undefined, {
    readStore: async () => ({
      version: STATUS_PLUGIN_STATE_VERSION,
      plugins: [
        {
          id: 'remote-limit',
          name: 'Remote limit',
          enabled: true,
          intervalMs: 60_000,
          source: { type: 'command', command: 'remote-limit' },
        },
      ],
    }),
    runCommand: async () => {
      executions += 1;
      return { stdout: '12%', stderr: '' };
    },
    configRefreshIntervalMs: 10_000,
  });

  await runtime.start();
  await waitFor(() => runtime.snapshots()[0]?.state === 'ready');
  assert.equal(executions, 1);
  runtime.stop();

  await runtime.start();
  assert.deepEqual(
    runtime.snapshots().map((snapshot) => snapshot.text),
    ['12%']
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(executions, 1);
  runtime.stop();
});
