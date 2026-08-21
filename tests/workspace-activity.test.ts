import assert from 'node:assert/strict';
import test from 'node:test';
import * as view from '../src/lib/features/workspace/workspace-view.ts';
import type { ManagedWorkspace, WorkspaceTerminal } from '../src/lib/shared/contracts/workspace.ts';
import type { WorkspaceActivityState } from '../src/lib/features/workspace/workspace-view.ts';

function workspace(
  lastOutputAt: number | null,
  id = 'workspace-1',
  state: ManagedWorkspace['state'] = 'running'
): ManagedWorkspace {
  return {
    id,
    tmuxSession: `vampire-${id}`,
    cwd: '/tmp/workspace-1',
    createdAt: 1,
    lastActiveAt: 1,
    lastOutputAt,
    notePreview: '',
    favoriteCommands: [],
    startupProfileId: null,
    state,
    attachedClients: 0,
    foregroundProcess: null,
    terminals: [],
    agentState: null,
    isGitRepository: false,
  };
}

function activity(id: string, activeUntil: number, seenThroughAt: number) {
  return new Map([[id, { activeUntil, seenThroughAt }]]);
}

function terminal(
  id: string,
  index: number,
  name: string,
  lastOutputAt: number,
  foregroundProcess: WorkspaceTerminal['foregroundProcess']
): WorkspaceTerminal {
  return {
    id,
    index,
    name,
    active: false,
    lastOutputAt,
    foregroundProcess,
    command: null,
    startedAt: null,
    state: 'running',
    exitCode: null,
  };
}

test('does not infer active output from a recent timestamp alone', () => {
  const current = workspace(Date.now());
  assert.equal(view.workspaceActivityState(current), 'review');
});

test('derives active, review, and idle from output and observation timestamps', () => {
  const current = workspace(2_000);
  assert.equal(view.workspaceActivityState(current, activity(current.id, 3_000, 0), 2_500), 'active');
  assert.equal(view.workspaceActivityState(current, activity(current.id, 2_500, 0), 2_500), 'review');
  assert.equal(view.workspaceActivityState(current, activity(current.id, 2_500, 2_000), 2_500), 'idle');
});

test('uses an explicit agent working signal across silent output gaps', () => {
  const current: ManagedWorkspace = { ...workspace(2_000), agentState: 'working' };
  assert.equal(view.workspaceActivityState(current, activity(current.id, 0, 0), 60_000), 'active');
  assert.equal(
    view.workspaceActivityState({ ...current, agentState: 'waiting' }, activity(current.id, 0, 0), 60_000),
    'review'
  );
});

test('places active workspaces above review workspaces', () => {
  const states: WorkspaceActivityState[] = ['active', 'review', 'idle', 'ended'];
  assert.deepEqual(
    states.sort((left, right) => view.workspaceActivityPriority(left) - view.workspaceActivityPriority(right)),
    ['active', 'review', 'idle', 'ended']
  );
});

test('does not mark output covered by the observation watermark for review', () => {
  const current = workspace(2_000);
  assert.equal(view.workspaceActivityState(current, activity(current.id, 0, 2_500), 3_000), 'idle');
  assert.equal(
    view.workspaceActivityState({ ...current, lastOutputAt: 3_000 }, activity(current.id, 0, 2_500), 3_500),
    'review'
  );
});

test('does not invent a shell label for a missing workspace', () => {
  assert.equal(view.workspaceProcess({ ...workspace(null), state: 'missing' }), null);
  assert.deepEqual(view.workspaceProcess(workspace(null)), { kind: 'shell', label: 'shell' });
});

test('groups activity states without reordering workspaces inside a state', () => {
  const workspaces = [
    workspace(1_000, 'idle-a'),
    workspace(2_000, 'review-a'),
    workspace(3_000, 'active-a'),
    workspace(4_000, 'idle-b'),
  ];
  const records = new Map([
    ['idle-a', { activeUntil: 0, seenThroughAt: 1_000 }],
    ['review-a', { activeUntil: 0, seenThroughAt: 0 }],
    ['active-a', { activeUntil: Date.now() + 10_000, seenThroughAt: 0 }],
    ['idle-b', { activeUntil: 0, seenThroughAt: 4_000 }],
  ]);
  assert.deepEqual(view.buildActivityOrder(workspaces, ['idle-a', 'review-a', 'active-a', 'idle-b'], records), [
    'active-a',
    'review-a',
    'idle-a',
    'idle-b',
  ]);
});

test('keeps manual workspace order stable while activity changes', () => {
  const workspaces = [
    workspace(1_000, 'workspace-a'),
    workspace(2_000, 'workspace-b'),
    workspace(3_000, 'workspace-c'),
  ];
  assert.deepEqual(
    view
      .sortWorkspaces(workspaces, 'manual', ['workspace-c', 'workspace-a', 'workspace-b'])
      .map((current) => current.id),
    ['workspace-c', 'workspace-a', 'workspace-b']
  );
});

test('tracks main workspace output without treating background process output as agent activity', () => {
  const current: ManagedWorkspace = {
    ...workspace(5_000),
    foregroundProcess: { kind: 'shell', label: 'zsh' },
    terminals: [
      terminal('@0', 0, 'main', 2_000, { kind: 'command', label: 'codex' }),
      { ...terminal('@1', 1, 'server', 5_000, { kind: 'command', label: 'vite' }), active: true },
      terminal('@2', 2, 'shell', 4_000, { kind: 'shell', label: 'zsh' }),
    ],
  };

  assert.deepEqual(view.workspaceProcess(current), { kind: 'command', label: 'codex' });
  assert.equal(view.workspaceActivityState(current, activity(current.id, 0, 2_000), 6_000), 'idle');
  assert.equal(view.latestWorkspaceOutputAt(current), 2_000);
});
