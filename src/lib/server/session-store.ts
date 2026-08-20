import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { errorHasCode } from './path-policy.ts';
import { MAX_LAUNCH_PROFILES, normalizeLaunchProfiles } from '../session/launch-profiles.ts';
import type { LaunchProfile, WorkspacePreferences } from '../session/types.ts';

export const SESSION_STATE_VERSION = 1;
export const BACKGROUND_COMMAND_MAX_LENGTH = 1_000;
export const MAX_FAVORITE_COMMANDS = 16;

export interface StoredSession {
	id: string;
	tmuxSession: string;
	cwd: string;
	workspaceKind?: 'directory' | 'worktree';
	repositoryPath?: string;
	workspaceLabel?: string;
	worktreeBranch?: string;
	createdAt: number;
	lastActiveAt: number;
	note: string;
	favoriteCommands: string[];
	startupProfileId: string | null;
}

export interface SessionStore {
	version: typeof SESSION_STATE_VERSION;
	sessions: StoredSession[];
	launchProfiles: LaunchProfile[];
	workspacePreferences?: WorkspacePreferences;
}

export interface SessionConnection {
	tmuxSession: string;
	cwd: string;
}

export function sessionStatePath(): string {
	const directory = process.env.VAMPIRE_STATE_DIR?.trim() || join(homedir(), '.vampire');
	return join(resolve(directory), 'sessions.json');
}

export async function readSessionStateFile(file = sessionStatePath()): Promise<unknown> {
	return JSON.parse(await readFile(file, 'utf8')) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStoredSession(value: unknown): value is Record<string, unknown> & Pick<StoredSession, 'id' | 'tmuxSession' | 'cwd' | 'createdAt'> {
	return isRecord(value)
		&& typeof value.id === 'string'
		&& typeof value.tmuxSession === 'string'
		&& typeof value.cwd === 'string'
		&& (value.workspaceKind === undefined || value.workspaceKind === 'directory' || value.workspaceKind === 'worktree')
		&& (value.repositoryPath === undefined || typeof value.repositoryPath === 'string')
		&& (value.workspaceLabel === undefined || typeof value.workspaceLabel === 'string')
		&& (value.worktreeBranch === undefined || typeof value.worktreeBranch === 'string')
		&& typeof value.createdAt === 'number'
		&& (value.lastActiveAt === undefined || typeof value.lastActiveAt === 'number')
		&& (value.note === undefined || typeof value.note === 'string')
		&& (value.favoriteCommands === undefined || (
			Array.isArray(value.favoriteCommands)
			&& value.favoriteCommands.every((command) => typeof command === 'string')
		))
		&& (value.startupProfileId === undefined || value.startupProfileId === null || typeof value.startupProfileId === 'string')
		&& (value.launchProfiles === undefined || Array.isArray(value.launchProfiles))
		&& (value.defaultLaunchProfileId === undefined || value.defaultLaunchProfileId === null || typeof value.defaultLaunchProfileId === 'string')
		&& (value.autoStartDefaultProfile === undefined || typeof value.autoStartDefaultProfile === 'boolean');
}

function uniqueLaunchProfileId(id: string, usedIds: Set<string>): string {
	if (!usedIds.has(id)) return id;
	let suffix = 2;
	while (true) {
		const suffixText = `-${suffix}`;
		const candidate = `${id.slice(0, 100 - suffixText.length)}${suffixText}`;
		if (!usedIds.has(candidate)) return candidate;
		suffix += 1;
	}
}

function migrateLegacyLaunchProfiles(
	sessions: Array<Record<string, unknown>>
): { launchProfiles: LaunchProfile[]; profileIdsBySession: Map<string, Map<string, string>> } {
	const launchProfiles: LaunchProfile[] = [];
	const profileIdsBySession = new Map<string, Map<string, string>>();
	const globalIdByDefinition = new Map<string, string>();
	const usedIds = new Set<string>();

	for (const session of sessions) {
		const profileIds = new Map<string, string>();
		for (const profile of normalizeLaunchProfiles(session.launchProfiles)) {
			const definition = `${profile.name}\0${profile.command}`;
			let globalId = globalIdByDefinition.get(definition);
			if (!globalId && launchProfiles.length < MAX_LAUNCH_PROFILES) {
				globalId = uniqueLaunchProfileId(profile.id, usedIds);
				usedIds.add(globalId);
				globalIdByDefinition.set(definition, globalId);
				launchProfiles.push({ ...profile, id: globalId });
			}
			if (globalId) profileIds.set(profile.id, globalId);
		}
		profileIdsBySession.set(session.id as string, profileIds);
	}

	return { launchProfiles, profileIdsBySession };
}

function normalizeFavoriteCommands(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value
		.filter((command): command is string => typeof command === 'string')
		.map((command) => command.trim())
		.filter((command) => command.length > 0
			&& command.length <= BACKGROUND_COMMAND_MAX_LENGTH
			&& !/[\0\r\n\t]/.test(command)))]
		.slice(0, MAX_FAVORITE_COMMANDS);
}

function normalizeWorkspacePreferences(value: unknown): WorkspacePreferences | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)
		|| (value.sessionOrderMode !== 'activity' && value.sessionOrderMode !== 'manual')
		|| !Array.isArray(value.manualSessionOrder)
		|| !value.manualSessionOrder.every((id) => typeof id === 'string')) {
		throw new Error('invalid workspace preferences');
	}
	return {
		sessionOrderMode: value.sessionOrderMode,
		manualSessionOrder: [...new Set(value.manualSessionOrder)]
	};
}

function parseSessionStore(value: unknown): SessionStore {
	if (!isRecord(value)
		|| value.version !== SESSION_STATE_VERSION
		|| !Array.isArray(value.sessions)
		|| !value.sessions.every(isStoredSession)
		|| (value.launchProfiles !== undefined && !Array.isArray(value.launchProfiles))) {
		throw new Error('invalid state file');
	}

	const workspacePreferences = normalizeWorkspacePreferences(value.workspacePreferences);
	const legacy = value.launchProfiles === undefined
		? migrateLegacyLaunchProfiles(value.sessions)
		: undefined;
	const launchProfiles = legacy?.launchProfiles ?? normalizeLaunchProfiles(value.launchProfiles);
	const launchProfileIds = new Set(launchProfiles.map((profile) => profile.id));
	return {
		version: SESSION_STATE_VERSION,
		...(workspacePreferences ? { workspacePreferences } : {}),
		launchProfiles,
		sessions: value.sessions.map((session) => {
			const explicitStartupProfileId = typeof session.startupProfileId === 'string'
				? session.startupProfileId.trim()
				: null;
			const legacyStartupProfileId = session.autoStartDefaultProfile === true
				&& typeof session.defaultLaunchProfileId === 'string'
				? legacy?.profileIdsBySession.get(session.id)?.get(session.defaultLaunchProfileId)
					?? session.defaultLaunchProfileId
				: null;
			const startupProfileId = explicitStartupProfileId && launchProfileIds.has(explicitStartupProfileId)
				? explicitStartupProfileId
				: legacyStartupProfileId && launchProfileIds.has(legacyStartupProfileId)
					? legacyStartupProfileId
					: null;
			const workspaceKind = session.workspaceKind === 'worktree' || typeof session.worktreeBranch === 'string'
				? 'worktree' as const
				: session.workspaceKind === 'directory'
					? 'directory' as const
					: undefined;
			return {
				id: session.id,
				tmuxSession: session.tmuxSession,
				cwd: session.cwd,
				...(workspaceKind ? { workspaceKind } : {}),
				...(typeof session.repositoryPath === 'string' ? { repositoryPath: session.repositoryPath } : {}),
				...(typeof session.workspaceLabel === 'string' ? { workspaceLabel: session.workspaceLabel } : {}),
				...(typeof session.worktreeBranch === 'string' ? { worktreeBranch: session.worktreeBranch } : {}),
				createdAt: session.createdAt,
				lastActiveAt: typeof session.lastActiveAt === 'number' ? session.lastActiveAt : session.createdAt,
				note: typeof session.note === 'string' ? session.note : '',
				favoriteCommands: normalizeFavoriteCommands(session.favoriteCommands),
				startupProfileId
			};
		})
	};
}

export async function readSessionStore(file = sessionStatePath()): Promise<SessionStore> {
	try {
		return parseSessionStore(await readSessionStateFile(file));
	} catch (error) {
		if (errorHasCode(error, 'ENOENT')) return { version: SESSION_STATE_VERSION, sessions: [], launchProfiles: [] };
		throw new Error('Vampire session registry is unreadable; refusing to overwrite it.', { cause: error });
	}
}

export async function writeSessionStore(state: SessionStore, file = sessionStatePath()): Promise<void> {
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	const temporaryFile = `${file}.${randomUUID()}.tmp`;
	await writeFile(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
	await rename(temporaryFile, file);
}

export async function findSessionConnection(id: string, file?: string): Promise<SessionConnection | undefined> {
	try {
		const state = await readSessionStateFile(file);
		if (!isRecord(state) || !Array.isArray(state.sessions)) return undefined;
		const session = state.sessions.find((candidate) => isRecord(candidate) && candidate.id === id);
		if (!isRecord(session) || typeof session.tmuxSession !== 'string' || typeof session.cwd !== 'string') {
			return undefined;
		}
		return { tmuxSession: session.tmuxSession, cwd: session.cwd };
	} catch {
		return undefined;
	}
}
