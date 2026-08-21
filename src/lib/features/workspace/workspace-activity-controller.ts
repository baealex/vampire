import {
  buildActivityOrder,
  workspaceOutputSettleMs,
  workspaceTrackedOutputAt,
  type WorkspaceActivityRecord,
  type WorkspaceActivityRecords,
} from './workspace-view.ts';
import type { ManagedWorkspace } from '~/lib/shared/contracts/workspace.ts';

const OUTPUT_ACTIVITY_UPDATE_INTERVAL_MS = 500;
const WORKSPACE_OUTPUT_SEEN_KEY = 'vampire:workspace-output-seen';
const COMPATIBILITY_SESSION_OUTPUT_SEEN_KEY = 'vampire:session-output-seen';
const WORKSPACE_OUTPUT_SEEN_VERSION = 1;

type WorkspaceOutputSeenState = {
  version: typeof WORKSPACE_OUTPUT_SEEN_VERSION;
  workspaces: Record<string, number>;
};

type WorkspaceActivityControllerOptions = {
  isWorkspaceObserved: (workspaceId: string) => boolean;
  getWorkspaces: () => ManagedWorkspace[];
  getActivityRecords: () => WorkspaceActivityRecords;
  setActivityRecords: (records: Map<string, WorkspaceActivityRecord>) => void;
  getActivityOrder: () => string[];
  setActivityOrder: (order: string[]) => void;
  updateWorkspaceOutput: (workspaceId: string, timestamp: number) => void;
};

export interface WorkspaceActivityScheduler {
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => number;
  clearTimeout: (timer: number) => void;
}

function browserScheduler(): WorkspaceActivityScheduler {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delay) => window.setTimeout(callback, delay),
    clearTimeout: (timer) => window.clearTimeout(timer),
  };
}

function outputTimestampChanged(previous: number | null, next: number | null): next is number {
  return next !== null && next > (previous ?? 0);
}

export class WorkspaceActivityController {
  #lastOutputActivityUpdate = new Map<string, number>();
  #outputActivityTimers = new Map<string, number>();
  #activeExpiryTimers = new Map<string, number>();
  #pendingOutputActivity = new Map<string, number>();
  #storage: Storage | undefined;
  readonly #options: WorkspaceActivityControllerOptions;
  readonly #scheduler: WorkspaceActivityScheduler;

  constructor(options: WorkspaceActivityControllerOptions, scheduler = browserScheduler()) {
    this.#options = options;
    this.#scheduler = scheduler;
  }

  restoreBrowserPreferences(storage: Storage) {
    this.#storage = storage;
    let saved: unknown;
    try {
      saved = JSON.parse(
        storage.getItem(WORKSPACE_OUTPUT_SEEN_KEY) ?? storage.getItem(COMPATIBILITY_SESSION_OUTPUT_SEEN_KEY) ?? 'null'
      );
    } catch {
      return;
    }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
    const state = saved as Partial<WorkspaceOutputSeenState>;
    const workspaces = state.workspaces ?? (state as typeof state & { sessions?: unknown }).sessions;
    if (state.version !== WORKSPACE_OUTPUT_SEEN_VERSION || !workspaces || typeof workspaces !== 'object') return;
    const nextRecords = new Map(this.#options.getActivityRecords());
    for (const [workspaceId, timestamp] of Object.entries(workspaces)) {
      if (!Number.isFinite(timestamp) || timestamp < 0) continue;
      const current = nextRecords.get(workspaceId) ?? { activeUntil: 0, seenThroughAt: 0 };
      nextRecords.set(workspaceId, {
        ...current,
        seenThroughAt: Math.max(current.seenThroughAt, timestamp),
      });
    }
    this.#options.setActivityRecords(nextRecords);
  }

  applyWorkspaces(
    previousWorkspaces: ManagedWorkspace[],
    nextWorkspaces: ManagedWorkspace[],
    workspacesLoaded: boolean
  ) {
    const previousById = new Map(previousWorkspaces.map((workspace) => [workspace.id, workspace]));
    for (const workspace of nextWorkspaces) {
      const previous = previousById.get(workspace.id);
      if (!previous) {
        this.#initializeWorkspace(workspace);
        continue;
      }
      const outputAt = workspaceTrackedOutputAt(workspace);
      if (workspacesLoaded && outputTimestampChanged(workspaceTrackedOutputAt(previous), outputAt)) {
        if (this.#options.isWorkspaceObserved(workspace.id)) {
          this.#markOutputSeen(workspace.id, outputAt);
        } else {
          this.#startOutputActivity(workspace.id, outputAt, false, workspaceOutputSettleMs(workspace));
        }
      }
      if (previous.agentState !== 'waiting' && workspace.agentState === 'waiting') {
        this.clearOutputActivity(workspace.id);
      }
    }
    this.#pruneWorkspaces(nextWorkspaces);
    this.#rebuildActivityOrder(nextWorkspaces);
  }

  applyWorkspaceUpdated(
    previous: ManagedWorkspace,
    next: ManagedWorkspace,
    nextWorkspaces: ManagedWorkspace[],
    workspacesLoaded: boolean
  ) {
    const outputAt = workspaceTrackedOutputAt(next);
    const outputChanged = workspacesLoaded && outputTimestampChanged(workspaceTrackedOutputAt(previous), outputAt);
    const observed = this.#options.isWorkspaceObserved(next.id);
    if (outputChanged && outputAt !== null) {
      if (observed) this.#markOutputSeen(next.id, outputAt);
      else {
        this.#startOutputActivity(next.id, outputAt, false, workspaceOutputSettleMs(next));
      }
    }
    if (previous.agentState !== 'waiting' && next.agentState === 'waiting') {
      this.clearOutputActivity(next.id);
    }
    if (outputChanged || previous.state !== next.state || previous.agentState !== next.agentState) {
      this.#rebuildActivityOrder(nextWorkspaces);
    }
  }

  recordWorkspaceOutput(workspaceId: string, active: boolean, timestamp?: number, observed = false) {
    if (!active) {
      this.#flushOutputActivity(workspaceId);
      return;
    }

    const outputTimestamp = timestamp ?? this.#scheduler.now();
    const workspace = this.#options.getWorkspaces().find((item) => item.id === workspaceId);
    if (!workspace) return;
    this.#startOutputActivity(workspaceId, outputTimestamp, observed, workspaceOutputSettleMs(workspace));
    this.#recordOutputActivity(workspaceId, outputTimestamp);
  }

  markWorkspaceObserved(workspaceId: string) {
    const workspace = this.#options.getWorkspaces().find((item) => item.id === workspaceId);
    if (!workspace) return;
    const current = this.#recordFor(workspaceId);
    const nextSeenThroughAt = Math.max(
      current.seenThroughAt,
      workspaceTrackedOutputAt(workspace) ?? 0,
      this.#scheduler.now()
    );
    if (nextSeenThroughAt === current.seenThroughAt) return;
    this.#setRecord(workspaceId, { ...current, seenThroughAt: nextSeenThroughAt });
    this.#persistSeenOutput();
    this.#rebuildActivityOrder();
  }

  removeWorkspace(workspaceId: string) {
    this.#clearTimers(workspaceId);
    this.#pendingOutputActivity.delete(workspaceId);
    this.#lastOutputActivityUpdate.delete(workspaceId);
    this.#removeRecord(workspaceId);
    this.#persistSeenOutput();
    this.#removeWorkspaceActivity(workspaceId);
  }

  rebuild(workspaces = this.#options.getWorkspaces()) {
    for (const workspace of workspaces) this.#initializeWorkspace(workspace);
    this.#rebuildActivityOrder(workspaces);
  }

  clearOutputActivity(workspaceId: string) {
    this.#clearTimers(workspaceId);
    this.#pendingOutputActivity.delete(workspaceId);
    this.#lastOutputActivityUpdate.delete(workspaceId);
    const current = this.#recordFor(workspaceId);
    this.#setRecord(workspaceId, { ...current, activeUntil: 0 });
  }

  reset() {
    this.#clearAllTimers();
    this.#options.setActivityOrder([]);
    this.#options.setActivityRecords(
      new Map(
        [...this.#options.getActivityRecords()].map(([workspaceId, record]) => [
          workspaceId,
          { ...record, activeUntil: 0 },
        ])
      )
    );
  }

  dispose() {
    this.#clearAllTimers();
    this.#options.setActivityOrder([]);
    this.#options.setActivityRecords(new Map());
  }

  #initializeWorkspace(workspace: ManagedWorkspace) {
    if (this.#options.getActivityRecords().has(workspace.id)) return;
    this.#setRecord(workspace.id, {
      activeUntil: 0,
      seenThroughAt: workspaceTrackedOutputAt(workspace) ?? 0,
    });
    this.#persistSeenOutput();
  }

  #markOutputSeen(workspaceId: string, outputTimestamp: number) {
    const current = this.#recordFor(workspaceId);
    const changed = this.#setRecord(workspaceId, {
      ...current,
      seenThroughAt: Math.max(current.seenThroughAt, outputTimestamp),
    });
    if (changed) this.#persistSeenOutput();
  }

  #startOutputActivity(workspaceId: string, outputTimestamp: number, observed: boolean, settleDelay: number) {
    const workspace = this.#options.getWorkspaces().find((item) => item.id === workspaceId);
    if (!workspace || workspace.state === 'missing') return;

    const current = this.#recordFor(workspaceId);
    const next: WorkspaceActivityRecord = {
      activeUntil: Math.max(current.activeUntil, this.#scheduler.now() + Math.max(0, settleDelay)),
      seenThroughAt: observed ? Math.max(current.seenThroughAt, outputTimestamp) : current.seenThroughAt,
    };
    const changed = this.#setRecord(workspaceId, next);
    if (changed && observed) this.#persistSeenOutput();
    this.#scheduleActiveExpiry(workspaceId, next.activeUntil);
    if (changed) this.#rebuildActivityOrder();
  }

  #recordOutputActivity(workspaceId: string, timestamp: number) {
    const now = this.#scheduler.now();
    const elapsed = now - (this.#lastOutputActivityUpdate.get(workspaceId) ?? -Infinity);
    if (elapsed >= OUTPUT_ACTIVITY_UPDATE_INTERVAL_MS) {
      const scheduledTimer = this.#outputActivityTimers.get(workspaceId);
      if (scheduledTimer !== undefined) this.#scheduler.clearTimeout(scheduledTimer);
      this.#outputActivityTimers.delete(workspaceId);
      this.#commitOutputActivity(workspaceId, timestamp, now);
      return;
    }

    this.#pendingOutputActivity.set(workspaceId, timestamp);
    if (this.#outputActivityTimers.has(workspaceId)) return;
    this.#outputActivityTimers.set(
      workspaceId,
      this.#scheduler.setTimeout(() => {
        this.#outputActivityTimers.delete(workspaceId);
        const pendingTimestamp = this.#pendingOutputActivity.get(workspaceId);
        if (pendingTimestamp !== undefined)
          this.#commitOutputActivity(workspaceId, pendingTimestamp, this.#scheduler.now());
      }, OUTPUT_ACTIVITY_UPDATE_INTERVAL_MS - elapsed)
    );
  }

  #flushOutputActivity(workspaceId: string) {
    const timer = this.#outputActivityTimers.get(workspaceId);
    if (timer !== undefined) this.#scheduler.clearTimeout(timer);
    this.#outputActivityTimers.delete(workspaceId);
    const pendingTimestamp = this.#pendingOutputActivity.get(workspaceId);
    if (pendingTimestamp !== undefined)
      this.#commitOutputActivity(workspaceId, pendingTimestamp, this.#scheduler.now());
  }

  #commitOutputActivity(workspaceId: string, timestamp: number, recordedAt: number) {
    this.#pendingOutputActivity.delete(workspaceId);
    this.#lastOutputActivityUpdate.set(workspaceId, recordedAt);
    this.#options.updateWorkspaceOutput(workspaceId, timestamp);
  }

  #scheduleActiveExpiry(workspaceId: string, activeUntil: number) {
    const existingTimer = this.#activeExpiryTimers.get(workspaceId);
    if (existingTimer !== undefined) this.#scheduler.clearTimeout(existingTimer);
    this.#activeExpiryTimers.set(
      workspaceId,
      this.#scheduler.setTimeout(
        () => {
          this.#activeExpiryTimers.delete(workspaceId);
          const current = this.#options.getActivityRecords().get(workspaceId);
          if (!current || current.activeUntil !== activeUntil) return;
          this.#setRecord(workspaceId, { ...current, activeUntil: 0 });
          this.#rebuildActivityOrder();
        },
        Math.max(0, activeUntil - this.#scheduler.now())
      )
    );
  }

  #recordFor(workspaceId: string): WorkspaceActivityRecord {
    return this.#options.getActivityRecords().get(workspaceId) ?? { activeUntil: 0, seenThroughAt: 0 };
  }

  #setRecord(workspaceId: string, record: WorkspaceActivityRecord): boolean {
    const records = this.#options.getActivityRecords();
    const current = records.get(workspaceId);
    if (current?.activeUntil === record.activeUntil && current.seenThroughAt === record.seenThroughAt) return false;
    const nextRecords = new Map(records);
    nextRecords.set(workspaceId, record);
    this.#options.setActivityRecords(nextRecords);
    return true;
  }

  #rebuildActivityOrder(workspaces = this.#options.getWorkspaces()) {
    this.#options.setActivityOrder(
      buildActivityOrder(workspaces, this.#options.getActivityOrder(), this.#options.getActivityRecords())
    );
  }

  #removeWorkspaceActivity(workspaceId: string) {
    const activityOrder = this.#options.getActivityOrder();
    if (activityOrder.includes(workspaceId)) {
      this.#options.setActivityOrder(activityOrder.filter((id) => id !== workspaceId));
    }
  }

  #removeRecord(workspaceId: string) {
    const records = this.#options.getActivityRecords();
    if (!records.has(workspaceId)) return;
    const nextRecords = new Map(records);
    nextRecords.delete(workspaceId);
    this.#options.setActivityRecords(nextRecords);
  }

  #pruneWorkspaces(workspaces = this.#options.getWorkspaces()) {
    const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
    for (const workspaceId of this.#activeExpiryTimers.keys()) {
      if (!workspaceIds.has(workspaceId)) this.removeWorkspace(workspaceId);
    }
    for (const workspaceId of this.#outputActivityTimers.keys()) {
      if (!workspaceIds.has(workspaceId)) this.removeWorkspace(workspaceId);
    }
    const records = this.#options.getActivityRecords();
    const nextRecords = new Map([...records].filter(([id]) => workspaceIds.has(id)));
    if (nextRecords.size !== records.size) {
      this.#options.setActivityRecords(nextRecords);
      this.#persistSeenOutput();
    }
  }

  #persistSeenOutput() {
    if (!this.#storage) return;
    const workspaces = Object.fromEntries(
      [...this.#options.getActivityRecords()]
        .filter(([, record]) => record.seenThroughAt > 0)
        .map(([workspaceId, record]) => [workspaceId, record.seenThroughAt])
    );
    try {
      this.#storage.setItem(
        WORKSPACE_OUTPUT_SEEN_KEY,
        JSON.stringify({
          version: WORKSPACE_OUTPUT_SEEN_VERSION,
          workspaces,
        } satisfies WorkspaceOutputSeenState)
      );
    } catch {
      // Storage can be unavailable or full; activity remains correct for this page lifetime.
    }
  }

  #clearTimers(workspaceId: string) {
    const outputTimer = this.#outputActivityTimers.get(workspaceId);
    if (outputTimer !== undefined) this.#scheduler.clearTimeout(outputTimer);
    this.#outputActivityTimers.delete(workspaceId);
    const activeTimer = this.#activeExpiryTimers.get(workspaceId);
    if (activeTimer !== undefined) this.#scheduler.clearTimeout(activeTimer);
    this.#activeExpiryTimers.delete(workspaceId);
  }

  #clearAllTimers() {
    for (const timer of this.#outputActivityTimers.values()) this.#scheduler.clearTimeout(timer);
    this.#outputActivityTimers.clear();
    for (const timer of this.#activeExpiryTimers.values()) this.#scheduler.clearTimeout(timer);
    this.#activeExpiryTimers.clear();
    this.#pendingOutputActivity.clear();
    this.#lastOutputActivityUpdate.clear();
  }
}
