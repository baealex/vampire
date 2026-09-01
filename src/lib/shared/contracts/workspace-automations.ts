import {
  isWorkspaceAgentActionId,
  WORKSPACE_AGENT_ACTION_REQUEST_MAX_LENGTH,
  WORKSPACE_AGENT_ACTION_IDS,
  type WorkspaceAgentActionId,
} from './workspace-agent-actions.ts';

export const WORKSPACE_AUTOMATION_NAME_MAX_LENGTH = 80;
export const WORKSPACE_AUTOMATION_PROMPT_MAX_LENGTH = 8_000;
export const WORKSPACE_AUTOMATION_ERROR_MAX_LENGTH = 500;
export const WORKSPACE_NOTE_AGENT_INSTRUCTIONS_MAX_LENGTH = WORKSPACE_AGENT_ACTION_REQUEST_MAX_LENGTH;
export const MAX_WORKSPACE_AUTOMATIONS = 32;
export const MAX_WORKSPACE_AUTOMATION_ENTRIES = MAX_WORKSPACE_AUTOMATIONS + WORKSPACE_AGENT_ACTION_IDS.length + 1;
export const MIN_AUTOMATION_INTERVAL_MS = 60_000;
export const MAX_AUTOMATION_INTERVAL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_JAVASCRIPT_DATE_TIMESTAMP = 8_640_000_000_000_000;

export const WORKSPACE_AUTOMATION_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
export type WorkspaceAutomationWeekday = (typeof WORKSPACE_AUTOMATION_WEEKDAYS)[number];

export type WorkspaceAutomationSchedule =
  | { type: 'once'; runAt: number }
  | { type: 'interval'; intervalMs: number; startAt: number }
  | {
      type: 'weekly';
      weekdays: WorkspaceAutomationWeekday[];
      hour: number;
      minute: number;
      timeZone: string;
      startAt: number;
    };

export type WorkspaceAutomationOutcome = 'submitted' | 'failed' | 'uncertain' | null;

export type WorkspaceAutomation = {
  id: string;
  kind: 'custom' | 'note' | 'agent-action';
  agentActionId?: WorkspaceAgentActionId;
  agentRequestId?: string;
  name: string;
  prompt: string;
  schedule: WorkspaceAutomationSchedule;
  enabled: boolean;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  lastAttemptAt: number | null;
  lastRunAt: number | null;
  lastOutcome: WorkspaceAutomationOutcome;
  lastError: string | null;
};

export type CreateWorkspaceAutomationInput = {
  name: string;
  prompt: string;
  schedule: WorkspaceAutomationSchedule;
};

export type WorkspaceAutomationGroup = {
  workspaceId: string;
  automations: WorkspaceAutomation[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_JAVASCRIPT_DATE_TIMESTAMP
  );
}

export function isWorkspaceAutomationSchedule(value: unknown): value is WorkspaceAutomationSchedule {
  if (!isRecord(value) || !isTimestamp(value.type === 'once' ? value.runAt : value.startAt)) return false;
  if (value.type === 'once') return true;
  if (value.type === 'interval') {
    return (
      typeof value.intervalMs === 'number' &&
      Number.isSafeInteger(value.intervalMs) &&
      value.intervalMs >= MIN_AUTOMATION_INTERVAL_MS &&
      value.intervalMs <= MAX_AUTOMATION_INTERVAL_MS
    );
  }
  const weekdays = value.weekdays;
  const hour = value.hour;
  const minute = value.minute;
  if (
    value.type !== 'weekly' ||
    !Array.isArray(weekdays) ||
    weekdays.length === 0 ||
    weekdays.length > WORKSPACE_AUTOMATION_WEEKDAYS.length ||
    !weekdays.every(
      (weekday, index) =>
        Number.isInteger(weekday) &&
        WORKSPACE_AUTOMATION_WEEKDAYS.includes(weekday as WorkspaceAutomationWeekday) &&
        weekdays.indexOf(weekday) === index
    ) ||
    typeof hour !== 'number' ||
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    typeof minute !== 'number' ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59 ||
    typeof value.timeZone !== 'string' ||
    value.timeZone.length === 0 ||
    value.timeZone.length > 100
  ) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function isWorkspaceAutomation(value: unknown): value is WorkspaceAutomation {
  if (!isRecord(value)) return false;
  const validKind =
    value.kind === 'custom' ||
    value.kind === 'note' ||
    (value.kind === 'agent-action' && isWorkspaceAgentActionId(value.agentActionId));
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= 128 &&
    validKind &&
    (value.agentRequestId === undefined ||
      (typeof value.agentRequestId === 'string' &&
        value.agentRequestId.length > 0 &&
        value.agentRequestId.length <= 128)) &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    value.name.length <= WORKSPACE_AUTOMATION_NAME_MAX_LENGTH &&
    typeof value.prompt === 'string' &&
    value.prompt.length > 0 &&
    value.prompt.length <= WORKSPACE_AUTOMATION_PROMPT_MAX_LENGTH &&
    isWorkspaceAutomationSchedule(value.schedule) &&
    typeof value.enabled === 'boolean' &&
    (value.nextRunAt === null || isTimestamp(value.nextRunAt)) &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt) &&
    (value.lastAttemptAt === null || isTimestamp(value.lastAttemptAt)) &&
    (value.lastRunAt === null || isTimestamp(value.lastRunAt)) &&
    (value.lastOutcome === null ||
      value.lastOutcome === 'submitted' ||
      value.lastOutcome === 'failed' ||
      value.lastOutcome === 'uncertain') &&
    (value.lastError === null ||
      (typeof value.lastError === 'string' && value.lastError.length <= WORKSPACE_AUTOMATION_ERROR_MAX_LENGTH))
  );
}

export function normalizeWorkspaceAutomations(value: unknown): WorkspaceAutomation[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const automations: WorkspaceAutomation[] = [];
  for (const candidate of value) {
    if (!isWorkspaceAutomation(candidate) || ids.has(candidate.id)) continue;
    ids.add(candidate.id);
    automations.push({
      ...candidate,
      schedule: { ...candidate.schedule },
    });
    if (automations.length >= MAX_WORKSPACE_AUTOMATION_ENTRIES) break;
  }
  return automations;
}

export function nextAutomationIntervalRunAt(dueAt: number, intervalMs: number, now: number): number {
  if (dueAt > now) return dueAt;
  const elapsedIntervals = Math.floor((now - dueAt) / intervalMs) + 1;
  return dueAt + elapsedIntervals * intervalMs;
}

type ZonedDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function zonedDateTimeParts(timestamp: number, timeZone: string): ZonedDateTimeParts {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(timestamp);
  const number = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: number('year'),
    month: number('month'),
    day: number('day'),
    hour: number('hour'),
    minute: number('minute'),
  };
}

function zonedTimestamp(parts: ZonedDateTimeParts, timeZone: string): number | undefined {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedDateTimeParts(candidate, timeZone);
    const difference = target - Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    if (difference === 0) return candidate;
    candidate += difference;
  }
  const actual = zonedDateTimeParts(candidate, timeZone);
  return actual.year === parts.year &&
    actual.month === parts.month &&
    actual.day === parts.day &&
    actual.hour === parts.hour &&
    actual.minute === parts.minute
    ? candidate
    : undefined;
}

export function nextAutomationWeeklyRunAt(
  schedule: Extract<WorkspaceAutomationSchedule, { type: 'weekly' }>,
  after: number
): number {
  const local = zonedDateTimeParts(Math.max(after, schedule.startAt), schedule.timeZone);
  const localMidnight = Date.UTC(local.year, local.month - 1, local.day);
  for (let dayOffset = 0; dayOffset < 15; dayOffset += 1) {
    const date = new Date(localMidnight + dayOffset * 24 * 60 * 60_000);
    if (!schedule.weekdays.includes(date.getUTCDay() as WorkspaceAutomationWeekday)) continue;
    const candidate = zonedTimestamp(
      {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour: schedule.hour,
        minute: schedule.minute,
      },
      schedule.timeZone
    );
    if (candidate !== undefined && candidate >= schedule.startAt && candidate > after) return candidate;
  }
  throw new RangeError('Unable to find the next weekly automation occurrence.');
}
