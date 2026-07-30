import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { readSessionStateFile, SESSION_STATE_VERSION } from './session-state.mjs';
import { createSessionNotePreview } from './session-note.mjs';
import { isGitRepository } from './repository.mjs';

const execFile = promisify(execFileCallback);
const SHELL_COMMANDS = new Set(['bash', 'dash', 'fish', 'ksh', 'nu', 'powershell', 'pwsh', 'sh', 'tcsh', 'zsh']);

/**
 * @typedef {{ id: string; tmuxSession: string; cwd: string; createdAt: number; lastActiveAt: number; note: string }} StoredSession
 * @typedef {{ pid: number; ppid: number; pgid: number; tpgid: number; command: string }} ProcessRecord
 * @typedef {{ name: string; createdAt: number | null; lastOutputAt: number | null; attachedClients: number; foregroundProcess: TmuxProcessHint | null }} TmuxSessionSnapshot
 * @typedef {{ name: string; lastOutputAt: number | null }} TmuxSessionActivity
 * @typedef {{ kind: 'shell' | 'command'; label: string }} TmuxProcessHint
 * @typedef {{ id: string; tmuxSession: string; cwd: string; createdAt: number; lastActiveAt: number; notePreview: string; state: 'running' | 'missing'; lastOutputAt: number | null; attachedClients: number; foregroundProcess: TmuxProcessHint | null; isGitRepository: boolean }} ManagedSessionSnapshot
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is StoredSession} */
function isStoredSession(value) {
	return isRecord(value)
		&& typeof value.id === 'string'
		&& typeof value.tmuxSession === 'string'
		&& typeof value.cwd === 'string'
		&& typeof value.createdAt === 'number'
		&& (value.lastActiveAt === undefined || typeof value.lastActiveAt === 'number')
		&& (value.note === undefined || typeof value.note === 'string');
}

/** @returns {Promise<{ sessions: StoredSession[] }>} */
async function readState() {
	try {
		const parsed = await readSessionStateFile();
		if (!isRecord(parsed) || parsed.version !== SESSION_STATE_VERSION || !Array.isArray(parsed.sessions) || !parsed.sessions.every(isStoredSession)) {
			throw new Error('invalid state file');
		}
		const sessions = /** @type {StoredSession[]} */ (parsed.sessions);
		return {
			sessions: sessions.map(({ id, tmuxSession, cwd, createdAt, lastActiveAt, note }) => ({
				id,
				tmuxSession,
				cwd,
				createdAt,
				lastActiveAt: typeof lastActiveAt === 'number' ? lastActiveAt : createdAt,
				note: typeof note === 'string' ? note : ''
			}))
		};
	} catch (error) {
		const details = /** @type {NodeJS.ErrnoException} */ (error);
		if (details.code === 'ENOENT') return { sessions: [] };
		throw new Error('Vampire session registry is unreadable; refusing to overwrite it.');
	}
}

/** @param {string} output @returns {Map<number, ProcessRecord>} */
function parseProcessTable(output) {
	const processes = new Map();
	for (const line of output.split('\n')) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 5) continue;
		const [pid, ppid, pgid, tpgid] = fields.slice(0, 4).map(Number);
		if (![pid, ppid, pgid, tpgid].every(Number.isFinite)) continue;
		processes.set(pid, { pid, ppid, pgid, tpgid, command: fields.slice(4).join(' ') });
	}
	return processes;
}

/** @param {string} command */
function executableName(command) {
	const executable = command.trim().split(/\s+/, 1)[0] ?? '';
	return executable.split('/').pop()?.replace(/^-/, '').toLowerCase() || '';
}

/** @param {number} panePid @param {Map<number, ProcessRecord>} processes */
function foregroundProcessForPane(panePid, processes) {
	const paneProcess = processes.get(panePid);
	let foregroundProcess = paneProcess?.tpgid ? processes.get(paneProcess.tpgid) : undefined;
	while (foregroundProcess && !SHELL_COMMANDS.has(executableName(foregroundProcess.command))) {
		const children = [...processes.values()].filter(
			(candidate) => candidate.ppid === foregroundProcess?.pid && candidate.tpgid === foregroundProcess?.tpgid
		);
		if (children.length !== 1) break;
		foregroundProcess = children[0];
	}
	return foregroundProcess;
}

/** @param {string} currentCommand @param {string} title @param {number} panePid @param {Map<number, ProcessRecord>} processes @returns {TmuxProcessHint | null} */
function classifyProcess(currentCommand, title, panePid, processes) {
	if (!currentCommand && !title && panePid <= 0) return null;
	const foregroundProcess = foregroundProcessForPane(panePid, processes);
	const command = executableName(foregroundProcess?.command || currentCommand || title) || 'process';
	if (SHELL_COMMANDS.has(command)) return { kind: 'shell', label: command };
	return { kind: 'command', label: command };
}

/** @param {string} output @param {Map<number, ProcessRecord>} processes @returns {TmuxSessionSnapshot[]} */
function parseTmuxSessions(output, processes) {
	return output
		.trim()
		.split('\n')
		.filter(Boolean)
		.flatMap((line) => {
			const [name, createdAt, lastOutputAt, attachedClients, currentCommand, panePidValue, title] = line.split('\t');
			if (!name) return [];

			const created = Number(createdAt);
			const lastOutput = Number(lastOutputAt);
			const attached = Number(attachedClients);
			const panePid = Number(panePidValue);
			return [{
				name,
				createdAt: Number.isFinite(created) ? created * 1_000 : null,
				lastOutputAt: Number.isFinite(lastOutput) ? lastOutput * 1_000 : null,
				attachedClients: Number.isFinite(attached) ? attached : 0,
				foregroundProcess: classifyProcess(
					currentCommand ?? '',
					title ?? '',
					Number.isFinite(panePid) ? panePid : 0,
					processes
				)
			}];
		});
}

/** @param {string} output @returns {TmuxSessionActivity[]} */
export function parseTmuxSessionActivity(output) {
	return output
		.trim()
		.split('\n')
		.filter(Boolean)
		.flatMap((line) => {
			const [name, lastOutputAt] = line.split('\t');
			if (!name) return [];
			const timestamp = Number(lastOutputAt);
			return [{
				name,
				lastOutputAt: Number.isFinite(timestamp) ? timestamp * 1_000 : null
			}];
		});
}

/** @returns {Promise<TmuxSessionSnapshot[]>} */
async function listTmuxSessions() {
	try {
		const [{ stdout }, processTable] = await Promise.all([
			execFile('tmux', [
				'list-sessions',
				'-F',
				'#{session_name}\t#{session_created}\t#{window_activity}\t#{session_attached}\t#{pane_current_command}\t#{pane_pid}\t#{pane_title}'
			]),
			execFile('ps', ['-axo', 'pid=,ppid=,pgid=,tpgid=,command='], { maxBuffer: 2 * 1024 * 1024 })
				.then(({ stdout: processOutput }) => parseProcessTable(processOutput))
				.catch(() => new Map())
		]);
		return parseTmuxSessions(stdout, processTable);
	} catch (error) {
		const details = /** @type {NodeJS.ErrnoException & { stderr?: string }} */ (error);
		if (details.code === 'ENOENT' || /(?:tmux|command) (?:not found|not recognized)/i.test(`${details.message ?? ''} ${details.stderr ?? ''}`)) return [];
		if (Number(details.code) === 1 && /no server running/i.test(details.stderr ?? '')) return [];
		throw error;
	}
}

/** @returns {Promise<TmuxSessionActivity[]>} */
export async function listTmuxSessionActivity() {
	try {
		const { stdout } = await execFile('tmux', [
			'list-sessions',
			'-F',
			'#{session_name}\t#{window_activity}'
		]);
		return parseTmuxSessionActivity(stdout);
	} catch (error) {
		const details = /** @type {NodeJS.ErrnoException & { stderr?: string }} */ (error);
		if (details.code === 'ENOENT' || /(?:tmux|command) (?:not found|not recognized)/i.test(`${details.message ?? ''} ${details.stderr ?? ''}`)) return [];
		if (Number(details.code) === 1 && /no server running/i.test(details.stderr ?? '')) return [];
		throw error;
	}
}

/** @returns {Promise<ManagedSessionSnapshot[]>} */
export async function listManagedSessions() {
	const [state, tmuxSessions] = await Promise.all([readState(), listTmuxSessions()]);
	const repositoryStates = await Promise.all([...new Set(state.sessions.map((session) => session.cwd))].map(async (cwd) => {
		try {
			return /** @type {[string, boolean]} */ ([cwd, await isGitRepository(cwd)]);
		} catch {
			return /** @type {[string, boolean]} */ ([cwd, false]);
		}
	}));
	const repositoryByCwd = new Map(repositoryStates);
	const byName = new Map(tmuxSessions.map((session) => [session.name, session]));
	return state.sessions.map((session) => {
		const tmux = byName.get(session.tmuxSession);
		const { note, ...withoutNote } = session;
		return {
			...withoutNote,
			notePreview: createSessionNotePreview(note),
			state: tmux ? 'running' : 'missing',
			lastOutputAt: tmux?.lastOutputAt ?? null,
			attachedClients: tmux?.attachedClients ?? 0,
			foregroundProcess: tmux?.foregroundProcess ?? null,
			isGitRepository: repositoryByCwd.get(session.cwd) ?? false
		};
	});
}
