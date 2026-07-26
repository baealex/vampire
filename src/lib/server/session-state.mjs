import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const SESSION_STATE_VERSION = 1;

export function sessionStatePath() {
	const directory = process.env.VAMPIRE_STATE_DIR?.trim() || join(homedir(), '.vampire');
	return join(resolve(directory), 'sessions.json');
}

export async function readSessionStateFile(file = sessionStatePath()) {
	return JSON.parse(await readFile(file, 'utf8'));
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {string} id
 * @param {string} [file]
 */
export async function findSessionConnection(id, file) {
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
