export const SESSION_AUTOMATION_NAME_MAX_LENGTH = 80;
export const SESSION_AUTOMATION_PROMPT_MAX_LENGTH = 8_000;
export const SESSION_AUTOMATION_ERROR_MAX_LENGTH = 500;
export const MAX_SESSION_AUTOMATIONS = 32;
export const MIN_AUTOMATION_INTERVAL_MS = 60_000;
export const MAX_AUTOMATION_INTERVAL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_JAVASCRIPT_DATE_TIMESTAMP = 8_640_000_000_000_000;

export type SessionAutomationSchedule =
	| { type: 'once'; runAt: number }
	| { type: 'interval'; intervalMs: number; startAt: number };

export type SessionAutomationOutcome = 'submitted' | 'failed' | 'uncertain' | null;

export type SessionAutomation = {
	id: string;
	kind: 'custom' | 'note';
	name: string;
	prompt: string;
	schedule: SessionAutomationSchedule;
	enabled: boolean;
	nextRunAt: number | null;
	createdAt: number;
	updatedAt: number;
	lastAttemptAt: number | null;
	lastRunAt: number | null;
	lastOutcome: SessionAutomationOutcome;
	lastError: string | null;
};

export type CreateSessionAutomationInput = {
	name: string;
	prompt: string;
	schedule: SessionAutomationSchedule;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is number {
	return typeof value === 'number'
		&& Number.isSafeInteger(value)
		&& value >= 0
		&& value <= MAX_JAVASCRIPT_DATE_TIMESTAMP;
}

export function isSessionAutomationSchedule(value: unknown): value is SessionAutomationSchedule {
	if (!isRecord(value) || !isTimestamp(value.type === 'once' ? value.runAt : value.startAt)) return false;
	if (value.type === 'once') return true;
	return value.type === 'interval'
		&& typeof value.intervalMs === 'number'
		&& Number.isSafeInteger(value.intervalMs)
		&& value.intervalMs >= MIN_AUTOMATION_INTERVAL_MS
		&& value.intervalMs <= MAX_AUTOMATION_INTERVAL_MS;
}

export function isSessionAutomation(value: unknown): value is SessionAutomation {
	if (!isRecord(value)) return false;
	return typeof value.id === 'string'
		&& value.id.length > 0
		&& value.id.length <= 128
		&& (value.kind === 'custom' || value.kind === 'note')
		&& typeof value.name === 'string'
		&& value.name.length > 0
		&& value.name.length <= SESSION_AUTOMATION_NAME_MAX_LENGTH
		&& typeof value.prompt === 'string'
		&& value.prompt.length > 0
		&& value.prompt.length <= SESSION_AUTOMATION_PROMPT_MAX_LENGTH
		&& isSessionAutomationSchedule(value.schedule)
		&& typeof value.enabled === 'boolean'
		&& (value.nextRunAt === null || isTimestamp(value.nextRunAt))
		&& isTimestamp(value.createdAt)
		&& isTimestamp(value.updatedAt)
		&& (value.lastAttemptAt === null || isTimestamp(value.lastAttemptAt))
		&& (value.lastRunAt === null || isTimestamp(value.lastRunAt))
		&& (
			value.lastOutcome === null
			|| value.lastOutcome === 'submitted'
			|| value.lastOutcome === 'failed'
			|| value.lastOutcome === 'uncertain'
		)
		&& (
			value.lastError === null
			|| (typeof value.lastError === 'string' && value.lastError.length <= SESSION_AUTOMATION_ERROR_MAX_LENGTH)
		);
}

export function normalizeSessionAutomations(value: unknown): SessionAutomation[] {
	if (!Array.isArray(value)) return [];
	const ids = new Set<string>();
	const automations: SessionAutomation[] = [];
	for (const candidate of value) {
		if (!isSessionAutomation(candidate) || ids.has(candidate.id)) continue;
		ids.add(candidate.id);
		automations.push({
			...candidate,
			schedule: { ...candidate.schedule }
		});
		if (automations.length >= MAX_SESSION_AUTOMATIONS) break;
	}
	return automations;
}

export function nextAutomationIntervalRunAt(dueAt: number, intervalMs: number, now: number): number {
	if (dueAt > now) return dueAt;
	const elapsedIntervals = Math.floor((now - dueAt) / intervalMs) + 1;
	return dueAt + elapsedIntervals * intervalMs;
}
