import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { isAgentProcessLabel, type AgentState } from '../session/agent.ts';

type ForegroundProcess = {
	kind: 'shell' | 'command';
	label: string;
};

type AgentSession = {
	id: string;
	state: 'running' | 'missing';
	terminals?: Array<{
		id: string;
		foregroundProcess?: ForegroundProcess | null;
	}>;
};

const execFile = promisify(execFileCallback);
const RECENT_SCREEN_LINES = 14;

export { isAgentProcessLabel };

// Infer only the coarse turn boundary. Terminal content is neither retained
// nor returned to callers.
export function inferAgentState(process: ForegroundProcess | null | undefined, output: string): AgentState {
	if (process?.kind !== 'command' || !isAgentProcessLabel(process.label)) return null;
	const label = process.label.toLowerCase();
	const recentLines = output.replace(/\r/g, '').split('\n').slice(-RECENT_SCREEN_LINES);
	const recent = recentLines.join('\n');

	// Some agent TUIs leave their composer visible while working, so the
	// interrupt hint must take precedence over detecting an input prompt.
	if (/(?:esc|escape)\s+to\s+(?:interrupt|cancel)/i.test(recent)) return 'working';
	if (/press\s+(?:esc|escape).{0,24}(?:interrupt|cancel)/i.test(recent)) return 'working';

	const promptPattern = label === 'codex'
		? /^\s*›(?:\s|$)/
		: label === 'claude' || label === 'claude-code'
			? /^\s*❯(?:\s|$)/
			: /^\s*[❯›>](?:\s|$)/;
	return recentLines.some((line) => promptPattern.test(line)) ? 'waiting' : null;
}

export async function readSessionAgentStates(sessions: Iterable<AgentSession>): Promise<Map<string, AgentState>> {
	const states = new Map<string, AgentState>();
	const captures: Promise<void>[] = [];
	for (const session of sessions) {
		states.set(session.id, null);
		const mainTerminal = session.terminals?.[0];
		const process = mainTerminal?.foregroundProcess;
		if (
			session.state !== 'running'
			|| !mainTerminal
			|| !/^@\d+$/.test(mainTerminal.id)
			|| process?.kind !== 'command'
			|| !isAgentProcessLabel(process.label)
		) continue;

		captures.push((async () => {
			try {
				const { stdout } = await execFile('tmux', [
					'capture-pane',
					'-p',
					'-S',
					`-${RECENT_SCREEN_LINES}`,
					'-t',
					mainTerminal.id
				], { maxBuffer: 128 * 1024, timeout: 750 });
				states.set(session.id, inferAgentState(process, stdout));
			} catch {
				// Unknown falls back to output timing; a capture failure must not
				// disrupt workspace updates.
			}
		})());
	}
	await Promise.all(captures);
	return states;
}
