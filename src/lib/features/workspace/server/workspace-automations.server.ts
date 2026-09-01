import { randomUUID } from 'node:crypto';
import {
  isWorkspaceAutomationSchedule,
  MAX_WORKSPACE_AUTOMATIONS,
  nextAutomationIntervalRunAt,
  nextAutomationWeeklyRunAt,
  WORKSPACE_AUTOMATION_ERROR_MAX_LENGTH,
  WORKSPACE_AUTOMATION_NAME_MAX_LENGTH,
  WORKSPACE_AUTOMATION_PROMPT_MAX_LENGTH,
  WORKSPACE_NOTE_AGENT_INSTRUCTIONS_MAX_LENGTH,
  type CreateWorkspaceAutomationInput,
  type WorkspaceAutomation,
  type WorkspaceAutomationGroup,
} from '~/lib/shared/contracts/workspace-automations.ts';
import type { WorkspaceAgentActionId } from '~/lib/shared/contracts/workspace-agent-actions.ts';
import {
  ensureManagedWorkspaceNoteFile,
  ensureManagedWorkspaceNoteMigrationBackup,
  managedWorkspaceNotePath,
  readManagedWorkspaceNoteFile,
  writeManagedWorkspaceNoteFile,
} from './workspace-note-file.server.ts';
import {
  readWorkspaceStateFile,
  readWorkspaceStore,
  type StoredWorkspace,
  withWorkspaceStoreMutation,
  writeWorkspaceStore,
} from './workspace-store.server.ts';
import { pendingWorkspaceAutomationCreateRequestCount } from './workspace-automation-request-files.server.ts';

const WORKSPACE_AUTOMATION_DISPATCH_COOLDOWN_MS = 5_000;

export type WorkspaceAutomationMutationErrorReason =
  | 'not-found'
  | 'automation-not-found'
  | 'invalid-input'
  | 'conflict'
  | 'limit';

export class WorkspaceAutomationMutationError extends Error {
  readonly reason: WorkspaceAutomationMutationErrorReason;

  constructor(reason: WorkspaceAutomationMutationErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

export type DueManagedWorkspaceAutomation = {
  workspaceId: string;
  automationId: string;
  dueAt: number;
};

type PreparedAutomationSubmission = () => Promise<void>;
type PrepareAutomationSubmission = (
  workspace: StoredWorkspace,
  automation: WorkspaceAutomation
) => Promise<PreparedAutomationSubmission | undefined>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compatibilityNoteState(value: unknown): {
  present: boolean;
  note?: string;
} {
  if (!isRecord(value)) return { present: false };
  return {
    present: 'note' in value || 'noteFile' in value || 'agentNoteFile' in value,
    ...(typeof value.note === 'string' ? { note: value.note } : {}),
  };
}

function normalizeCreateInput(value: unknown): CreateWorkspaceAutomationInput {
  if (!isRecord(value)) {
    throw new WorkspaceAutomationMutationError('invalid-input', 'Automation settings are required.');
  }
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : '';
  if (!name || name.length > WORKSPACE_AUTOMATION_NAME_MAX_LENGTH || /[\0\r\n\t]/.test(name)) {
    throw new WorkspaceAutomationMutationError(
      'invalid-input',
      `Automation names must stay on one line and be ${WORKSPACE_AUTOMATION_NAME_MAX_LENGTH} characters or fewer.`
    );
  }
  if (!prompt || prompt.length > WORKSPACE_AUTOMATION_PROMPT_MAX_LENGTH || prompt.includes('\0')) {
    throw new WorkspaceAutomationMutationError(
      'invalid-input',
      `Automation prompts must be ${WORKSPACE_AUTOMATION_PROMPT_MAX_LENGTH.toLocaleString('en-US')} characters or fewer.`
    );
  }
  if (!isWorkspaceAutomationSchedule(value.schedule)) {
    throw new WorkspaceAutomationMutationError('invalid-input', 'Automation schedule is invalid.');
  }
  return { name, prompt, schedule: { ...value.schedule } };
}

function automationFromInput(
  input: CreateWorkspaceAutomationInput,
  now: number,
  kind: WorkspaceAutomation['kind'] = 'custom',
  agentActionId?: WorkspaceAgentActionId,
  agentRequestId?: string
): WorkspaceAutomation {
  const nextRunAt =
    input.schedule.type === 'once'
      ? input.schedule.runAt
      : input.schedule.type === 'interval'
        ? input.schedule.startAt
        : nextAutomationWeeklyRunAt(input.schedule, Math.max(now, input.schedule.startAt) - 1);
  return {
    id: randomUUID(),
    kind,
    ...(agentActionId ? { agentActionId } : {}),
    ...(agentRequestId ? { agentRequestId } : {}),
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
    lastError: null,
  };
}

function replaceStoredAutomation(workspace: StoredWorkspace, automation: WorkspaceAutomation): StoredWorkspace {
  return {
    ...workspace,
    automations: workspace.automations.map((candidate) => (candidate.id === automation.id ? automation : candidate)),
  };
}

function replaceStoredWorkspace(workspaces: StoredWorkspace[], updated: StoredWorkspace): StoredWorkspace[] {
  return workspaces.map((workspace) => (workspace.id === updated.id ? updated : workspace));
}

function customAutomations(workspace: StoredWorkspace): WorkspaceAutomation[] {
  return workspace.automations
    .filter((automation) => automation.kind === 'custom')
    .map((automation) => ({ ...automation, schedule: { ...automation.schedule } }))
    .sort((left, right) => right.createdAt - left.createdAt);
}

export async function listManagedWorkspaceAutomations(id: string): Promise<WorkspaceAutomation[]> {
  const stored = (await readWorkspaceStore()).workspaces.find((workspace) => workspace.id === id);
  if (!stored) throw new WorkspaceAutomationMutationError('not-found', 'Workspace was not found.');
  return customAutomations(stored);
}

export async function listManagedWorkspaceAutomationGroups(): Promise<WorkspaceAutomationGroup[]> {
  const state = await readWorkspaceStore();
  return state.workspaces.map((workspace) => ({
    workspaceId: workspace.id,
    automations: customAutomations(workspace),
  }));
}

export async function queueManagedWorkspaceAgentPrompt(
  workspaceId: string,
  input: {
    actionId: WorkspaceAgentActionId;
    name: string;
    prompt: string;
  },
  now = Date.now()
): Promise<WorkspaceAutomation> {
  const normalized = normalizeCreateInput({
    name: input.name,
    prompt: input.prompt,
    schedule: { type: 'once', runAt: now },
  });
  return withWorkspaceStoreMutation(async () => {
    const state = await readWorkspaceStore();
    const stored = state.workspaces.find((workspace) => workspace.id === workspaceId);
    if (!stored) throw new WorkspaceAutomationMutationError('not-found', 'Workspace was not found.');
    const existing = stored.automations.find(
      (automation) => automation.kind === 'agent-action' && automation.agentActionId === input.actionId
    );
    if (existing?.enabled) {
      throw new WorkspaceAutomationMutationError(
        'conflict',
        'A request for this agent action is already being delivered.'
      );
    }
    const automation = existing
      ? {
          ...existing,
          ...normalized,
          schedule: { ...normalized.schedule },
          enabled: true,
          nextRunAt: now,
          updatedAt: now,
          lastOutcome: null,
          lastError: null,
        }
      : automationFromInput(normalized, now, 'agent-action', input.actionId);
    const automations = existing
      ? stored.automations.map((candidate) => (candidate.id === existing.id ? automation : candidate))
      : [...stored.automations, automation];
    const updated = { ...stored, automations };
    await writeWorkspaceStore({ ...state, workspaces: replaceStoredWorkspace(state.workspaces, updated) });
    return automation;
  });
}

export async function createManagedWorkspaceAutomation(
  id: string,
  value: unknown,
  now = Date.now()
): Promise<WorkspaceAutomation> {
  const input = normalizeCreateInput(value);
  return withWorkspaceStoreMutation(async () => {
    const state = await readWorkspaceStore();
    const index = state.workspaces.findIndex((workspace) => workspace.id === id);
    if (index < 0) throw new WorkspaceAutomationMutationError('not-found', 'Workspace was not found.');
    const stored = state.workspaces[index];
    const customCount = stored.automations.filter((automation) => automation.kind === 'custom').length;
    const pendingCount = await pendingWorkspaceAutomationCreateRequestCount(id);
    if (customCount + pendingCount >= MAX_WORKSPACE_AUTOMATIONS) {
      throw new WorkspaceAutomationMutationError(
        'limit',
        `A workspace can save up to ${MAX_WORKSPACE_AUTOMATIONS} automations.`
      );
    }
    const automation = automationFromInput(input, now);
    const workspaces = [...state.workspaces];
    workspaces[index] = { ...stored, automations: [...stored.automations, automation] };
    await writeWorkspaceStore({ ...state, workspaces });
    return automation;
  });
}

function normalizeAgentRequestId(value: unknown): string {
  const requestId = typeof value === 'string' ? value.trim() : '';
  if (!requestId || requestId.length > 128 || !/^[a-zA-Z0-9-]+$/.test(requestId)) {
    throw new WorkspaceAutomationMutationError('invalid-input', 'Automation agent request ID is invalid.');
  }
  return requestId;
}

export async function createManagedWorkspaceAutomationFromAgentRequest(
  id: string,
  requestIdValue: unknown,
  value: unknown,
  now = Date.now()
): Promise<WorkspaceAutomation> {
  return applyManagedWorkspaceAutomationAgentRequest(
    id,
    requestIdValue,
    { type: 'create', automation: { ...(isRecord(value) ? value : {}), enabled: true } },
    now
  );
}

type NormalizedWorkspaceAutomationAgentOperation =
  | { type: 'create'; input: CreateWorkspaceAutomationInput; enabled: boolean }
  | {
      type: 'update';
      automationId: string;
      expectedUpdatedAt: number;
      input: CreateWorkspaceAutomationInput;
      enabled: boolean;
    };

function normalizeAgentAutomationConfiguration(value: unknown): {
  input: CreateWorkspaceAutomationInput;
  enabled: boolean;
} {
  const input = normalizeCreateInput(value);
  if (!isRecord(value) || typeof value.enabled !== 'boolean') {
    throw new WorkspaceAutomationMutationError('invalid-input', 'automation.enabled must be a boolean.');
  }
  return { input, enabled: value.enabled };
}

function normalizeAgentOperation(value: unknown): NormalizedWorkspaceAutomationAgentOperation {
  if (!isRecord(value)) {
    throw new WorkspaceAutomationMutationError(
      'invalid-input',
      'An automation create or update operation is required.'
    );
  }
  const configuration = normalizeAgentAutomationConfiguration(value.automation);
  if (value.type === 'create') return { type: 'create', ...configuration };
  if (value.type !== 'update') {
    throw new WorkspaceAutomationMutationError('invalid-input', 'The automation operation must create or update.');
  }
  const automationId = typeof value.automationId === 'string' ? value.automationId.trim() : '';
  if (!automationId || automationId.length > 128 || /[\0\r\n\t]/.test(automationId)) {
    throw new WorkspaceAutomationMutationError('invalid-input', 'The automation update target is invalid.');
  }
  if (
    typeof value.expectedUpdatedAt !== 'number' ||
    !Number.isSafeInteger(value.expectedUpdatedAt) ||
    value.expectedUpdatedAt < 0
  ) {
    throw new WorkspaceAutomationMutationError('invalid-input', 'The automation update version is invalid.');
  }
  return {
    type: 'update',
    automationId,
    expectedUpdatedAt: value.expectedUpdatedAt,
    ...configuration,
  };
}

export async function applyManagedWorkspaceAutomationAgentRequest(
  id: string,
  requestIdValue: unknown,
  value: unknown,
  now = Date.now()
): Promise<WorkspaceAutomation> {
  const requestId = normalizeAgentRequestId(requestIdValue);
  const operation = normalizeAgentOperation(value);
  return withWorkspaceStoreMutation(async () => {
    const state = await readWorkspaceStore();
    const index = state.workspaces.findIndex((workspace) => workspace.id === id);
    if (index < 0) throw new WorkspaceAutomationMutationError('not-found', 'Workspace was not found.');
    const stored = state.workspaces[index];
    const previouslyApplied = stored.automations.find(
      (automation) => automation.kind === 'custom' && automation.agentRequestId === requestId
    );
    if (previouslyApplied) return previouslyApplied;
    if (operation.type === 'update') {
      const current = stored.automations.find(
        (automation) => automation.kind === 'custom' && automation.id === operation.automationId
      );
      if (!current) {
        throw new WorkspaceAutomationMutationError('automation-not-found', 'Automation was not found.');
      }
      if (current.updatedAt !== operation.expectedUpdatedAt) {
        throw new WorkspaceAutomationMutationError(
          'conflict',
          'The automation changed after the agent request was prepared. Review the latest automation before retrying.'
        );
      }
      const scheduled = automationFromInput(operation.input, now);
      const automation: WorkspaceAutomation = {
        ...current,
        agentRequestId: requestId,
        name: operation.input.name,
        prompt: operation.input.prompt,
        schedule: { ...operation.input.schedule },
        enabled: operation.enabled,
        nextRunAt: scheduled.nextRunAt,
        updatedAt: Math.max(now, current.updatedAt + 1),
        lastOutcome: null,
        lastError: null,
      };
      const workspaces = [...state.workspaces];
      workspaces[index] = replaceStoredAutomation(stored, automation);
      await writeWorkspaceStore({ ...state, workspaces });
      return automation;
    }

    const customCount = stored.automations.filter((automation) => automation.kind === 'custom').length;
    const pendingCount = Math.max(1, await pendingWorkspaceAutomationCreateRequestCount(id, requestId, now));
    if (customCount + pendingCount > MAX_WORKSPACE_AUTOMATIONS) {
      throw new WorkspaceAutomationMutationError(
        'limit',
        `A workspace can save up to ${MAX_WORKSPACE_AUTOMATIONS} automations.`
      );
    }
    const automation = {
      ...automationFromInput(operation.input, now, 'custom', undefined, requestId),
      enabled: operation.enabled,
    };
    const workspaces = [...state.workspaces];
    workspaces[index] = { ...stored, automations: [...stored.automations, automation] };
    await writeWorkspaceStore({ ...state, workspaces });
    return automation;
  });
}

export async function setManagedWorkspaceAutomationEnabled(
  workspaceId: string,
  automationId: string,
  enabled: boolean,
  now = Date.now()
): Promise<WorkspaceAutomation> {
  return withWorkspaceStoreMutation(async () => {
    const state = await readWorkspaceStore();
    const stored = state.workspaces.find((workspace) => workspace.id === workspaceId);
    if (!stored) throw new WorkspaceAutomationMutationError('not-found', 'Workspace was not found.');
    const current = stored.automations.find((automation) => automation.id === automationId);
    if (!current) {
      throw new WorkspaceAutomationMutationError('automation-not-found', 'Automation was not found.');
    }
    let nextRunAt = current.nextRunAt;
    if (enabled && (nextRunAt === null || nextRunAt <= now)) {
      nextRunAt =
        current.schedule.type === 'once'
          ? now
          : current.schedule.type === 'interval'
            ? now + current.schedule.intervalMs
            : nextAutomationWeeklyRunAt(current.schedule, now);
    }
    const automation: WorkspaceAutomation = {
      ...current,
      enabled,
      nextRunAt,
      updatedAt: Math.max(now, current.updatedAt + 1),
      ...(enabled ? { lastOutcome: null, lastError: null } : {}),
    };
    const updated = replaceStoredAutomation(stored, automation);
    await writeWorkspaceStore({ ...state, workspaces: replaceStoredWorkspace(state.workspaces, updated) });
    return automation;
  });
}

export async function updateManagedWorkspaceAutomation(
  workspaceId: string,
  automationId: string,
  value: unknown,
  now = Date.now()
): Promise<WorkspaceAutomation> {
  const input = normalizeCreateInput(value);
  return withWorkspaceStoreMutation(async () => {
    const state = await readWorkspaceStore();
    const stored = state.workspaces.find((workspace) => workspace.id === workspaceId);
    if (!stored) throw new WorkspaceAutomationMutationError('not-found', 'Workspace was not found.');
    const current = stored.automations.find(
      (automation) => automation.id === automationId && automation.kind === 'custom'
    );
    if (!current) {
      throw new WorkspaceAutomationMutationError('automation-not-found', 'Automation was not found.');
    }
    const scheduled = automationFromInput(input, now);
    const automation: WorkspaceAutomation = {
      ...current,
      name: input.name,
      prompt: input.prompt,
      schedule: { ...input.schedule },
      nextRunAt: scheduled.nextRunAt,
      updatedAt: Math.max(now, current.updatedAt + 1),
      lastOutcome: null,
      lastError: null,
    };
    const updated = replaceStoredAutomation(stored, automation);
    await writeWorkspaceStore({ ...state, workspaces: replaceStoredWorkspace(state.workspaces, updated) });
    return automation;
  });
}

export async function deleteManagedWorkspaceAutomation(workspaceId: string, automationId: string): Promise<void> {
  await withWorkspaceStoreMutation(async () => {
    const state = await readWorkspaceStore();
    const stored = state.workspaces.find((workspace) => workspace.id === workspaceId);
    if (!stored) throw new WorkspaceAutomationMutationError('not-found', 'Workspace was not found.');
    const automations = stored.automations.filter((automation) => automation.id !== automationId);
    if (automations.length === stored.automations.length) {
      throw new WorkspaceAutomationMutationError('automation-not-found', 'Automation was not found.');
    }
    await writeWorkspaceStore({
      ...state,
      workspaces: replaceStoredWorkspace(state.workspaces, { ...stored, automations }),
    });
  });
}

export async function listDueManagedWorkspaceAutomations(now = Date.now()): Promise<DueManagedWorkspaceAutomation[]> {
  const state = await readWorkspaceStore();
  const candidates: DueManagedWorkspaceAutomation[] = [];
  for (const workspace of state.workspaces) {
    const latestAttemptAt = Math.max(0, ...workspace.automations.map((automation) => automation.lastAttemptAt ?? 0));
    if (latestAttemptAt > now - WORKSPACE_AUTOMATION_DISPATCH_COOLDOWN_MS) continue;
    const due = workspace.automations
      .filter((automation) => automation.enabled && automation.nextRunAt !== null && automation.nextRunAt <= now)
      .sort((left, right) => (left.nextRunAt ?? 0) - (right.nextRunAt ?? 0))[0];
    if (!due || due.nextRunAt === null) continue;
    candidates.push({ workspaceId: workspace.id, automationId: due.id, dueAt: due.nextRunAt });
  }
  return candidates.sort((left, right) => left.dueAt - right.dueAt);
}

function consumedAutomation(automation: WorkspaceAutomation, now: number): WorkspaceAutomation {
  if (automation.schedule.type === 'once') {
    return {
      ...automation,
      enabled: false,
      nextRunAt: null,
      updatedAt: now,
      lastAttemptAt: now,
      lastOutcome: 'uncertain',
      lastError: null,
    };
  }
  const nextRunAt =
    automation.schedule.type === 'interval'
      ? nextAutomationIntervalRunAt(automation.nextRunAt ?? now, automation.schedule.intervalMs, now)
      : nextAutomationWeeklyRunAt(automation.schedule, now);
  return {
    ...automation,
    enabled: true,
    nextRunAt,
    updatedAt: now,
    lastAttemptAt: now,
    lastOutcome: 'uncertain',
    lastError: null,
  };
}

export async function dispatchManagedWorkspaceAutomation(
  workspaceId: string,
  automationId: string,
  now: number,
  prepare: PrepareAutomationSubmission
): Promise<'submitted' | 'failed' | 'not-ready' | 'not-due'> {
  return withWorkspaceStoreMutation(async () => {
    const state = await readWorkspaceStore();
    const stored = state.workspaces.find((workspace) => workspace.id === workspaceId);
    const current = stored?.automations.find((automation) => automation.id === automationId);
    if (!stored || !current || !current.enabled || current.nextRunAt === null || current.nextRunAt > now) {
      return 'not-due';
    }
    const submit = await prepare(stored, current);
    if (!submit) return 'not-ready';

    const attempted = consumedAutomation(current, now);
    const attemptedWorkspace = replaceStoredAutomation(stored, attempted);
    const attemptedState = {
      ...state,
      workspaces: replaceStoredWorkspace(state.workspaces, attemptedWorkspace),
    };
    await writeWorkspaceStore(attemptedState);

    let completed: WorkspaceAutomation;
    let outcome: 'submitted' | 'failed';
    try {
      await submit();
      completed = {
        ...attempted,
        updatedAt: now,
        lastRunAt: now,
        lastOutcome: 'submitted',
        lastError: null,
      };
      outcome = 'submitted';
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The prompt could not be submitted.';
      completed = {
        ...attempted,
        updatedAt: now,
        lastOutcome: 'failed',
        lastError: message.slice(0, WORKSPACE_AUTOMATION_ERROR_MAX_LENGTH),
      };
      outcome = 'failed';
    }
    const completedWorkspace = replaceStoredAutomation(attemptedWorkspace, completed);
    await writeWorkspaceStore({
      ...attemptedState,
      workspaces: replaceStoredWorkspace(attemptedState.workspaces, completedWorkspace),
    });
    return outcome;
  });
}

function normalizeWorkspaceNoteAgentInstructions(value: unknown): string {
  const instructions = typeof value === 'string' ? value.trim() : '';
  if (
    !instructions ||
    instructions.length > WORKSPACE_NOTE_AGENT_INSTRUCTIONS_MAX_LENGTH ||
    instructions.includes('\0')
  ) {
    throw new WorkspaceAutomationMutationError(
      'invalid-input',
      `Agent instructions must be between 1 and ${WORKSPACE_NOTE_AGENT_INSTRUCTIONS_MAX_LENGTH.toLocaleString('en-US')} characters.`
    );
  }
  return instructions;
}

function workspaceNotePrompt(path: string, instructions: string): string {
  return [
    'Update only the Vampire workspace note file at this exact path:',
    JSON.stringify(path),
    '',
    'Read the existing note before editing it. Preserve content that the user instructions do not ask you to change.',
    '',
    'User instructions:',
    instructions,
    '',
    'Do not edit any other file. If no change is needed, leave the note untouched and say so.',
  ].join('\n');
}

export async function queueManagedWorkspaceNoteUpdate(
  workspaceId: string,
  value: unknown,
  now = Date.now()
): Promise<{ automation: WorkspaceAutomation; notePath: string }> {
  const instructions = normalizeWorkspaceNoteAgentInstructions(value);
  return withWorkspaceStoreMutation(async () => {
    const state = await readWorkspaceStore();
    const stored = state.workspaces.find((workspace) => workspace.id === workspaceId);
    if (!stored) throw new WorkspaceAutomationMutationError('not-found', 'Workspace was not found.');
    const existing = stored.automations.find((automation) => automation.kind === 'note');
    await ensureManagedWorkspaceNoteFile(stored.id, '');
    const notePath = managedWorkspaceNotePath(stored.id);
    const input: CreateWorkspaceAutomationInput = {
      name: 'Update workspace note',
      prompt: workspaceNotePrompt(notePath, instructions),
      schedule: { type: 'once', runAt: now },
    };
    let automation: WorkspaceAutomation;
    let automations: WorkspaceAutomation[];
    if (existing) {
      automation = {
        ...existing,
        ...input,
        schedule: { ...input.schedule },
        enabled: true,
        nextRunAt: now,
        updatedAt: now,
        lastOutcome: null,
        lastError: null,
      };
      automations = stored.automations.map((candidate) => (candidate.id === existing.id ? automation : candidate));
    } else {
      automation = automationFromInput(input, now, 'note');
      automations = [...stored.automations, automation];
    }
    const updated = { ...stored, automations };
    await writeWorkspaceStore({ ...state, workspaces: replaceStoredWorkspace(state.workspaces, updated) });
    return { automation, notePath };
  });
}

export async function migrateManagedWorkspaceNotes(): Promise<number> {
  return withWorkspaceStoreMutation(async () => {
    const state = await readWorkspaceStore();
    let rawState: unknown;
    try {
      rawState = await readWorkspaceStateFile();
    } catch {
      return 0;
    }
    const rawWorkspaces = isRecord(rawState)
      ? Array.isArray(rawState.workspaces)
        ? rawState.workspaces
        : Array.isArray(rawState.sessions)
          ? rawState.sessions
          : []
      : [];
    const compatibilityById = new Map<string, ReturnType<typeof compatibilityNoteState>>();
    for (const rawWorkspace of rawWorkspaces) {
      if (!isRecord(rawWorkspace) || typeof rawWorkspace.id !== 'string') continue;
      compatibilityById.set(rawWorkspace.id, compatibilityNoteState(rawWorkspace));
    }
    const compatibilityCount = [...compatibilityById.values()].filter((compatibility) => compatibility.present).length;

    if (compatibilityCount === 0) return 0;

    await ensureManagedWorkspaceNoteMigrationBackup();
    await Promise.all(
      state.workspaces.map(async (stored) => {
        const compatibility = compatibilityById.get(stored.id);
        if (!compatibility?.present) return;
        const compatibilityNote = compatibility.note ?? '';
        const fileNote = await readManagedWorkspaceNoteFile(stored.id);
        if (fileNote === undefined) {
          if (compatibilityNote) await ensureManagedWorkspaceNoteFile(stored.id, compatibilityNote);
          return;
        }
        if (!fileNote && compatibilityNote) {
          await writeManagedWorkspaceNoteFile(stored.id, compatibilityNote);
        }
      })
    );

    await writeWorkspaceStore(state);
    return compatibilityCount;
  });
}
