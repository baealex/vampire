import { readSessionAgentStates } from '../src/lib/server/agent-activity.ts';
import {
	dispatchManagedSessionAutomation,
	listDueManagedSessionAutomations,
	migrateManagedSessionNotes
} from '../src/lib/server/session-automations.ts';
import type { StoredSession } from '../src/lib/server/session-store.ts';
import {
	listTmuxSessions,
	submitTmuxPrompt,
	type TmuxSession,
	type TmuxTerminal
} from '../src/lib/server/tmux.ts';
import { isAgentProcessLabel, type AgentState } from '../src/lib/session/agent.ts';
import type { SessionAutomation } from '../src/lib/session/automations.ts';

const AUTOMATION_POLL_INTERVAL_MS = 2_000;

export function automationSubmissionTerminal(
	session: TmuxSession | undefined,
	agentState: AgentState
): TmuxTerminal | undefined {
	const mainTerminal = session?.terminals[0];
	const process = mainTerminal?.foregroundProcess;
	return agentState === 'waiting'
		&& mainTerminal?.index === 0
		&& mainTerminal.state === 'running'
		&& process?.kind === 'command'
		&& isAgentProcessLabel(process.label)
		? mainTerminal
		: undefined;
}

type AutomationSubmissionDependencies = {
	listSessions: typeof listTmuxSessions;
	readAgentStates: typeof readSessionAgentStates;
	submitPrompt: typeof submitTmuxPrompt;
};

const submissionDependencies: AutomationSubmissionDependencies = {
	listSessions: listTmuxSessions,
	readAgentStates: readSessionAgentStates,
	submitPrompt: submitTmuxPrompt
};

export async function prepareAutomationSubmission(
	stored: StoredSession,
	automation: SessionAutomation,
	dependencies: AutomationSubmissionDependencies = submissionDependencies
): Promise<(() => Promise<void>) | undefined> {
	const running = (await dependencies.listSessions())
		.find((session) => session.name === stored.tmuxSession);
	if (!running) return undefined;
	const detected = await dependencies.readAgentStates([{
		id: stored.id,
		state: 'running',
		terminals: running.terminals
	}]);
	const terminal = automationSubmissionTerminal(running, detected.get(stored.id) ?? null);
	if (!terminal) return undefined;
	return () => dependencies.submitPrompt(stored.tmuxSession, terminal.id, automation.prompt);
}

export async function runSessionAutomationTick(now = Date.now()): Promise<void> {
	const due = await listDueManagedSessionAutomations(now);
	for (const candidate of due) {
		try {
			await dispatchManagedSessionAutomation(
				candidate.sessionId,
				candidate.automationId,
				now,
				(stored, automation) => prepareAutomationSubmission(stored, automation)
			);
		} catch {
			// One unreadable workspace must not stop other users' queued automations.
		}
	}
}

export async function installSessionAutomationRunner(): Promise<() => void> {
	let noteMigrationComplete = false;
	const attemptNoteMigration = async () => {
		if (noteMigrationComplete) return;
		try {
			await migrateManagedSessionNotes();
			noteMigrationComplete = true;
		} catch {
			// Retry the migration on the next automation tick without falling back
			// to the legacy JSON note.
		}
	};
	await attemptNoteMigration();
	let activeTick: Promise<void> | undefined;
	const tick = () => {
		if (activeTick) return;
		activeTick = attemptNoteMigration()
			.then(() => runSessionAutomationTick())
			.catch(() => undefined)
			.finally(() => { activeTick = undefined; });
	};
	void tick();
	const timer = setInterval(tick, AUTOMATION_POLL_INTERVAL_MS);
	timer.unref();
	return () => clearInterval(timer);
}
