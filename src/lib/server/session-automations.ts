import { randomUUID } from 'node:crypto';
import {
	isSessionAutomationSchedule,
	MAX_SESSION_AUTOMATIONS,
	nextAutomationIntervalRunAt,
	SESSION_AUTOMATION_ERROR_MAX_LENGTH,
	SESSION_AUTOMATION_NAME_MAX_LENGTH,
	SESSION_AUTOMATION_PROMPT_MAX_LENGTH,
	type CreateSessionAutomationInput,
	type SessionAutomation
} from '../session/automations.ts';
import {
	ensureManagedSessionNoteFile,
	managedSessionNotePath
} from './session-note-file.ts';
import { withSessionRegistryMutation } from './session-registry.ts';
import {
	readSessionStateFile,
	readSessionStore,
	type StoredSession,
	writeSessionStore
} from './session-store.ts';

const SESSION_AUTOMATION_DISPATCH_COOLDOWN_MS = 5_000;

export type SessionAutomationMutationErrorReason =
	| 'not-found'
	| 'automation-not-found'
	| 'invalid-input'
	| 'limit';

export class SessionAutomationMutationError extends Error {
	readonly reason: SessionAutomationMutationErrorReason;

	constructor(reason: SessionAutomationMutationErrorReason, message: string) {
		super(message);
		this.reason = reason;
	}
}

export type DueManagedSessionAutomation = {
	sessionId: string;
	automationId: string;
	dueAt: number;
};

type PreparedAutomationSubmission = () => Promise<void>;
type PrepareAutomationSubmission = (
	session: StoredSession,
	automation: SessionAutomation
) => Promise<PreparedAutomationSubmission | undefined>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function legacyNoteState(value: unknown): {
	present: boolean;
	note?: string;
} {
	if (!isRecord(value)) return { present: false };
	return {
		present: 'note' in value || 'noteFile' in value || 'agentNoteFile' in value,
		...(typeof value.note === 'string' ? { note: value.note } : {})
	};
}

function normalizeCreateInput(value: unknown): CreateSessionAutomationInput {
	if (!isRecord(value)) {
		throw new SessionAutomationMutationError('invalid-input', 'Automation settings are required.');
	}
	const name = typeof value.name === 'string' ? value.name.trim() : '';
	const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : '';
	if (!name || name.length > SESSION_AUTOMATION_NAME_MAX_LENGTH || /[\0\r\n\t]/.test(name)) {
		throw new SessionAutomationMutationError(
			'invalid-input',
			`Automation names must stay on one line and be ${SESSION_AUTOMATION_NAME_MAX_LENGTH} characters or fewer.`
		);
	}
	if (!prompt || prompt.length > SESSION_AUTOMATION_PROMPT_MAX_LENGTH || prompt.includes('\0')) {
		throw new SessionAutomationMutationError(
			'invalid-input',
			`Automation prompts must be ${SESSION_AUTOMATION_PROMPT_MAX_LENGTH.toLocaleString('en-US')} characters or fewer.`
		);
	}
	if (!isSessionAutomationSchedule(value.schedule)) {
		throw new SessionAutomationMutationError('invalid-input', 'Automation schedule is invalid.');
	}
	return { name, prompt, schedule: { ...value.schedule } };
}

function automationFromInput(
	input: CreateSessionAutomationInput,
	now: number,
	kind: SessionAutomation['kind'] = 'custom'
): SessionAutomation {
	const nextRunAt = input.schedule.type === 'once' ? input.schedule.runAt : input.schedule.startAt;
	return {
		id: randomUUID(),
		kind,
		name: input.name,
		prompt: input.prompt,
		schedule: { ...input.schedule },
		enabled: true,
		nextRunAt,
		createdAt: now,
		updatedAt: now,
		lastAttemptAt: null,
		lastRunAt: null,
		lastOutcome: null,
		lastError: null
	};
}

function replaceStoredAutomation(
	session: StoredSession,
	automation: SessionAutomation
): StoredSession {
	return {
		...session,
		automations: session.automations.map((candidate) => candidate.id === automation.id ? automation : candidate)
	};
}

function replaceStoredSession(
	sessions: StoredSession[],
	updated: StoredSession
): StoredSession[] {
	return sessions.map((session) => session.id === updated.id ? updated : session);
}

export async function listManagedSessionAutomations(id: string): Promise<SessionAutomation[]> {
	const stored = (await readSessionStore()).sessions.find((session) => session.id === id);
	if (!stored) throw new SessionAutomationMutationError('not-found', 'Session was not found.');
	return stored.automations
		.map((automation) => ({ ...automation, schedule: { ...automation.schedule } }))
		.sort((left, right) => right.createdAt - left.createdAt);
}

export async function createManagedSessionAutomation(
	id: string,
	value: unknown,
	now = Date.now()
): Promise<SessionAutomation> {
	const input = normalizeCreateInput(value);
	return withSessionRegistryMutation(async () => {
		const state = await readSessionStore();
		const index = state.sessions.findIndex((session) => session.id === id);
		if (index < 0) throw new SessionAutomationMutationError('not-found', 'Session was not found.');
		const stored = state.sessions[index];
		if (stored.automations.length >= MAX_SESSION_AUTOMATIONS) {
			throw new SessionAutomationMutationError(
				'limit',
				`A workspace can save up to ${MAX_SESSION_AUTOMATIONS} automations.`
			);
		}
		const automation = automationFromInput(input, now);
		const sessions = [...state.sessions];
		sessions[index] = { ...stored, automations: [...stored.automations, automation] };
		await writeSessionStore({ ...state, sessions });
		return automation;
	});
}

export async function setManagedSessionAutomationEnabled(
	sessionId: string,
	automationId: string,
	enabled: boolean,
	now = Date.now()
): Promise<SessionAutomation> {
	return withSessionRegistryMutation(async () => {
		const state = await readSessionStore();
		const stored = state.sessions.find((session) => session.id === sessionId);
		if (!stored) throw new SessionAutomationMutationError('not-found', 'Session was not found.');
		const current = stored.automations.find((automation) => automation.id === automationId);
		if (!current) {
			throw new SessionAutomationMutationError('automation-not-found', 'Automation was not found.');
		}
		let nextRunAt = current.nextRunAt;
		if (enabled && (nextRunAt === null || nextRunAt <= now)) {
			nextRunAt = current.schedule.type === 'once'
				? now
				: now + current.schedule.intervalMs;
		}
		const automation: SessionAutomation = {
			...current,
			enabled,
			nextRunAt,
			updatedAt: now,
			...(enabled ? { lastOutcome: null, lastError: null } : {})
		};
		const updated = replaceStoredAutomation(stored, automation);
		await writeSessionStore({ ...state, sessions: replaceStoredSession(state.sessions, updated) });
		return automation;
	});
}

export async function deleteManagedSessionAutomation(
	sessionId: string,
	automationId: string
): Promise<void> {
	await withSessionRegistryMutation(async () => {
		const state = await readSessionStore();
		const stored = state.sessions.find((session) => session.id === sessionId);
		if (!stored) throw new SessionAutomationMutationError('not-found', 'Session was not found.');
		const automations = stored.automations.filter((automation) => automation.id !== automationId);
		if (automations.length === stored.automations.length) {
			throw new SessionAutomationMutationError('automation-not-found', 'Automation was not found.');
		}
		await writeSessionStore({
			...state,
			sessions: replaceStoredSession(state.sessions, { ...stored, automations })
		});
	});
}

export async function listDueManagedSessionAutomations(
	now = Date.now()
): Promise<DueManagedSessionAutomation[]> {
	const state = await readSessionStore();
	const candidates: DueManagedSessionAutomation[] = [];
	for (const session of state.sessions) {
		const latestAttemptAt = Math.max(
			0,
			...session.automations.map((automation) => automation.lastAttemptAt ?? 0)
		);
		if (latestAttemptAt > now - SESSION_AUTOMATION_DISPATCH_COOLDOWN_MS) continue;
		const due = session.automations
			.filter((automation) => automation.enabled
				&& automation.nextRunAt !== null
				&& automation.nextRunAt <= now)
			.sort((left, right) => (left.nextRunAt ?? 0) - (right.nextRunAt ?? 0))[0];
		if (!due || due.nextRunAt === null) continue;
		candidates.push({ sessionId: session.id, automationId: due.id, dueAt: due.nextRunAt });
	}
	return candidates.sort((left, right) => left.dueAt - right.dueAt);
}

function consumedAutomation(automation: SessionAutomation, now: number): SessionAutomation {
	if (automation.schedule.type === 'once') {
		return {
			...automation,
			enabled: false,
			nextRunAt: null,
			updatedAt: now,
			lastAttemptAt: now,
			lastOutcome: 'uncertain',
			lastError: null
		};
	}
	return {
		...automation,
		enabled: true,
		nextRunAt: nextAutomationIntervalRunAt(
			automation.nextRunAt ?? now,
			automation.schedule.intervalMs,
			now
		),
		updatedAt: now,
		lastAttemptAt: now,
		lastOutcome: 'uncertain',
		lastError: null
	};
}

export async function dispatchManagedSessionAutomation(
	sessionId: string,
	automationId: string,
	now: number,
	prepare: PrepareAutomationSubmission
): Promise<'submitted' | 'failed' | 'not-ready' | 'not-due'> {
	return withSessionRegistryMutation(async () => {
		const state = await readSessionStore();
		const stored = state.sessions.find((session) => session.id === sessionId);
		const current = stored?.automations.find((automation) => automation.id === automationId);
		if (!stored || !current || !current.enabled || current.nextRunAt === null || current.nextRunAt > now) {
			return 'not-due';
		}
		const submit = await prepare(stored, current);
		if (!submit) return 'not-ready';

		const attempted = consumedAutomation(current, now);
		const attemptedSession = replaceStoredAutomation(stored, attempted);
		const attemptedState = {
			...state,
			sessions: replaceStoredSession(state.sessions, attemptedSession)
		};
		await writeSessionStore(attemptedState);

		let completed: SessionAutomation;
		let outcome: 'submitted' | 'failed';
		try {
			await submit();
			completed = {
				...attempted,
				updatedAt: now,
				lastRunAt: now,
				lastOutcome: 'submitted',
				lastError: null
			};
			outcome = 'submitted';
		} catch (error) {
			const message = error instanceof Error ? error.message : 'The prompt could not be submitted.';
			completed = {
				...attempted,
				updatedAt: now,
				lastOutcome: 'failed',
				lastError: message.slice(0, SESSION_AUTOMATION_ERROR_MAX_LENGTH)
			};
			outcome = 'failed';
		}
		const completedSession = replaceStoredAutomation(attemptedSession, completed);
		await writeSessionStore({
			...attemptedState,
			sessions: replaceStoredSession(attemptedState.sessions, completedSession)
		});
		return outcome;
	});
}

function sessionNotePrompt(path: string): string {
	return [
		'Review the work and conversation in this main agent session, then update only the Vampire workspace note file at this exact path:',
		JSON.stringify(path),
		'',
		'This note is the shared Markdown memory for the Vampire workspace, not a disposable summary. Read the existing note first and preserve useful context, user-written Markdown, and headings.',
		'Do not delete, reorder, or rewrite existing content just to fit a template. Make the smallest useful update and leave unfamiliar sections verbatim. Do not truncate useful context.',
		'Infer the document language from the user\'s language and the conversation context. Do not assume the document should be in English just because these instructions are in English.',
		'The first non-empty line must be a plain Markdown paragraph with no heading and no "Summary:" label. It is shown as the workspace-list preview, so make it one concise sentence that combines the current state with the immediate next action.',
		'After that line and a blank line, use Markdown level-two headings equivalent to Next and Done, translating them into the inferred document language when appropriate. Put the immediate next task in the Next section. Add Tasks, Decisions, Blockers, or Notes only when useful.',
		'If the existing note already has a summary line or these sections, update them in place. If it does not, add the plain summary and missing sections without removing the existing body.',
		'Do not edit any other file. After saving the note, briefly confirm what changed.'
	].join('\n');
}

export async function queueManagedSessionNoteSummary(
	sessionId: string,
	now = Date.now()
): Promise<{ automation: SessionAutomation; notePath: string }> {
	return withSessionRegistryMutation(async () => {
		const state = await readSessionStore();
		const stored = state.sessions.find((session) => session.id === sessionId);
		if (!stored) throw new SessionAutomationMutationError('not-found', 'Session was not found.');
		const existing = stored.automations.find((automation) => automation.kind === 'note');
		if (!existing && stored.automations.length >= MAX_SESSION_AUTOMATIONS) {
			throw new SessionAutomationMutationError(
				'limit',
				`A workspace can save up to ${MAX_SESSION_AUTOMATIONS} automations.`
			);
		}
		await ensureManagedSessionNoteFile(stored.id, '');
		const notePath = managedSessionNotePath(stored.id);
		const input: CreateSessionAutomationInput = {
			name: 'Update workspace note',
			prompt: sessionNotePrompt(notePath),
			schedule: { type: 'once', runAt: now }
		};
		let automation: SessionAutomation;
		let automations: SessionAutomation[];
		if (existing) {
			automation = {
				...existing,
				...input,
				schedule: { ...input.schedule },
				enabled: true,
				nextRunAt: now,
				updatedAt: now,
				lastOutcome: null,
				lastError: null
			};
			automations = stored.automations.map((candidate) => candidate.id === existing.id ? automation : candidate);
		} else {
			automation = automationFromInput(input, now, 'note');
			automations = [...stored.automations, automation];
		}
		const updated = { ...stored, automations };
		await writeSessionStore({ ...state, sessions: replaceStoredSession(state.sessions, updated) });
		return { automation, notePath };
	});
}

export async function migrateManagedSessionNotes(): Promise<number> {
	return withSessionRegistryMutation(async () => {
		const state = await readSessionStore();
		let rawState: unknown;
		try {
			rawState = await readSessionStateFile();
		} catch {
			return 0;
		}
		const rawSessions = isRecord(rawState) && Array.isArray(rawState.sessions)
			? rawState.sessions
			: [];
		const legacyById = new Map<string, ReturnType<typeof legacyNoteState>>();
		for (const rawSession of rawSessions) {
			if (!isRecord(rawSession) || typeof rawSession.id !== 'string') continue;
			legacyById.set(rawSession.id, legacyNoteState(rawSession));
		}
		const legacyCount = [...legacyById.values()].filter((legacy) => legacy.present).length;

		// Complete the file migration before removing the old JSON fields. If any
		// file operation fails, the registry stays untouched and the next startup
		// can retry without losing the source note.
		await Promise.all(state.sessions.map(async (stored) => {
			const legacy = legacyById.get(stored.id);
			await ensureManagedSessionNoteFile(stored.id, legacy?.note ?? '');
		}));

		if (legacyCount > 0) await writeSessionStore(state);
		return legacyCount;
	});
}
