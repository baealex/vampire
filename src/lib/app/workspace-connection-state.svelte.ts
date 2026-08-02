import { isUnauthorized, requestJson } from '$lib/client/request';
import type { ManagedSession } from '$lib/session/types';
import { SYSTEM_METRICS_INTERVAL_MS, type SystemMetrics } from '$lib/system-metrics';
import type { TmuxStatus } from '$lib/tmux-status';
import { decodeWorkspaceServerMessage, type SessionChanges } from './workspace-protocol.ts';

type SessionRefresher = (options?: { quiet?: boolean }) => Promise<void> | void;
type WorkspaceSessionEvent =
	| { type: 'sessions-snapshot'; sessions: ManagedSession[] }
	| { type: 'session-added'; session: ManagedSession }
	| { type: 'session-updated'; id: string; changes: SessionChanges }
	| { type: 'session-removed'; id: string };

type StatusResponse = {
	authenticationRequired: boolean;
	authenticated: boolean;
	tmux: TmuxStatus;
	system?: SystemMetrics;
};

type ConnectionStartOptions = {
	refreshSessions: SessionRefresher;
	onVisible?: () => void;
	onSessionEvent?: (event: WorkspaceSessionEvent) => void;
};

export class WorkspaceConnectionState {
	authenticationRequired = $state(true);
	authenticated = $state(false);
	checking = $state(true);
	token = $state('');
	loginError = $state('');
	errorMessage = $state('');
	tmuxStatus = $state<TmuxStatus | undefined>(undefined);
	systemMetrics = $state<SystemMetrics | undefined>(undefined);

	#authenticationVersion = 0;
	#runVersion = 0;
	#stopCurrentRun: (() => void) | undefined;
	#systemRequestInFlight = false;
	#connectionOptions: ConnectionStartOptions | undefined;
	#workspaceSocket: WebSocket | undefined;
	#workspaceReconnectTimer: number | undefined;
	#workspaceFallbackTimer: number | undefined;
	#systemFallbackTimer: number | undefined;
	#workspaceSnapshotTimer: number | undefined;
	#workspaceReconnectAttempt = 0;

	start(options: ConnectionStartOptions): () => void {
		this.#stopCurrentRun?.();
		const runVersion = ++this.#runVersion;
		const abortController = new AbortController();
		this.#connectionOptions = options;
		this.checking = true;

		void this.#loadStatus(runVersion, abortController.signal);
		const refreshWhenVisible = () => {
			if (document.hidden || !this.authenticated) return;
			options.onVisible?.();
			const socketState = this.#workspaceSocket?.readyState;
			if (socketState !== WebSocket.OPEN && socketState !== WebSocket.CONNECTING) {
				void this.refreshSystemMetrics();
			}
			this.#startWorkspaceStream(options, runVersion);
		};
		document.addEventListener('visibilitychange', refreshWhenVisible);
		if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => undefined);

		const stop = () => {
			if (runVersion !== this.#runVersion) return;
			this.#runVersion += 1;
			abortController.abort();
			this.#stopWorkspaceStream();
			document.removeEventListener('visibilitychange', refreshWhenVisible);
			this.#stopCurrentRun = undefined;
			this.#connectionOptions = undefined;
		};
		this.#stopCurrentRun = stop;
		return stop;
	}

	async unlock() {
		this.loginError = '';
		try {
			await requestJson<{ ok: boolean }>('/api/login', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ token: this.token })
			});
			this.token = '';
			this.authenticated = true;
			this.#authenticationVersion += 1;
			if (this.#connectionOptions) this.#startWorkspaceStream(this.#connectionOptions, this.#runVersion);
		} catch (error) {
			this.loginError = isUnauthorized(error)
				? 'That access token did not work.'
				: error instanceof Error ? error.message : 'Unable to connect';
		}
	}

	async logout(): Promise<boolean> {
		try {
			await requestJson<{ ok: boolean }>('/api/login', { method: 'DELETE' });
		} catch (error) {
			this.errorMessage = error instanceof Error ? error.message : 'Unable to sign out';
			return false;
		}
		this.markUnauthenticated();
		return true;
	}

	markUnauthenticated() {
		this.#authenticationVersion += 1;
		this.authenticated = false;
		this.systemMetrics = undefined;
		this.#stopWorkspaceStream();
	}

	async refreshSystemMetrics() {
		if (!this.authenticated || document.hidden || this.#systemRequestInFlight) return;
		const authenticationVersion = this.#authenticationVersion;
		this.#systemRequestInFlight = true;
		try {
			const metrics = await requestJson<SystemMetrics>('/api/system');
			if (this.authenticated && authenticationVersion === this.#authenticationVersion) this.systemMetrics = metrics;
		} catch (error) {
			if (isUnauthorized(error)) this.markUnauthenticated();
		} finally {
			this.#systemRequestInFlight = false;
		}
	}

	async #loadStatus(runVersion: number, signal: AbortSignal) {
		let shouldRefreshSessions = false;
		try {
			const status = await requestJson<StatusResponse>('/api/status', { signal });
			if (runVersion !== this.#runVersion) return;
			this.authenticationRequired = status.authenticationRequired;
			this.authenticated = status.authenticated;
			this.tmuxStatus = status.tmux;
			this.systemMetrics = status.system;
			shouldRefreshSessions = status.authenticated;
		} catch (error) {
			if (runVersion === this.#runVersion && !signal.aborted) {
				this.errorMessage = error instanceof Error ? error.message : 'Unable to connect to Vampire';
			}
		} finally {
			if (runVersion === this.#runVersion) this.checking = false;
		}
		if (shouldRefreshSessions && runVersion === this.#runVersion && this.#connectionOptions) {
			this.#startWorkspaceStream(this.#connectionOptions, runVersion);
		}
	}

	#startWorkspaceStream(options: ConnectionStartOptions, runVersion: number) {
		if (runVersion !== this.#runVersion || !this.authenticated) return;
		const socketState = this.#workspaceSocket?.readyState;
		if (socketState === WebSocket.OPEN || socketState === WebSocket.CONNECTING) return;
		if (this.#workspaceReconnectTimer !== undefined) {
			window.clearTimeout(this.#workspaceReconnectTimer);
			this.#workspaceReconnectTimer = undefined;
		}

		const websocketUrl = new URL(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/workspace`);
		const socket = new WebSocket(websocketUrl);
		this.#workspaceSocket = socket;
		if (this.#workspaceSnapshotTimer !== undefined) window.clearTimeout(this.#workspaceSnapshotTimer);
		this.#workspaceSnapshotTimer = window.setTimeout(() => {
			this.#workspaceSnapshotTimer = undefined;
			if (runVersion === this.#runVersion && this.authenticated) {
				this.#startWorkspaceFallback(options, runVersion);
				void options.refreshSessions({ quiet: true });
			}
		}, 3_000);
		socket.onopen = () => {
			this.#workspaceReconnectAttempt = 0;
		};
		socket.onmessage = (event) => {
			const message = decodeWorkspaceServerMessage(event.data);
			if (!message) return;
			if (message.type === 'system-metrics') {
				this.systemMetrics = message.metrics;
			} else if (message.type === 'sessions-snapshot') {
				this.#stopWorkspaceFallback();
				this.#stopWorkspaceSnapshotTimer();
				options.onSessionEvent?.({ type: 'sessions-snapshot', sessions: message.sessions });
			} else if (message.type === 'session-added') {
				options.onSessionEvent?.({ type: 'session-added', session: message.session });
			} else if (message.type === 'session-updated') {
				options.onSessionEvent?.({ type: 'session-updated', id: message.id, changes: message.changes });
			} else if (message.type === 'session-removed') {
				options.onSessionEvent?.({ type: 'session-removed', id: message.id });
			} else if (message.type === 'error') {
				this.errorMessage = message.message;
			}
		};
		socket.onerror = () => undefined;
		socket.onclose = (event) => {
			if (this.#workspaceSocket !== socket) return;
			this.#workspaceSocket = undefined;
			if (event.code === 1008 && event.reason === 'authentication expired') {
				this.markUnauthenticated();
				return;
			}
			if (runVersion !== this.#runVersion || !this.authenticated) return;
			this.#startWorkspaceFallback(options, runVersion);
			this.#scheduleWorkspaceReconnect(options, runVersion);
		};
	}

	#startWorkspaceFallback(options: ConnectionStartOptions, runVersion: number) {
		if (this.#workspaceFallbackTimer === undefined) {
			this.#workspaceFallbackTimer = window.setInterval(() => {
				if (runVersion !== this.#runVersion || document.hidden || !this.authenticated) return;
				void options.refreshSessions({ quiet: true });
			}, 10_000);
		}
		if (this.#systemFallbackTimer === undefined) {
			void this.refreshSystemMetrics();
			this.#systemFallbackTimer = window.setInterval(() => {
				if (runVersion !== this.#runVersion || document.hidden || !this.authenticated) return;
				void this.refreshSystemMetrics();
			}, SYSTEM_METRICS_INTERVAL_MS);
		}
	}

	#stopWorkspaceFallback() {
		if (this.#workspaceFallbackTimer !== undefined) window.clearInterval(this.#workspaceFallbackTimer);
		if (this.#systemFallbackTimer !== undefined) window.clearInterval(this.#systemFallbackTimer);
		this.#workspaceFallbackTimer = undefined;
		this.#systemFallbackTimer = undefined;
	}

	#stopWorkspaceSnapshotTimer() {
		if (this.#workspaceSnapshotTimer === undefined) return;
		window.clearTimeout(this.#workspaceSnapshotTimer);
		this.#workspaceSnapshotTimer = undefined;
	}

	#scheduleWorkspaceReconnect(options: ConnectionStartOptions, runVersion: number) {
		if (this.#workspaceReconnectTimer !== undefined) return;
		const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.#workspaceReconnectAttempt, 5));
		this.#workspaceReconnectAttempt += 1;
		this.#workspaceReconnectTimer = window.setTimeout(() => {
			this.#workspaceReconnectTimer = undefined;
			this.#startWorkspaceStream(options, runVersion);
		}, delay);
	}

	#stopWorkspaceStream() {
		if (this.#workspaceReconnectTimer !== undefined) {
			window.clearTimeout(this.#workspaceReconnectTimer);
			this.#workspaceReconnectTimer = undefined;
		}
		this.#stopWorkspaceFallback();
		this.#stopWorkspaceSnapshotTimer();
		this.#workspaceReconnectAttempt = 0;
		const socket = this.#workspaceSocket;
		this.#workspaceSocket = undefined;
		if (socket && socket.readyState !== WebSocket.CLOSED) socket.close(1000, 'workspace stream stopped');
	}
}
