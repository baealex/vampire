import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WorkspaceActivityController,
  type WorkspaceActivityScheduler,
} from '~/lib/features/workspace/model/workspace-activity-controller.ts';
import * as view from '~/lib/features/workspace/model/workspace-view.ts';
import type { ManagedWorkspace, WorkspaceTerminal } from '~/lib/shared/contracts/workspace.ts';
import type { WorkspaceActivityRecord } from '~/lib/features/workspace/model/workspace-view.ts';

let now = 1_000_000;
let nextTimerId = 0;
const timers = new Map<number, { at: number; callback: () => void }>();
const scheduler: WorkspaceActivityScheduler = {
  now: () => now,
  setTimeout(callback, delay) {
    const id = ++nextTimerId;
    timers.set(id, { at: now + Math.max(0, delay), callback });
    return id;
  },
  clearTimeout(id) {
    timers.delete(id);
  },
};

function advance(milliseconds: number): void {
  now += milliseconds;
  while (true) {
    const due = [...timers.entries()]
      .filter(([, timer]) => timer.at <= now)
      .sort(([, left], [, right]) => left.at - right.at)[0];
    if (!due) return;
    timers.delete(due[0]);
    due[1].callback();
  }
}

function workspace(lastOutputAt: number | null = null, id = 'workspace-1'): ManagedWorkspace {
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
    state: 'running',
    attachedClients: 0,
    foregroundProcess: null,
    terminals: [],
    agentState: null,
    isGitRepository: false,
  };
}

function terminal(id: string, index: number, lastOutputAt: number): WorkspaceTerminal {
  return {
    id,
    index,
    name: index === 0 ? 'main' : 'server',
    active: index === 0,
    lastOutputAt,
    foregroundProcess: null,
    command: null,
    startedAt: null,
    state: 'running',
    exitCode: null,
  };
}

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();
  get length(): number {
    return this.#values.size;
  }
  clear(): void {
    this.#values.clear();
  }
  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.#values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

interface HarnessOptions {
  initialLastOutputAt?: number | null;
  storage?: Storage;
}

function createHarness({ initialLastOutputAt = null, storage }: HarnessOptions = {}) {
  const initialWorkspace = workspace(initialLastOutputAt);
  let workspaces: ManagedWorkspace[] = [initialWorkspace];
  let observed = false;
  let activityRecords = new Map<string, WorkspaceActivityRecord>();
  let activityOrder: string[] = [];
  const controller = new WorkspaceActivityController(
    {
      isWorkspaceObserved: () => observed,
      getWorkspaces: () => workspaces,
      getActivityRecords: () => activityRecords,
      setActivityRecords: (records) => {
        activityRecords = records;
      },
      getActivityOrder: () => activityOrder,
      setActivityOrder: (order) => {
        activityOrder = order;
      },
      updateWorkspaceOutput: (workspaceId, timestamp) => {
        workspaces = workspaces.map((item) =>
          item.id === workspaceId ? { ...item, lastOutputAt: Math.max(item.lastOutputAt ?? 0, timestamp) } : item
        );
      },
    },
    scheduler
  );
  if (storage) controller.restoreBrowserPreferences(storage);
  controller.applyWorkspaces([], workspaces, false);
  return {
    controller,
    get workspaces() {
      return workspaces;
    },
    get activityRecords() {
      return activityRecords;
    },
    get activityOrder() {
      return activityOrder;
    },
    state(workspaceId = 'workspace-1') {
      return view.workspaceActivityState(workspaces.find((item) => item.id === workspaceId)!, activityRecords, now);
    },
    setObserved(value: boolean) {
      observed = value;
    },
    setWorkspaces(nextWorkspaces: ManagedWorkspace[]) {
      workspaces = nextWorkspaces;
    },
  };
}

test.afterEach(() => {
  timers.clear();
});

test('transitions unobserved output from active to review to idle', () => {
  now = 1_000_000;
  const harness = createHarness();
  harness.controller.recordWorkspaceOutput('workspace-1', true, now, false);
  assert.equal(harness.state(), 'active');
  assert.equal(harness.activityRecords.get('workspace-1')!.seenThroughAt, 0);

  advance(7_999);
  assert.equal(harness.state(), 'active');
  advance(1);
  assert.equal(harness.state(), 'review');
  assert.equal(harness.activityRecords.get('workspace-1')!.activeUntil, 0);

  harness.controller.markWorkspaceObserved('workspace-1');
  assert.equal(harness.state(), 'idle');
  assert.equal(harness.activityRecords.get('workspace-1')!.seenThroughAt, now);
});

test('extends active while output continues and re-enters active from review', () => {
  now = 1_000_000;
  const harness = createHarness();
  harness.controller.recordWorkspaceOutput('workspace-1', true, now, false);
  advance(6_000);
  harness.controller.recordWorkspaceOutput('workspace-1', true, now, false);
  advance(7_999);
  assert.equal(harness.state(), 'active');
  advance(1);
  assert.equal(harness.state(), 'review');
  harness.controller.recordWorkspaceOutput('workspace-1', true, now, false);
  assert.equal(harness.state(), 'active');
});

test('gives recognized terminal agents a longer fallback for silent tool work', () => {
  now = 1_000_000;
  const harness = createHarness();
  harness.setWorkspaces([
    {
      ...harness.workspaces[0],
      foregroundProcess: { kind: 'command', label: 'codex' },
    },
  ]);
  harness.controller.recordWorkspaceOutput('workspace-1', true, now, false);

  advance(29_999);
  assert.equal(harness.state(), 'active');
  advance(1);
  assert.equal(harness.state(), 'review');
});

test('uses the same stable quiet deadline for background and direct terminal output', () => {
  now = 1_000_000;
  const harness = createHarness();
  const previous = harness.workspaces[0];
  const next = workspace(now);
  harness.setWorkspaces([next]);
  harness.controller.applyWorkspaces([previous], [next], true);
  assert.equal(harness.state(), 'active');

  advance(7_999);
  assert.equal(harness.state(), 'active');
  advance(1);
  assert.equal(harness.state(), 'review');
});

test('ignores background process polling output until the main workspace changes', () => {
  now = 1_000_000;
  const harness = createHarness({ initialLastOutputAt: 1_000 });
  const previous = {
    ...harness.workspaces[0],
    terminals: [terminal('@0', 0, 1_000), terminal('@1', 1, 1_000)],
  };
  const auxiliaryOutput = {
    ...previous,
    lastOutputAt: 2_000,
    terminals: [previous.terminals[0], { ...previous.terminals[1], lastOutputAt: 2_000 }],
  };
  harness.setWorkspaces([auxiliaryOutput]);
  harness.controller.applyWorkspaces([previous], [auxiliaryOutput], true);
  assert.equal(harness.state(), 'idle');

  const mainOutput = {
    ...auxiliaryOutput,
    lastOutputAt: 3_000,
    terminals: [{ ...auxiliaryOutput.terminals[0], lastOutputAt: 3_000 }, auxiliaryOutput.terminals[1]],
  };
  harness.setWorkspaces([mainOutput]);
  harness.controller.applyWorkspaces([auxiliaryOutput], [mainOutput], true);
  assert.equal(harness.state(), 'active');
});

test('renews background activity before its previous quiet deadline', () => {
  now = 1_000_000;
  const harness = createHarness();
  let previous = harness.workspaces[0];
  let next = workspace(now);
  harness.setWorkspaces([next]);
  harness.controller.applyWorkspaces([previous], [next], true);

  advance(6_000);
  previous = next;
  next = workspace(now);
  harness.setWorkspaces([next]);
  harness.controller.applyWorkspaces([previous], [next], true);
  advance(7_999);
  assert.equal(harness.state(), 'active');
  advance(1);
  assert.equal(harness.state(), 'review');
});

test('treats observed polling updates as seen but honors direct terminal activity', () => {
  now = 1_000_000;
  const harness = createHarness();
  harness.setObserved(true);
  const previous = harness.workspaces[0];
  const next = workspace(now);
  harness.setWorkspaces([next]);
  harness.controller.applyWorkspaces([previous], [next], true);
  assert.equal(harness.state(), 'idle');
  assert.equal(harness.activityRecords.get('workspace-1')!.seenThroughAt, now);

  harness.controller.recordWorkspaceOutput('workspace-1', true, now, true);
  assert.equal(harness.state(), 'active');
  advance(8_000);
  assert.equal(harness.state(), 'idle');
});

test('persists the output watermark across page lifetimes', () => {
  now = 1_000_000;
  const storage = new MemoryStorage();
  const firstPage = createHarness({ initialLastOutputAt: 1_000, storage });
  assert.equal(firstPage.state(), 'idle');

  firstPage.controller.recordWorkspaceOutput('workspace-1', true, 2_000, false);
  advance(8_000);
  assert.equal(firstPage.state(), 'review');

  const reloadedPage = createHarness({ initialLastOutputAt: 2_000, storage });
  assert.equal(reloadedPage.state(), 'review');
  reloadedPage.controller.markWorkspaceObserved('workspace-1');
  assert.equal(reloadedPage.state(), 'idle');

  const seenReload = createHarness({ initialLastOutputAt: 2_000, storage });
  assert.equal(seenReload.state(), 'idle');
});
