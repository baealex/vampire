import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { promisify } from 'node:util';

import { closeTerminalControlHubs, retainTerminalControlHub } from './terminal-control-hub.server.ts';

const execFile = promisify(execFileCallback);

function hexadecimalInput(data: string): string {
  return Array.from(Buffer.from(data), (byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for terminal hub output.');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test('shares one ordered tmux reader across pane subscribers', async () => {
  const session = `vampire-hub-test-${randomUUID()}`;
  await execFile('tmux', ['new-session', '-d', '-s', session, '-x', '80', '-y', '24', '/bin/sh']);
  try {
    const { stdout } = await execFile('tmux', [
      'display-message',
      '-p',
      '-t',
      session,
      '#{window_id}\t#{pane_id}\t#{pane_width}\t#{pane_height}',
    ]);
    const [windowId, paneId, rawColumns, rawRows] = stdout.trim().split('\t');
    const geometry = { columns: Number(rawColumns), rows: Number(rawRows) };
    const firstLease = retainTerminalControlHub(session, windowId, paneId, geometry);
    const secondLease = retainTerminalControlHub(session, windowId, paneId, geometry);
    assert.equal(firstLease.hub, secondLease.hub);
    await firstLease.hub.ready;

    let firstOutput = '';
    let secondOutput = '';
    const failedSubscriberUnavailable: Error[] = [];
    const firstUnavailable: Error[] = [];
    const secondUnavailable: Error[] = [];
    const unsubscribeFirst = firstLease.hub.subscribe({
      onOutput: ({ data }) => {
        firstOutput += data;
      },
      onUnavailable: (error) => firstUnavailable.push(error),
    });
    const unsubscribeSecond = secondLease.hub.subscribe({
      onOutput: ({ data }) => {
        secondOutput += data;
      },
      onUnavailable: (error) => secondUnavailable.push(error),
    });
    firstLease.hub.subscribe({
      onOutput: () => {
        throw new Error('subscriber write failed');
      },
      onUnavailable: (error) => failedSubscriberUnavailable.push(error),
    });

    await firstLease.hub.runCommand(`send-keys -H -t ${paneId} ${hexadecimalInput("printf 'VAMP_HUB_ONE\\n'\r")}`);
    await waitFor(() => firstOutput.includes('VAMP_HUB_ONE') && secondOutput.includes('VAMP_HUB_ONE'));
    assert.equal(firstOutput, secondOutput);
    assert.deepEqual(firstUnavailable, []);
    assert.deepEqual(secondUnavailable, []);
    assert.equal(failedSubscriberUnavailable.length, 1);
    assert.match(failedSubscriberUnavailable[0]?.message ?? '', /subscriber write failed/);

    unsubscribeFirst();
    const firstBoundary = firstOutput;
    await secondLease.hub.runCommand(`send-keys -H -t ${paneId} ${hexadecimalInput("printf 'VAMP_HUB_TWO\\n'\r")}`);
    await waitFor(() => secondOutput.includes('VAMP_HUB_TWO'));
    assert.equal(firstOutput, firstBoundary);

    const desktop = {};
    const phone = {};
    assert.equal(firstLease.hub.claimSize(desktop), true);
    assert.equal(firstLease.hub.claimSize(phone), false);
    assert.equal(firstLease.hub.releaseSize(desktop), false);
    assert.equal(firstLease.hub.ownsSize(phone), true);
    assert.equal(firstLease.hub.releaseSize(phone), true);

    unsubscribeSecond();
    firstLease.hub.dispose();
    await assert.rejects(
      () => firstLease.hub.runOperation(async () => 'should not run'),
      /tmux control client is unavailable/
    );
    firstLease.release();
    secondLease.release();
  } finally {
    closeTerminalControlHubs();
    await execFile('tmux', ['kill-session', '-t', session]).catch(() => undefined);
  }
});
