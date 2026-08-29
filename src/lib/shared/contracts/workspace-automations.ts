import {
  isWorkspaceAgentActionId,
  WORKSPACE_AGENT_ACTION_REQUEST_MAX_LENGTH,
  type WorkspaceAgentActionId,
} from './workspace-agent-actions.ts';

export const WORKSPACE_AUTOMATION_NAME_MAX_LENGTH = 80;
export const WORKSPACE_AUTOMATION_PROMPT_MAX_LENGTH = 8_000;
export const WORKSPACE_AUTOMATION_ERROR_MAX_LENGTH = 500;
export const WORKSPACE_NOTE_AGENT_INSTRUCTIONS_MAX_LENGTH = WORKSPACE_AGENT_ACTION_REQUEST_MAX_LENGTH;
export const MAX_WORKSPACE_AUTOMATIONS = 32;
export const MIN_AUTOMATION_INTERVAL_MS = 60_000;
export const MAX_AUTOMATION_INTERVAL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_JAVASCRIPT_DATE_TIMESTAMP = 8_640_000_000_000_000;

export type WorkspaceAutomationSchedule =
  | { type: 'once'; runAt: number }
  | { type: 'interval'; intervalMs: number; startAt: number };

export type WorkspaceAutomationOutcome = 'submitted' | 'failed' | 'uncertain' | null;

export type WorkspaceAutomation = {
  id: string;
  kind: 'custom' | 'note' | 'agent-action';
  agentActionId?: WorkspaceAgentActionId;
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
  return (
    value.type === 'interval' &&
    typeof value.intervalMs === 'number' &&
    Number.isSafeInteger(value.intervalMs) &&
    value.intervalMs >= MIN_AUTOMATION_INTERVAL_MS &&
    value.intervalMs <= MAX_AUTOMATION_INTERVAL_MS
  );
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
    if (automations.length >= MAX_WORKSPACE_AUTOMATIONS) break;
  }
  return automations;
}

export function nextAutomationIntervalRunAt(dueAt: number, intervalMs: number, now: number): number {
  if (dueAt > now) return dueAt;
  const elapsedIntervals = Math.floor((now - dueAt) / intervalMs) + 1;
  return dueAt + elapsedIntervals * intervalMs;
}
