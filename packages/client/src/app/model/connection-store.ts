import type { StatusPluginSnapshot } from '@vampire/lib/shared/contracts/status-plugin.ts';
import type { TmuxStatus } from '@vampire/lib/shared/contracts/tmux-status.ts';
import type { LaunchProfile, ManagedWorkspace, WorkspacePreferences } from '@vampire/lib/shared/contracts/workspace.ts';
import {
  decodeWorkspaceServerMessage,
  type WorkspaceChanges,
} from '@vampire/lib/shared/contracts/workspace-protocol.ts';
import { create } from 'zustand';
import { queryClient } from '~/shared/api/query-client.ts';
import { isUnauthorized, requestJson } from '~/shared/api/request.ts';

export type WorkspaceEvent =
  | {
      type: 'workspaces-snapshot';
      workspaces: ManagedWorkspace[];
      preferences?: WorkspacePreferences | null;
      launchProfiles?: LaunchProfile[];
      defaultStartupProfileId?: string | null;
    }
  | { type: 'workspace-added'; workspace: ManagedWorkspace }
  | { type: 'workspace-updated'; id: string; changes: WorkspaceChanges }
  | { type: 'workspace-removed'; id: string }
  | { type: 'workspace-preferences-updated'; preferences: WorkspacePreferences | null }
  | { type: 'launch-profiles-updated'; launchProfiles: LaunchProfile[]; defaultStartupProfileId?: string | null };

type StatusResponse = { authenticationRequired: boolean; authenticated: boolean; tmux: TmuxStatus | null };
type StartOptions = {
  onVisible?: () => void;
  onWorkspaceEvent?: (event: WorkspaceEvent) => void;
  refreshWorkspaces: (options?: { quiet?: boolean }) => Promise<void> | void;
};

type ConnectionStore = {
  authenticated: boolean;
  authenticationRequired: boolean;
  checking: boolean;
  errorMessage: string;
  loginError: string;
  statusPlugins: StatusPluginSnapshot[];
  tmuxStatus?: TmuxStatus;
  token: string;
  logout: () => Promise<boolean>;
  markUnauthenticated: () => void;
  setToken: (token: string) => void;
  start: (options: StartOptions) => () => void;
  unlock: () => Promise<void>;
};

let authenticationVersion = 0;
let runVersion = 0;
let stopCurrentRun: (() => void) | undefined;
let connectionOptions: StartOptions | undefined;
let workspaceEventSource: EventSource | undefined;
let workspaceFallbackTimer: number | undefined;
let workspaceSnapshotTimer: number | undefined;

function stopWorkspaceFallback(): void {
  if (workspaceFallbackTimer !== undefined) window.clearInterval(workspaceFallbackTimer);
  workspaceFallbackTimer = undefined;
}

function stopWorkspaceSnapshotTimer(): void {
  if (workspaceSnapshotTimer !== undefined) window.clearTimeout(workspaceSnapshotTimer);
  workspaceSnapshotTimer = undefined;
}

function stopWorkspaceStream(): void {
  stopWorkspaceFallback();
  stopWorkspaceSnapshotTimer();
  const source = workspaceEventSource;
  workspaceEventSource = undefined;
  source?.close();
}

function startWorkspaceFallback(options: StartOptions, version: number): void {
  if (workspaceFallbackTimer !== undefined) return;
  workspaceFallbackTimer = window.setInterval(() => {
    if (version !== runVersion || document.hidden || !useConnectionStore.getState().authenticated) return;
    void options.refreshWorkspaces({ quiet: true });
  }, 10_000);
}

function startWorkspaceStream(options: StartOptions, version: number): void {
  if (version !== runVersion || !useConnectionStore.getState().authenticated || workspaceEventSource) return;
  const source = new EventSource('/events/workspaces');
  workspaceEventSource = source;
  stopWorkspaceSnapshotTimer();
  workspaceSnapshotTimer = window.setTimeout(() => {
    workspaceSnapshotTimer = undefined;
    if (version === runVersion && useConnectionStore.getState().authenticated) {
      startWorkspaceFallback(options, version);
      void options.refreshWorkspaces({ quiet: true });
    }
  }, 3_000);

  source.onmessage = (event) => {
    const message = decodeWorkspaceServerMessage(event.data);
    if (!message) return;
    if (message.type === 'workspaces-snapshot') {
      stopWorkspaceFallback();
      stopWorkspaceSnapshotTimer();
      options.onWorkspaceEvent?.(message);
      if (
        message.preferences === undefined ||
        message.launchProfiles === undefined ||
        message.defaultStartupProfileId === undefined
      ) {
        void options.refreshWorkspaces({ quiet: true });
      }
    } else if (message.type === 'status-plugins-snapshot') {
      useConnectionStore.setState({ statusPlugins: message.plugins });
    } else if (message.type === 'error') {
      useConnectionStore.setState({ errorMessage: message.message });
    } else {
      options.onWorkspaceEvent?.(message);
    }
  };
  const endAuthentication = () => {
    if (workspaceEventSource !== source) return;
    source.close();
    workspaceEventSource = undefined;
    useConnectionStore.getState().markUnauthenticated();
  };
  source.addEventListener('authentication-expired', endAuthentication);
  source.addEventListener('authentication-revoked', endAuthentication);
  source.onerror = () => {
    if (workspaceEventSource === source && version === runVersion && useConnectionStore.getState().authenticated) {
      startWorkspaceFallback(options, version);
    }
  };
}

async function refreshAuthenticatedStatus(version: number): Promise<void> {
  try {
    const status = await requestJson<StatusResponse>('/api/status');
    if (version !== authenticationVersion) return;
    if (!status.authenticated) useConnectionStore.getState().markUnauthenticated();
    else useConnectionStore.setState({ tmuxStatus: status.tmux ?? undefined });
  } catch (error) {
    if (version === authenticationVersion) {
      useConnectionStore.setState({
        errorMessage: error instanceof Error ? error.message : 'Unable to refresh Vampire status',
      });
    }
  }
}

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
  authenticated: false,
  authenticationRequired: true,
  checking: true,
  errorMessage: '',
  loginError: '',
  statusPlugins: [],
  token: '',
  setToken: (token) => set({ token, loginError: '' }),
  markUnauthenticated() {
    authenticationVersion += 1;
    stopWorkspaceStream();
    queryClient.clear();
    set({ authenticated: false, statusPlugins: [] });
  },
  async unlock() {
    set({ loginError: '' });
    try {
      await requestJson<{ ok: boolean }>('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: get().token }),
      });
      set({ authenticated: true, token: '' });
      const version = ++authenticationVersion;
      void refreshAuthenticatedStatus(version);
      // Authentication unlocks the shell immediately. Workspace data arrives
      // independently over SSE (with the REST fallback retained below).
      if (connectionOptions) startWorkspaceStream(connectionOptions, runVersion);
    } catch (error) {
      set({
        loginError: isUnauthorized(error)
          ? 'That access token did not work. Check it and try again.'
          : error instanceof Error
            ? error.message
            : 'Unable to connect',
      });
    }
  },
  async logout() {
    try {
      await requestJson<{ ok: boolean }>('/api/login', { method: 'DELETE' });
    } catch (error) {
      set({ errorMessage: error instanceof Error ? error.message : 'Unable to sign out' });
      return false;
    }
    get().markUnauthenticated();
    return true;
  },
  start(options) {
    stopCurrentRun?.();
    const version = ++runVersion;
    const abortController = new AbortController();
    connectionOptions = options;
    set({ checking: true });
    void (async () => {
      let shouldRefresh = false;
      try {
        const status = await requestJson<StatusResponse>('/api/status', { signal: abortController.signal });
        if (version !== runVersion) return;
        set({
          authenticationRequired: status.authenticationRequired,
          authenticated: status.authenticated,
          tmuxStatus: status.tmux ?? undefined,
        });
        shouldRefresh = status.authenticated;
      } catch (error) {
        if (version === runVersion && !abortController.signal.aborted)
          set({ errorMessage: error instanceof Error ? error.message : 'Unable to connect to Vampire' });
      } finally {
        if (version === runVersion) set({ checking: false });
      }
      if (shouldRefresh && version === runVersion) startWorkspaceStream(options, version);
    })();
    const refreshWhenVisible = () => {
      if (document.hidden || !get().authenticated) return;
      options.onVisible?.();
      startWorkspaceStream(options, version);
    };
    document.addEventListener('visibilitychange', refreshWhenVisible);
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    const stop = () => {
      if (version !== runVersion) return;
      runVersion += 1;
      abortController.abort();
      stopWorkspaceStream();
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      stopCurrentRun = undefined;
      connectionOptions = undefined;
    };
    stopCurrentRun = stop;
    return stop;
  },
}));
