import { isUnauthorized, requestJson } from '$lib/client/request';
import type { SystemMetrics } from '$lib/system-metrics';
import type { TmuxStatus } from '$lib/tmux-status';

type SessionRefresher = (options?: { quiet?: boolean }) => Promise<void> | void;

type StatusResponse = {
	authenticationRequired: boolean;
	authenticated: boolean;
	tmux: TmuxStatus;
	system?: SystemMetrics;
};

type ConnectionStartOptions = {
	refreshSessions: SessionRefresher;
	onVisible?: () => void;
};

export class WorkspaceConnectionState {
	authenticationRequired = $state(true);
	authenticated = $state(false);
	checking = $state(true);
	token = $state('');
	loginError = $state('');
	errorMessage = $state('');
	transportSecure = $state(true);
	tmuxStatus = $state<TmuxStatus | undefined>(undefined);
	systemMetrics = $state<SystemMetrics | undefined>(undefined);

	#authenticationVersion = 0;
	#runVersion = 0;
	#stopCurrentRun: (() => void) | undefined;
	#systemRequestInFlight = false;

	start(options: ConnectionStartOptions): () => void {
		this.#stopCurrentRun?.();
		const runVersion = ++this.#runVersion;
		const abortController = new AbortController();
		this.checking = true;
		this.transportSecure = location.protocol === 'https:' || ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);

		void this.#loadStatus(options.refreshSessions, runVersion, abortController.signal);
		const refreshWhenVisible = () => {
			if (document.hidden || !this.authenticated) return;
			options.onVisible?.();
			void options.refreshSessions({ quiet: true });
			void this.refreshSystemMetrics();
		};
		const sessionInterval = window.setInterval(() => {
			if (!document.hidden && this.authenticated) void options.refreshSessions({ quiet: true });
		}, 2_000);
		const metricsInterval = window.setInterval(() => void this.refreshSystemMetrics(), 5_000);
		document.addEventListener('visibilitychange', refreshWhenVisible);
		if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => undefined);

		const stop = () => {
			if (runVersion !== this.#runVersion) return;
			this.#runVersion += 1;
			abortController.abort();
			window.clearInterval(sessionInterval);
			window.clearInterval(metricsInterval);
			document.removeEventListener('visibilitychange', refreshWhenVisible);
			this.#stopCurrentRun = undefined;
		};
		this.#stopCurrentRun = stop;
		return stop;
	}

	async unlock(refreshSessions: SessionRefresher) {
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
			await Promise.all([refreshSessions(), this.refreshSystemMetrics()]);
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

	async #loadStatus(refreshSessions: SessionRefresher, runVersion: number, signal: AbortSignal) {
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
		if (shouldRefreshSessions && runVersion === this.#runVersion) void refreshSessions();
	}
}
