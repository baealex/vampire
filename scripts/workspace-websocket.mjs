import { WebSocketServer } from 'ws';
import { isAuthorized, parseCookie, sessionCookieExpiresAt } from '../src/lib/server/session-cookie.mjs';
import { listManagedSessions } from '../src/lib/server/session-snapshot.mjs';
import { getSystemMetrics } from '../src/lib/server/system-metrics.mjs';

const MAX_CONNECTIONS = 32;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const HEARTBEAT_INTERVAL_MS = 30_000;
const SESSION_REFRESH_INTERVAL_MS = 2_000;
const SYSTEM_METRICS_INTERVAL_MS = 10_000;
const SESSION_FIELDS = [
	'tmuxSession',
	'cwd',
	'createdAt',
	'lastActiveAt',
	'notePreview',
	'state',
	'lastOutputAt',
	'attachedClients',
	'foregroundProcess'
];

function send(socket, payload) {
	if (socket.readyState === 1) socket.send(JSON.stringify(payload));
}

function rejectUpgrade(socket, status, reason) {
	socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
	socket.destroy();
}

function equalForegroundProcess(left, right) {
	return left?.kind === right?.kind && left?.label === right?.label;
}

function systemMetricsChanged(previous, next) {
	return !previous
		|| previous.cpuUsage !== next.cpuUsage
		|| previous.memoryUsage !== next.memoryUsage
		|| previous.memoryTotalBytes !== next.memoryTotalBytes;
}

function sessionChanges(previous, next) {
	const changes = {};
	for (const field of SESSION_FIELDS) {
		const equal = field === 'foregroundProcess'
			? equalForegroundProcess(previous[field], next[field])
			: previous[field] === next[field];
		if (!equal) changes[field] = next[field];
	}
	return changes;
}

class WorkspaceStatusHub {
	#clients = new Set();
	#sessions;
	#refreshPromise;
	#refreshTimer;
	#metricsTimer;
	#metrics;

	async subscribe(socket) {
		try {
			await this.#refresh();
			if (socket.readyState !== 1) return;
			const previousMetrics = this.#metrics;
			const metrics = getSystemMetrics();
			this.#metrics = metrics;
			send(socket, { type: 'sessions-snapshot', sessions: [...this.#sessions.values()] });
			send(socket, { type: 'system-metrics', metrics });
			this.#clients.add(socket);
			if (previousMetrics && systemMetricsChanged(previousMetrics, metrics)) {
				this.#broadcast({ type: 'system-metrics', metrics }, socket);
			}
			socket.once('close', () => this.unsubscribe(socket));
			this.#startPolling();
		} catch {
			send(socket, { type: 'error', message: 'Unable to load workspace sessions.' });
			socket.close(1011, 'workspace state unavailable');
		}
	}

	unsubscribe(socket) {
		this.#clients.delete(socket);
		if (this.#clients.size > 0) return;
		if (this.#refreshTimer !== undefined) clearInterval(this.#refreshTimer);
		if (this.#metricsTimer !== undefined) clearInterval(this.#metricsTimer);
		this.#refreshTimer = undefined;
		this.#metricsTimer = undefined;
		this.#sessions = undefined;
		this.#metrics = undefined;
	}

	close() {
		if (this.#refreshTimer !== undefined) clearInterval(this.#refreshTimer);
		if (this.#metricsTimer !== undefined) clearInterval(this.#metricsTimer);
		this.#refreshTimer = undefined;
		this.#metricsTimer = undefined;
		this.#sessions = undefined;
		this.#metrics = undefined;
		for (const socket of this.#clients) socket.close(1001, 'server shutting down');
		this.#clients.clear();
	}

	#startPolling() {
		if (this.#refreshTimer !== undefined) return;
		this.#refreshTimer = setInterval(() => void this.#refresh().catch(() => undefined), SESSION_REFRESH_INTERVAL_MS);
		this.#refreshTimer.unref();
		this.#metricsTimer = setInterval(() => {
			const metrics = getSystemMetrics();
			if (!systemMetricsChanged(this.#metrics, metrics)) return;
			this.#metrics = metrics;
			this.#broadcast({ type: 'system-metrics', metrics });
		}, SYSTEM_METRICS_INTERVAL_MS);
		this.#metricsTimer.unref();
	}

	async #refresh() {
		if (this.#refreshPromise) return this.#refreshPromise;
		this.#refreshPromise = (async () => {
			const nextSessions = new Map((await listManagedSessions()).map((session) => [session.id, session]));
			const previousSessions = this.#sessions;
			this.#sessions = nextSessions;
			if (!previousSessions) return;

			for (const [id] of previousSessions) {
				if (!nextSessions.has(id)) this.#broadcast({ type: 'session-removed', id });
			}
			for (const [id, next] of nextSessions) {
				const previous = previousSessions.get(id);
				if (!previous) {
					this.#broadcast({ type: 'session-added', session: next });
					continue;
				}
				const changes = sessionChanges(previous, next);
				if (Object.keys(changes).length > 0) this.#broadcast({ type: 'session-updated', id, changes });
			}
		})();
		try {
			await this.#refreshPromise;
		} finally {
			this.#refreshPromise = undefined;
		}
	}

	#broadcast(payload, excludedSocket) {
		for (const socket of this.#clients) {
			if (socket !== excludedSocket) send(socket, payload);
		}
	}
}

const workspaceStatusHub = new WorkspaceStatusHub();

export function installWorkspaceWebSocket(server) {
	const workspaceSockets = new WebSocketServer({
		noServer: true,
		maxPayload: MAX_PAYLOAD_BYTES,
		perMessageDeflate: false
	});

	const handleUpgrade = (request, socket, head) => {
		const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
		if (url.pathname !== '/ws/workspace') return;
		if (workspaceSockets.clients.size >= MAX_CONNECTIONS) {
			rejectUpgrade(socket, 503, 'Service Unavailable');
			return;
		}

		const origin = request.headers.origin;
		try {
			if (!origin || new URL(origin).host !== request.headers.host) {
				rejectUpgrade(socket, 403, 'Forbidden');
				return;
			}
		} catch {
			rejectUpgrade(socket, 403, 'Forbidden');
			return;
		}

		const token = process.env.VAMPIRE_TOKEN?.trim() || undefined;
		const cookies = parseCookie(request.headers.cookie);
		if (!isAuthorized({ authorization: request.headers.authorization, sessionCookie: cookies.vampire_session, token })) {
			rejectUpgrade(socket, 401, 'Unauthorized');
			return;
		}
		const expiresAt = token ? sessionCookieExpiresAt(cookies.vampire_session, token) : undefined;

		workspaceSockets.handleUpgrade(request, socket, head, (websocket) => {
			workspaceSockets.emit('connection', websocket, { expiresAt });
		});
	};

	server.on('upgrade', handleUpgrade);
	workspaceSockets.on('connection', (socket, context) => {
		socket.isAlive = true;
		socket.on('error', () => undefined);
		socket.on('pong', () => {
			socket.isAlive = true;
		});

		let expiryTimer;
		if (context.expiresAt) {
			expiryTimer = setTimeout(() => socket.close(1008, 'authentication expired'), Math.max(0, context.expiresAt - Date.now()));
			socket.once('close', () => clearTimeout(expiryTimer));
		}

		void workspaceStatusHub.subscribe(socket).catch(() => socket.close(1011, 'workspace state unavailable'));
	});
	const heartbeat = setInterval(() => {
		for (const socket of workspaceSockets.clients) {
			if (!socket.isAlive) {
				socket.terminate();
				continue;
			}
			socket.isAlive = false;
			socket.ping();
		}
	}, HEARTBEAT_INTERVAL_MS);
	heartbeat.unref();

	return () => {
		clearInterval(heartbeat);
		server.off('upgrade', handleUpgrade);
		workspaceStatusHub.close();
		workspaceSockets.close();
	};
}
