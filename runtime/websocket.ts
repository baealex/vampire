import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';

import { closeRepositoryStatusObservers, observeRepositoryStatus } from './repository-status.ts';
import {
	activateTerminalAttachment,
	createTerminalAttachmentState,
	releaseTerminalAttachment,
	terminalAttachmentKey,
	updateTerminalGeometry,
	type ManagedTerminalAttachment,
	type TerminalAttachmentState
} from './terminal-attachments.ts';
import {
	attachTerminal,
	type TerminalScreenSynchronizer,
	type TerminalSize,
	type TerminalSizeController
} from './terminal.ts';
import { recordWorkspaceSessionOutput, suppressWorkspaceSessionActivity } from './workspace-websocket.ts';
import {
	encodeTerminalServerMessage,
	TERMINAL_PROTOCOL_VERSION,
	TERMINAL_SIZE_LIMITS,
	type TerminalServerMessage
} from '../src/lib/terminal/protocol.ts';
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

interface TerminalAttachment extends ManagedTerminalAttachment {
	socket: WebSocket;
	supportsGeometry: boolean;
	readyPromise: Promise<void>;
	resolveReady: () => void;
	setIgnoreSize?: TerminalSizeController;
	synchronizeScreen?: TerminalScreenSynchronizer;
}

interface SessionAttachmentState extends TerminalAttachmentState<TerminalAttachment> {
	syntheticOutputUntil: number;
}

interface TerminalConnectionContext {
	sessionId: string;
	terminalId?: string;
	initialSize?: TerminalSize;
	historyLines?: number;
	claimControl: boolean;
	supportsGeometry: boolean;
	expiresAt?: number;
}

const sessionAttachmentStates = new Map<string, SessionAttachmentState>();

function getAttachmentState(key: string): SessionAttachmentState {
	let state = sessionAttachmentStates.get(key);
	if (!state) {
		state = {
			...createTerminalAttachmentState<TerminalAttachment>(),
			syntheticOutputUntil: 0
		};
		sessionAttachmentStates.set(key, state);
	}
	return state;
}

function sendTerminalMessage(socket: WebSocket, payload: TerminalServerMessage): void {
	if (socket.readyState === WebSocket.OPEN) socket.send(encodeTerminalServerMessage(payload));
}

function broadcastTerminalGeometry(state: SessionAttachmentState, geometry: TerminalSize): void {
	for (const attachment of state.attachments) {
		if (!attachment.released && attachment.supportsGeometry) {
			sendTerminalMessage(attachment.socket, { type: 'geometry', ...geometry });
		}
	}
}

async function activateAttachment(
	state: SessionAttachmentState,
	attachment: TerminalAttachment,
	options: { onlyIfUnclaimed?: boolean } = {}
): Promise<void> {
	const changed = await activateTerminalAttachment(state, attachment, options);
	if (changed && attachment.supportsGeometry && !attachment.released) {
		sendTerminalMessage(attachment.socket, { type: 'request-terminal-theme' });
	}
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

function requestedTerminalHistory(url: URL): number | undefined {
	const value = url.searchParams.get('history');
	if (value === null) return undefined;
	const historyLines = Number(value);
	return Number.isInteger(historyLines) ? historyLines : undefined;
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
		const historyLines = requestedTerminalHistory(url);
		const claimControl = url.searchParams.get('active') === '1';
		const supportsGeometry = Number(url.searchParams.get('protocol')) >= TERMINAL_PROTOCOL_VERSION;
		terminalSockets.handleUpgrade(request, socket, head, (websocket) => {
			connectionContexts.set(websocket, {
				sessionId,
				terminalId,
				initialSize,
				historyLines,
				claimControl,
				supportsGeometry,
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

		const attachmentKey = terminalAttachmentKey(context.sessionId, context.terminalId);
		const state = getAttachmentState(attachmentKey);
		let resolveReady!: () => void;
		const readyPromise = new Promise<void>((resolve) => { resolveReady = resolve; });
		const attachment: TerminalAttachment = {
			socket,
			supportsGeometry: context.supportsGeometry,
			released: false,
			readyPromise,
			resolveReady,
			setIgnoreSize: undefined,
			synchronizeScreen: undefined
		};
		state.attachments.add(attachment);
		const releaseAttachment = () => {
			attachment.resolveReady();
			const fallback = releaseTerminalAttachment(state, attachment);
			if (fallback) void activateAttachment(state, fallback).catch(() => undefined);
			if (state.attachments.size === 0) sessionAttachmentStates.delete(attachmentKey);
		};
		socket.once('close', releaseAttachment);
		void observeRepositoryStatus(socket, context.sessionId).catch(() => undefined);

		void attachTerminal(socket, context.sessionId, context.initialSize, {
			terminalId: context.terminalId,
			historyLines: context.historyLines,
			ignoreSize: true,
			canResize: () => state.activeAttachment === attachment && !attachment.released,
			canReportTerminalColor: () => state.activeAttachment === attachment && !attachment.released,
			getGeometry: () => state.geometry,
			sendGeometry: context.supportsGeometry,
			onAttached: async (setIgnoreSize, synchronizeScreen) => {
				attachment.setIgnoreSize = setIgnoreSize;
				attachment.synchronizeScreen = synchronizeScreen;
				attachment.resolveReady();
				if (attachment.released) return;
				// A focused, visible page is the device the user is looking at, so its
				// initial claim must take control even when another device is attached.
				// Passive connections can still fill an otherwise unclaimed terminal.
				await activateAttachment(
					state,
					attachment,
					context.claimControl ? {} : { onlyIfUnclaimed: true }
				);
			},
			onActivate: async () => {
				await attachment.readyPromise;
				if (!attachment.released) await activateAttachment(state, attachment);
			},
			onGeometryChange: (geometry) => {
				if (updateTerminalGeometry(state, attachment, geometry)) {
					broadcastTerminalGeometry(state, geometry);
				}
			},
			onInput: () => { state.syntheticOutputUntil = 0; },
			onSyntheticOutput: (timestamp) => {
				state.syntheticOutputUntil = Math.max(state.syntheticOutputUntil, timestamp);
			},
			onSyntheticActivity: (timestamp) => suppressWorkspaceSessionActivity(context.sessionId, timestamp),
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
