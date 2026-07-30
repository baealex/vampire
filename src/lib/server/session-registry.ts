import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createTmuxSession, killTmuxSession, listTmuxSessions, type TmuxProcessHint } from './tmux';
import { listManagedSessions as readManagedSessions } from './session-snapshot.mjs';
import { isGitRepository as readIsGitRepository } from './repository.mjs';
import { createSessionNotePreview } from './session-note.mjs';
import { readSessionStateFile, SESSION_STATE_VERSION, sessionStatePath } from './session-state.mjs';
import { resolveAllowedWorkspaceDirectory, resolveExistingWorkspaceDirectory, WorkspaceRootError } from './workspace-roots.mjs';

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

export interface ManagedSession extends Omit<StoredSession, 'note'> {
	notePreview: string;
	state: 'running' | 'missing';
	lastOutputAt: number | null;
	attachedClients: number;
	foregroundProcess: TmuxProcessHint | null;
	isGitRepository: boolean;
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
	try {
		return await resolveAllowedWorkspaceDirectory(cwd);
	} catch (cause) {
		if (cause instanceof WorkspaceRootError) throw new SessionLaunchError('invalid-cwd', cause.message);
		throw new SessionLaunchError('invalid-cwd', 'Working directory does not exist or is not a permitted workspace.');
	}
}

async function validateExistingCwd(cwd: string): Promise<string> {
	try {
		return await resolveExistingWorkspaceDirectory(cwd);
	} catch (cause) {
		if (cause instanceof WorkspaceRootError) throw new SessionLaunchError('invalid-cwd', cause.message);
		throw new SessionLaunchError('invalid-cwd', 'Working directory does not exist or is not a directory.');
	}
}

async function detectGitRepository(cwd: string): Promise<boolean> {
	try {
		return await readIsGitRepository(cwd);
	} catch {
		return false;
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
	return readManagedSessions();
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
		const gitRepository = await detectGitRepository(cwd);
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
			id: stored.id,
			tmuxSession: stored.tmuxSession,
			cwd: stored.cwd,
			createdAt: stored.createdAt,
			lastActiveAt: stored.lastActiveAt,
			notePreview: createSessionNotePreview(stored.note),
			state: 'running',
			lastOutputAt: stored.createdAt,
			attachedClients: 0,
			foregroundProcess: { kind: 'shell', label: 'shell' },
			isGitRepository: gitRepository
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
			const gitRepository = await detectGitRepository(stored.cwd);
			return {
				id: stored.id,
				tmuxSession: stored.tmuxSession,
				cwd: stored.cwd,
				createdAt: stored.createdAt,
				lastActiveAt: stored.lastActiveAt,
				notePreview: createSessionNotePreview(stored.note),
				state: 'running',
				lastOutputAt: tmux.lastOutputAt,
				attachedClients: tmux.attachedClients,
				foregroundProcess: tmux.foregroundProcess,
				isGitRepository: gitRepository
			};
		}

		const cwd = await validateExistingCwd(stored.cwd);
		const gitRepository = await detectGitRepository(cwd);
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
			id: restarted.id,
			tmuxSession: restarted.tmuxSession,
			cwd: restarted.cwd,
			createdAt: restarted.createdAt,
			lastActiveAt: restarted.lastActiveAt,
			notePreview: createSessionNotePreview(restarted.note),
			state: 'running',
			lastOutputAt: restarted.createdAt,
			attachedClients: 0,
			foregroundProcess: { kind: 'shell', label: 'shell' },
			isGitRepository: gitRepository
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
		return createSessionNotePreview(normalizedNote);
	});
}

export async function findManagedSessionNote(id: string): Promise<string | undefined> {
	const state = await readState();
	return state.sessions.find((session) => session.id === id)?.note;
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
