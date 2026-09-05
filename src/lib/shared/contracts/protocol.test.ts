import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeTerminalClientMessage,
  decodeTerminalServerMessage,
  encodeTerminalClientMessage,
  encodeTerminalServerMessage,
} from '~/lib/shared/contracts/terminal-protocol.ts';
import type { ManagedWorkspace } from '~/lib/shared/contracts/workspace.ts';
import {
  decodeWorkspaceServerMessage,
  encodeWorkspaceServerMessage,
  type WorkspaceServerMessage,
} from '~/lib/shared/contracts/workspace-protocol.ts';

function managedWorkspace(overrides: Record<string, unknown> = {}): ManagedWorkspace {
  return {
    id: 'workspace-1',
    tmuxSession: 'vampire-workspace-1',
    cwd: '/tmp/workspace',
    createdAt: 1,
    lastActiveAt: 2,
    notePreview: '',
    composerPromptPreview: null,
    favoriteCommands: ['pnpm dev'],
    startupProfileId: 'codex',
    state: 'running',
    lastOutputAt: 3,
    attachedClients: 1,
    foregroundProcess: { kind: 'command', label: 'codex' },
    terminals: [
      {
        id: '@0',
        index: 0,
        name: 'codex',
        active: true,
        lastOutputAt: 3,
        foregroundProcess: { kind: 'command', label: 'codex' },
        command: null,
        startedAt: null,
        state: 'running',
        exitCode: null,
      },
    ],
    agentState: null,
    isGitRepository: true,
    ...overrides,
  } as ManagedWorkspace;
}

test('round-trips valid terminal client messages and rejects invalid sizes', () => {
  assert.deepEqual(decodeTerminalClientMessage(encodeTerminalClientMessage({ type: 'activate' })), {
    type: 'activate',
  });
  assert.deepEqual(decodeTerminalClientMessage(encodeTerminalClientMessage({ type: 'input', data: 'hello\n' })), {
    type: 'input',
    data: 'hello\n',
  });
  assert.deepEqual(
    decodeTerminalClientMessage(
      encodeTerminalClientMessage({
        type: 'submit',
        data: 'hello\nworld',
        bracketedPaste: true,
        requestId: 'submission-7',
      })
    ),
    { type: 'submit', data: 'hello\nworld', bracketedPaste: true, requestId: 'submission-7' }
  );
  assert.deepEqual(
    decodeTerminalClientMessage(encodeTerminalClientMessage({ type: 'submit', data: 'legacy', bracketedPaste: false })),
    { type: 'submit', data: 'legacy', bracketedPaste: false }
  );
  assert.deepEqual(
    decodeTerminalClientMessage(encodeTerminalClientMessage({ type: 'resize', columns: 120, rows: 40 })),
    { type: 'resize', columns: 120, rows: 40 }
  );
  assert.deepEqual(
    decodeTerminalClientMessage(encodeTerminalClientMessage({ type: 'resize', columns: 257, rows: 57 })),
    { type: 'resize', columns: 257, rows: 57 }
  );
  assert.deepEqual(decodeTerminalClientMessage(encodeTerminalClientMessage({ type: 'load-history', lines: 500 })), {
    type: 'load-history',
    lines: 500,
  });
  assert.deepEqual(
    decodeTerminalClientMessage(encodeTerminalClientMessage({ type: 'snapshot-ready', snapshotId: 7 })),
    { type: 'snapshot-ready', snapshotId: 7 }
  );
  assert.deepEqual(
    decodeTerminalClientMessage(
      encodeTerminalClientMessage({
        type: 'terminal-color',
        slot: 11,
        color: '#fbfafa',
      })
    ),
    { type: 'terminal-color', slot: 11, color: '#fbfafa' }
  );
  assert.equal(decodeTerminalClientMessage('{"type":"resize","columns":19,"rows":40}'), undefined);
  assert.equal(decodeTerminalClientMessage('{"type":"resize","columns":513,"rows":40}'), undefined);
  assert.equal(decodeTerminalClientMessage('{"type":"load-history","lines":0}'), undefined);
  assert.equal(decodeTerminalClientMessage('{"type":"load-history","lines":10001}'), undefined);
  assert.equal(decodeTerminalClientMessage('{"type":"input","data":12}'), undefined);
  assert.equal(decodeTerminalClientMessage('{"type":"submit","data":"hello"}'), undefined);
  assert.equal(decodeTerminalClientMessage('{"type":"submit","data":"hello","bracketedPaste":"yes"}'), undefined);
  assert.equal(
    decodeTerminalClientMessage('{"type":"submit","data":"hello","bracketedPaste":true,"requestId":""}'),
    undefined
  );
  assert.equal(
    decodeTerminalClientMessage('{"type":"submit","data":"hello","bracketedPaste":true,"requestId":"contains space"}'),
    undefined
  );
  assert.equal(decodeTerminalClientMessage('{"type":"snapshot-ready","snapshotId":0}'), undefined);
  assert.equal(decodeTerminalClientMessage('{"type":"terminal-color","slot":9,"color":"#fbfafa"}'), undefined);
  assert.equal(
    decodeTerminalClientMessage('{"type":"terminal-color","slot":11,"color":"red; kill-server"}'),
    undefined
  );
});

test('round-trips valid terminal server messages and rejects incomplete payloads', () => {
  assert.deepEqual(
    decodeTerminalServerMessage(
      encodeTerminalServerMessage({
        type: 'snapshot',
        data: 'screen',
        history: { loaded: 500, available: 1_200 },
        snapshotId: 9,
        throughSequence: 41,
      })
    ),
    {
      type: 'snapshot',
      data: 'screen',
      history: { loaded: 500, available: 1_200 },
      snapshotId: 9,
      throughSequence: 41,
    }
  );
  assert.deepEqual(decodeTerminalServerMessage(encodeTerminalServerMessage({ type: 'request-terminal-theme' })), {
    type: 'request-terminal-theme',
  });
  assert.deepEqual(
    decodeTerminalServerMessage(encodeTerminalServerMessage({ type: 'geometry', columns: 120, rows: 40 })),
    { type: 'geometry', columns: 120, rows: 40 }
  );
  assert.deepEqual(
    decodeTerminalServerMessage(
      encodeTerminalServerMessage({ type: 'geometry', columns: 48, rows: 20, active: false })
    ),
    { type: 'geometry', columns: 48, rows: 20, active: false }
  );
  assert.deepEqual(
    decodeTerminalServerMessage(
      encodeTerminalServerMessage({
        type: 'output',
        data: 'ready',
        activity: true,
        activityAt: 4_000,
        sequence: 42,
      })
    ),
    { type: 'output', data: 'ready', activity: true, activityAt: 4_000, sequence: 42 }
  );
  assert.deepEqual(
    decodeTerminalServerMessage(
      encodeTerminalServerMessage({
        type: 'output',
        data: 'screen',
        activity: false,
        activityAt: null,
        screenSync: true,
        reset: true,
        history: { loaded: 250, available: 900 },
        throughSequence: 46,
      })
    ),
    {
      type: 'output',
      data: 'screen',
      activity: false,
      activityAt: null,
      screenSync: true,
      reset: true,
      history: { loaded: 250, available: 900 },
      throughSequence: 46,
    }
  );
  assert.deepEqual(
    decodeTerminalServerMessage(
      encodeTerminalServerMessage({ type: 'repository-status', changeCount: 2, worktreeCount: 1 })
    ),
    { type: 'repository-status', changeCount: 2, worktreeCount: 1 }
  );
  assert.deepEqual(
    decodeTerminalServerMessage(
      encodeTerminalServerMessage({ type: 'repository-status', changeCount: 2, worktreeCount: 1, branch: 'fix-login' })
    ),
    { type: 'repository-status', changeCount: 2, worktreeCount: 1, branch: 'fix-login' }
  );
  assert.deepEqual(
    decodeTerminalServerMessage(
      encodeTerminalServerMessage({ type: 'submission-result', requestId: 'submission-7', status: 'completed' })
    ),
    { type: 'submission-result', requestId: 'submission-7', status: 'completed' }
  );
  assert.deepEqual(
    decodeTerminalServerMessage(
      encodeTerminalServerMessage({
        type: 'submission-result',
        requestId: 'submission-8',
        status: 'failed',
        message: 'tmux command failed',
      })
    ),
    {
      type: 'submission-result',
      requestId: 'submission-8',
      status: 'failed',
      message: 'tmux command failed',
    }
  );
  assert.equal(decodeTerminalServerMessage('{"type":"snapshot"}'), undefined);
  assert.equal(decodeTerminalServerMessage('{"type":"snapshot","data":"screen","snapshotId":0}'), undefined);
  assert.equal(
    decodeTerminalServerMessage('{"type":"snapshot","data":"screen","history":{"loaded":6,"available":5}}'),
    undefined
  );
  assert.equal(decodeTerminalServerMessage('{"type":"geometry","columns":0,"rows":40}'), undefined);
  assert.equal(decodeTerminalServerMessage('{"type":"geometry","columns":120,"rows":40,"active":"yes"}'), undefined);
  assert.equal(
    decodeTerminalServerMessage('{"type":"output","data":"ready","activity":true,"activityAt":null}'),
    undefined
  );
  assert.equal(
    decodeTerminalServerMessage('{"type":"output","data":"screen","activity":false,"activityAt":null,"reset":true}'),
    undefined
  );
  assert.equal(
    decodeTerminalServerMessage('{"type":"output","data":"screen","activity":false,"activityAt":null,"sequence":0}'),
    undefined
  );
  assert.equal(
    decodeTerminalServerMessage(
      '{"type":"output","data":"screen","activity":false,"activityAt":null,"throughSequence":4}'
    ),
    undefined
  );
  assert.equal(
    decodeTerminalServerMessage('{"type":"repository-status","changeCount":-1,"worktreeCount":1}'),
    undefined
  );
  assert.equal(
    decodeTerminalServerMessage('{"type":"repository-status","changeCount":0,"worktreeCount":1,"branch":42}'),
    undefined
  );
  assert.equal(
    decodeTerminalServerMessage('{"type":"submission-result","requestId":"submission-7","status":"failed"}'),
    undefined
  );
  assert.equal(
    decodeTerminalServerMessage('{"type":"submission-result","requestId":"bad id","status":"completed"}'),
    undefined
  );
});

test('validates complete workspace messages before applying them to client state', () => {
  const snapshot: WorkspaceServerMessage = {
    type: 'workspaces-snapshot',
    launchProfiles: [{ id: 'codex', name: 'Codex', command: 'codex' }],
    preferences: {
      workspaceOrderMode: 'manual',
      manualWorkspaceOrder: ['workspace-1'],
    },
    workspaces: [
      managedWorkspace({
        workspaceKind: 'worktree',
        repositoryPath: '/tmp/project',
        workspaceLabel: 'Fix login',
        worktreeBranch: 'vampire/fix-login-01234567',
        composerTemplate: 'Read AGENTS.md.\n\n{{ prompts }}',
        composerPromptPreview: { text: 'Review the current changes', submittedAt: 4 },
      }),
    ],
  };
  assert.deepEqual(decodeWorkspaceServerMessage(encodeWorkspaceServerMessage(snapshot)), snapshot);
  assert.deepEqual(
    decodeWorkspaceServerMessage(
      encodeWorkspaceServerMessage({
        type: 'launch-profiles-updated',
        launchProfiles: [{ id: 'codex', name: 'Codex CLI', command: 'codex' }],
      })
    ),
    {
      type: 'launch-profiles-updated',
      launchProfiles: [{ id: 'codex', name: 'Codex CLI', command: 'codex' }],
    }
  );
  assert.deepEqual(
    decodeWorkspaceServerMessage(
      encodeWorkspaceServerMessage({
        type: 'workspace-preferences-updated',
        preferences: { workspaceOrderMode: 'activity', manualWorkspaceOrder: ['workspace-1'] },
      })
    ),
    {
      type: 'workspace-preferences-updated',
      preferences: { workspaceOrderMode: 'activity', manualWorkspaceOrder: ['workspace-1'] },
    }
  );
  assert.deepEqual(
    decodeWorkspaceServerMessage(
      encodeWorkspaceServerMessage({
        type: 'workspace-updated',
        id: 'workspace-1',
        changes: { state: 'missing', lastOutputAt: null, foregroundProcess: null, agentState: null },
      })
    ),
    {
      type: 'workspace-updated',
      id: 'workspace-1',
      changes: { state: 'missing', lastOutputAt: null, foregroundProcess: null, agentState: null },
    }
  );
  assert.deepEqual(
    decodeWorkspaceServerMessage(
      encodeWorkspaceServerMessage({
        type: 'workspace-updated',
        id: 'workspace-1',
        changes: { composerTemplate: '{{ prompts }}\n\nVerify the result.' },
      })
    ),
    {
      type: 'workspace-updated',
      id: 'workspace-1',
      changes: { composerTemplate: '{{ prompts }}\n\nVerify the result.' },
    }
  );
  assert.equal(
    decodeWorkspaceServerMessage(
      JSON.stringify({
        type: 'workspaces-snapshot',
        workspaces: [managedWorkspace({ composerPromptPreview: { text: 42, submittedAt: 4 } })],
      })
    ),
    undefined
  );
  assert.equal(
    decodeWorkspaceServerMessage(
      JSON.stringify({
        type: 'workspaces-snapshot',
        workspaces: [managedWorkspace({ attachedClients: '1' })],
      })
    ),
    undefined
  );
  assert.equal(
    decodeWorkspaceServerMessage(
      JSON.stringify({
        type: 'workspaces-snapshot',
        workspaces: [managedWorkspace({ isGitRepository: 'true' })],
      })
    ),
    undefined
  );
  assert.equal(
    decodeWorkspaceServerMessage(
      JSON.stringify({
        type: 'workspaces-snapshot',
        workspaces: [managedWorkspace({ workspaceLabel: 42 })],
      })
    ),
    undefined
  );
  assert.equal(
    decodeWorkspaceServerMessage(
      JSON.stringify({
        type: 'workspaces-snapshot',
        workspaces: [managedWorkspace({ workspaceKind: 'clone' })],
      })
    ),
    undefined
  );
  assert.equal(
    decodeWorkspaceServerMessage(
      JSON.stringify({
        type: 'workspaces-snapshot',
        workspaces: [managedWorkspace({ workspaceAvailable: 'yes' })],
      })
    ),
    undefined
  );
  assert.equal(
    decodeWorkspaceServerMessage(
      JSON.stringify({
        type: 'workspaces-snapshot',
        workspaces: [
          managedWorkspace({
            note: 'private note',
            noteFile: true,
            automations: [{ prompt: 'private prompt' }],
          }),
        ],
      })
    ),
    undefined
  );
  assert.equal(
    decodeWorkspaceServerMessage(
      JSON.stringify({
        type: 'workspaces-snapshot',
        workspaces: [managedWorkspace()],
        preferences: { workspaceOrderMode: 'manual', manualWorkspaceOrder: [42] },
      })
    ),
    undefined
  );
  assert.equal(
    decodeWorkspaceServerMessage(
      JSON.stringify({
        type: 'workspace-preferences-updated',
        preferences: { workspaceOrderMode: 'smart', manualWorkspaceOrder: [] },
      })
    ),
    undefined
  );
  assert.equal(
    decodeWorkspaceServerMessage(
      JSON.stringify({
        type: 'workspaces-snapshot',
        workspaces: [managedWorkspace({ favoriteCommands: ['pnpm dev', 42] })],
      })
    ),
    undefined
  );
  assert.equal(
    decodeWorkspaceServerMessage(
      JSON.stringify({
        type: 'workspaces-snapshot',
        workspaces: [
          managedWorkspace({
            terminals: [
              {
                id: '0',
                index: 0,
                name: 'shell',
                active: true,
                lastOutputAt: 3,
                foregroundProcess: null,
                command: null,
                startedAt: null,
                state: 'running',
                exitCode: null,
              },
            ],
          }),
        ],
      })
    ),
    undefined
  );
  assert.equal(
    decodeWorkspaceServerMessage(
      JSON.stringify({
        type: 'workspace-updated',
        id: 'workspace-1',
        changes: { unknownField: true },
      })
    ),
    undefined
  );
  assert.equal(
    decodeWorkspaceServerMessage(
      JSON.stringify({
        type: 'workspace-updated',
        id: 'workspace-1',
        changes: { agentState: 'done' },
      })
    ),
    undefined
  );
});

test('round-trips status plugin snapshots without exposing command configuration', () => {
  const snapshot: WorkspaceServerMessage = {
    type: 'status-plugins-snapshot',
    plugins: [
      {
        id: 'codex-usage',
        name: 'Codex',
        state: 'ready',
        text: '18%',
        tooltip: 'Current usage',
        menu: [
          { type: 'heading', text: 'Codex', badge: 'Overall' },
          { type: 'item', text: '5h', value: '18% used', time: { label: 'Resets', at: 1_787_225_200_000 } },
          { type: 'separator' },
        ],
        progress: 18,
        tone: 'success',
        updatedAt: 1_787_220_000_000,
      },
    ],
  };
  assert.deepEqual(decodeWorkspaceServerMessage(encodeWorkspaceServerMessage(snapshot)), snapshot);
  assert.equal(
    decodeWorkspaceServerMessage(
      JSON.stringify({
        type: 'status-plugins-snapshot',
        plugins: [{ ...snapshot.plugins[0], progress: 101 }],
      })
    ),
    undefined
  );
  assert.equal(
    decodeWorkspaceServerMessage(
      JSON.stringify({
        type: 'status-plugins-snapshot',
        plugins: [{ ...snapshot.plugins[0], menu: [{ type: 'item', text: 'Docs', href: 'javascript:alert(1)' }] }],
      })
    ),
    undefined
  );
  assert.equal(
    decodeWorkspaceServerMessage(
      JSON.stringify({
        type: 'status-plugins-snapshot',
        plugins: [{ ...snapshot.plugins[0], command: 'cat ~/.ssh/id_rsa' }],
      })
    ),
    undefined
  );
});

test('keeps activity from compatibility terminal updates without erasing richer terminal metadata', () => {
  assert.deepEqual(
    decodeWorkspaceServerMessage(
      JSON.stringify({
        type: 'workspace-updated',
        id: 'workspace-1',
        changes: {
          lastOutputAt: 4,
          terminals: [
            {
              id: '@0',
              index: 0,
              name: 'codex',
              active: true,
              lastOutputAt: 4,
              foregroundProcess: { kind: 'command', label: 'codex' },
            },
          ],
        },
      })
    ),
    {
      type: 'workspace-updated',
      id: 'workspace-1',
      changes: { lastOutputAt: 4 },
    }
  );
});
