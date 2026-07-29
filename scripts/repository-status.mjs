import { watch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readRepositorySummary, readRepositoryWatchPaths } from '../src/lib/server/repository.mjs';
import { findSessionConnection } from '../src/lib/server/session-state.mjs';
import { encodeTerminalServerMessage } from '../src/lib/terminal/protocol.mjs';

const STATUS_SETTLE_MS = 400;
const FALLBACK_REFRESH_MS = 10_000;

function send(socket, payload) {
	if (socket.readyState === 1) socket.send(encodeTerminalServerMessage(payload));
}

function normalizedFilename(filename) {
	if (filename === null || filename === undefined) return '';
	return String(filename).replaceAll('\\', '/');
}

function shouldRefreshForWorkspaceEvent(filename) {
	const path = normalizedFilename(filename);
	if (!path) return true;
	if (path === 'node_modules' || path.startsWith('node_modules/')) return false;
	if (path === '.git') return true;
	if (!path.startsWith('.git/')) return true;
	return path === '.git/HEAD'
		|| path === '.git/index'
		|| path === '.git/packed-refs'
		|| path.startsWith('.git/refs/');
}

function shouldRefreshForGitEvent(filename) {
	const path = normalizedFilename(filename);
	return !path
		|| path === 'HEAD'
		|| path === 'index'
		|| path === 'packed-refs'
		|| path === 'worktrees'
		|| path.startsWith('worktrees/')
		|| path === 'refs'
		|| path.startsWith('refs/');
}

class RepositoryStatusMonitor {
	#abortController = new AbortController();
	#disposed = false;
	#fallbackTimer;
	#refreshQueued = false;
	#refreshTimer;
	#refreshing = false;
	#sockets = new Set();
	#startPromise;
	#summary;
	#worktreeWatcherInstalled = false;
	#worktreesDirectory;

	constructor(cwd, onEmpty) {
		this.cwd = cwd;
		this.onEmpty = onEmpty;
	}

	async subscribe(socket) {
		if (this.#disposed) return;
		this.#sockets.add(socket);
		if (this.#summary) send(socket, { type: 'repository-status', ...this.#summary });
		await this.#start();
	}

	unsubscribe(socket) {
		this.#sockets.delete(socket);
		if (this.#sockets.size === 0) {
			this.dispose();
			this.onEmpty(this);
		}
	}

	dispose() {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#abortController.abort();
		if (this.#refreshTimer !== undefined) clearTimeout(this.#refreshTimer);
		if (this.#fallbackTimer !== undefined) clearInterval(this.#fallbackTimer);
		this.#refreshTimer = undefined;
		this.#fallbackTimer = undefined;
		this.#sockets.clear();
	}

	#start() {
		if (this.#startPromise) return this.#startPromise;
		this.#startPromise = this.#installWatchers()
			.then(() => this.#refresh())
			.catch(() => this.#startFallback());
		return this.#startPromise;
	}

	async #installWatchers() {
		const { root, gitDirectory, worktreesDirectory } = await readRepositoryWatchPaths(this.cwd);
		if (this.#disposed) return;
		this.#worktreesDirectory = worktreesDirectory;

		let watcherInstalled = false;
		watcherInstalled = this.#watch(root, true, shouldRefreshForWorkspaceEvent) || watcherInstalled;
		if (gitDirectory) {
			watcherInstalled = this.#watch(gitDirectory, false, shouldRefreshForGitEvent) || watcherInstalled;
			watcherInstalled = this.#watch(join(gitDirectory, 'refs'), true, () => true) || watcherInstalled;
		}
		if (worktreesDirectory && await this.#directoryExists(worktreesDirectory)) {
			this.#worktreeWatcherInstalled = this.#watch(worktreesDirectory, false, () => true);
			if (!this.#worktreeWatcherInstalled) this.#startFallback();
		}
		if (!watcherInstalled) this.#startFallback();
	}

	async #directoryExists(path) {
		try {
			return (await stat(path)).isDirectory();
		} catch {
			return false;
		}
	}

	#watch(path, recursive, shouldRefresh) {
		try {
			const watcher = watch(path, {
				recursive,
				signal: this.#abortController.signal
			}, (_event, filename) => {
				if (shouldRefresh(filename)) this.#scheduleRefresh();
			});
			watcher.on('error', () => this.#startFallback());
			return true;
		} catch {
			return false;
		}
	}

	#startFallback() {
		if (this.#disposed || this.#fallbackTimer !== undefined) return;
		this.#fallbackTimer = setInterval(() => this.#scheduleRefresh(), FALLBACK_REFRESH_MS);
		this.#fallbackTimer.unref();
	}

	#scheduleRefresh() {
		if (this.#disposed) return;
		if (this.#refreshing) {
			this.#refreshQueued = true;
			return;
		}
		if (this.#refreshTimer !== undefined) return;
		this.#refreshTimer = setTimeout(() => {
			this.#refreshTimer = undefined;
			void this.#refresh();
		}, STATUS_SETTLE_MS);
	}

	async #refresh() {
		if (this.#disposed || this.#refreshing) return;
		this.#refreshing = true;
		try {
			const summary = await readRepositorySummary(this.cwd);
			if (this.#disposed) return;
			if (summary.worktreeCount > 1 && this.#worktreesDirectory && !this.#worktreeWatcherInstalled) {
				this.#worktreeWatcherInstalled = this.#watch(this.#worktreesDirectory, false, () => true);
				if (!this.#worktreeWatcherInstalled) this.#startFallback();
			}
			const changed = !this.#summary
				|| summary.isGitRepository !== this.#summary.isGitRepository
				|| summary.changeCount !== this.#summary.changeCount
				|| summary.worktreeCount !== this.#summary.worktreeCount;
			this.#summary = summary;
			if (changed || this.#sockets.size > 0) {
				for (const socket of this.#sockets) send(socket, { type: 'repository-status', ...summary });
			}
		} catch {
			// Keep the last known count. A later file event or fallback refresh can recover.
		} finally {
			this.#refreshing = false;
			if (this.#refreshQueued) {
				this.#refreshQueued = false;
				this.#scheduleRefresh();
			}
		}
	}
}

class RepositoryStatusHub {
	#closed = false;
	#monitors = new Map();

	async observe(socket, sessionId) {
		if (this.#closed || socket.readyState !== 1) return;
		const connection = await findSessionConnection(sessionId);
		if (!connection || this.#closed || socket.readyState !== 1) return;

		let monitor = this.#monitors.get(connection.cwd);
		if (!monitor) {
			monitor = new RepositoryStatusMonitor(connection.cwd, (emptyMonitor) => {
				if (this.#monitors.get(connection.cwd) === emptyMonitor) this.#monitors.delete(connection.cwd);
			});
			this.#monitors.set(connection.cwd, monitor);
		}

		let subscribed = true;
		const unsubscribe = () => {
			if (!subscribed) return;
			subscribed = false;
			monitor.unsubscribe(socket);
		};
		socket.once('close', unsubscribe);
		await monitor.subscribe(socket);
		if (socket.readyState !== 1) unsubscribe();
	}

	close() {
		if (this.#closed) return;
		this.#closed = true;
		for (const monitor of this.#monitors.values()) monitor.dispose();
		this.#monitors.clear();
	}
}

const repositoryStatusHub = new RepositoryStatusHub();

export function observeRepositoryStatus(socket, sessionId) {
	return repositoryStatusHub.observe(socket, sessionId);
}

export function closeRepositoryStatusObservers() {
	repositoryStatusHub.close();
}
