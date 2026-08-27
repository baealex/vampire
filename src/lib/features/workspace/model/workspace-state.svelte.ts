import { isUnauthorized, requestJson } from '~/lib/shared/api/request.ts';
import type {
  LaunchProfile,
  ManagedWorkspace,
  WorkspaceOrderMode,
  WorkspacePreferences,
  WorkspaceTerminal,
} from '~/lib/shared/contracts/workspace.ts';
import type { WorkspaceAutomation } from '~/lib/shared/contracts/workspace-automations.ts';
import { BackgroundTerminalReconciler } from './background-terminal-reconciler.ts';
import { WorkspaceActivityController } from './workspace-activity-controller.ts';
import {
  maxTimestamp,
  reconcileWorkspaceOrder,
  sortWorkspaces,
  type WorkspaceActivityRecord,
} from './workspace-view.ts';

type RefreshOptions = { quiet?: boolean };
type WorkspaceChanges = Partial<Omit<ManagedWorkspace, 'id'>>;

type WorkspaceStateOptions = {
  navigate: (path: string) => void;
  onUnauthorized: () => void;
  isWorkspaceObserved: (workspaceId: string) => boolean;
};

const WORKSPACE_ORDER_KEY = 'vampire:workspace-order';
const WORKSPACE_ORDER_MODE_KEY = 'vampire:workspace-order-mode';
const COMPATIBILITY_SESSION_ORDER_KEY = 'vampire:session-order';
const COMPATIBILITY_SESSION_ORDER_MODE_KEY = 'vampire:session-order-mode';

function findMainTerminal(terminals: WorkspaceTerminal[]): WorkspaceTerminal | undefined {
  return terminals.find((terminal) => terminal.terminalKind === 'main') ?? terminals[0];
}

function isMainTerminal(terminal: WorkspaceTerminal, terminals: WorkspaceTerminal[]): boolean {
  return terminal.id === findMainTerminal(terminals)?.id;
}

export class WorkspaceState {
  workspaces = $state<ManagedWorkspace[]>([]);
  launchProfiles = $state<LaunchProfile[]>([]);
  cwd = $state('');
  loading = $state(false);
  starting = $state(false);
  startError = $state('');
  creatingKing = $state(false);
  kingCreateError = $state('');
  newWorkspaceOpen = $state(false);
  workspacesLoaded = $state(false);
  requestedWorkspaceId = $state<string | undefined>(undefined);
  errorMessage = $state('');
  workspaceAction = $state<'restart' | 'close' | 'remove' | undefined>(undefined);
  workspaceActionError = $state('');
  startingBackgroundWorkspaceId = $state<string | undefined>(undefined);
  stoppingBackgroundProcessId = $state<string | undefined>(undefined);
  updatingFavoriteCommand = $state<string | undefined>(undefined);
  backgroundActionError = $state('');
  backgroundActionErrorWorkspaceId = $state<string | undefined>(undefined);
  workspaceOrderMode = $state<WorkspaceOrderMode>('activity');
  manualWorkspaceOrder = $state<string[]>([]);
  workspacePreferencesError = $state('');
  activityOrder = $state<string[]>([]);
  activityRecords = $state<Map<string, WorkspaceActivityRecord>>(new Map());

  displayedWorkspaces = $derived(
    sortWorkspaces(this.workspaces, this.workspaceOrderMode, this.manualWorkspaceOrder, this.activityOrder)
  );
  shortcutWorkspaces = $derived(this.displayedWorkspaces.filter((workspace) => workspace.state === 'running'));
  activeWorkspace = $derived(
    this.requestedWorkspaceId
      ? this.workspaces.find((workspace) => workspace.id === this.requestedWorkspaceId)
      : undefined
  );
  hasOpenWorkspace = $derived(Boolean(this.activeWorkspace || this.requestedWorkspaceId));

  #activityRequestTimers = new Map<string, number>();
  #activity: WorkspaceActivityController;
  #backgroundTerminals = new BackgroundTerminalReconciler();
  #workspaceNotes = new Map<string, string>();
  #workspaceNoteRequests = new Map<string, Promise<string>>();
  #refreshPromise: Promise<void> | undefined;
  #refreshQueued = false;
  #workspacesVersion = 0;
  #compatibilityPreferenceStorage: Storage | undefined;
  #preferencesInitialized = false;
  #preferenceWriteQueue: Promise<void> = Promise.resolve();
  #preferenceMutationVersion = 0;
  #pendingPreferenceWrites = 0;
  readonly #options: WorkspaceStateOptions;

  constructor(options: WorkspaceStateOptions) {
    this.#options = options;
    this.#activity = new WorkspaceActivityController({
      isWorkspaceObserved: options.isWorkspaceObserved,
      getWorkspaces: () => this.workspaces,
      getActivityRecords: () => this.activityRecords,
      setActivityRecords: (records) => (this.activityRecords = records),
      getActivityOrder: () => this.activityOrder,
      setActivityOrder: (order) => (this.activityOrder = order),
      updateWorkspaceOutput: (workspaceId, timestamp) => {
        const workspace = this.workspaces.find((item) => item.id === workspaceId);
        if (!workspace) return;
        const lastOutputAt = maxTimestamp(workspace.lastOutputAt, timestamp);
        const mainTerminal = findMainTerminal(workspace.terminals);
        const mainLastOutputAt = maxTimestamp(mainTerminal?.lastOutputAt ?? null, timestamp);
        if (lastOutputAt === workspace.lastOutputAt && mainLastOutputAt === mainTerminal?.lastOutputAt) return;
        this.workspaces = this.workspaces.map((item) =>
          workspaceId === item.id
            ? {
                ...item,
                lastOutputAt,
                terminals: mainTerminal
                  ? item.terminals.map((terminal) =>
                      terminal.id === mainTerminal.id ? { ...terminal, lastOutputAt: mainLastOutputAt } : terminal
                    )
                  : item.terminals,
              }
            : item
        );
      },
    });
  }

  async refresh(options: RefreshOptions = {}) {
    if (!options.quiet) this.loading = true;
    if (this.#refreshPromise) {
      await this.#refreshPromise;
      if (!options.quiet) this.loading = false;
      return;
    }

    this.#refreshPromise = this.#runRefreshLoop();
    try {
      await this.#refreshPromise;
    } finally {
      this.#refreshPromise = undefined;
      if (!options.quiet) this.loading = false;
    }
  }

  applyWorkspaceSnapshot(workspaces: ManagedWorkspace[]) {
    this.applyWorkspaces(workspaces);
  }

  applyLaunchProfiles(launchProfiles: LaunchProfile[]) {
    this.launchProfiles = launchProfiles.map((profile) => ({ ...profile }));
    const profileIds = new Set(this.launchProfiles.map((profile) => profile.id));
    this.workspaces = this.workspaces.map((workspace) =>
      workspace.startupProfileId && !profileIds.has(workspace.startupProfileId)
        ? { ...workspace, startupProfileId: null }
        : workspace
    );
  }

  applyWorkspacePreferences(preferences: WorkspacePreferences | null, options: { initialSnapshot?: boolean } = {}) {
    if (options.initialSnapshot && this.#preferencesInitialized) return;
    if (preferences === null) {
      if (this.#preferencesInitialized || this.#pendingPreferenceWrites > 0) return;
      this.#preferencesInitialized = true;
      this.syncManualWorkspaceOrder();
      this.persistWorkspacePreferences();
      return;
    }
    if (this.#pendingPreferenceWrites > 0) return;
    this.acceptWorkspacePreferences(preferences);
  }

  applyWorkspaceAdded(workspace: ManagedWorkspace) {
    if (this.workspaces.some((item) => item.id === workspace.id)) {
      const { id, ...changes } = workspace;
      this.applyWorkspaceUpdated(id, changes);
      return;
    }
    this.applyWorkspaces([...this.workspaces, workspace]);
  }

  applyWorkspaceUpdated(workspaceId: string, changes: WorkspaceChanges) {
    const previous = this.workspaces.find((workspace) => workspace.id === workspaceId);
    if (!previous) {
      void this.refresh({ quiet: true });
      return;
    }

    const nextState = changes.state ?? previous.state;
    if (nextState === 'missing') this.#backgroundTerminals.clearWorkspace(workspaceId);
    const terminals =
      changes.terminals && nextState === 'running'
        ? this.#backgroundTerminals.reconcile(workspaceId, changes.terminals)
        : (changes.terminals ??
          (typeof changes.lastOutputAt === 'number' && previous.terminals.length > 0
            ? previous.terminals.map((terminal) =>
                isMainTerminal(terminal, previous.terminals)
                  ? { ...terminal, lastOutputAt: maxTimestamp(terminal.lastOutputAt, changes.lastOutputAt ?? null) }
                  : terminal
              )
            : previous.terminals));
    const next = {
      ...previous,
      ...changes,
      id: workspaceId,
      terminals,
      lastActiveAt: Math.max(previous.lastActiveAt, changes.lastActiveAt ?? previous.lastActiveAt),
      lastOutputAt: maxTimestamp(changes.lastOutputAt ?? previous.lastOutputAt, previous.lastOutputAt),
    };
    if ('notePreview' in changes && changes.notePreview !== previous.notePreview)
      this.#workspaceNotes.delete(workspaceId);
    const nextWorkspaces = this.workspaces.map((workspace) => (workspace.id === workspaceId ? next : workspace));
    this.workspaces = nextWorkspaces;
    this.#activity.applyWorkspaceUpdated(previous, next, nextWorkspaces, this.workspacesLoaded);
    this.syncManualWorkspaceOrder();
  }

  applyWorkspaceRemoved(workspaceId: string) {
    this.#backgroundTerminals.clearWorkspace(workspaceId);
    if (!this.workspaces.some((workspace) => workspace.id === workspaceId)) return;
    this.workspaces = this.workspaces.filter((workspace) => workspace.id !== workspaceId);
    this.#workspaceNotes.delete(workspaceId);
    this.#workspaceNoteRequests.delete(workspaceId);
    this.#activity.removeWorkspace(workspaceId);
    if (this.backgroundActionErrorWorkspaceId === workspaceId) {
      this.backgroundActionError = '';
      this.backgroundActionErrorWorkspaceId = undefined;
    }
    this.syncManualWorkspaceOrder();
  }

  async #runRefreshLoop() {
    do {
      this.#refreshQueued = false;
      const requestVersion = this.#workspacesVersion;
      this.errorMessage = '';
      try {
        const data = await requestJson<{
          workspaces: ManagedWorkspace[];
          preferences?: WorkspacePreferences | null;
          launchProfiles?: LaunchProfile[];
        }>('/api/workspaces');
        if (requestVersion !== this.#workspacesVersion) continue;
        this.applyWorkspaces(data.workspaces);
        if (data.preferences !== undefined) this.applyWorkspacePreferences(data.preferences);
        if (data.launchProfiles !== undefined) this.applyLaunchProfiles(data.launchProfiles);
      } catch (error) {
        if (requestVersion !== this.#workspacesVersion) continue;
        if (isUnauthorized(error)) this.#options.onUnauthorized();
        else this.errorMessage = error instanceof Error ? error.message : 'Unable to load workspaces';
      }
    } while (this.#refreshQueued);
  }

  private applyWorkspaces(incomingWorkspaces: ManagedWorkspace[]) {
    const previousWorkspaces = new Map(this.workspaces.map((workspace) => [workspace.id, workspace]));
    const incomingWorkspaceIds = new Set(incomingWorkspaces.map((workspace) => workspace.id));
    for (const workspaceId of previousWorkspaces.keys()) {
      if (!incomingWorkspaceIds.has(workspaceId)) this.#backgroundTerminals.clearWorkspace(workspaceId);
    }
    const nextWorkspaces = incomingWorkspaces.map((workspace) => {
      const previous = previousWorkspaces.get(workspace.id);
      if (previous && previous.notePreview !== workspace.notePreview) this.#workspaceNotes.delete(workspace.id);
      if (workspace.state === 'missing') this.#backgroundTerminals.clearWorkspace(workspace.id);
      return {
        ...workspace,
        terminals:
          workspace.state === 'running'
            ? this.#backgroundTerminals.reconcile(workspace.id, workspace.terminals)
            : workspace.terminals,
        lastActiveAt: Math.max(workspace.lastActiveAt, previous?.lastActiveAt ?? 0),
        lastOutputAt: maxTimestamp(workspace.lastOutputAt, previous?.lastOutputAt ?? null),
      };
    });

    this.workspaces = nextWorkspaces;
    this.#activity.applyWorkspaces([...previousWorkspaces.values()], nextWorkspaces, this.workspacesLoaded);
    this.syncManualWorkspaceOrder();
    if (!this.workspacesLoaded) {
      this.newWorkspaceOpen = this.workspaces.length === 0;
      this.workspacesLoaded = true;
    }
  }

  async createWorkspace(tmuxAvailable?: boolean): Promise<boolean> {
    if (tmuxAvailable === false) {
      this.startError = 'Install tmux on the server computer before starting a workspace.';
      return false;
    }
    this.starting = true;
    this.startError = '';
    try {
      const data = await requestJson<{ workspace: ManagedWorkspace }>('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: this.cwd }),
      });
      this.invalidateWorkspaces();
      this.cwd = '';
      this.newWorkspaceOpen = false;
      this.workspaces = [...this.workspaces.filter((workspace) => workspace.id !== data.workspace.id), data.workspace];
      this.#activity.rebuild(this.workspaces);
      this.manualWorkspaceOrder = [
        ...this.manualWorkspaceOrder.filter((id) => id !== data.workspace.id),
        data.workspace.id,
      ];
      this.openWorkspace(data.workspace);
      void this.refresh({ quiet: true });
      return true;
    } catch (error) {
      this.startError = error instanceof Error ? error.message : 'Unable to start the shell';
      return false;
    } finally {
      this.starting = false;
    }
  }

  async createKingWorkspace(launchProfileId: string | null, tmuxAvailable?: boolean): Promise<boolean> {
    if (tmuxAvailable === false) {
      this.kingCreateError = 'Install tmux on the server computer before creating King.';
      return false;
    }
    this.creatingKing = true;
    this.kingCreateError = '';
    try {
      const data = await requestJson<{ workspace: ManagedWorkspace }>('/api/workspaces/king', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ launchProfileId }),
      });
      this.invalidateWorkspaces();
      this.workspaces = [...this.workspaces.filter((workspace) => workspace.id !== data.workspace.id), data.workspace];
      this.#activity.rebuild(this.workspaces);
      this.manualWorkspaceOrder = [
        data.workspace.id,
        ...this.manualWorkspaceOrder.filter((id) => id !== data.workspace.id),
      ];
      this.openWorkspace(data.workspace);
      void this.refresh({ quiet: true });
      return true;
    } catch (error) {
      if (isUnauthorized(error)) this.#options.onUnauthorized();
      this.kingCreateError = error instanceof Error ? error.message : 'Unable to create the King workspace';
      return false;
    } finally {
      this.creatingKing = false;
    }
  }

  async createIsolatedWorkspace(
    sourceWorkspaceId: string,
    name: string,
    tmuxAvailable?: boolean
  ): Promise<{ ok: boolean; error?: string }> {
    if (tmuxAvailable === false) {
      return { ok: false, error: 'Install tmux on the server computer before starting a workspace.' };
    }

    try {
      const data = await requestJson<{ workspace: ManagedWorkspace }>(
        `/api/workspaces/${encodeURIComponent(sourceWorkspaceId)}/worktrees`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        },
        'Unable to create the isolated workspace'
      );
      this.invalidateWorkspaces();
      this.workspaces = [...this.workspaces.filter((workspace) => workspace.id !== data.workspace.id), data.workspace];
      this.#activity.rebuild(this.workspaces);
      const manualOrder = reconcileWorkspaceOrder(this.workspaces, this.manualWorkspaceOrder).filter(
        (id) => id !== data.workspace.id
      );
      const sourceIndex = manualOrder.indexOf(sourceWorkspaceId);
      manualOrder.splice(sourceIndex < 0 ? manualOrder.length : sourceIndex + 1, 0, data.workspace.id);
      this.manualWorkspaceOrder = manualOrder;
      if (this.workspaceOrderMode === 'manual') {
        this.#preferencesInitialized = true;
        void this.persistWorkspacePreferences().then(() => this.refresh({ quiet: true }));
      } else {
        void this.refresh({ quiet: true });
      }
      this.openWorkspace(data.workspace);
      return { ok: true };
    } catch (error) {
      if (isUnauthorized(error)) this.#options.onUnauthorized();
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Unable to create the isolated workspace',
      };
    }
  }

  async updateWorkspaceNote(workspaceId: string, note: string) {
    const normalizedNote = note.trim();
    const data = await requestJson<{ notePreview: string }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/note`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: normalizedNote }),
    });
    this.#workspaceNotes.set(workspaceId, normalizedNote);
    this.workspaces = this.workspaces.map((workspace) =>
      workspace.id === workspaceId ? { ...workspace, notePreview: data.notePreview } : workspace
    );
  }

  async updateWorkspaceAlias(workspaceId: string, alias: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const data = await requestJson<{ alias: string | null }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/alias`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ alias }),
        },
        'Unable to save the workspace alias'
      );
      this.workspaces = this.workspaces.map((workspace) =>
        workspace.id === workspaceId ? { ...workspace, workspaceLabel: data.alias ?? '' } : workspace
      );
      return { ok: true };
    } catch (error) {
      if (isUnauthorized(error)) this.#options.onUnauthorized();
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Unable to save the workspace alias',
      };
    }
  }

  async loadWorkspaceNote(workspaceId: string, refresh = false): Promise<string> {
    const cached = refresh ? undefined : this.#workspaceNotes.get(workspaceId);
    if (cached !== undefined) return cached;
    const pending = this.#workspaceNoteRequests.get(workspaceId);
    if (pending) return pending;

    const request = requestJson<{ note: string }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/note`, {
      cache: 'no-store',
    })
      .then(({ note }) => {
        this.#workspaceNotes.set(workspaceId, note);
        return note;
      })
      .finally(() => {
        if (this.#workspaceNoteRequests.get(workspaceId) === request) this.#workspaceNoteRequests.delete(workspaceId);
      });
    this.#workspaceNoteRequests.set(workspaceId, request);
    return request;
  }

  async queueWorkspaceNoteUpdate(
    workspaceId: string,
    instructions: string
  ): Promise<{ automation: WorkspaceAutomation; notePath: string }> {
    try {
      return await requestJson<{ automation: WorkspaceAutomation; notePath: string }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/note/agent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ instructions }),
        },
        'Unable to queue the workspace note update'
      );
    } catch (error) {
      if (isUnauthorized(error)) this.#options.onUnauthorized();
      throw error;
    }
  }

  async updateWorkspaceStartup(
    workspaceId: string,
    launchProfiles: LaunchProfile[],
    startupProfileId: string | null
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const data = await requestJson<{
        launchProfiles: LaunchProfile[];
        startupProfileId: string | null;
        clearedWorkspaceIds: string[];
      }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/startup-profile`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ launchProfiles, startupProfileId }),
        },
        'Unable to save the startup profile'
      );
      this.applyLaunchProfiles(data.launchProfiles);
      const clearedWorkspaceIds = new Set(data.clearedWorkspaceIds);
      this.workspaces = this.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? { ...workspace, startupProfileId: data.startupProfileId }
          : clearedWorkspaceIds.has(workspace.id)
            ? { ...workspace, startupProfileId: null }
            : workspace
      );
      return { ok: true };
    } catch (error) {
      if (isUnauthorized(error)) this.#options.onUnauthorized();
      return { ok: false, error: error instanceof Error ? error.message : 'Unable to save the startup profile' };
    }
  }

  async startBackgroundProcess(workspaceId: string, command: string): Promise<WorkspaceTerminal | undefined> {
    if (this.startingBackgroundWorkspaceId || this.stoppingBackgroundProcessId) return undefined;
    this.startingBackgroundWorkspaceId = workspaceId;
    this.backgroundActionError = '';
    this.backgroundActionErrorWorkspaceId = undefined;
    try {
      const data = await requestJson<{ backgroundProcess: WorkspaceTerminal }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/background`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ command }),
        },
        'Unable to start the background command'
      );
      this.workspaces = this.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              terminals: this.#backgroundTerminals.applyStarted(
                workspaceId,
                workspace.terminals,
                data.backgroundProcess
              ),
            }
          : workspace
      );
      return data.backgroundProcess;
    } catch (error) {
      if (isUnauthorized(error)) this.#options.onUnauthorized();
      this.backgroundActionError = error instanceof Error ? error.message : 'Unable to start the background command';
      this.backgroundActionErrorWorkspaceId = workspaceId;
      return undefined;
    } finally {
      this.startingBackgroundWorkspaceId = undefined;
    }
  }

  async stopBackgroundProcess(workspaceId: string, processId: string): Promise<boolean> {
    if (this.startingBackgroundWorkspaceId || this.stoppingBackgroundProcessId) return false;
    this.stoppingBackgroundProcessId = processId;
    this.backgroundActionError = '';
    this.backgroundActionErrorWorkspaceId = undefined;
    try {
      await requestJson<{ ok: boolean }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/background/${encodeURIComponent(processId)}`,
        { method: 'DELETE' },
        'Unable to stop the background process'
      );
      this.workspaces = this.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              terminals: this.#backgroundTerminals.applyStopped(workspaceId, workspace.terminals, processId),
            }
          : workspace
      );
      return true;
    } catch (error) {
      if (isUnauthorized(error)) this.#options.onUnauthorized();
      this.backgroundActionError = error instanceof Error ? error.message : 'Unable to stop the background process';
      this.backgroundActionErrorWorkspaceId = workspaceId;
      return false;
    } finally {
      this.stoppingBackgroundProcessId = undefined;
    }
  }

  async loadBackgroundOutput(workspaceId: string, processId: string): Promise<string> {
    const data = await requestJson<{ output: string }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/background/${encodeURIComponent(processId)}/output`,
      { cache: 'no-store' },
      'Unable to read the background output'
    );
    return data.output;
  }

  async favoriteBackgroundCommand(workspaceId: string, command: string): Promise<boolean> {
    if (this.updatingFavoriteCommand) return false;
    this.updatingFavoriteCommand = command;
    this.backgroundActionError = '';
    this.backgroundActionErrorWorkspaceId = undefined;
    try {
      const data = await requestJson<{ favoriteCommands: string[] }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/background/favorites`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ command }),
        },
        'Unable to save the favorite command'
      );
      this.workspaces = this.workspaces.map((workspace) =>
        workspace.id === workspaceId ? { ...workspace, favoriteCommands: data.favoriteCommands } : workspace
      );
      return true;
    } catch (error) {
      if (isUnauthorized(error)) this.#options.onUnauthorized();
      this.backgroundActionError = error instanceof Error ? error.message : 'Unable to save the favorite command';
      this.backgroundActionErrorWorkspaceId = workspaceId;
      return false;
    } finally {
      this.updatingFavoriteCommand = undefined;
    }
  }

  async removeBackgroundCommandFavorite(workspaceId: string, command: string): Promise<boolean> {
    if (this.updatingFavoriteCommand) return false;
    this.updatingFavoriteCommand = command;
    this.backgroundActionError = '';
    this.backgroundActionErrorWorkspaceId = undefined;
    try {
      const data = await requestJson<{ favoriteCommands: string[] }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/background/favorites`,
        {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ command }),
        },
        'Unable to remove the favorite command'
      );
      this.workspaces = this.workspaces.map((workspace) =>
        workspace.id === workspaceId ? { ...workspace, favoriteCommands: data.favoriteCommands } : workspace
      );
      return true;
    } catch (error) {
      if (isUnauthorized(error)) this.#options.onUnauthorized();
      this.backgroundActionError = error instanceof Error ? error.message : 'Unable to remove the favorite command';
      this.backgroundActionErrorWorkspaceId = workspaceId;
      return false;
    } finally {
      this.updatingFavoriteCommand = undefined;
    }
  }

  restoreBrowserPreferences(storage: Storage) {
    this.#activity.restoreBrowserPreferences(storage);
    this.#compatibilityPreferenceStorage = storage;
    const savedMode =
      storage.getItem(WORKSPACE_ORDER_MODE_KEY) ?? storage.getItem(COMPATIBILITY_SESSION_ORDER_MODE_KEY);
    if (savedMode === 'activity' || savedMode === 'manual') this.workspaceOrderMode = savedMode;
    try {
      const savedOrder: unknown = JSON.parse(
        storage.getItem(WORKSPACE_ORDER_KEY) ?? storage.getItem(COMPATIBILITY_SESSION_ORDER_KEY) ?? '[]'
      );
      if (Array.isArray(savedOrder) && savedOrder.every((id) => typeof id === 'string')) {
        this.manualWorkspaceOrder = savedOrder;
      }
    } catch {
      this.manualWorkspaceOrder = [];
    }
  }

  setWorkspaceOrderMode(mode: WorkspaceOrderMode) {
    const changed = this.workspaceOrderMode !== mode;
    const needsInitialization = !this.#preferencesInitialized;
    this.#preferencesInitialized = true;
    this.workspaceOrderMode = mode;
    if (mode === 'manual') this.syncManualWorkspaceOrder();
    if (changed || needsInitialization) this.persistWorkspacePreferences();
  }

  reorderWorkspace(draggedId: string, targetId: string, position: 'before' | 'after') {
    if (draggedId === targetId) return;
    const order = this.displayedWorkspaces.map((workspace) => workspace.id).filter((id) => id !== draggedId);
    const targetIndex = order.indexOf(targetId);
    if (targetIndex < 0) return;
    order.splice(targetIndex + (position === 'after' ? 1 : 0), 0, draggedId);
    this.manualWorkspaceOrder = order;
    this.#preferencesInitialized = true;
    this.persistWorkspacePreferences();
  }

  recordWorkspaceInput(workspaceId: string, timestamp: number) {
    this.workspaces = this.workspaces.map((workspace) =>
      workspace.id === workspaceId ? { ...workspace, lastActiveAt: timestamp } : workspace
    );
    const existingTimer = this.#activityRequestTimers.get(workspaceId);
    if (existingTimer !== undefined) window.clearTimeout(existingTimer);
    this.#activityRequestTimers.set(
      workspaceId,
      window.setTimeout(() => {
        this.#activityRequestTimers.delete(workspaceId);
        void requestJson<{ lastActiveAt: number }>(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
          method: 'PATCH',
        })
          .then(({ lastActiveAt }) => {
            this.workspaces = this.workspaces.map((workspace) =>
              workspace.id === workspaceId
                ? { ...workspace, lastActiveAt: Math.max(workspace.lastActiveAt, lastActiveAt) }
                : workspace
            );
          })
          .catch(() => undefined);
      }, 600)
    );
  }

  recordWorkspaceOutput(workspaceId: string, active: boolean, timestamp?: number, observed = false) {
    this.#activity.recordWorkspaceOutput(workspaceId, active, timestamp, observed);
  }

  markWorkspaceObserved(workspaceId: string) {
    this.#activity.markWorkspaceObserved(workspaceId);
  }

  openWorkspace(workspace: ManagedWorkspace) {
    const previousWorkspaceId = this.requestedWorkspaceId;
    if (
      previousWorkspaceId &&
      previousWorkspaceId !== workspace.id &&
      this.#options.isWorkspaceObserved(previousWorkspaceId)
    ) {
      this.markWorkspaceObserved(previousWorkspaceId);
    }
    if (this.activeWorkspace?.id === workspace.id && this.requestedWorkspaceId === workspace.id) return;
    this.requestedWorkspaceId = workspace.id;
    this.workspaceActionError = '';
    this.#options.navigate(`/workspaces/${encodeURIComponent(workspace.id)}`);
  }

  clearActiveWorkspace() {
    if (this.requestedWorkspaceId && this.#options.isWorkspaceObserved(this.requestedWorkspaceId)) {
      this.markWorkspaceObserved(this.requestedWorkspaceId);
    }
    this.requestedWorkspaceId = undefined;
    this.workspaceActionError = '';
    this.#options.navigate('/');
  }

  syncLocation(pathname: string) {
    const match = /^\/workspaces\/([^/]+)\/?$/.exec(pathname);
    const nextWorkspaceId = match ? decodeURIComponent(match[1]) : undefined;
    if (
      this.requestedWorkspaceId &&
      this.requestedWorkspaceId !== nextWorkspaceId &&
      this.#options.isWorkspaceObserved(this.requestedWorkspaceId)
    ) {
      this.markWorkspaceObserved(this.requestedWorkspaceId);
    }
    this.requestedWorkspaceId = nextWorkspaceId;
    if (this.requestedWorkspaceId && this.#options.isWorkspaceObserved(this.requestedWorkspaceId)) {
      this.markWorkspaceObserved(this.requestedWorkspaceId);
    }
    this.workspaceActionError = '';
  }

  async restartWorkspace(workspace: ManagedWorkspace, launchProfileId?: string | null): Promise<boolean> {
    this.workspaceAction = 'restart';
    this.workspaceActionError = '';
    try {
      const data = await requestJson<{ workspace: ManagedWorkspace }>(
        `/api/workspaces/${encodeURIComponent(workspace.id)}`,
        {
          method: 'POST',
          ...(launchProfileId === undefined
            ? {}
            : {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ launchProfileId }),
              }),
        }
      );
      this.#backgroundTerminals.clearWorkspace(workspace.id);
      this.invalidateWorkspaces();
      this.workspaces = this.workspaces.map((item) => (item.id === data.workspace.id ? data.workspace : item));
      this.#activity.rebuild(this.workspaces);
      void this.refresh({ quiet: true });
      return true;
    } catch (error) {
      this.workspaceActionError = error instanceof Error ? error.message : 'Unable to restart the workspace';
      return false;
    } finally {
      this.workspaceAction = undefined;
    }
  }

  async closeWorkspace(workspace: ManagedWorkspace): Promise<boolean> {
    this.workspaceAction = 'close';
    this.workspaceActionError = '';
    try {
      await requestJson<{ ok: boolean }>(`/api/workspaces/${encodeURIComponent(workspace.id)}/close`, {
        method: 'POST',
      });
      this.#backgroundTerminals.clearWorkspace(workspace.id);
      this.invalidateWorkspaces();
      this.workspaces = this.workspaces.map((item) =>
        item.id === workspace.id
          ? {
              ...item,
              state: 'missing',
              lastOutputAt: null,
              attachedClients: 0,
              foregroundProcess: null,
              terminals: [],
            }
          : item
      );
      this.#activity.clearOutputActivity(workspace.id);
      this.markWorkspaceObserved(workspace.id);
      this.#activity.rebuild(this.workspaces);
      if (this.requestedWorkspaceId === workspace.id) this.clearActiveWorkspace();
      void this.refresh({ quiet: true });
      return true;
    } catch (error) {
      this.workspaceActionError = error instanceof Error ? error.message : 'Unable to close the workspace';
      return false;
    } finally {
      this.workspaceAction = undefined;
    }
  }

  async removeWorkspace(workspace: ManagedWorkspace): Promise<boolean> {
    this.workspaceAction = 'remove';
    this.workspaceActionError = '';
    this.backgroundActionError = '';
    this.backgroundActionErrorWorkspaceId = undefined;
    try {
      await requestJson<{ ok: boolean }>(`/api/workspaces/${encodeURIComponent(workspace.id)}?terminate=true`, {
        method: 'DELETE',
      });
      this.#backgroundTerminals.clearWorkspace(workspace.id);
      this.invalidateWorkspaces();
      this.workspaces = this.workspaces.filter((item) => item.id !== workspace.id);
      this.#activity.removeWorkspace(workspace.id);
      this.manualWorkspaceOrder = this.manualWorkspaceOrder.filter((id) => id !== workspace.id);
      if (this.requestedWorkspaceId === workspace.id) this.clearActiveWorkspace();
      return true;
    } catch (error) {
      this.workspaceActionError = error instanceof Error ? error.message : 'Unable to remove the workspace';
      return false;
    } finally {
      this.workspaceAction = undefined;
    }
  }

  reset() {
    this.invalidateWorkspaces();
    this.clearAllInputActivity();
    this.#activity.reset();
    this.#backgroundTerminals.clear();
    this.workspaces = [];
    this.launchProfiles = [];
    this.requestedWorkspaceId = undefined;
    this.#workspaceNotes.clear();
    this.#workspaceNoteRequests.clear();
    this.workspacesLoaded = false;
    this.newWorkspaceOpen = false;
    this.creatingKing = false;
    this.kingCreateError = '';
    this.errorMessage = '';
    this.workspaceActionError = '';
    this.startingBackgroundWorkspaceId = undefined;
    this.stoppingBackgroundProcessId = undefined;
    this.updatingFavoriteCommand = undefined;
    this.backgroundActionError = '';
    this.backgroundActionErrorWorkspaceId = undefined;
    this.workspaceOrderMode = 'activity';
    this.manualWorkspaceOrder = [];
    this.workspacePreferencesError = '';
    this.#preferencesInitialized = false;
    this.#preferenceMutationVersion += 1;
  }

  dispose() {
    this.clearAllInputActivity();
    this.#activity.dispose();
    this.#backgroundTerminals.clear();
    this.#workspaceNotes.clear();
    this.#workspaceNoteRequests.clear();
  }

  private invalidateWorkspaces() {
    this.#workspacesVersion += 1;
    this.#refreshQueued = true;
  }

  private clearAllInputActivity() {
    for (const timer of this.#activityRequestTimers.values()) window.clearTimeout(timer);
    this.#activityRequestTimers.clear();
  }

  private acceptWorkspacePreferences(preferences: WorkspacePreferences) {
    this.#preferencesInitialized = true;
    this.workspaceOrderMode = preferences.workspaceOrderMode;
    this.manualWorkspaceOrder = reconcileWorkspaceOrder(this.workspaces, preferences.manualWorkspaceOrder);
    this.workspacePreferencesError = '';
    this.#compatibilityPreferenceStorage?.removeItem(WORKSPACE_ORDER_MODE_KEY);
    this.#compatibilityPreferenceStorage?.removeItem(WORKSPACE_ORDER_KEY);
    this.#compatibilityPreferenceStorage?.removeItem(COMPATIBILITY_SESSION_ORDER_MODE_KEY);
    this.#compatibilityPreferenceStorage?.removeItem(COMPATIBILITY_SESSION_ORDER_KEY);
  }

  private persistWorkspacePreferences() {
    const preferences: WorkspacePreferences = {
      workspaceOrderMode: this.workspaceOrderMode,
      manualWorkspaceOrder: reconcileWorkspaceOrder(this.workspaces, this.manualWorkspaceOrder),
    };
    this.manualWorkspaceOrder = preferences.manualWorkspaceOrder;
    const mutationVersion = ++this.#preferenceMutationVersion;
    this.#pendingPreferenceWrites += 1;
    this.workspacePreferencesError = '';
    this.#preferenceWriteQueue = this.#preferenceWriteQueue.then(async () => {
      let savedPreferences: WorkspacePreferences | undefined;
      try {
        const data = await requestJson<{ preferences: WorkspacePreferences }>(
          '/api/workspace-preferences',
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(preferences),
          },
          'Unable to sync workspace order'
        );
        savedPreferences = data.preferences;
      } catch (error) {
        if (isUnauthorized(error)) this.#options.onUnauthorized();
        if (mutationVersion === this.#preferenceMutationVersion) {
          this.workspacePreferencesError = error instanceof Error ? error.message : 'Unable to sync workspace order';
        }
      } finally {
        this.#pendingPreferenceWrites -= 1;
      }
      if (savedPreferences && mutationVersion === this.#preferenceMutationVersion) {
        this.acceptWorkspacePreferences(savedPreferences);
      }
    });
    return this.#preferenceWriteQueue;
  }

  private syncManualWorkspaceOrder() {
    const nextOrder = reconcileWorkspaceOrder(this.workspaces, this.manualWorkspaceOrder);
    if (nextOrder.join('\0') === this.manualWorkspaceOrder.join('\0')) return;
    this.manualWorkspaceOrder = nextOrder;
  }
}
