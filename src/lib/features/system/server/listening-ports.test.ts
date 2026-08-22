import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createListeningPorts,
  ListeningPortError,
  parseLsofListeningSockets,
  parseSsListeningSockets,
  terminateListeningProcess,
} from '~/lib/features/system/server/listening-ports.ts';

test('parses and deduplicates lsof TCP listeners', () => {
  const output = [
    'p120\0cnode\0',
    'f18\0PTCP\0n127.0.0.1:5173\0',
    'f19\0PTCP\0n127.0.0.1:5173\0',
    'p240\0cpostgres\0',
    'f7\0PTCP\0n[::1]:5432\0',
    '',
  ].join('\n');

  assert.deepEqual(parseLsofListeningSockets(output), [
    { address: '127.0.0.1', port: 5173, pid: 120, processName: 'node' },
    { address: '::1', port: 5432, pid: 240, processName: 'postgres' },
  ]);
});

test('parses ss listeners even when process details are unavailable', () => {
  const output = [
    'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=321,fd=20))',
    'LISTEN 0 4096 *:8080 *:*',
    'LISTEN 0 128 [::1]:4321 [::]:* users:(("python3",pid=654,fd=4))',
  ].join('\n');

  assert.deepEqual(parseSsListeningSockets(output), [
    { address: '127.0.0.1', port: 3000, pid: 321, processName: 'node' },
    { address: '*', port: 8080, pid: null, processName: null },
    { address: '::1', port: 4321, pid: 654, processName: 'python3' },
  ]);
});

test('groups addresses and describes whether each process can be terminated', () => {
  const ports = createListeningPorts(
    [
      { address: '127.0.0.1', port: 5173, pid: 120, processName: 'node' },
      { address: '::1', port: 5173, pid: 120, processName: 'node' },
      { address: '*', port: 7677, pid: 999, processName: 'node' },
      { address: '*', port: 8080, pid: null, processName: null },
      { address: '*', port: 9000, pid: 444, processName: 'service' },
    ],
    {
      currentPid: 999,
      workingDirectories: new Map([
        [120, '/code/site'],
        [999, '/code/vampire'],
      ]),
      processAccess: (pid) => (pid === 444 ? 'permission-denied' : 'available'),
    }
  );

  assert.deepEqual(ports, [
    {
      protocol: 'tcp',
      port: 5173,
      addresses: ['127.0.0.1', '::1'],
      pid: 120,
      processName: 'node',
      cwd: '/code/site',
      termination: 'available',
    },
    {
      protocol: 'tcp',
      port: 7677,
      addresses: ['*'],
      pid: 999,
      processName: 'node',
      cwd: '/code/vampire',
      termination: 'protected',
    },
    {
      protocol: 'tcp',
      port: 8080,
      addresses: ['*'],
      pid: null,
      processName: null,
      cwd: null,
      termination: 'unavailable',
    },
    {
      protocol: 'tcp',
      port: 9000,
      addresses: ['*'],
      pid: 444,
      processName: 'service',
      cwd: null,
      termination: 'permission-denied',
    },
  ]);
});

test('rechecks listener identity before sending SIGTERM', async () => {
  const signaled: Array<[number, NodeJS.Signals]> = [];
  await terminateListeningProcess(
    {
      pid: 120,
      port: 5173,
      processName: 'node',
      cwd: '/code/site',
    },
    {
      currentPid: 999,
      list: async () => [
        {
          protocol: 'tcp',
          port: 5173,
          addresses: ['127.0.0.1'],
          pid: 120,
          processName: 'node',
          cwd: '/code/site',
          termination: 'available',
        },
      ],
      signal: (pid, signal) => {
        signaled.push([pid, signal]);
      },
    }
  );

  assert.deepEqual(signaled, [[120, 'SIGTERM']]);
});

test('refuses stale or protected listener termination requests', async () => {
  await assert.rejects(
    terminateListeningProcess(
      {
        pid: 120,
        port: 5173,
        processName: 'node',
        cwd: '/old/project',
      },
      {
        currentPid: 999,
        list: async () => [
          {
            protocol: 'tcp',
            port: 5173,
            addresses: ['127.0.0.1'],
            pid: 120,
            processName: 'node',
            cwd: '/new/project',
            termination: 'available',
          },
        ],
      }
    ),
    (error: unknown) => error instanceof ListeningPortError && error.reason === 'stale'
  );

  await assert.rejects(
    terminateListeningProcess(
      {
        pid: 999,
        port: 7677,
        processName: 'node',
        cwd: '/code/vampire',
      },
      { currentPid: 999, list: async () => [] }
    ),
    (error: unknown) => error instanceof ListeningPortError && error.reason === 'protected'
  );
});
