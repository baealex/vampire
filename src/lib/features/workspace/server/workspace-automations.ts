import { randomUUID } from 'node:crypto';
import {
  isWorkspaceAutomationSchedule,
  MAX_WORKSPACE_AUTOMATIONS,
  nextAutomationIntervalRunAt,
  WORKSPACE_AUTOMATION_ERROR_MAX_LENGTH,
  WORKSPACE_AUTOMATION_NAME_MAX_LENGTH,
  WORKSPACE_AUTOMATION_PROMPT_MAX_LENGTH,
  type CreateWorkspaceAutomationInput,
  type WorkspaceAutomation,
} from '~/lib/shared/contracts/workspace-automations.ts';
import { ensureManagedWorkspaceNoteFile, managedWorkspaceNotePath } from './workspace-note-file.ts';
import {
  readWorkspaceStateFile,
  readWorkspaceStore,
  type StoredWorkspace,
  withWorkspaceStoreMutation,
  writeWorkspaceStore,
} from './workspace-store.ts';

const WORKSPACE_AUTOMATION_DISPATCH_COOLDOWN_MS = 5_000;

export type WorkspaceAutomationMutationErrorReason = 'not-found' | 'automation-not-found' | 'invalid-input' | 'limit';

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
  kind: WorkspaceAutomation['kind'] = 'custom'
): WorkspaceAutomation {
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

export async function listManagedWorkspaceAutomations(id: string): Promise<WorkspaceAutomation[]> {
  const stored = (await readWorkspaceStore()).workspaces.find((workspace) => workspace.id === id);
  if (!stored) throw new WorkspaceAutomationMutationError('not-found', 'Workspace was not found.');
  return stored.automations
    .map((automation) => ({ ...automation, schedule: { ...automation.schedule } }))
    .sort((left, right) => right.createdAt - left.createdAt);
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
    if (stored.automations.length >= MAX_WORKSPACE_AUTOMATIONS) {
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
      nextRunAt = current.schedule.type === 'once' ? now : now + current.schedule.intervalMs;
    }
    const automation: WorkspaceAutomation = {
      ...current,
      enabled,
      nextRunAt,
      updatedAt: now,
      ...(enabled ? { lastOutcome: null, lastError: null } : {}),
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
  return {
    ...automation,
    enabled: true,
    nextRunAt: nextAutomationIntervalRunAt(automation.nextRunAt ?? now, automation.schedule.intervalMs, now),
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

function workspaceNotePrompt(path: string): string {
  return [
    'Review the work and conversation in this main agent workspace, then update only the Vampire workspace note file at this exact path:',
    JSON.stringify(path),
    '',
    'This note is the shared Markdown memory for the Vampire workspace, not a disposable summary. Read the existing note first and preserve useful context, user-written Markdown, and headings.',
    'Do not delete, reorder, or rewrite existing content just to fit a template. Make the smallest useful update and leave unfamiliar sections verbatim. Do not truncate useful context.',
    "Infer the document language from the user's language and the conversation context. Do not assume the document should be in English just because these instructions are in English.",
    'The first non-empty line must be a plain Markdown paragraph with no heading and no "Summary:" label. It is shown as the workspace-list preview, so make it one concise sentence that combines the current state with the immediate next action.',
    'After that line and a blank line, use Markdown level-two headings equivalent to Next and Done, translating them into the inferred document language when appropriate. Put the immediate next task in the Next section. Add Tasks, Decisions, Blockers, or Notes only when useful.',
    'If the existing note already has a summary line or these sections, update them in place. If it does not, add the plain summary and missing sections without removing the existing body.',
    'Do not edit any other file. After saving the note, briefly confirm what changed.',
  ].join('\n');
}

export async function queueManagedWorkspaceNoteSummary(
  workspaceId: string,
  now = Date.now()
): Promise<{ automation: WorkspaceAutomation; notePath: string }> {
  return withWorkspaceStoreMutation(async () => {
    const state = await readWorkspaceStore();
    const stored = state.workspaces.find((workspace) => workspace.id === workspaceId);
    if (!stored) throw new WorkspaceAutomationMutationError('not-found', 'Workspace was not found.');
    const existing = stored.automations.find((automation) => automation.kind === 'note');
    if (!existing && stored.automations.length >= MAX_WORKSPACE_AUTOMATIONS) {
      throw new WorkspaceAutomationMutationError(
        'limit',
        `A workspace can save up to ${MAX_WORKSPACE_AUTOMATIONS} automations.`
      );
    }
    await ensureManagedWorkspaceNoteFile(stored.id, '');
    const notePath = managedWorkspaceNotePath(stored.id);
    const input: CreateWorkspaceAutomationInput = {
      name: 'Update workspace note',
      prompt: workspaceNotePrompt(notePath),
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
    const rawWorkspaces = isRecord(rawState) && Array.isArray(rawState.workspaces) ? rawState.workspaces : [];
    const compatibilityById = new Map<string, ReturnType<typeof compatibilityNoteState>>();
    for (const rawWorkspace of rawWorkspaces) {
      if (!isRecord(rawWorkspace) || typeof rawWorkspace.id !== 'string') continue;
      compatibilityById.set(rawWorkspace.id, compatibilityNoteState(rawWorkspace));
    }
    const compatibilityCount = [...compatibilityById.values()].filter((compatibility) => compatibility.present).length;

    // Complete the file migration before removing the old JSON fields. If any
    // file operation fails, the registry stays untouched and the next startup
    // can retry without losing the source note.
    await Promise.all(
      state.workspaces.map(async (stored) => {
        const compatibility = compatibilityById.get(stored.id);
        await ensureManagedWorkspaceNoteFile(stored.id, compatibility?.note ?? '');
      })
    );

    if (compatibilityCount > 0) await writeWorkspaceStore(state);
    return compatibilityCount;
  });
}
