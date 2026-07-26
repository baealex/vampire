import { WebSocketServer } from 'ws';
import { isAuthorized, parseCookie, sessionCookieExpiresAt } from '../src/lib/server/session-cookie.mjs';
import { closeRepositoryStatusObservers, observeRepositoryStatus } from './repository-status.mjs';
import { attachTerminal } from './terminal.mjs';

const MAX_CONNECTIONS = 32;
const MAX_PAYLOAD_BYTES = 72 * 1024;
const HEARTBEAT_INTERVAL_MS = 30_000;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sessionAttachmentStates = new Map();

function getAttachmentState(sessionId) {
	let state = sessionAttachmentStates.get(sessionId);
	if (!state) {
		state = { attachments: new Set(), activeAttachment: undefined, activationQueue: Promise.resolve() };
		sessionAttachmentStates.set(sessionId, state);
	}
	return state;
}

function activateAttachment(state, attachment) {
	const activation = state.activationQueue
		.catch(() => undefined)
		.then(async () => {
			if (attachment.released || !attachment.setIgnoreSize) return;
			const previous = state.activeAttachment;
			if (previous === attachment) {
				await attachment.setIgnoreSize(false);
				return;
			}
			state.activeAttachment = attachment;
			try {
				if (previous && !previous.released) await previous.setIgnoreSize(true);
				await attachment.setIgnoreSize(false);
			} catch (error) {
				if (state.activeAttachment === attachment) state.activeAttachment = previous;
				throw error;
			}
		});
	state.activationQueue = activation.catch(() => undefined);
	return activation;
}

function rejectUpgrade(socket, status, reason) {
	socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
	socket.destroy();
}

function requestedTerminalSize(url) {
	const columns = Number(url.searchParams.get('columns'));
	const rows = Number(url.searchParams.get('rows'));
	return Number.isInteger(columns)
		&& columns >= 20
		&& columns <= 240
		&& Number.isInteger(rows)
		&& rows >= 5
		&& rows <= 120
		? { columns, rows }
		: undefined;
}

export function installTerminalWebSocket(server) {
	const terminalSockets = new WebSocketServer({
		noServer: true,
		maxPayload: MAX_PAYLOAD_BYTES,
		perMessageDeflate: false
	});

	const handleUpgrade = (request, socket, head) => {
		const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
		if (url.pathname !== '/ws/terminal') return;
		if (terminalSockets.clients.size >= MAX_CONNECTIONS) {
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

		const sessionId = url.searchParams.get('session');
		if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
			rejectUpgrade(socket, 400, 'Bad Request');
			return;
		}
		const initialSize = requestedTerminalSize(url);
		const expiresAt = token ? sessionCookieExpiresAt(cookies.vampire_session, token) : undefined;

		terminalSockets.handleUpgrade(request, socket, head, (websocket) => {
			terminalSockets.emit('connection', websocket, { sessionId, initialSize, expiresAt });
		});
	};

	server.on('upgrade', handleUpgrade);
	terminalSockets.on('connection', (socket, context) => {
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

		const state = getAttachmentState(context.sessionId);
		const attachment = {
			socket,
			released: false,
			ready: false,
			setIgnoreSize: undefined
		};
		state.attachments.add(attachment);
		const releaseAttachment = () => {
			if (attachment.released) return;
			attachment.released = true;
			state.attachments.delete(attachment);
			if (state.activeAttachment === attachment) {
				state.activeAttachment = undefined;
				const next = [...state.attachments].find((candidate) => candidate.ready && !candidate.released);
				if (next) void activateAttachment(state, next).catch(() => undefined);
			}
			if (state.attachments.size === 0) sessionAttachmentStates.delete(context.sessionId);
		};
		socket.once('close', releaseAttachment);
		void observeRepositoryStatus(socket, context.sessionId).catch(() => undefined);

		void attachTerminal(socket, context.sessionId, context.initialSize, {
			ignoreSize: true,
			canResize: () => state.activeAttachment === attachment && !attachment.released,
			onAttached: (setIgnoreSize) => {
				attachment.setIgnoreSize = setIgnoreSize;
				attachment.ready = true;
				return activateAttachment(state, attachment);
			},
			onActivate: () => activateAttachment(state, attachment)
		}).catch(() => {
			socket.close(1011, 'terminal unavailable');
		});
	});
	const heartbeat = setInterval(() => {
		for (const socket of terminalSockets.clients) {
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
		closeRepositoryStatusObservers();
		for (const socket of terminalSockets.clients) socket.terminate();
		terminalSockets.close();
	};
}
