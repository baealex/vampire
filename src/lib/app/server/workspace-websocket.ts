import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';

import { readWorkspaceAgentStates } from '~/lib/features/workspace/server/workspace-agent-activity.ts';
import {
  listManagedWorkspaces,
  readManagedLaunchProfiles,
  readManagedWorkspacePreferences,
} from './workspace-registry.ts';
import {
  listTmuxSessionActivity,
  type TmuxProcessHint,
  type TmuxSessionActivity,
  type TmuxTerminal,
} from '~/lib/features/terminal/server/tmux.ts';
import {
  encodeWorkspaceServerMessage,
  type WorkspaceChanges,
  type WorkspaceServerMessage,
} from '~/lib/shared/contracts/workspace-protocol.ts';
import type { AgentState } from '~/lib/shared/contracts/workspace-agent.ts';
import type { LaunchProfile, ManagedWorkspace, WorkspacePreferences } from '~/lib/shared/contracts/workspace.ts';
import {
  authorizeWebSocketUpgrade,
  installWebSocketHeartbeat,
  rejectWebSocketUpgrade,
  scheduleAuthenticationExpiry,
} from '~/lib/shared/server/websocket-support.ts';
import { StatusPluginRuntime } from '~/lib/features/status/server/status-plugin-runtime.ts';

const MAX_CONNECTIONS = 32;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const HEARTBEAT_INTERVAL_MS = 30_000;
const WORKSPACE_ACTIVITY_REFRESH_INTERVAL_MS = 1_000;
const WORKSPACE_REFRESH_INTERVAL_MS = 5_000;
const WORKSPACE_FIELDS = [
  'tmuxSession',
  'cwd',
  'workspaceKind',
  'repositoryPath',
  'workspaceLabel',
  'worktreeBranch',
  'createdAt',
  'lastActiveAt',
  'notePreview',
  'favoriteCommands',
  'startupProfileId',
  'state',
  'lastOutputAt',
  'attachedClients',
  'foregroundProcess',
  'terminals',
  'agentState',
  'isGitRepository',
  'workspaceAvailable',
] as const satisfies ReadonlyArray<keyof Omit<ManagedWorkspace, 'id'>>;

interface ActivitySuppression {
  lastOutputAt: number;
  mainLastOutputAt: number;
}

interface PendingAgentState {
  state: AgentState;
  count: number;
}

interface WorkspaceUpdate {
  id: string;
  changes: WorkspaceChanges;
}

interface WorkspaceConnectionContext {
  expiresAt?: number;
}

function send(socket: WebSocket, payload: WorkspaceServerMessage): void {
  if (socket.readyState === 1) socket.send(encodeWorkspaceServerMessage(payload));
}

function equalForegroundProcess(
  left: TmuxProcessHint | null | undefined,
  right: TmuxProcessHint | null | undefined
): boolean {
  return left?.kind === right?.kind && left?.label === right?.label;
}

function equalTerminals(left: TmuxTerminal[] | undefined, right: TmuxTerminal[] | undefined): boolean {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((terminal, index) => {
      const candidate = right[index];
      return (
        terminal.id === candidate?.id &&
        terminal.index === candidate.index &&
        terminal.name === candidate.name &&
        terminal.active === candidate.active &&
        terminal.lastOutputAt === candidate.lastOutputAt &&
        terminal.command === candidate.command &&
        terminal.startedAt === candidate.startedAt &&
        terminal.state === candidate.state &&
        terminal.exitCode === candidate.exitCode &&
        equalForegroundProcess(terminal.foregroundProcess, candidate.foregroundProcess)
      );
    })
  );
}

function equalStrings(left: string[] | undefined, right: string[] | undefined): boolean {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function equalWorkspacePreferences(
  left: WorkspacePreferences | null | undefined,
  right: WorkspacePreferences | null | undefined
): boolean {
  return (
    left === right ||
    (left != null &&
      right != null &&
      left.workspaceOrderMode === right.workspaceOrderMode &&
      equalStrings(left.manualWorkspaceOrder, right.manualWorkspaceOrder))
  );
}

function equalLaunchProfiles(left: LaunchProfile[] | undefined, right: LaunchProfile[] | undefined): boolean {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((profile, index) => {
      const candidate = right[index];
      return profile.id === candidate?.id && profile.name === candidate?.name && profile.command === candidate?.command;
    })
  );
}

function workspaceChanges(previous: ManagedWorkspace, next: ManagedWorkspace): WorkspaceChanges {
  const changes: WorkspaceChanges = {};
  for (const field of WORKSPACE_FIELDS) {
    const equal =
      field === 'foregroundProcess'
        ? equalForegroundProcess(previous[field], next[field])
        : field === 'terminals'
          ? equalTerminals(previous[field], next[field])
          : field === 'favoriteCommands'
            ? equalStrings(previous[field], next[field])
            : previous[field] === next[field];
    if (!equal) (changes as Record<string, unknown>)[field] = next[field];
  }
  return changes;
}

export function reconcileWorkspaceActivity(
  workspaces: Map<string, ManagedWorkspace>,
  tmuxActivity: TmuxSessionActivity[],
  suppressedActivity = new Map<string, ActivitySuppression>(),
  agentStates = new Map<string, AgentState>()
): { workspaces: Map<string, ManagedWorkspace>; updates: WorkspaceUpdate[] } {
  const activityByName = new Map(tmuxActivity.map((activity) => [activity.name, activity]));
  const nextWorkspaces = new Map(workspaces);
  const updates: WorkspaceUpdate[] = [];
  for (const [id, workspace] of workspaces) {
    const activity = activityByName.get(workspace.tmuxSession);
    const suppression = suppressedActivity.get(id);
    const changes: WorkspaceChanges = {};
    if (!activity) {
      if (workspace.state === 'running') {
        changes.state = 'missing';
        changes.lastOutputAt = null;
        changes.attachedClients = 0;
        changes.foregroundProcess = null;
        changes.terminals = [];
        if (workspace.agentState != null) changes.agentState = null;
      }
    } else {
      if (workspace.state === 'missing') changes.state = 'running';
      if (agentStates.has(id)) {
        const agentState = agentStates.get(id) ?? null;
        if ((workspace.agentState ?? null) !== agentState) changes.agentState = agentState;
      }
      const mainTerminal = workspace.terminals?.[0];
      const mainOutputAt = mainTerminal ? activity.mainLastOutputAt : activity.lastOutputAt;
      if (
        mainOutputAt !== null &&
        mainOutputAt > (suppression?.lastOutputAt ?? 0) &&
        mainOutputAt > (workspace.lastOutputAt ?? 0)
      ) {
        changes.lastOutputAt = mainOutputAt;
      }
      if (
        mainTerminal &&
        activity.mainLastOutputAt !== null &&
        activity.mainLastOutputAt > (suppression?.mainLastOutputAt ?? 0) &&
        activity.mainLastOutputAt > (mainTerminal.lastOutputAt ?? 0)
      ) {
        changes.terminals = workspace.terminals.map((terminal, index) =>
          index === 0 ? { ...terminal, lastOutputAt: activity.mainLastOutputAt } : terminal
        );
      }
    }
    if (Object.keys(changes).length === 0) continue;
    const next = { ...workspace, ...changes };
    nextWorkspaces.set(id, next);
    updates.push({ id, changes });
  }
  return { workspaces: nextWorkspaces, updates };
}

export function preserveLatestOutput(
  nextWorkspaces: Map<string, ManagedWorkspace>,
  currentWorkspaces: Map<string, ManagedWorkspace> | undefined,
  suppressedActivity = new Map<string, ActivitySuppression>()
): Map<string, ManagedWorkspace> {
  if (!currentWorkspaces) return nextWorkspaces;
  const preservedWorkspaces = new Map<string, ManagedWorkspace>();
  for (const [id, next] of nextWorkspaces) {
    const current = currentWorkspaces.get(id);
    if (
      !current ||
      current.tmuxSession !== next.tmuxSession ||
      current.state !== 'running' ||
      next.state !== 'running'
    ) {
      preservedWorkspaces.set(id, next);
      continue;
    }
    const suppression = suppressedActivity.get(id);
    const currentTerminals = new Map(current.terminals.map((terminal) => [terminal.id, terminal]));
    const nextLastOutputAt =
      next.lastOutputAt !== null && next.lastOutputAt <= (suppression?.lastOutputAt ?? 0)
        ? current.lastOutputAt
        : next.lastOutputAt;
    preservedWorkspaces.set(id, {
      ...next,
      agentState: current.agentState ?? next.agentState ?? null,
      lastOutputAt: Math.max(nextLastOutputAt ?? 0, current.lastOutputAt ?? 0) || null,
      terminals: next.terminals.map((terminal, index) => {
        if (index > 0) return terminal;
        const previous = currentTerminals.get(terminal.id);
        const nextTerminalOutputAt =
          terminal.lastOutputAt !== null && terminal.lastOutputAt <= (suppression?.lastOutputAt ?? 0)
            ? (previous?.lastOutputAt ?? null)
            : terminal.lastOutputAt;
        return (previous?.lastOutputAt ?? 0) > (nextTerminalOutputAt ?? 0)
          ? { ...terminal, lastOutputAt: previous!.lastOutputAt }
          : { ...terminal, lastOutputAt: nextTerminalOutputAt };
      }),
    });
  }
  return preservedWorkspaces;
}

export function stabilizeAgentStates(
  workspaces: Map<string, ManagedWorkspace>,
  detectedStates: Map<string, AgentState>,
  pendingStates: Map<string, PendingAgentState>
): Map<string, AgentState> {
  const stableStates = new Map<string, AgentState>();
  for (const [id, detectedState] of detectedStates) {
    const currentState = workspaces.get(id)?.agentState ?? null;
    if (detectedState === currentState || detectedState === 'working') {
      pendingStates.delete(id);
      stableStates.set(id, detectedState);
      continue;
    }

    const pending = pendingStates.get(id);
    const count = pending?.state === detectedState ? pending.count + 1 : 1;
    if (currentState === null || count >= 2) {
      pendingStates.delete(id);
      stableStates.set(id, detectedState);
    } else {
      pendingStates.set(id, { state: detectedState, count });
      stableStates.set(id, currentState);
    }
  }
  for (const id of pendingStates.keys()) {
    if (!workspaces.has(id) || !detectedStates.has(id)) pendingStates.delete(id);
  }
  return stableStates;
}

class WorkspaceStatusHub {
  #clients = new Set<WebSocket>();
  #workspaces: Map<string, ManagedWorkspace> | undefined;
  #preferences: WorkspacePreferences | null | undefined;
  #launchProfiles: LaunchProfile[] | undefined;
  #refreshPromise: Promise<void> | undefined;
  #activityRefreshPromise: Promise<void> | undefined;
  #refreshTimer: NodeJS.Timeout | undefined;
  #activityRefreshTimer: NodeJS.Timeout | undefined;
  #suppressedActivity = new Map<string, ActivitySuppression>();
  #pendingAgentStates = new Map<string, PendingAgentState>();
  #statusPlugins = new StatusPluginRuntime((plugins) => {
    this.#broadcast({ type: 'status-plugins-snapshot', plugins });
  });

  suppressWorkspaceActivity(workspaceId: string, timestamp: number): void {
    const current = this.#suppressedActivity.get(workspaceId) ?? {
      lastOutputAt: 0,
      mainLastOutputAt: 0,
    };
    this.#suppressedActivity.set(workspaceId, {
      lastOutputAt: Math.max(current.lastOutputAt, timestamp),
      mainLastOutputAt: Math.max(current.mainLastOutputAt, timestamp),
    });
  }

  recordWorkspaceOutput(workspaceId: string, terminalId: string | undefined, timestamp: number): boolean {
    const suppression = this.#suppressedActivity.get(workspaceId);
    if (timestamp <= (suppression?.mainLastOutputAt ?? 0)) return false;
    const workspaces = this.#workspaces;
    if (!workspaces) return false;
    const workspace = workspaces.get(workspaceId);
    if (!workspace || workspace.state !== 'running') return false;
    const mainTerminal = workspace.terminals[0];
    if (mainTerminal && terminalId && terminalId !== mainTerminal.id) return false;
    const changes: WorkspaceChanges = {};
    if (timestamp > (workspace.lastOutputAt ?? 0)) changes.lastOutputAt = timestamp;
    const targetTerminalId = mainTerminal?.id;
    if (targetTerminalId) {
      const targetTerminal = workspace.terminals.find((terminal) => terminal.id === targetTerminalId);
      if (targetTerminal && timestamp > (targetTerminal.lastOutputAt ?? 0)) {
        changes.terminals = workspace.terminals.map((terminal) =>
          terminal.id === targetTerminalId ? { ...terminal, lastOutputAt: timestamp } : terminal
        );
      }
    }
    if (Object.keys(changes).length === 0) return true;
    workspaces.set(workspaceId, { ...workspace, ...changes });
    this.#broadcast({ type: 'workspace-updated', id: workspaceId, changes });
    return true;
  }

  async subscribe(socket: WebSocket): Promise<void> {
    try {
      await this.#refresh();
      if (socket.readyState !== 1) return;
      const firstClient = this.#clients.size === 0;
      send(socket, {
        type: 'workspaces-snapshot',
        workspaces: [...this.#workspaces!.values()],
        preferences: this.#preferences ?? null,
        launchProfiles: this.#launchProfiles ?? [],
      });
      this.#clients.add(socket);
      socket.once('close', () => this.unsubscribe(socket));
      if (firstClient) {
        try {
          await this.#statusPlugins.start();
        } catch {
          send(socket, { type: 'error', message: 'Unable to load status plugins.' });
        }
      } else {
        send(socket, { type: 'status-plugins-snapshot', plugins: this.#statusPlugins.snapshots() });
      }
      this.#startPolling();
    } catch {
      send(socket, { type: 'error', message: 'Unable to load workspace workspaces.' });
      socket.close(1011, 'workspace state unavailable');
    }
  }

  unsubscribe(socket: WebSocket): void {
    this.#clients.delete(socket);
    if (this.#clients.size > 0) return;
    if (this.#refreshTimer !== undefined) clearInterval(this.#refreshTimer);
    if (this.#activityRefreshTimer !== undefined) clearInterval(this.#activityRefreshTimer);
    this.#refreshTimer = undefined;
    this.#activityRefreshTimer = undefined;
    this.#workspaces = undefined;
    this.#preferences = undefined;
    this.#launchProfiles = undefined;
    this.#suppressedActivity.clear();
    this.#pendingAgentStates.clear();
    this.#statusPlugins.stop();
  }

  close(): void {
    if (this.#refreshTimer !== undefined) clearInterval(this.#refreshTimer);
    if (this.#activityRefreshTimer !== undefined) clearInterval(this.#activityRefreshTimer);
    this.#refreshTimer = undefined;
    this.#activityRefreshTimer = undefined;
    this.#workspaces = undefined;
    this.#preferences = undefined;
    this.#launchProfiles = undefined;
    this.#suppressedActivity.clear();
    this.#pendingAgentStates.clear();
    this.#statusPlugins.stop();
    for (const socket of this.#clients) socket.close(1001, 'server shutting down');
    this.#clients.clear();
  }

  #startPolling(): void {
    if (this.#refreshTimer !== undefined) return;
    this.#refreshTimer = setInterval(() => void this.#refresh().catch(() => undefined), WORKSPACE_REFRESH_INTERVAL_MS);
    this.#refreshTimer.unref();
    this.#activityRefreshTimer = setInterval(
      () => void this.#refreshActivity().catch(() => undefined),
      WORKSPACE_ACTIVITY_REFRESH_INTERVAL_MS
    );
    this.#activityRefreshTimer.unref();
  }

  async #refresh(): Promise<void> {
    if (this.#refreshPromise) return this.#refreshPromise;
    const precedingActivityRefresh = this.#activityRefreshPromise;
    this.#refreshPromise = (async () => {
      if (precedingActivityRefresh) await precedingActivityRefresh;
      const [managedWorkspaces, nextPreferences, nextLaunchProfiles] = await Promise.all([
        listManagedWorkspaces(),
        readManagedWorkspacePreferences(),
        readManagedLaunchProfiles(),
      ]);
      const nextWorkspaces = preserveLatestOutput(
        new Map(managedWorkspaces.map((workspace) => [workspace.id, workspace])),
        this.#workspaces,
        this.#suppressedActivity
      );
      const previousWorkspaces = this.#workspaces;
      const previousPreferences = this.#preferences;
      const previousLaunchProfiles = this.#launchProfiles;
      this.#workspaces = nextWorkspaces;
      this.#preferences = nextPreferences;
      this.#launchProfiles = nextLaunchProfiles;
      if (!previousWorkspaces) return;

      for (const [id] of previousWorkspaces) {
        if (!nextWorkspaces.has(id)) {
          this.#suppressedActivity.delete(id);
          this.#pendingAgentStates.delete(id);
          this.#broadcast({ type: 'workspace-removed', id });
        }
      }
      for (const [id, next] of nextWorkspaces) {
        const previous = previousWorkspaces.get(id);
        if (!previous) {
          this.#broadcast({ type: 'workspace-added', workspace: next });
          continue;
        }
        const changes = workspaceChanges(previous, next);
        if (Object.keys(changes).length > 0) this.#broadcast({ type: 'workspace-updated', id, changes });
      }
      if (previousPreferences !== undefined && !equalWorkspacePreferences(previousPreferences, nextPreferences)) {
        this.#broadcast({
          type: 'workspace-preferences-updated',
          preferences: nextPreferences,
        });
      }
      if (previousLaunchProfiles !== undefined && !equalLaunchProfiles(previousLaunchProfiles, nextLaunchProfiles)) {
        this.#broadcast({
          type: 'launch-profiles-updated',
          launchProfiles: nextLaunchProfiles,
        });
      }
    })();
    try {
      await this.#refreshPromise;
    } finally {
      this.#refreshPromise = undefined;
    }
  }

  async #refreshActivity(): Promise<void> {
    if (this.#activityRefreshPromise) return this.#activityRefreshPromise;
    const precedingRefresh = this.#refreshPromise;
    this.#activityRefreshPromise = (async () => {
      if (precedingRefresh) await precedingRefresh;
      if (!this.#workspaces) return;
      const [tmuxActivity, detectedAgentStates] = await Promise.all([
        listTmuxSessionActivity(),
        readWorkspaceAgentStates(this.#workspaces.values()),
      ]);
      if (!this.#workspaces) return;
      const agentStates = stabilizeAgentStates(this.#workspaces, detectedAgentStates, this.#pendingAgentStates);
      const result = reconcileWorkspaceActivity(this.#workspaces, tmuxActivity, this.#suppressedActivity, agentStates);
      this.#workspaces = result.workspaces;
      for (const update of result.updates) {
        this.#broadcast({ type: 'workspace-updated', id: update.id, changes: update.changes });
      }
    })();
    try {
      await this.#activityRefreshPromise;
    } finally {
      this.#activityRefreshPromise = undefined;
    }
  }

  #broadcast(payload: WorkspaceServerMessage, excludedSocket?: WebSocket): void {
    for (const socket of this.#clients) {
      if (socket !== excludedSocket) send(socket, payload);
    }
  }
}

const workspaceStatusHub = new WorkspaceStatusHub();

export function recordWorkspaceOutput(workspaceId: string, terminalId: string | undefined, timestamp: number): boolean {
  return workspaceStatusHub.recordWorkspaceOutput(workspaceId, terminalId, timestamp);
}

export function suppressWorkspaceActivity(workspaceId: string, timestamp: number): void {
  workspaceStatusHub.suppressWorkspaceActivity(workspaceId, timestamp);
}

export function installWorkspaceWebSocket(server: HttpServer): () => void {
  const workspaceSockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });

  const connectionContexts = new WeakMap<WebSocket, WorkspaceConnectionContext>();
  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/ws/workspace') return;
    if (workspaceSockets.clients.size >= MAX_CONNECTIONS) {
      rejectWebSocketUpgrade(socket, 503, 'Service Unavailable');
      return;
    }

    const authorization = authorizeWebSocketUpgrade(request);
    if (!authorization.authorized) {
      rejectWebSocketUpgrade(socket, authorization.status, authorization.reason);
      return;
    }

    workspaceSockets.handleUpgrade(request, socket, head, (websocket) => {
      connectionContexts.set(websocket, { expiresAt: authorization.expiresAt });
      workspaceSockets.emit('connection', websocket, request);
    });
  };

  server.on('upgrade', handleUpgrade);
  workspaceSockets.on('connection', (socket) => {
    const context = connectionContexts.get(socket) ?? {};
    scheduleAuthenticationExpiry(socket, context.expiresAt);
    void workspaceStatusHub.subscribe(socket).catch(() => socket.close(1011, 'workspace state unavailable'));
  });
  const closeHeartbeat = installWebSocketHeartbeat(workspaceSockets, HEARTBEAT_INTERVAL_MS);

  return () => {
    closeHeartbeat();
    server.off('upgrade', handleUpgrade);
    workspaceStatusHub.close();
    workspaceSockets.close();
  };
}
