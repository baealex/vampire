import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createTmuxSession, killTmuxSession, listTmuxSessions, type TmuxProcessHint } from './tmux';
import { readSessionStateFile, SESSION_STATE_VERSION, sessionStatePath } from './session-state.mjs';

export const SESSION_NOTE_MAX_LENGTH = 4_000;

interface StoredSession {
	id: string;
	tmuxSession: string;
	cwd: string;
	createdAt: number;
	lastActiveAt: number;
	note: string;
}

interface StateFile {
	version: number;
	sessions: StoredSession[];
}

export interface ManagedSession extends StoredSession {
	state: 'running' | 'missing';
	lastOutputAt: number | null;
	attachedClients: number;
	foregroundProcess: TmuxProcessHint | null;
}

export class SessionLaunchError extends Error {
	constructor(
		readonly reason: 'invalid-cwd' | 'tmux-launch-failed',
		message: string
	) {
		super(message);
	}
}

export class SessionMutationError extends Error {
	constructor(
		readonly reason: 'not-found' | 'session-running',
		message: string
	) {
		super(message);
	}
}

function isStoredSession(value: unknown): value is StoredSession {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const session = value as Record<string, unknown>;
	return typeof session.id === 'string'
		&& typeof session.tmuxSession === 'string'
		&& typeof session.cwd === 'string'
		&& typeof session.createdAt === 'number'
		&& (session.lastActiveAt === undefined || typeof session.lastActiveAt === 'number')
		&& (session.note === undefined || typeof session.note === 'string');
}

async function readState(): Promise<StateFile> {
	try {
		const parsed: unknown = await readSessionStateFile();
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid state file');
		const state = parsed as { version?: unknown; sessions?: unknown };
		if (state.version !== SESSION_STATE_VERSION || !Array.isArray(state.sessions) || !state.sessions.every(isStoredSession)) {
			throw new Error('invalid state file');
		}
		return {
			version: SESSION_STATE_VERSION,
			sessions: state.sessions.map(({ id, tmuxSession, cwd, createdAt, lastActiveAt, note }) => ({
				id,
				tmuxSession,
				cwd,
				createdAt,
				lastActiveAt: typeof lastActiveAt === 'number' ? lastActiveAt : createdAt,
				note: typeof note === 'string' ? note : ''
			}))
		};
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { version: SESSION_STATE_VERSION, sessions: [] };
		throw new Error('Vampire session registry is unreadable; refusing to overwrite it.');
	}
}

async function writeState(state: StateFile): Promise<void> {
	const file = sessionStatePath();
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	const temporaryFile = `${file}.${randomUUID()}.tmp`;
	await writeFile(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
	await rename(temporaryFile, file);
}

async function validateCwd(cwd: string): Promise<string> {
	if (!cwd.startsWith('/')) {
		throw new SessionLaunchError('invalid-cwd', 'Working directory must be an absolute path.');
	}

	try {
		const directory = resolve(cwd);
		const { stat } = await import('node:fs/promises');
		if (!(await stat(directory)).isDirectory()) throw new Error('not a directory');
		return directory;
	} catch {
		throw new SessionLaunchError('invalid-cwd', 'Working directory does not exist or is not a directory.');
	}
}

let mutationQueue: Promise<void> = Promise.resolve();

async function exclusively<T>(operation: () => Promise<T>): Promise<T> {
	const previous = mutationQueue;
	let release: () => void;
	mutationQueue = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previous;
	try {
		return await operation();
	} finally {
		release!();
	}
}

export async function listManagedSessions(): Promise<ManagedSession[]> {
	const [state, tmuxSessions] = await Promise.all([readState(), listTmuxSessions()]);
	const byName = new Map(tmuxSessions.map((session) => [session.name, session]));
	return state.sessions.map((session) => {
		const tmux = byName.get(session.tmuxSession);
		return {
			...session,
			state: tmux ? 'running' : 'missing',
			lastOutputAt: tmux?.lastOutputAt ?? null,
			attachedClients: tmux?.attachedClients ?? 0,
			foregroundProcess: tmux?.foregroundProcess ?? null
		};
	});
}

export async function findManagedSession(id: string): Promise<ManagedSession | undefined> {
	return (await listManagedSessions()).find((session) => session.id === id);
}

export async function findManagedWorkspace(id: string): Promise<Pick<StoredSession, 'id' | 'cwd'> | undefined> {
	const session = (await readState()).sessions.find((candidate) => candidate.id === id);
	return session ? { id: session.id, cwd: session.cwd } : undefined;
}

export async function createManagedSession(input: { cwd: string }): Promise<ManagedSession> {
	return exclusively(async () => {
		const cwd = await validateCwd(input.cwd);
		const id = randomUUID();
		const stored: StoredSession = {
			id,
			tmuxSession: `vampire-${id.slice(0, 8)}`,
			cwd,
			createdAt: Date.now(),
			lastActiveAt: Date.now(),
			note: ''
		};
		const current = await readState();
		await writeState({ ...current, sessions: [...current.sessions, stored] });

		try {
			await createTmuxSession(stored.tmuxSession, cwd);
		} catch {
			const afterFailure = await readState();
			await writeState({
				...afterFailure,
				sessions: afterFailure.sessions.filter((session) => session.id !== stored.id)
			});
			throw new SessionLaunchError('tmux-launch-failed', 'tmux could not start the shell session.');
		}

		return {
			...stored,
			state: 'running',
			lastOutputAt: stored.createdAt,
			attachedClients: 0,
			foregroundProcess: { kind: 'shell', label: 'shell' }
		};
	});
}

export async function restartManagedSession(id: string): Promise<ManagedSession> {
	return exclusively(async () => {
		const state = await readState();
		const index = state.sessions.findIndex((session) => session.id === id);
		if (index < 0) throw new SessionMutationError('not-found', 'Session was not found.');

		const stored = state.sessions[index];
		const tmux = (await listTmuxSessions()).find((session) => session.name === stored.tmuxSession);
		if (tmux) {
			return {
				...stored,
				state: 'running',
				lastOutputAt: tmux.lastOutputAt,
				attachedClients: tmux.attachedClients,
				foregroundProcess: tmux.foregroundProcess
			};
		}

		const cwd = await validateCwd(stored.cwd);
		try {
			await createTmuxSession(stored.tmuxSession, cwd);
		} catch {
			throw new SessionLaunchError('tmux-launch-failed', 'tmux could not restart the shell session.');
		}

		const restarted = { ...stored, cwd, createdAt: Date.now(), lastActiveAt: Date.now() };
		const sessions = [...state.sessions];
		sessions[index] = restarted;
		await writeState({ ...state, sessions });
		return {
			...restarted,
			state: 'running',
			lastOutputAt: restarted.createdAt,
			attachedClients: 0,
			foregroundProcess: { kind: 'shell', label: 'shell' }
		};
	});
}

export async function touchManagedSession(id: string): Promise<number> {
	return exclusively(async () => {
		const state = await readState();
		const index = state.sessions.findIndex((session) => session.id === id);
		if (index < 0) throw new SessionMutationError('not-found', 'Session was not found.');

		const lastActiveAt = Date.now();
		const sessions = [...state.sessions];
		sessions[index] = { ...sessions[index], lastActiveAt };
		await writeState({ ...state, sessions });
		return lastActiveAt;
	});
}

export async function updateManagedSessionNote(id: string, note: string): Promise<string> {
	return exclusively(async () => {
		const state = await readState();
		const index = state.sessions.findIndex((session) => session.id === id);
		if (index < 0) throw new SessionMutationError('not-found', 'Session was not found.');

		const normalizedNote = note.trim();
		const sessions = [...state.sessions];
		sessions[index] = { ...sessions[index], note: normalizedNote };
		await writeState({ ...state, sessions });
		return normalizedNote;
	});
}

export async function closeManagedSession(id: string): Promise<void> {
	await exclusively(async () => {
		const state = await readState();
		const stored = state.sessions.find((session) => session.id === id);
		if (!stored) throw new SessionMutationError('not-found', 'Session was not found.');

		await killTmuxSession(stored.tmuxSession);
	});
}

export async function removeManagedSession(id: string): Promise<void> {
	await exclusively(async () => {
		const state = await readState();
		const stored = state.sessions.find((session) => session.id === id);
		if (!stored) throw new SessionMutationError('not-found', 'Session was not found.');

		const running = (await listTmuxSessions()).some((session) => session.name === stored.tmuxSession);
		if (running) {
			throw new SessionMutationError('session-running', 'Close the session before removing this workspace.');
		}

		await writeState({ ...state, sessions: state.sessions.filter((session) => session.id !== id) });
	});
}

export async function stopAndRemoveManagedSession(id: string): Promise<void> {
	await exclusively(async () => {
		const state = await readState();
		const stored = state.sessions.find((session) => session.id === id);
		if (!stored) throw new SessionMutationError('not-found', 'Session was not found.');

		await killTmuxSession(stored.tmuxSession);
		await writeState({ ...state, sessions: state.sessions.filter((session) => session.id !== id) });
	});
}
