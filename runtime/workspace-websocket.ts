import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';

import { readSessionAgentStates } from '../src/lib/server/agent-activity.ts';
import { listManagedSessions } from '../src/lib/server/session-registry.ts';
import { listTmuxSessionActivity, type TmuxProcessHint, type TmuxSessionActivity, type TmuxTerminal } from '../src/lib/server/tmux.ts';
import {
	encodeWorkspaceServerMessage,
	type SessionChanges,
	type WorkspaceServerMessage
} from '../src/lib/app/workspace-protocol.ts';
import type { AgentState } from '../src/lib/session/agent.ts';
import type { ManagedSession } from '../src/lib/session/types.ts';
import {
	authorizeWebSocketUpgrade,
	installWebSocketHeartbeat,
	rejectWebSocketUpgrade,
	scheduleAuthenticationExpiry
} from './websocket-support.ts';

const MAX_CONNECTIONS = 32;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const HEARTBEAT_INTERVAL_MS = 30_000;
const SESSION_ACTIVITY_REFRESH_INTERVAL_MS = 1_000;
const SESSION_REFRESH_INTERVAL_MS = 5_000;
const SESSION_FIELDS = [
	'tmuxSession',
	'cwd',
	'createdAt',
	'lastActiveAt',
	'notePreview',
	'favoriteCommands',
	'state',
	'lastOutputAt',
	'attachedClients',
	'foregroundProcess',
	'terminals',
	'agentState',
	'isGitRepository'
] as const satisfies ReadonlyArray<keyof Omit<ManagedSession, 'id'>>;

interface ActivitySuppression {
	lastOutputAt: number;
	mainLastOutputAt: number;
}

interface PendingAgentState {
	state: AgentState;
	count: number;
}

interface SessionUpdate {
	id: string;
	changes: SessionChanges;
}

interface WorkspaceConnectionContext {
	expiresAt?: number;
}

function send(socket: WebSocket, payload: WorkspaceServerMessage): void {
	if (socket.readyState === 1) socket.send(encodeWorkspaceServerMessage(payload));
}

function equalForegroundProcess(left: TmuxProcessHint | null | undefined, right: TmuxProcessHint | null | undefined): boolean {
	return left?.kind === right?.kind && left?.label === right?.label;
}

function equalTerminals(left: TmuxTerminal[] | undefined, right: TmuxTerminal[] | undefined): boolean {
	return Array.isArray(left)
		&& Array.isArray(right)
		&& left.length === right.length
		&& left.every((terminal, index) => {
			const candidate = right[index];
			return terminal.id === candidate?.id
				&& terminal.index === candidate.index
				&& terminal.name === candidate.name
				&& terminal.active === candidate.active
				&& terminal.lastOutputAt === candidate.lastOutputAt
				&& terminal.command === candidate.command
				&& terminal.startedAt === candidate.startedAt
				&& terminal.state === candidate.state
				&& terminal.exitCode === candidate.exitCode
				&& equalForegroundProcess(terminal.foregroundProcess, candidate.foregroundProcess);
		});
}

function equalStrings(left: string[] | undefined, right: string[] | undefined): boolean {
	return Array.isArray(left)
		&& Array.isArray(right)
		&& left.length === right.length
		&& left.every((value, index) => value === right[index]);
}

function sessionChanges(previous: ManagedSession, next: ManagedSession): SessionChanges {
	const changes: SessionChanges = {};
	for (const field of SESSION_FIELDS) {
		const equal = field === 'foregroundProcess'
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

export function reconcileSessionActivity(
	sessions: Map<string, ManagedSession>,
	tmuxActivity: TmuxSessionActivity[],
	suppressedActivity = new Map<string, ActivitySuppression>(),
	agentStates = new Map<string, AgentState>()
): { sessions: Map<string, ManagedSession>; updates: SessionUpdate[] } {
	const activityByName = new Map(tmuxActivity.map((activity) => [activity.name, activity]));
	const nextSessions = new Map(sessions);
	const updates: SessionUpdate[] = [];
	for (const [id, session] of sessions) {
		const activity = activityByName.get(session.tmuxSession);
		const suppression = suppressedActivity.get(id);
		const changes: SessionChanges = {};
		if (!activity) {
			if (session.state === 'running') {
				changes.state = 'missing';
				changes.lastOutputAt = null;
				changes.attachedClients = 0;
				changes.foregroundProcess = null;
				changes.terminals = [];
				if (session.agentState != null) changes.agentState = null;
			}
		} else {
			if (session.state === 'missing') changes.state = 'running';
			if (agentStates.has(id)) {
				const agentState = agentStates.get(id) ?? null;
				if ((session.agentState ?? null) !== agentState) changes.agentState = agentState;
			}
			const mainTerminal = session.terminals?.[0];
			const mainOutputAt = mainTerminal ? activity.mainLastOutputAt : activity.lastOutputAt;
			if (
				mainOutputAt !== null
				&& mainOutputAt > (suppression?.lastOutputAt ?? 0)
				&& mainOutputAt > (session.lastOutputAt ?? 0)
			) {
				changes.lastOutputAt = mainOutputAt;
			}
			if (
				mainTerminal
				&& activity.mainLastOutputAt !== null
				&& activity.mainLastOutputAt > (suppression?.mainLastOutputAt ?? 0)
				&& activity.mainLastOutputAt > (mainTerminal.lastOutputAt ?? 0)
			) {
				changes.terminals = session.terminals.map((terminal, index) => index === 0
					? { ...terminal, lastOutputAt: activity.mainLastOutputAt }
					: terminal);
			}
		}
		if (Object.keys(changes).length === 0) continue;
		const next = { ...session, ...changes };
		nextSessions.set(id, next);
		updates.push({ id, changes });
	}
	return { sessions: nextSessions, updates };
}

export function preserveLatestOutput(
	nextSessions: Map<string, ManagedSession>,
	currentSessions: Map<string, ManagedSession> | undefined,
	suppressedActivity = new Map<string, ActivitySuppression>()
): Map<string, ManagedSession> {
	if (!currentSessions) return nextSessions;
	const preservedSessions = new Map<string, ManagedSession>();
	for (const [id, next] of nextSessions) {
		const current = currentSessions.get(id);
		if (
			!current
			|| current.tmuxSession !== next.tmuxSession
			|| current.state !== 'running'
			|| next.state !== 'running'
		) {
			preservedSessions.set(id, next);
			continue;
		}
		const suppression = suppressedActivity.get(id);
		const currentTerminals = new Map(current.terminals.map((terminal) => [terminal.id, terminal]));
		const nextLastOutputAt = next.lastOutputAt !== null
			&& next.lastOutputAt <= (suppression?.lastOutputAt ?? 0)
				? current.lastOutputAt
				: next.lastOutputAt;
		preservedSessions.set(id, {
			...next,
			agentState: current.agentState ?? next.agentState ?? null,
			lastOutputAt: Math.max(nextLastOutputAt ?? 0, current.lastOutputAt ?? 0) || null,
			terminals: next.terminals.map((terminal, index) => {
				if (index > 0) return terminal;
				const previous = currentTerminals.get(terminal.id);
				const nextTerminalOutputAt = terminal.lastOutputAt !== null
					&& terminal.lastOutputAt <= (suppression?.lastOutputAt ?? 0)
						? previous?.lastOutputAt ?? null
						: terminal.lastOutputAt;
				return (previous?.lastOutputAt ?? 0) > (nextTerminalOutputAt ?? 0)
					? { ...terminal, lastOutputAt: previous!.lastOutputAt }
					: { ...terminal, lastOutputAt: nextTerminalOutputAt };
			})
		});
	}
	return preservedSessions;
}

export function stabilizeAgentStates(
	sessions: Map<string, ManagedSession>,
	detectedStates: Map<string, AgentState>,
	pendingStates: Map<string, PendingAgentState>
): Map<string, AgentState> {
	const stableStates = new Map<string, AgentState>();
	for (const [id, detectedState] of detectedStates) {
		const currentState = sessions.get(id)?.agentState ?? null;
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
		if (!sessions.has(id) || !detectedStates.has(id)) pendingStates.delete(id);
	}
	return stableStates;
}

class WorkspaceStatusHub {
	#clients = new Set<WebSocket>();
	#sessions: Map<string, ManagedSession> | undefined;
	#refreshPromise: Promise<void> | undefined;
	#activityRefreshPromise: Promise<void> | undefined;
	#refreshTimer: NodeJS.Timeout | undefined;
	#activityRefreshTimer: NodeJS.Timeout | undefined;
	#suppressedActivity = new Map<string, ActivitySuppression>();
	#pendingAgentStates = new Map<string, PendingAgentState>();

	suppressSessionActivity(sessionId: string, timestamp: number): void {
		const current = this.#suppressedActivity.get(sessionId) ?? {
			lastOutputAt: 0,
			mainLastOutputAt: 0
		};
		this.#suppressedActivity.set(sessionId, {
			lastOutputAt: Math.max(current.lastOutputAt, timestamp),
			mainLastOutputAt: Math.max(current.mainLastOutputAt, timestamp)
		});
	}

	recordSessionOutput(sessionId: string, terminalId: string | undefined, timestamp: number): boolean {
		const suppression = this.#suppressedActivity.get(sessionId);
		if (timestamp <= (suppression?.mainLastOutputAt ?? 0)) return false;
		const sessions = this.#sessions;
		if (!sessions) return false;
		const session = sessions.get(sessionId);
		if (!session || session.state !== 'running') return false;
		const mainTerminal = session.terminals[0];
		if (mainTerminal && terminalId && terminalId !== mainTerminal.id) return false;
		const changes: SessionChanges = {};
		if (timestamp > (session.lastOutputAt ?? 0)) changes.lastOutputAt = timestamp;
		const targetTerminalId = mainTerminal?.id;
		if (targetTerminalId) {
			const targetTerminal = session.terminals.find((terminal) => terminal.id === targetTerminalId);
			if (targetTerminal && timestamp > (targetTerminal.lastOutputAt ?? 0)) {
				changes.terminals = session.terminals.map((terminal) => terminal.id === targetTerminalId
					? { ...terminal, lastOutputAt: timestamp }
					: terminal);
			}
		}
		if (Object.keys(changes).length === 0) return true;
		sessions.set(sessionId, { ...session, ...changes });
		this.#broadcast({ type: 'session-updated', id: sessionId, changes });
		return true;
	}

	async subscribe(socket: WebSocket): Promise<void> {
		try {
			await this.#refresh();
			if (socket.readyState !== 1) return;
			send(socket, { type: 'sessions-snapshot', sessions: [...this.#sessions!.values()] });
			this.#clients.add(socket);
			socket.once('close', () => this.unsubscribe(socket));
			this.#startPolling();
		} catch {
			send(socket, { type: 'error', message: 'Unable to load workspace sessions.' });
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
		this.#sessions = undefined;
		this.#suppressedActivity.clear();
		this.#pendingAgentStates.clear();
	}

	close(): void {
		if (this.#refreshTimer !== undefined) clearInterval(this.#refreshTimer);
		if (this.#activityRefreshTimer !== undefined) clearInterval(this.#activityRefreshTimer);
		this.#refreshTimer = undefined;
		this.#activityRefreshTimer = undefined;
		this.#sessions = undefined;
		this.#suppressedActivity.clear();
		this.#pendingAgentStates.clear();
		for (const socket of this.#clients) socket.close(1001, 'server shutting down');
		this.#clients.clear();
	}

	#startPolling(): void {
		if (this.#refreshTimer !== undefined) return;
		this.#refreshTimer = setInterval(() => void this.#refresh().catch(() => undefined), SESSION_REFRESH_INTERVAL_MS);
		this.#refreshTimer.unref();
		this.#activityRefreshTimer = setInterval(
			() => void this.#refreshActivity().catch(() => undefined),
			SESSION_ACTIVITY_REFRESH_INTERVAL_MS
		);
		this.#activityRefreshTimer.unref();
	}

	async #refresh(): Promise<void> {
		if (this.#refreshPromise) return this.#refreshPromise;
		const precedingActivityRefresh = this.#activityRefreshPromise;
		this.#refreshPromise = (async () => {
			if (precedingActivityRefresh) await precedingActivityRefresh;
			const nextSessions = preserveLatestOutput(
				new Map((await listManagedSessions()).map((session) => [session.id, session])),
				this.#sessions,
				this.#suppressedActivity
			);
			const previousSessions = this.#sessions;
			this.#sessions = nextSessions;
			if (!previousSessions) return;

			for (const [id] of previousSessions) {
				if (!nextSessions.has(id)) {
					this.#suppressedActivity.delete(id);
					this.#pendingAgentStates.delete(id);
					this.#broadcast({ type: 'session-removed', id });
				}
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

	async #refreshActivity(): Promise<void> {
		if (this.#activityRefreshPromise) return this.#activityRefreshPromise;
		const precedingRefresh = this.#refreshPromise;
		this.#activityRefreshPromise = (async () => {
			if (precedingRefresh) await precedingRefresh;
			if (!this.#sessions) return;
			const [tmuxActivity, detectedAgentStates] = await Promise.all([
				listTmuxSessionActivity(),
				readSessionAgentStates(this.#sessions.values())
			]);
			if (!this.#sessions) return;
			const agentStates = stabilizeAgentStates(this.#sessions, detectedAgentStates, this.#pendingAgentStates);
			const result = reconcileSessionActivity(this.#sessions, tmuxActivity, this.#suppressedActivity, agentStates);
			this.#sessions = result.sessions;
			for (const update of result.updates) {
				this.#broadcast({ type: 'session-updated', id: update.id, changes: update.changes });
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

export function recordWorkspaceSessionOutput(sessionId: string, terminalId: string | undefined, timestamp: number): boolean {
	return workspaceStatusHub.recordSessionOutput(sessionId, terminalId, timestamp);
}

export function suppressWorkspaceSessionActivity(sessionId: string, timestamp: number): void {
	workspaceStatusHub.suppressSessionActivity(sessionId, timestamp);
}

export function installWorkspaceWebSocket(server: HttpServer): () => void {
	const workspaceSockets = new WebSocketServer({
		noServer: true,
		maxPayload: MAX_PAYLOAD_BYTES,
		perMessageDeflate: false
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
