import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import {
	captureTmuxBackgroundOutput,
	createTmuxSession,
	createTmuxBackgroundProcess,
	killTmuxBackgroundProcess,
	killTmuxSession,
	listTmuxSessions,
	sendTmuxInput,
	type TmuxProcessHint,
	type TmuxSession,
	type TmuxTerminal
} from './tmux.ts';
import { isGitRepository as readIsGitRepository } from './repository.ts';
import { createSessionNotePreview } from './session-note.ts';
import {
	BACKGROUND_COMMAND_MAX_LENGTH,
	MAX_FAVORITE_COMMANDS,
	readSessionStore as readState,
	type StoredSession,
	writeSessionStore as writeState
} from './session-store.ts';
import { resolveAllowedWorkspaceDirectory, resolveExistingWorkspaceDirectory, WorkspaceRootError } from './workspace-roots.ts';
import {
	createGitWorktree,
	GitWorktreeError,
	removeManagedGitWorktree,
	rollbackGitWorktree
} from './git-worktree.ts';
import type { AgentState } from '../session/agent.ts';
import {
	isLaunchProfileList,
	normalizeLaunchProfiles
} from '../session/launch-profiles.ts';
import type { LaunchProfile, WorkspacePreferences } from '../session/types.ts';

export const SESSION_NOTE_MAX_LENGTH = 4_000;
export const WORKSPACE_ALIAS_MAX_LENGTH = 80;
export const MAX_BACKGROUND_PROCESSES = 8;
export { BACKGROUND_COMMAND_MAX_LENGTH, MAX_FAVORITE_COMMANDS };

export interface ManagedSession extends Omit<StoredSession, 'note'> {
	notePreview: string;
	state: 'running' | 'missing';
	lastOutputAt: number | null;
	attachedClients: number;
	foregroundProcess: TmuxProcessHint | null;
	terminals: TmuxTerminal[];
	agentState: AgentState;
	isGitRepository: boolean;
	workspaceAvailable: boolean;
}

export type SessionLaunchErrorReason = 'invalid-cwd' | 'tmux-launch-failed';

export class SessionLaunchError extends Error {
	readonly reason: SessionLaunchErrorReason;

	constructor(reason: SessionLaunchErrorReason, message: string) {
		super(message);
		this.reason = reason;
	}
}

export type SessionMutationErrorReason = 'not-found' | 'session-running' | 'session-not-running' | 'worktree-cleanup-failed' | 'invalid-background-command' | 'background-not-found' | 'background-limit' | 'favorite-limit' | 'invalid-launch-profiles' | 'invalid-workspace-alias' | 'invalid-workspace-preferences';

export class SessionMutationError extends Error {
	readonly reason: SessionMutationErrorReason;

	constructor(reason: SessionMutationErrorReason, message: string) {
		super(message);
		this.reason = reason;
	}
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

function isValidBackgroundCommand(command: string): boolean {
	return Boolean(command)
		&& command.length <= BACKGROUND_COMMAND_MAX_LENGTH
		&& !/[\0\r\n\t]/.test(command);
}

function normalizeBackgroundCommand(command: string): string {
	const normalizedCommand = command.trim();
	if (!isValidBackgroundCommand(normalizedCommand)) {
		throw new SessionMutationError('invalid-background-command', 'Enter a single-line background command.');
	}
	return normalizedCommand;
}

async function detectGitRepository(cwd: string): Promise<boolean> {
	try {
		return await readIsGitRepository(cwd);
	} catch {
		return false;
	}
}

async function detectWorkspaceAvailable(cwd: string): Promise<boolean> {
	try {
		return (await stat(cwd)).isDirectory();
	} catch {
		return false;
	}
}

function reconcileWorkspacePreferences(
	sessions: StoredSession[],
	preferences: WorkspacePreferences
): WorkspacePreferences {
	const sessionIds = new Set(sessions.map((session) => session.id));
	const manualSessionOrder = [...new Set(preferences.manualSessionOrder)]
		.filter((id) => sessionIds.has(id));
	const orderedIds = new Set(manualSessionOrder);
	for (const session of sessions) {
		if (!orderedIds.has(session.id)) manualSessionOrder.push(session.id);
	}
	return {
		sessionOrderMode: preferences.sessionOrderMode,
		manualSessionOrder
	};
}

function validateWorkspacePreferences(input: WorkspacePreferences): WorkspacePreferences {
	if ((input.sessionOrderMode !== 'activity' && input.sessionOrderMode !== 'manual')
		|| !Array.isArray(input.manualSessionOrder)
		|| !input.manualSessionOrder.every((id) => typeof id === 'string')) {
		throw new SessionMutationError('invalid-workspace-preferences', 'Workspace order preferences are invalid.');
	}
	return {
		sessionOrderMode: input.sessionOrderMode,
		manualSessionOrder: [...new Set(input.manualSessionOrder)]
	};
}

function normalizeWorkspaceAlias(alias: string): string {
	const normalizedAlias = alias.trim();
	if (normalizedAlias.length > WORKSPACE_ALIAS_MAX_LENGTH || /[\0\r\n\t]/.test(normalizedAlias)) {
		throw new SessionMutationError(
			'invalid-workspace-alias',
			`Workspace aliases must stay on one line and be ${WORKSPACE_ALIAS_MAX_LENGTH} characters or fewer.`
		);
	}
	return normalizedAlias;
}

type SessionRegistryGlobal = typeof globalThis & {
	__vampireSessionRegistryMutationState?: { queue: Promise<void> };
};

const registryGlobal = globalThis as SessionRegistryGlobal;
const mutationState = registryGlobal.__vampireSessionRegistryMutationState ??= {
	queue: Promise.resolve()
};

async function exclusively<T>(operation: () => Promise<T>): Promise<T> {
	const previous = mutationState.queue;
	let release: () => void;
	mutationState.queue = new Promise<void>((resolve) => {
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
	const workspaceStates = await Promise.all(
		[...new Set(state.sessions.map((session) => session.cwd))].map(async (cwd): Promise<[string, boolean, boolean]> => {
			const [isGitRepository, workspaceAvailable] = await Promise.all([
				detectGitRepository(cwd),
				detectWorkspaceAvailable(cwd)
			]);
			return [cwd, isGitRepository, workspaceAvailable];
		})
	);
	const repositoryByCwd = new Map(workspaceStates.map(([cwd, isGitRepository]) => [cwd, isGitRepository]));
	const availabilityByCwd = new Map(workspaceStates.map(([cwd, , workspaceAvailable]) => [cwd, workspaceAvailable]));
	const tmuxByName = new Map(tmuxSessions.map((session) => [session.name, session]));

	return state.sessions.map((session) => {
		const tmux = tmuxByName.get(session.tmuxSession);
		const { note, ...stored } = session;
		return {
			...stored,
			notePreview: createSessionNotePreview(note),
			state: tmux ? 'running' : 'missing',
			lastOutputAt: tmux?.lastOutputAt ?? null,
			attachedClients: tmux?.attachedClients ?? 0,
			foregroundProcess: tmux?.foregroundProcess ?? null,
			terminals: tmux?.terminals ?? [],
			agentState: null,
			isGitRepository: repositoryByCwd.get(session.cwd) ?? false,
			workspaceAvailable: availabilityByCwd.get(session.cwd) ?? false
		};
	});
}

export async function findManagedSession(id: string): Promise<ManagedSession | undefined> {
	return (await listManagedSessions()).find((session) => session.id === id);
}

export async function readManagedWorkspacePreferences(): Promise<WorkspacePreferences | null> {
	const state = await readState();
	return state.workspacePreferences
		? reconcileWorkspacePreferences(state.sessions, state.workspacePreferences)
		: null;
}

export async function updateManagedWorkspacePreferences(
	input: WorkspacePreferences
): Promise<WorkspacePreferences> {
	return exclusively(async () => {
		const state = await readState();
		const workspacePreferences = reconcileWorkspacePreferences(
			state.sessions,
			validateWorkspacePreferences(input)
		);
		await writeState({ ...state, workspacePreferences });
		return workspacePreferences;
	});
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
			workspaceKind: 'directory',
			createdAt: Date.now(),
			lastActiveAt: Date.now(),
			note: '',
			favoriteCommands: [],
			launchProfiles: [],
			defaultLaunchProfileId: null,
			autoStartDefaultProfile: false
		};
		const current = await readState();
		await writeState({ ...current, sessions: [...current.sessions, stored] });

		let tmux;
		try {
			tmux = await createTmuxSession(stored.tmuxSession, cwd);
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
			workspaceKind: stored.workspaceKind,
			repositoryPath: stored.repositoryPath,
			workspaceLabel: stored.workspaceLabel,
			worktreeBranch: stored.worktreeBranch,
			createdAt: stored.createdAt,
			lastActiveAt: stored.lastActiveAt,
			favoriteCommands: stored.favoriteCommands,
			launchProfiles: stored.launchProfiles,
			defaultLaunchProfileId: stored.defaultLaunchProfileId,
			autoStartDefaultProfile: stored.autoStartDefaultProfile,
			notePreview: createSessionNotePreview(stored.note),
			state: 'running',
			lastOutputAt: tmux.lastOutputAt,
			attachedClients: tmux.attachedClients,
			foregroundProcess: tmux.foregroundProcess,
			terminals: tmux.terminals,
			agentState: null,
			isGitRepository: gitRepository,
			workspaceAvailable: true
		};
	});
}

export async function createManagedWorktreeSession(input: { sourceSessionId: string; name: string }): Promise<ManagedSession> {
	return exclusively(async () => {
		const current = await readState();
		const source = current.sessions.find((session) => session.id === input.sourceSessionId);
		if (!source) throw new SessionMutationError('not-found', 'Source workspace was not found.');

		const id = randomUUID();
		const worktree = await createGitWorktree(source.cwd, input.name, { id });
		const now = Date.now();
		const stored: StoredSession = {
			id,
			tmuxSession: `vampire-${id.slice(0, 8)}`,
			cwd: worktree.cwd,
			workspaceKind: 'worktree',
			repositoryPath: source.repositoryPath ?? worktree.sourceRoot,
			workspaceLabel: worktree.label,
			worktreeBranch: worktree.branch,
			createdAt: now,
			lastActiveAt: now,
			note: '',
			favoriteCommands: [...source.favoriteCommands],
			launchProfiles: source.launchProfiles.map((profile) => ({ ...profile })),
			defaultLaunchProfileId: source.defaultLaunchProfileId,
			autoStartDefaultProfile: source.autoStartDefaultProfile
		};

		try {
			await writeState({ ...current, sessions: [...current.sessions, stored] });
		} catch (error) {
			await rollbackGitWorktree(worktree);
			throw error;
		}

		let tmux;
		try {
			tmux = await createTmuxSession(stored.tmuxSession, stored.cwd);
		} catch {
			const afterFailure = await readState();
			await writeState({
				...afterFailure,
				sessions: afterFailure.sessions.filter((session) => session.id !== stored.id)
			});
			await rollbackGitWorktree(worktree);
			throw new SessionLaunchError('tmux-launch-failed', 'tmux could not start the isolated workspace shell.');
		}
		if (stored.autoStartDefaultProfile) {
			try {
				await sendDefaultLaunchProfile(stored, tmux);
			} catch {
				// Keep the new shell available when an optional auto-start command cannot be sent.
			}
		}

		return {
			id: stored.id,
			tmuxSession: stored.tmuxSession,
			cwd: stored.cwd,
			workspaceKind: stored.workspaceKind,
			repositoryPath: stored.repositoryPath,
			workspaceLabel: stored.workspaceLabel,
			worktreeBranch: stored.worktreeBranch,
			createdAt: stored.createdAt,
			lastActiveAt: stored.lastActiveAt,
			favoriteCommands: stored.favoriteCommands,
			launchProfiles: stored.launchProfiles,
			defaultLaunchProfileId: stored.defaultLaunchProfileId,
			autoStartDefaultProfile: stored.autoStartDefaultProfile,
			notePreview: '',
			state: 'running',
			lastOutputAt: tmux.lastOutputAt,
			attachedClients: tmux.attachedClients,
			foregroundProcess: tmux.foregroundProcess,
			terminals: tmux.terminals,
			agentState: null,
			isGitRepository: true,
			workspaceAvailable: true
		};
	});
}

export async function restartManagedSession(id: string): Promise<ManagedSession> {
	return exclusively(async () => {
		const state = await readState();
		const index = state.sessions.findIndex((session) => session.id === id);
		if (index < 0) throw new SessionMutationError('not-found', 'Session was not found.');

		const stored = state.sessions[index];
		const existingTmux = (await listTmuxSessions()).find((session) => session.name === stored.tmuxSession);
		if (existingTmux) {
			const [gitRepository, workspaceAvailable] = await Promise.all([
				detectGitRepository(stored.cwd),
				detectWorkspaceAvailable(stored.cwd)
			]);
			return {
				id: stored.id,
				tmuxSession: stored.tmuxSession,
				cwd: stored.cwd,
				workspaceKind: stored.workspaceKind,
				repositoryPath: stored.repositoryPath,
				workspaceLabel: stored.workspaceLabel,
				worktreeBranch: stored.worktreeBranch,
				createdAt: stored.createdAt,
				lastActiveAt: stored.lastActiveAt,
				favoriteCommands: stored.favoriteCommands,
				launchProfiles: stored.launchProfiles,
				defaultLaunchProfileId: stored.defaultLaunchProfileId,
				autoStartDefaultProfile: stored.autoStartDefaultProfile,
				notePreview: createSessionNotePreview(stored.note),
				state: 'running',
				lastOutputAt: existingTmux.lastOutputAt,
				attachedClients: existingTmux.attachedClients,
				foregroundProcess: existingTmux.foregroundProcess,
				terminals: existingTmux.terminals,
				agentState: null,
				isGitRepository: gitRepository,
				workspaceAvailable
			};
		}

		const cwd = await validateExistingCwd(stored.cwd);
		const gitRepository = await detectGitRepository(cwd);
		let restartedTmux;
		try {
			restartedTmux = await createTmuxSession(stored.tmuxSession, cwd);
		} catch {
			throw new SessionLaunchError('tmux-launch-failed', 'tmux could not restart the shell session.');
		}

		const restarted = { ...stored, cwd, createdAt: Date.now(), lastActiveAt: Date.now() };
		const sessions = [...state.sessions];
		sessions[index] = restarted;
		await writeState({ ...state, sessions });
		if (restarted.autoStartDefaultProfile) {
			try {
				await sendDefaultLaunchProfile(restarted, restartedTmux);
			} catch {
				// Keep the shell available when an optional auto-start command cannot be sent.
			}
		}
		return {
			id: restarted.id,
			tmuxSession: restarted.tmuxSession,
			cwd: restarted.cwd,
			workspaceKind: restarted.workspaceKind,
			repositoryPath: restarted.repositoryPath,
			workspaceLabel: restarted.workspaceLabel,
			worktreeBranch: restarted.worktreeBranch,
			createdAt: restarted.createdAt,
			lastActiveAt: restarted.lastActiveAt,
			favoriteCommands: restarted.favoriteCommands,
			launchProfiles: restarted.launchProfiles,
			defaultLaunchProfileId: restarted.defaultLaunchProfileId,
			autoStartDefaultProfile: restarted.autoStartDefaultProfile,
			notePreview: createSessionNotePreview(restarted.note),
			state: 'running',
			lastOutputAt: restartedTmux.lastOutputAt,
			attachedClients: restartedTmux.attachedClients,
			foregroundProcess: restartedTmux.foregroundProcess,
			terminals: restartedTmux.terminals,
			agentState: null,
			isGitRepository: gitRepository,
			workspaceAvailable: true
		};
	});
}

export type LaunchProfileSettings = {
	launchProfiles: LaunchProfile[];
	defaultLaunchProfileId: string | null;
	autoStartDefaultProfile: boolean;
};

function validateLaunchProfileSettings(input: LaunchProfileSettings): LaunchProfileSettings {
	if (!isLaunchProfileList(input.launchProfiles)) {
		throw new SessionMutationError('invalid-launch-profiles', 'Launch profiles must contain valid names and single-line commands.');
	}
	const launchProfiles = normalizeLaunchProfiles(input.launchProfiles);
	const defaultLaunchProfileId = input.defaultLaunchProfileId?.trim() ?? null;
	if (defaultLaunchProfileId !== null && !launchProfiles.some((profile) => profile.id === defaultLaunchProfileId)) {
		throw new SessionMutationError('invalid-launch-profiles', 'The default launch profile was not found.');
	}
	return {
		launchProfiles,
		defaultLaunchProfileId,
		autoStartDefaultProfile: input.autoStartDefaultProfile && defaultLaunchProfileId !== null
	};
}

export async function updateManagedLaunchProfiles(id: string, input: LaunchProfileSettings): Promise<LaunchProfileSettings> {
	return exclusively(async () => {
		const settings = validateLaunchProfileSettings(input);
		const state = await readState();
		const index = state.sessions.findIndex((session) => session.id === id);
		if (index < 0) throw new SessionMutationError('not-found', 'Session was not found.');

		const sessions = [...state.sessions];
		sessions[index] = { ...sessions[index], ...settings };
		await writeState({ ...state, sessions });
		return settings;
	});
}

async function sendDefaultLaunchProfile(
	stored: StoredSession,
	running: TmuxSession
): Promise<void> {
	const profile = stored.defaultLaunchProfileId
		? stored.launchProfiles.find((candidate) => candidate.id === stored.defaultLaunchProfileId)
		: undefined;
	const mainTerminal = running.terminals[0];
	if (!profile || !mainTerminal) return;
	await sendTmuxInput(stored.tmuxSession, `${profile.command}\n`);
}

export async function createManagedBackgroundProcess(id: string, command: string): Promise<TmuxTerminal> {
	return exclusively(async () => {
		const state = await readState();
		const stored = state.sessions.find((session) => session.id === id);
		if (!stored) throw new SessionMutationError('not-found', 'Session was not found.');

		const normalizedCommand = normalizeBackgroundCommand(command);
		const running = (await listTmuxSessions()).find((session) => session.name === stored.tmuxSession);
		if (!running) throw new SessionMutationError('session-not-running', 'Reopen the workspace before running a background command.');
		if (running.terminals.slice(1).length >= MAX_BACKGROUND_PROCESSES) {
			throw new SessionMutationError('background-limit', `A workspace can run up to ${MAX_BACKGROUND_PROCESSES} background commands.`);
		}
		return createTmuxBackgroundProcess(stored.tmuxSession, stored.cwd, normalizedCommand);
	});
}

export async function favoriteManagedBackgroundCommand(id: string, command: string): Promise<string[]> {
	return exclusively(async () => {
		const state = await readState();
		const index = state.sessions.findIndex((session) => session.id === id);
		if (index < 0) throw new SessionMutationError('not-found', 'Session was not found.');

		const normalizedCommand = normalizeBackgroundCommand(command);
		const stored = state.sessions[index];
		if (stored.favoriteCommands.includes(normalizedCommand)) return stored.favoriteCommands;
		if (stored.favoriteCommands.length >= MAX_FAVORITE_COMMANDS) {
			throw new SessionMutationError('favorite-limit', `A workspace can save up to ${MAX_FAVORITE_COMMANDS} favorite commands.`);
		}

		const favoriteCommands = [...stored.favoriteCommands, normalizedCommand];
		const sessions = [...state.sessions];
		sessions[index] = { ...stored, favoriteCommands };
		await writeState({ ...state, sessions });
		return favoriteCommands;
	});
}

export async function removeManagedBackgroundCommandFavorite(id: string, command: string): Promise<string[]> {
	return exclusively(async () => {
		const state = await readState();
		const index = state.sessions.findIndex((session) => session.id === id);
		if (index < 0) throw new SessionMutationError('not-found', 'Session was not found.');

		const normalizedCommand = normalizeBackgroundCommand(command);
		const stored = state.sessions[index];
		const favoriteCommands = stored.favoriteCommands.filter((favorite) => favorite !== normalizedCommand);
		if (favoriteCommands.length === stored.favoriteCommands.length) return stored.favoriteCommands;

		const sessions = [...state.sessions];
		sessions[index] = { ...stored, favoriteCommands };
		await writeState({ ...state, sessions });
		return favoriteCommands;
	});
}

export async function stopManagedBackgroundProcess(id: string, terminalId: string): Promise<void> {
	await exclusively(async () => {
		const state = await readState();
		const stored = state.sessions.find((session) => session.id === id);
		if (!stored) throw new SessionMutationError('not-found', 'Session was not found.');

		const running = (await listTmuxSessions()).find((session) => session.name === stored.tmuxSession);
		if (!running) throw new SessionMutationError('session-not-running', 'Reopen the workspace before stopping a background process.');
		const backgroundProcess = running.terminals.slice(1).find((candidate) => candidate.id === terminalId);
		if (!backgroundProcess) return;
		await killTmuxBackgroundProcess(stored.tmuxSession, backgroundProcess.id);
	});
}

export async function captureManagedBackgroundOutput(id: string, terminalId: string): Promise<string> {
	const state = await readState();
	const stored = state.sessions.find((session) => session.id === id);
	if (!stored) throw new SessionMutationError('not-found', 'Session was not found.');

	const running = (await listTmuxSessions()).find((session) => session.name === stored.tmuxSession);
	if (!running) throw new SessionMutationError('session-not-running', 'Reopen the workspace before reading background output.');
	const backgroundProcess = running.terminals.slice(1).find((candidate) => candidate.id === terminalId);
	if (!backgroundProcess) throw new SessionMutationError('background-not-found', 'Background process was not found in this workspace.');
	return captureTmuxBackgroundOutput(stored.tmuxSession, backgroundProcess.id);
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

export async function updateManagedWorkspaceAlias(id: string, alias: string): Promise<string> {
	return exclusively(async () => {
		const workspaceLabel = normalizeWorkspaceAlias(alias);
		const state = await readState();
		const index = state.sessions.findIndex((session) => session.id === id);
		if (index < 0) throw new SessionMutationError('not-found', 'Session was not found.');

		const sessions = [...state.sessions];
		sessions[index] = { ...sessions[index], workspaceLabel };
		await writeState({ ...state, sessions });
		return workspaceLabel;
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

async function cleanupManagedWorktree(stored: StoredSession): Promise<void> {
	if (stored.workspaceKind !== 'worktree' && !stored.worktreeBranch) return;
	try {
		await removeManagedGitWorktree({
			id: stored.id,
			cwd: stored.cwd,
			repositoryPath: stored.repositoryPath
		});
	} catch (cause) {
		if (cause instanceof GitWorktreeError) {
			throw new SessionMutationError('worktree-cleanup-failed', cause.message);
		}
		throw new SessionMutationError(
			'worktree-cleanup-failed',
			'Vampire could not remove the managed working copy. The workspace remains registered.'
		);
	}
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

		await cleanupManagedWorktree(stored);
		await writeState({ ...state, sessions: state.sessions.filter((session) => session.id !== id) });
	});
}

export async function stopAndRemoveManagedSession(id: string): Promise<void> {
	await exclusively(async () => {
		const state = await readState();
		const stored = state.sessions.find((session) => session.id === id);
		if (!stored) throw new SessionMutationError('not-found', 'Session was not found.');

		await killTmuxSession(stored.tmuxSession);
		await cleanupManagedWorktree(stored);
		await writeState({ ...state, sessions: state.sessions.filter((session) => session.id !== id) });
	});
}
