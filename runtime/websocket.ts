import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';

import { closeRepositoryStatusObservers, observeRepositoryStatus } from './repository-status.ts';
import { attachTerminal, type TerminalSize, type TerminalSizeController } from './terminal.ts';
import { recordWorkspaceSessionOutput, suppressWorkspaceSessionActivity } from './workspace-websocket.ts';
import { TERMINAL_SIZE_LIMITS } from '../src/lib/terminal/protocol.ts';
import {
	authorizeWebSocketUpgrade,
	installWebSocketHeartbeat,
	rejectWebSocketUpgrade,
	scheduleAuthenticationExpiry
} from './websocket-support.ts';

const MAX_CONNECTIONS = 32;
const MAX_PAYLOAD_BYTES = 72 * 1024;
const HEARTBEAT_INTERVAL_MS = 30_000;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_ID_PATTERN = /^@\d+$/;

interface TerminalAttachment {
	socket: WebSocket;
	released: boolean;
	ready: boolean;
	setIgnoreSize?: TerminalSizeController;
}

interface SessionAttachmentState {
	attachments: Set<TerminalAttachment>;
	activeAttachment?: TerminalAttachment;
	activationQueue: Promise<void>;
	syntheticOutputUntil: number;
}

interface TerminalConnectionContext {
	sessionId: string;
	terminalId?: string;
	initialSize?: TerminalSize;
	expiresAt?: number;
}

const sessionAttachmentStates = new Map<string, SessionAttachmentState>();

function getAttachmentState(sessionId: string): SessionAttachmentState {
	let state = sessionAttachmentStates.get(sessionId);
	if (!state) {
		state = {
			attachments: new Set(),
			activeAttachment: undefined,
			activationQueue: Promise.resolve(),
			syntheticOutputUntil: 0
		};
		sessionAttachmentStates.set(sessionId, state);
	}
	return state;
}

function activateAttachment(state: SessionAttachmentState, attachment: TerminalAttachment): Promise<void> {
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
				if (previous && !previous.released && previous.setIgnoreSize) await previous.setIgnoreSize(true);
				await attachment.setIgnoreSize(false);
			} catch (error) {
				if (state.activeAttachment === attachment) state.activeAttachment = previous;
				throw error;
			}
		});
	state.activationQueue = activation.catch(() => undefined);
	return activation;
}

function requestedTerminalSize(url: URL): TerminalSize | undefined {
	const columns = Number(url.searchParams.get('columns'));
	const rows = Number(url.searchParams.get('rows'));
	return Number.isInteger(columns)
		&& columns >= TERMINAL_SIZE_LIMITS.minimumColumns
		&& columns <= TERMINAL_SIZE_LIMITS.maximumColumns
		&& Number.isInteger(rows)
		&& rows >= TERMINAL_SIZE_LIMITS.minimumRows
		&& rows <= TERMINAL_SIZE_LIMITS.maximumRows
		? { columns, rows }
		: undefined;
}

export function installTerminalWebSocket(server: HttpServer): () => void {
	const terminalSockets = new WebSocketServer({
		noServer: true,
		maxPayload: MAX_PAYLOAD_BYTES,
		perMessageDeflate: false
	});

	const connectionContexts = new WeakMap<WebSocket, TerminalConnectionContext>();
	const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
		const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
		if (url.pathname !== '/ws/terminal') return;
		if (terminalSockets.clients.size >= MAX_CONNECTIONS) {
			rejectWebSocketUpgrade(socket, 503, 'Service Unavailable');
			return;
		}

		const authorization = authorizeWebSocketUpgrade(request);
		if (!authorization.authorized) {
			rejectWebSocketUpgrade(socket, authorization.status, authorization.reason);
			return;
		}

		const sessionId = url.searchParams.get('session');
		if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
			rejectWebSocketUpgrade(socket, 400, 'Bad Request');
			return;
		}
		const terminalId = url.searchParams.get('terminal') ?? undefined;
		if (terminalId !== undefined && !TERMINAL_ID_PATTERN.test(terminalId)) {
			rejectWebSocketUpgrade(socket, 400, 'Bad Request');
			return;
		}
		const initialSize = requestedTerminalSize(url);
		terminalSockets.handleUpgrade(request, socket, head, (websocket) => {
			connectionContexts.set(websocket, {
				sessionId,
				terminalId,
				initialSize,
				expiresAt: authorization.expiresAt
			});
			terminalSockets.emit('connection', websocket, request);
		});
	};

	server.on('upgrade', handleUpgrade);
	terminalSockets.on('connection', (socket) => {
		const context = connectionContexts.get(socket);
		if (!context) {
			socket.close(1011, 'terminal context unavailable');
			return;
		}
		scheduleAuthenticationExpiry(socket, context.expiresAt);

		const state = getAttachmentState(context.sessionId);
		const attachment: TerminalAttachment = {
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
			terminalId: context.terminalId,
			ignoreSize: true,
			canResize: () => state.activeAttachment === attachment && !attachment.released,
			onAttached: (setIgnoreSize) => {
				attachment.setIgnoreSize = setIgnoreSize;
				attachment.ready = true;
				return activateAttachment(state, attachment);
			},
			onActivate: () => activateAttachment(state, attachment),
			onSyntheticOutput: (timestamp) => {
				state.syntheticOutputUntil = Math.max(state.syntheticOutputUntil, timestamp);
				suppressWorkspaceSessionActivity(context.sessionId, timestamp);
			},
			isOutputActivity: (timestamp) => timestamp > state.syntheticOutputUntil,
			onOutputActivity: (timestamp) => recordWorkspaceSessionOutput(context.sessionId, context.terminalId, timestamp)
		}).catch(() => {
			socket.close(1011, 'terminal unavailable');
		});
	});
	const closeHeartbeat = installWebSocketHeartbeat(terminalSockets, HEARTBEAT_INTERVAL_MS);

	return () => {
		closeHeartbeat();
		server.off('upgrade', handleUpgrade);
		closeRepositoryStatusObservers();
		for (const socket of terminalSockets.clients) socket.terminate();
		terminalSockets.close();
	};
}
