import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, posix } from 'node:path';
import {
  KING_EVENT_SCHEMA_VERSION,
  KING_RESULT_SCHEMA_VERSION,
  KING_WORKFLOW_VERSION,
  type KingAttempt,
  type KingAttemptBaseline,
  type KingAttemptDeliveryTarget,
  type KingAttemptResult,
  type KingAttemptStartedEvent,
  type KingAttemptVerdict,
  type KingAttemptVerification,
  type KingCreateDecisionInput,
  type KingCreateRunInput,
  type KingCreateTaskInput,
  type KingDecisionRequest,
  type KingInboxEvent,
  type KingInboxEventType,
  type KingPlanResult,
  type KingProposedTask,
  type KingRun,
  type KingTask,
  type KingWorkflowStore,
  type KingWorkflowSummary,
} from '~/lib/shared/contracts/king-workflow.ts';
import { errorHasCode } from '~/lib/shared/server/path-policy.ts';
import { ensureManagedKingWorkspace, KING_CONTRACT_REVISION, managedKingWorkspacePath } from './king-workspace.ts';

const KING_WORKFLOW_FILE_NAME = 'workflow.json';
const KING_TASKS_DIRECTORY_NAME = 'tasks';
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_TITLE_LENGTH = 160;
const MAX_OBJECTIVE_LENGTH = 20_000;
const MAX_LIST_ITEMS = 128;
const MAX_ITEM_LENGTH = 2_000;
const MAX_COMMAND_LENGTH = 1_000;
const MAX_VERIFICATION_COMMANDS = 10;
const MAX_TASKS_PER_RUN = 100;
const MAX_ATTEMPTS_PER_TASK = 10;
const MAX_LISTED_RUNS = 50;
const MAX_LISTED_INBOX_EVENTS = 200;

type KingWorkflowGlobal = typeof globalThis & {
  __vampireKingWorkflowMutationState?: { queue: Promise<void> };
};

const workflowGlobal = globalThis as KingWorkflowGlobal;
if (!workflowGlobal.__vampireKingWorkflowMutationState) {
  workflowGlobal.__vampireKingWorkflowMutationState = { queue: Promise.resolve() };
}
const mutationState = workflowGlobal.__vampireKingWorkflowMutationState;

export type KingWorkflowErrorReason =
  | 'invalid-input'
  | 'not-found'
  | 'invalid-state'
  | 'active-attempt'
  | 'event-conflict'
  | 'verification-required'
  | 'owner-required';

export class KingWorkflowError extends Error {
  readonly reason: KingWorkflowErrorReason;

  constructor(reason: KingWorkflowErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

export type KingAttemptEventScanResult = {
  attemptId: string;
  started: 'missing' | 'recorded' | 'unchanged' | 'conflict' | 'invalid';
  result: 'missing' | 'recorded' | 'unchanged' | 'conflict' | 'invalid';
  errors: string[];
};

function emptyStore(): KingWorkflowStore {
  return { version: KING_WORKFLOW_VERSION, runs: [], tasks: [], attempts: [], decisions: [], inbox: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isRepositoryChange(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.status === 'string' &&
    (value.previousPath === undefined || typeof value.previousPath === 'string')
  );
}

function isBaseline(value: unknown): value is KingAttemptBaseline {
  return (
    isRecord(value) &&
    typeof value.capturedAt === 'number' &&
    (value.workspaceLeaseKey === undefined || typeof value.workspaceLeaseKey === 'string') &&
    typeof value.isGitRepository === 'boolean' &&
    (value.headRevision === null || typeof value.headRevision === 'string') &&
    Array.isArray(value.changes) &&
    value.changes.every(isRepositoryChange) &&
    typeof value.dirty === 'boolean' &&
    (value.repositoryStateHash === undefined ||
      value.repositoryStateHash === null ||
      typeof value.repositoryStateHash === 'string') &&
    (value.changeFingerprints === undefined ||
      (Array.isArray(value.changeFingerprints) &&
        value.changeFingerprints.every(
          (fingerprint) => isRepositoryChange(fingerprint) && typeof fingerprint.diffHash === 'string'
        )))
  );
}

function isDeliveryTarget(value: unknown): value is KingAttemptDeliveryTarget {
  return (
    isRecord(value) &&
    typeof value.tmuxSession === 'string' &&
    typeof value.terminalId === 'string' &&
    typeof value.agentLabel === 'string'
  );
}

function isProposedTask(value: unknown): value is KingProposedTask {
  return (
    isRecord(value) &&
    typeof value.workspaceId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.objective === 'string' &&
    isStringArray(value.acceptanceCriteria) &&
    isStringArray(value.allowedPaths) &&
    isStringArray(value.forbiddenPaths) &&
    isStringArray(value.verificationCommands) &&
    (value.approvalPolicy === 'auto' || value.approvalPolicy === 'owner')
  );
}

function isPlanResult(value: unknown): value is KingPlanResult {
  return (
    isRecord(value) &&
    typeof value.candidateWorkspaceId === 'string' &&
    (value.recommendation === 'proceed' || value.recommendation === 'clarify' || value.recommendation === 'reject') &&
    typeof value.confidence === 'number' &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1 &&
    typeof value.summary === 'string' &&
    isStringArray(value.steps) &&
    isStringArray(value.assumptions) &&
    isStringArray(value.risks) &&
    isStringArray(value.questions) &&
    Array.isArray(value.proposedTasks) &&
    value.proposedTasks.every(isProposedTask)
  );
}

function isResult(value: unknown): value is KingAttemptResult {
  return (
    isRecord(value) &&
    value.schemaVersion === KING_RESULT_SCHEMA_VERSION &&
    typeof value.attemptId === 'string' &&
    (value.status === 'succeeded' || value.status === 'blocked' || value.status === 'failed') &&
    typeof value.summary === 'string' &&
    isStringArray(value.changedPaths) &&
    Array.isArray(value.verification) &&
    value.verification.every(
      (claim) =>
        isRecord(claim) &&
        typeof claim.command === 'string' &&
        (claim.outcome === 'passed' || claim.outcome === 'failed' || claim.outcome === 'not-run') &&
        (claim.summary === undefined || typeof claim.summary === 'string')
    ) &&
    isStringArray(value.blockers) &&
    (value.plan === undefined || value.plan === null || isPlanResult(value.plan))
  );
}

function isVerification(value: unknown): value is KingAttemptVerification {
  return (
    isRecord(value) &&
    (value.outcome === 'passed' || value.outcome === 'failed' || value.outcome === 'needs-owner') &&
    typeof value.checkedAt === 'number' &&
    Array.isArray(value.actualChanges) &&
    value.actualChanges.every(isRepositoryChange) &&
    isStringArray(value.attemptChangePaths) &&
    isStringArray(value.unexpectedPaths) &&
    typeof value.baselineDirty === 'boolean' &&
    (value.baselineHeadRevision === null || typeof value.baselineHeadRevision === 'string') &&
    (value.currentHeadRevision === null || typeof value.currentHeadRevision === 'string') &&
    typeof value.headRevisionChanged === 'boolean' &&
    Array.isArray(value.commands) &&
    value.commands.every(
      (command) =>
        isRecord(command) &&
        typeof command.command === 'string' &&
        (command.outcome === 'passed' || command.outcome === 'failed') &&
        (command.exitCode === null || typeof command.exitCode === 'number') &&
        typeof command.stdout === 'string' &&
        typeof command.stderr === 'string' &&
        typeof command.durationMs === 'number'
    ) &&
    isStringArray(value.reasons)
  );
}

function isVerdict(value: unknown): value is KingAttemptVerdict {
  return (
    isRecord(value) &&
    (value.outcome === 'accepted' || value.outcome === 'rejected' || value.outcome === 'owner-required') &&
    typeof value.reason === 'string' &&
    (value.decidedBy === 'vampire' || value.decidedBy === 'king' || value.decidedBy === 'owner') &&
    typeof value.decidedAt === 'number'
  );
}

function isRun(value: unknown): value is KingRun {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.objective === 'string' &&
    typeof value.ownerRequest === 'string' &&
    isStringArray(value.workspaceIds) &&
    (value.planningPolicy === 'managed' || value.planningPolicy === 'direct') &&
    ['intake', 'analyzing', 'needs-owner', 'approved', 'executing', 'verifying', 'completed', 'cancelled'].includes(
      String(value.phase)
    ) &&
    (value.status === 'active' ||
      value.status === 'needs-owner' ||
      value.status === 'completed' ||
      value.status === 'cancelled') &&
    typeof value.contractRevision === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    isNullableNumber(value.completedAt)
  );
}

function isTask(value: unknown): value is KingTask {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.runId === 'string' &&
    typeof value.workspaceId === 'string' &&
    (value.kind === 'analysis' || value.kind === 'change' || value.kind === 'review') &&
    typeof value.title === 'string' &&
    typeof value.objective === 'string' &&
    typeof value.background === 'string' &&
    isStringArray(value.nonGoals) &&
    isStringArray(value.dependsOnTaskIds) &&
    isStringArray(value.acceptanceCriteria) &&
    isStringArray(value.allowedPaths) &&
    isStringArray(value.forbiddenPaths) &&
    isStringArray(value.verificationCommands) &&
    (value.approvalPolicy === 'auto' || value.approvalPolicy === 'owner') &&
    [
      'planned',
      'queued',
      'running',
      'result-submitted',
      'verified',
      'needs-owner',
      'completed',
      'blocked',
      'failed',
    ].includes(String(value.status)) &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    isNullableNumber(value.completedAt)
  );
}

function isAttempt(value: unknown): value is KingAttempt {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.runId === 'string' &&
    typeof value.taskId === 'string' &&
    typeof value.workspaceId === 'string' &&
    [
      'queued',
      'delivery-uncertain',
      'dispatched',
      'working',
      'result-submitted',
      'verified',
      'needs-owner',
      'accepted',
      'rejected',
      'blocked',
      'failed',
    ].includes(String(value.status)) &&
    typeof value.taskPacketPath === 'string' &&
    isBaseline(value.baseline) &&
    (value.deliveryTarget === null || isDeliveryTarget(value.deliveryTarget)) &&
    (value.result === null || isResult(value.result)) &&
    (value.verification === null || isVerification(value.verification)) &&
    (value.verdict === null || isVerdict(value.verdict)) &&
    (value.startedEventHash === null || typeof value.startedEventHash === 'string') &&
    (value.startedEventConflictHash === null || typeof value.startedEventConflictHash === 'string') &&
    (value.resultEventHash === null || typeof value.resultEventHash === 'string') &&
    (value.resultEventConflictHash === null || typeof value.resultEventConflictHash === 'string') &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    isNullableNumber(value.deliveryAttemptedAt) &&
    isNullableNumber(value.dispatchedAt) &&
    isNullableNumber(value.startedAt) &&
    isNullableNumber(value.resultSubmittedAt)
  );
}

function isInboxEvent(value: unknown): value is KingInboxEvent {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    [
      'attempt-dispatched',
      'attempt-started',
      'attempt-result',
      'attempt-delivery-failed',
      'attempt-event-conflict',
      'attempt-interrupted',
      'verification-complete',
      'owner-required',
      'owner-answer',
      'owner-decision',
      'plan-approved',
      'task-completed',
    ].includes(String(value.type)) &&
    typeof value.runId === 'string' &&
    typeof value.taskId === 'string' &&
    typeof value.attemptId === 'string' &&
    typeof value.workspaceId === 'string' &&
    typeof value.message === 'string' &&
    typeof value.createdAt === 'number' &&
    isNullableNumber(value.notifiedAt) &&
    isNullableNumber(value.acknowledgedAt)
  );
}

function isDecisionRequest(value: unknown): value is KingDecisionRequest {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.runId === 'string' &&
    typeof value.taskId === 'string' &&
    typeof value.attemptId === 'string' &&
    typeof value.workspaceId === 'string' &&
    typeof value.question === 'string' &&
    typeof value.context === 'string' &&
    isStringArray(value.options) &&
    (value.status === 'pending' || value.status === 'answered') &&
    (value.answer === null || typeof value.answer === 'string') &&
    typeof value.createdAt === 'number' &&
    isNullableNumber(value.answeredAt)
  );
}

function parseStore(value: unknown): KingWorkflowStore {
  if (
    !isRecord(value) ||
    value.version !== KING_WORKFLOW_VERSION ||
    !Array.isArray(value.runs) ||
    !value.runs.every(isRun) ||
    !Array.isArray(value.tasks) ||
    !value.tasks.every(isTask) ||
    !Array.isArray(value.attempts) ||
    !value.attempts.every(isAttempt) ||
    !Array.isArray(value.decisions) ||
    !value.decisions.every(isDecisionRequest) ||
    !Array.isArray(value.inbox) ||
    !value.inbox.every(isInboxEvent)
  ) {
    throw new Error('invalid King workflow store');
  }
  return value as KingWorkflowStore;
}

function legacyRunPhase(status: unknown): KingRun['phase'] {
  if (status === 'completed') return 'completed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'needs-owner') return 'needs-owner';
  return 'executing';
}

function migrateLegacyRun(run: unknown): unknown {
  if (!isRecord(run)) return run;
  return {
    ...run,
    ownerRequest: typeof run.objective === 'string' ? run.objective : '',
    planningPolicy: 'direct',
    phase: legacyRunPhase(run.status),
  };
}

function migrateLegacyTask(task: unknown): unknown {
  return isRecord(task) ? { ...task, kind: 'change' } : task;
}

function migrateLegacyAttempt(attempt: unknown): unknown {
  if (!isRecord(attempt) || !isRecord(attempt.result)) return attempt;
  return { ...attempt, result: { ...attempt.result, plan: null } };
}

function migrateLegacyStore(value: unknown): unknown {
  if (!isRecord(value) || value.version !== 1) return value;
  const runs = Array.isArray(value.runs) ? value.runs.map(migrateLegacyRun) : value.runs;
  const tasks = Array.isArray(value.tasks) ? value.tasks.map(migrateLegacyTask) : value.tasks;
  const attempts = Array.isArray(value.attempts) ? value.attempts.map(migrateLegacyAttempt) : value.attempts;
  return { ...value, version: KING_WORKFLOW_VERSION, runs, tasks, attempts, decisions: [] };
}

async function withMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = mutationState.queue;
  let release = () => {};
  mutationState.queue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

async function ensureRegularDirectory(path: string): Promise<void> {
  try {
    const details = await lstat(path);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error(`King managed path is not a regular directory: ${path}`);
    }
    await chmod(path, 0o700);
    return;
  } catch (error) {
    if (!errorHasCode(error, 'ENOENT')) throw error;
  }
  await mkdir(path, { mode: 0o700 });
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`King managed path is not a regular directory: ${path}`);
  }
  await chmod(path, 0o700);
}

async function readRegularFile(path: string, maxBytes?: number): Promise<Buffer> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink())
    throw new Error(`King managed path is not a regular file: ${path}`);
  if (maxBytes !== undefined && details.size > maxBytes) throw new Error(`King event exceeds ${maxBytes} bytes.`);
  return readFile(path);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error(`King managed path is not a regular file: ${path}`);
    }
  } catch (error) {
    if (!errorHasCode(error, 'ENOENT')) throw error;
  }

  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

export function kingWorkflowPath(): string {
  return join(managedKingWorkspacePath(), KING_WORKFLOW_FILE_NAME);
}

export function kingTasksPath(): string {
  return join(managedKingWorkspacePath(), KING_TASKS_DIRECTORY_NAME);
}

export function kingTaskPath(taskId: string): string {
  return join(kingTasksPath(), taskId);
}

export function kingAttemptPath(taskId: string, attemptId: string): string {
  return join(kingTaskPath(taskId), 'attempts', attemptId);
}

export function kingAttemptEventsPath(taskId: string, attemptId: string): string {
  return join(kingAttemptPath(taskId, attemptId), 'events');
}

async function ensureWorkflowDirectories(): Promise<void> {
  try {
    const details = await lstat(managedKingWorkspacePath());
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error(`King managed path is not a regular directory: ${managedKingWorkspacePath()}`);
    }
  } catch (error) {
    if (!errorHasCode(error, 'ENOENT')) throw error;
    await ensureManagedKingWorkspace();
    return;
  }
  await ensureRegularDirectory(kingTasksPath());
}

export async function readKingWorkflowStore(): Promise<KingWorkflowStore> {
  try {
    return parseStore(migrateLegacyStore(JSON.parse((await readRegularFile(kingWorkflowPath())).toString('utf8'))));
  } catch (error) {
    if (errorHasCode(error, 'ENOENT')) return emptyStore();
    throw new Error('Vampire King workflow store is unreadable; refusing to overwrite it.', { cause: error });
  }
}

async function writeStore(store: KingWorkflowStore): Promise<void> {
  await ensureWorkflowDirectories();
  await writeJsonAtomic(kingWorkflowPath(), store);
}

function normalizeText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new KingWorkflowError('invalid-input', `${label} must be text.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || normalized.includes('\0')) {
    throw new KingWorkflowError('invalid-input', `${label} must be between 1 and ${maxLength} characters.`);
  }
  return normalized;
}

function normalizeOptionalText(value: unknown, label: string, maxLength: number): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new KingWorkflowError('invalid-input', `${label} must be text.`);
  const normalized = value.trim();
  if (normalized.length > maxLength || normalized.includes('\0')) {
    throw new KingWorkflowError('invalid-input', `${label} must be ${maxLength} characters or fewer.`);
  }
  return normalized;
}

function normalizeOwnerRequest(value: unknown): string {
  if (typeof value !== 'string') throw new KingWorkflowError('invalid-input', 'ownerRequest must be text.');
  if (!value.trim() || value.length > MAX_OBJECTIVE_LENGTH || value.includes('\0')) {
    throw new KingWorkflowError(
      'invalid-input',
      `ownerRequest must be between 1 and ${MAX_OBJECTIVE_LENGTH} characters.`
    );
  }
  return value;
}

function normalizeList(
  value: unknown,
  label: string,
  options: { required?: boolean; maxItemLength?: number } = {}
): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS || !value.every((item) => typeof item === 'string')) {
    throw new KingWorkflowError('invalid-input', `${label} must be a list with at most ${MAX_LIST_ITEMS} text items.`);
  }
  const maxItemLength = options.maxItemLength ?? MAX_ITEM_LENGTH;
  const normalized = [
    ...new Set(
      value
        .map((item) => item.trim())
        .filter((item) => item.length > 0 && item.length <= maxItemLength && !item.includes('\0'))
    ),
  ];
  if (normalized.length !== value.length || (options.required && normalized.length === 0)) {
    throw new KingWorkflowError('invalid-input', `${label} contains an empty, duplicate, or oversized item.`);
  }
  return normalized;
}

function normalizeWorkspaceId(value: unknown): string {
  const id = normalizeText(value, 'workspaceId', 200);
  if (/[\r\n\t/\\]/.test(id)) throw new KingWorkflowError('invalid-input', 'workspaceId is invalid.');
  return id;
}

function normalizePaths(value: unknown, label: string): string[] {
  return normalizeList(value, label, { maxItemLength: 500 }).map((path) => {
    if (isAbsolute(path) || path.includes('\\')) {
      throw new KingWorkflowError('invalid-input', `${label} entries must be repository-relative paths.`);
    }
    const normalized = posix.normalize(path).replace(/^\.\//, '').replace(/\/$/, '');
    if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
      throw new KingWorkflowError('invalid-input', `${label} entries must stay inside the repository.`);
    }
    return normalized;
  });
}

function normalizeCommands(value: unknown): string[] {
  const commands = normalizeList(value, 'verificationCommands', { maxItemLength: MAX_COMMAND_LENGTH });
  if (commands.length > MAX_VERIFICATION_COMMANDS) {
    throw new KingWorkflowError(
      'invalid-input',
      `A Task may declare at most ${MAX_VERIFICATION_COMMANDS} verification commands.`
    );
  }
  return commands.map((command) => {
    if (/[\0\r\n]/.test(command)) {
      throw new KingWorkflowError('invalid-input', 'Verification commands must stay on one line.');
    }
    return command;
  });
}

function normalizeProposedTask(value: unknown, candidateWorkspaceId: string, index: number): KingProposedTask {
  if (!isRecord(value)) {
    throw new KingWorkflowError('invalid-input', `plan.proposedTasks[${index}] must be an object.`);
  }
  const workspaceId = normalizeWorkspaceId(value.workspaceId);
  if (workspaceId !== candidateWorkspaceId) {
    throw new KingWorkflowError(
      'invalid-input',
      'An analysis Result may propose work only for the workspace it was assigned to.'
    );
  }
  const approvalPolicy = value.approvalPolicy;
  if (approvalPolicy !== 'auto' && approvalPolicy !== 'owner') {
    throw new KingWorkflowError('invalid-input', `plan.proposedTasks[${index}].approvalPolicy is invalid.`);
  }
  return {
    workspaceId,
    title: normalizeText(value.title, `plan.proposedTasks[${index}].title`, MAX_TITLE_LENGTH),
    objective: normalizeText(value.objective, `plan.proposedTasks[${index}].objective`, MAX_OBJECTIVE_LENGTH),
    acceptanceCriteria: normalizeList(value.acceptanceCriteria, `plan.proposedTasks[${index}].acceptanceCriteria`, {
      required: true,
    }),
    allowedPaths: normalizePaths(value.allowedPaths, `plan.proposedTasks[${index}].allowedPaths`),
    forbiddenPaths: normalizePaths(value.forbiddenPaths, `plan.proposedTasks[${index}].forbiddenPaths`),
    verificationCommands: normalizeCommands(value.verificationCommands),
    approvalPolicy,
  };
}

function normalizePlanResult(value: unknown, candidateWorkspaceId: string): KingPlanResult {
  if (!isRecord(value)) throw new KingWorkflowError('invalid-input', 'An analysis Result requires a plan object.');
  const normalizedCandidateId = normalizeWorkspaceId(value.candidateWorkspaceId);
  if (normalizedCandidateId !== candidateWorkspaceId) {
    throw new KingWorkflowError('invalid-input', 'The plan candidate does not match the assigned workspace.');
  }
  const recommendation = value.recommendation;
  if (recommendation !== 'proceed' && recommendation !== 'clarify' && recommendation !== 'reject') {
    throw new KingWorkflowError('invalid-input', 'plan.recommendation must be proceed, clarify, or reject.');
  }
  if (
    typeof value.confidence !== 'number' ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
    throw new KingWorkflowError('invalid-input', 'plan.confidence must be a number between 0 and 1.');
  }
  if (!Array.isArray(value.proposedTasks) || value.proposedTasks.length > 20) {
    throw new KingWorkflowError('invalid-input', 'plan.proposedTasks must contain at most 20 Tasks.');
  }
  const questions = normalizeList(value.questions, 'plan.questions');
  const proposedTasks = value.proposedTasks.map((task, index) =>
    normalizeProposedTask(task, normalizedCandidateId, index)
  );
  if (recommendation === 'proceed' && proposedTasks.length === 0) {
    throw new KingWorkflowError('invalid-input', 'A proceed recommendation must propose at least one Task.');
  }
  if (recommendation === 'clarify' && questions.length === 0) {
    throw new KingWorkflowError('invalid-input', 'A clarify recommendation must include at least one question.');
  }
  return {
    candidateWorkspaceId: normalizedCandidateId,
    recommendation,
    confidence: value.confidence,
    summary: normalizeText(value.summary, 'plan.summary', MAX_OBJECTIVE_LENGTH),
    steps: normalizeList(value.steps, 'plan.steps', { required: true }),
    assumptions: normalizeList(value.assumptions, 'plan.assumptions'),
    risks: normalizeList(value.risks, 'plan.risks'),
    questions,
    proposedTasks,
  };
}

function normalizeResultForTask(result: KingAttemptResult, task: KingTask): KingAttemptResult {
  if (!isResult(result)) throw new KingWorkflowError('invalid-input', 'Result evidence is invalid.');
  const changedPaths = normalizePaths(result.changedPaths, 'changedPaths');
  const blockers = normalizeList(result.blockers, 'blockers');
  const verification = result.verification.map((claim, index) => ({
    command: normalizeText(claim.command, `verification[${index}].command`, MAX_COMMAND_LENGTH),
    outcome: claim.outcome,
    ...(claim.summary === undefined
      ? {}
      : { summary: normalizeOptionalText(claim.summary, `verification[${index}].summary`, MAX_ITEM_LENGTH) }),
  }));
  if (task.kind === 'analysis') {
    if (changedPaths.length > 0 || verification.length > 0) {
      throw new KingWorkflowError(
        'invalid-input',
        'An analysis Result must be read-only and report empty changedPaths and verification claims.'
      );
    }
    return {
      schemaVersion: KING_RESULT_SCHEMA_VERSION,
      attemptId: result.attemptId,
      status: result.status,
      summary: normalizeText(result.summary, 'summary', MAX_OBJECTIVE_LENGTH),
      changedPaths,
      verification,
      blockers,
      plan: normalizePlanResult(result.plan, task.workspaceId),
    };
  }
  if (result.plan !== undefined && result.plan !== null) {
    throw new KingWorkflowError('invalid-input', 'Only an analysis Task may submit a plan.');
  }
  return {
    schemaVersion: KING_RESULT_SCHEMA_VERSION,
    attemptId: result.attemptId,
    status: result.status,
    summary: normalizeText(result.summary, 'summary', MAX_OBJECTIVE_LENGTH),
    changedPaths,
    verification,
    blockers,
    plan: null,
  };
}

function addInboxEvent(
  store: KingWorkflowStore,
  attempt: KingAttempt,
  type: KingInboxEventType,
  message: string,
  now: number
): void {
  store.inbox.push({
    id: randomUUID(),
    type,
    runId: attempt.runId,
    taskId: attempt.taskId,
    attemptId: attempt.id,
    workspaceId: attempt.workspaceId,
    message,
    createdAt: now,
    notifiedAt: null,
    acknowledgedAt: null,
  });
}

function requireRun(store: KingWorkflowStore, id: string): KingRun {
  const run = store.runs.find((candidate) => candidate.id === id);
  if (!run) throw new KingWorkflowError('not-found', `King Run ${id} was not found.`);
  return run;
}

function requireTask(store: KingWorkflowStore, id: string): KingTask {
  const task = store.tasks.find((candidate) => candidate.id === id);
  if (!task) throw new KingWorkflowError('not-found', `King Task ${id} was not found.`);
  return task;
}

function requireAttempt(store: KingWorkflowStore, id: string): KingAttempt {
  const attempt = store.attempts.find((candidate) => candidate.id === id);
  if (!attempt) throw new KingWorkflowError('not-found', `King Attempt ${id} was not found.`);
  return attempt;
}

function requireDecision(store: KingWorkflowStore, id: string): KingDecisionRequest {
  const decision = store.decisions.find((candidate) => candidate.id === id);
  if (!decision) throw new KingWorkflowError('not-found', `King Decision ${id} was not found.`);
  return decision;
}

function refreshRun(store: KingWorkflowStore, runId: string, now: number): void {
  const run = requireRun(store, runId);
  if (run.status === 'cancelled') return;
  const tasks = store.tasks.filter((task) => task.runId === runId);
  const analysisTasks = tasks.filter((task) => task.kind === 'analysis');
  const workTasks = tasks.filter((task) => task.kind !== 'analysis');
  const pendingDecision = store.decisions.some((decision) => decision.runId === runId && decision.status === 'pending');
  const needsOwner = pendingDecision || tasks.some((task) => task.status === 'needs-owner');
  const allWorkCompleted = workTasks.length > 0 && workTasks.every((task) => task.status === 'completed');
  const planApproved = analysisTasks.some((task) => task.status === 'completed');
  const workIsVerifying = workTasks.some((task) =>
    ['result-submitted', 'verified', 'needs-owner'].includes(task.status)
  );
  const workHasStarted = workTasks.some((task) => task.status !== 'planned');

  if (needsOwner) {
    run.status = 'needs-owner';
    run.phase = 'needs-owner';
    run.completedAt = null;
  } else if (allWorkCompleted) {
    run.status = 'completed';
    run.phase = 'completed';
    run.completedAt ??= now;
  } else {
    run.status = 'active';
    run.completedAt = null;
    if (workIsVerifying) run.phase = 'verifying';
    else if (workHasStarted || workTasks.length > 0) run.phase = 'executing';
    else if (run.planningPolicy === 'direct' || planApproved) run.phase = 'approved';
    else if (analysisTasks.length > 0) run.phase = 'analyzing';
    else run.phase = 'intake';
  }
  run.updatedAt = now;
}

function setAttemptConflict(store: KingWorkflowStore, attempt: KingAttempt, reason: string, now: number): void {
  attempt.status = 'needs-owner';
  attempt.updatedAt = now;
  attempt.verdict = {
    outcome: 'owner-required',
    reason,
    decidedBy: 'vampire',
    decidedAt: now,
  };
  const task = requireTask(store, attempt.taskId);
  task.status = 'needs-owner';
  task.updatedAt = now;
  addInboxEvent(store, attempt, 'attempt-event-conflict', reason, now);
  addInboxEvent(store, attempt, 'owner-required', `Owner review required: ${reason}`, now);
  refreshRun(store, attempt.runId, now);
}

export async function createKingRun(
  input: KingCreateRunInput,
  options: { now?: number; contractRevision?: string } = {}
): Promise<KingRun> {
  return withMutation(async () => {
    const now = options.now ?? Date.now();
    const workspaceIds =
      input.workspaceIds === undefined
        ? []
        : normalizeList(input.workspaceIds, 'workspaceIds').map(normalizeWorkspaceId);
    const run: KingRun = {
      id: randomUUID(),
      title: normalizeText(input.title, 'title', MAX_TITLE_LENGTH),
      objective: normalizeText(input.objective, 'objective', MAX_OBJECTIVE_LENGTH),
      ownerRequest: normalizeOwnerRequest(input.ownerRequest ?? input.objective),
      workspaceIds,
      planningPolicy: input.planningPolicy ?? 'managed',
      phase: input.planningPolicy === 'direct' ? 'approved' : 'intake',
      status: 'active',
      contractRevision: normalizeText(options.contractRevision ?? KING_CONTRACT_REVISION, 'contractRevision', 200),
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    if (run.planningPolicy !== 'managed' && run.planningPolicy !== 'direct') {
      throw new KingWorkflowError('invalid-input', 'planningPolicy must be managed or direct.');
    }
    if (run.planningPolicy === 'managed' && workspaceIds.length > 3) {
      throw new KingWorkflowError('invalid-input', 'A managed Run may shortlist at most three workspaces.');
    }
    const store = await readKingWorkflowStore();
    store.runs.push(run);
    await writeStore(store);
    return structuredClone(run);
  });
}

export async function createKingTask(input: KingCreateTaskInput, now = Date.now()): Promise<KingTask> {
  return withMutation(async () => {
    const store = await readKingWorkflowStore();
    const run = requireRun(store, normalizeText(input.runId, 'runId', 200));
    if (run.status === 'completed' || run.status === 'cancelled') {
      throw new KingWorkflowError('invalid-state', `Run ${run.id} does not accept new Tasks.`);
    }
    if (store.tasks.filter((task) => task.runId === run.id).length >= MAX_TASKS_PER_RUN) {
      throw new KingWorkflowError('invalid-state', `Run ${run.id} reached its ${MAX_TASKS_PER_RUN} Task limit.`);
    }
    if (store.decisions.some((decision) => decision.runId === run.id && decision.status === 'pending')) {
      throw new KingWorkflowError('owner-required', `Run ${run.id} is waiting for an owner answer.`);
    }
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const kind = input.kind ?? 'change';
    if (kind !== 'analysis' && kind !== 'change' && kind !== 'review') {
      throw new KingWorkflowError('invalid-input', 'kind must be analysis, change, or review.');
    }
    if (run.planningPolicy === 'managed') {
      const planApproved = store.tasks.some(
        (task) => task.runId === run.id && task.kind === 'analysis' && task.status === 'completed'
      );
      if (kind === 'analysis' && planApproved) {
        throw new KingWorkflowError('invalid-state', `Run ${run.id} already has an approved plan.`);
      }
      if (
        kind === 'analysis' &&
        store.tasks.filter(
          (task) =>
            task.runId === run.id &&
            task.kind === 'analysis' &&
            !['completed', 'blocked', 'failed'].includes(task.status)
        ).length >= 3
      ) {
        throw new KingWorkflowError('invalid-state', `Run ${run.id} already used its three candidate analyses.`);
      }
      if (kind !== 'analysis' && !planApproved) {
        throw new KingWorkflowError(
          'invalid-state',
          `Run ${run.id} requires an accepted analysis plan before repository work can be created.`
        );
      }
    }
    const dependsOnTaskIds = normalizeList(input.dependsOnTaskIds ?? [], 'dependsOnTaskIds').map((id) =>
      normalizeText(id, 'dependency Task id', 200)
    );
    for (const dependencyId of dependsOnTaskIds) {
      const dependency = requireTask(store, dependencyId);
      if (dependency.runId !== run.id) {
        throw new KingWorkflowError('invalid-input', `Dependency Task ${dependency.id} belongs to another Run.`);
      }
    }
    const task: KingTask = {
      id: randomUUID(),
      runId: run.id,
      workspaceId,
      kind,
      title: normalizeText(input.title, 'title', MAX_TITLE_LENGTH),
      objective: normalizeText(input.objective, 'objective', MAX_OBJECTIVE_LENGTH),
      background: normalizeOptionalText(input.background, 'background', MAX_OBJECTIVE_LENGTH),
      nonGoals: normalizeList(input.nonGoals ?? [], 'nonGoals'),
      dependsOnTaskIds,
      acceptanceCriteria: normalizeList(input.acceptanceCriteria, 'acceptanceCriteria', { required: true }),
      allowedPaths: normalizePaths(input.allowedPaths ?? [], 'allowedPaths'),
      forbiddenPaths: normalizePaths(input.forbiddenPaths ?? [], 'forbiddenPaths'),
      verificationCommands: normalizeCommands(input.verificationCommands ?? []),
      approvalPolicy: input.approvalPolicy ?? (kind === 'analysis' ? 'auto' : 'owner'),
      status: 'planned',
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    if (task.approvalPolicy !== 'auto' && task.approvalPolicy !== 'owner') {
      throw new KingWorkflowError('invalid-input', 'approvalPolicy must be auto or owner.');
    }
    if (task.kind === 'analysis' && (task.approvalPolicy !== 'auto' || task.verificationCommands.length > 0)) {
      throw new KingWorkflowError(
        'invalid-input',
        'Analysis Tasks must use automatic plan review and cannot declare repository verification commands.'
      );
    }
    await ensureWorkflowDirectories();
    await ensureRegularDirectory(kingTaskPath(task.id));
    await writeJsonAtomic(join(kingTaskPath(task.id), 'task.json'), {
      schemaVersion: KING_WORKFLOW_VERSION,
      contractRevision: run.contractRevision,
      run: { id: run.id, title: run.title, objective: run.objective },
      task,
    });
    store.tasks.push(task);
    if (!run.workspaceIds.includes(workspaceId)) run.workspaceIds.push(workspaceId);
    refreshRun(store, run.id, now);
    await writeStore(store);
    return structuredClone(task);
  });
}

const ACTIVE_ATTEMPT_STATUSES = new Set<KingAttempt['status']>([
  'queued',
  'delivery-uncertain',
  'dispatched',
  'working',
  'result-submitted',
  'verified',
  'needs-owner',
]);

export async function interruptKingWorkspaceAttempts(
  workspaceId: string,
  reason: string,
  now = Date.now()
): Promise<KingAttempt[]> {
  return withMutation(async () => {
    const normalizedWorkspaceId = normalizeText(workspaceId, 'workspaceId', 200);
    const normalizedReason = normalizeText(reason, 'reason', MAX_ITEM_LENGTH);
    const store = await readKingWorkflowStore();
    const interrupted: KingAttempt[] = [];
    const runIds = new Set<string>();
    for (const attempt of store.attempts) {
      if (attempt.workspaceId !== normalizedWorkspaceId || !ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) continue;
      attempt.status = 'blocked';
      attempt.updatedAt = now;
      attempt.verdict = {
        outcome: 'rejected',
        reason: normalizedReason,
        decidedBy: 'owner',
        decidedAt: now,
      };
      const task = requireTask(store, attempt.taskId);
      task.status = 'blocked';
      task.updatedAt = now;
      task.completedAt = null;
      addInboxEvent(store, attempt, 'attempt-interrupted', normalizedReason, now);
      runIds.add(attempt.runId);
      interrupted.push(structuredClone(attempt));
    }
    if (interrupted.length === 0) return [];
    for (const runId of runIds) refreshRun(store, runId, now);
    await writeStore(store);
    return interrupted;
  });
}

export type CancelledKingWorkflow = {
  runIds: string[];
  taskIds: string[];
  attemptIds: string[];
  decisionIds: string[];
};

export async function cancelActiveKingWorkflow(reason: string, now = Date.now()): Promise<CancelledKingWorkflow> {
  return withMutation(async () => {
    const normalizedReason = normalizeText(reason, 'reason', MAX_ITEM_LENGTH);
    const store = await readKingWorkflowStore();
    const inboxLengthBeforeCancellation = store.inbox.length;
    const cancelled: CancelledKingWorkflow = { runIds: [], taskIds: [], attemptIds: [], decisionIds: [] };
    const activeRunIds = new Set(
      store.runs.filter((run) => run.status === 'active' || run.status === 'needs-owner').map((run) => run.id)
    );

    for (const attempt of store.attempts) {
      if (!activeRunIds.has(attempt.runId) || !ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) continue;
      attempt.status = 'blocked';
      attempt.updatedAt = now;
      attempt.verdict = {
        outcome: 'rejected',
        reason: normalizedReason,
        decidedBy: 'owner',
        decidedAt: now,
      };
      addInboxEvent(store, attempt, 'attempt-interrupted', normalizedReason, now);
      cancelled.attemptIds.push(attempt.id);
    }

    for (const task of store.tasks) {
      if (!activeRunIds.has(task.runId) || task.status === 'completed' || task.status === 'failed') continue;
      task.status = 'blocked';
      task.updatedAt = now;
      task.completedAt = null;
      cancelled.taskIds.push(task.id);
    }

    for (const decision of store.decisions) {
      if (!activeRunIds.has(decision.runId) || decision.status !== 'pending') continue;
      decision.status = 'answered';
      decision.answer = `Cancelled: ${normalizedReason}`.slice(0, MAX_ITEM_LENGTH);
      decision.answeredAt = now;
      cancelled.decisionIds.push(decision.id);
    }

    for (const run of store.runs) {
      if (!activeRunIds.has(run.id)) continue;
      run.status = 'cancelled';
      run.phase = 'cancelled';
      run.updatedAt = now;
      run.completedAt = now;
      cancelled.runIds.push(run.id);
    }

    if (cancelled.runIds.length === 0) return cancelled;
    for (const event of store.inbox.slice(inboxLengthBeforeCancellation)) {
      event.notifiedAt = now;
      event.acknowledgedAt = now;
    }
    await writeStore(store);
    return cancelled;
  });
}

export async function createKingAttempt(
  taskId: string,
  baseline: KingAttemptBaseline,
  now = Date.now()
): Promise<KingAttempt> {
  return withMutation(async () => {
    if (!isBaseline(baseline)) throw new KingWorkflowError('invalid-input', 'Attempt baseline is invalid.');
    const store = await readKingWorkflowStore();
    const task = requireTask(store, normalizeText(taskId, 'taskId', 200));
    const run = requireRun(store, task.runId);
    if (run.status === 'completed' || run.status === 'cancelled' || task.status === 'completed') {
      throw new KingWorkflowError('invalid-state', `Task ${task.id} does not accept a new Attempt.`);
    }
    if (run.status === 'needs-owner') {
      throw new KingWorkflowError('owner-required', `Run ${run.id} is waiting for an owner decision.`);
    }
    const incompleteDependencies = task.dependsOnTaskIds.filter(
      (dependencyId) => requireTask(store, dependencyId).status !== 'completed'
    );
    if (incompleteDependencies.length > 0) {
      throw new KingWorkflowError(
        'invalid-state',
        `Task ${task.id} is waiting for dependencies: ${incompleteDependencies.join(', ')}.`
      );
    }
    if (store.attempts.some((attempt) => attempt.taskId === task.id && ACTIVE_ATTEMPT_STATUSES.has(attempt.status))) {
      throw new KingWorkflowError('active-attempt', `Task ${task.id} already has an active Attempt.`);
    }
    if (store.attempts.filter((attempt) => attempt.taskId === task.id).length >= MAX_ATTEMPTS_PER_TASK) {
      throw new KingWorkflowError(
        'invalid-state',
        `Task ${task.id} reached its ${MAX_ATTEMPTS_PER_TASK} Attempt limit.`
      );
    }
    if (
      store.attempts.some(
        (attempt) => attempt.workspaceId === task.workspaceId && ACTIVE_ATTEMPT_STATUSES.has(attempt.status)
      )
    ) {
      throw new KingWorkflowError(
        'active-attempt',
        `Workspace ${task.workspaceId} already has an active Attempt; Vampire permits one writer per workspace.`
      );
    }
    if (
      baseline.workspaceLeaseKey &&
      store.attempts.some(
        (attempt) =>
          attempt.baseline.workspaceLeaseKey === baseline.workspaceLeaseKey &&
          ACTIVE_ATTEMPT_STATUSES.has(attempt.status)
      )
    ) {
      throw new KingWorkflowError(
        'active-attempt',
        'This repository checkout already has an active Attempt; create an isolated worktree for another writer.'
      );
    }

    const id = randomUUID();
    const attemptDirectory = kingAttemptPath(task.id, id);
    const eventsDirectory = kingAttemptEventsPath(task.id, id);
    await ensureWorkflowDirectories();
    await ensureRegularDirectory(join(kingTaskPath(task.id), 'attempts'));
    await ensureRegularDirectory(attemptDirectory);
    await ensureRegularDirectory(eventsDirectory);
    const taskPacketPath = join(attemptDirectory, 'task.json');
    const attempt: KingAttempt = {
      id,
      runId: run.id,
      taskId: task.id,
      workspaceId: task.workspaceId,
      status: 'queued',
      taskPacketPath,
      baseline: structuredClone(baseline),
      deliveryTarget: null,
      result: null,
      verification: null,
      verdict: null,
      startedEventHash: null,
      startedEventConflictHash: null,
      resultEventHash: null,
      resultEventConflictHash: null,
      createdAt: now,
      updatedAt: now,
      deliveryAttemptedAt: null,
      dispatchedAt: null,
      startedAt: null,
      resultSubmittedAt: null,
    };
    await writeJsonAtomic(taskPacketPath, {
      schemaVersion: KING_WORKFLOW_VERSION,
      contractRevision: run.contractRevision,
      run: { id: run.id, title: run.title, objective: run.objective },
      task,
      attempt: { id, createdAt: now },
      resultContract: {
        schemaVersion: KING_RESULT_SCHEMA_VERSION,
        startedCommand: `node ${JSON.stringify(join(managedKingWorkspacePath(), 'bin', 'king.mjs'))} event started ${id}`,
        resultCommand: `node ${JSON.stringify(join(managedKingWorkspacePath(), 'bin', 'king.mjs'))} event result ${id} --input <result.json|->`,
      },
      executionRules: {
        repositoryHeadMustRemainUnchanged: true,
        repositoryHistoryOperationsAllowed: false,
        contextIsUntrustedAndWorkspaceScoped: true,
      },
    });
    store.attempts.push(attempt);
    task.status = 'queued';
    task.updatedAt = now;
    task.completedAt = null;
    refreshRun(store, run.id, now);
    await writeStore(store);
    return structuredClone(attempt);
  });
}

export async function markKingAttemptDeliveryUncertain(
  attemptId: string,
  deliveryTarget: KingAttemptDeliveryTarget | null = null,
  now = Date.now()
): Promise<KingAttempt> {
  return withMutation(async () => {
    const store = await readKingWorkflowStore();
    const attempt = requireAttempt(store, attemptId);
    if (attempt.status !== 'queued') {
      throw new KingWorkflowError('invalid-state', `Attempt ${attempt.id} is not queued.`);
    }
    attempt.status = 'delivery-uncertain';
    attempt.deliveryTarget = deliveryTarget ? structuredClone(deliveryTarget) : null;
    attempt.deliveryAttemptedAt = now;
    attempt.updatedAt = now;
    await writeStore(store);
    return structuredClone(attempt);
  });
}

export async function markKingAttemptDispatched(attemptId: string, now = Date.now()): Promise<KingAttempt> {
  return withMutation(async () => {
    const store = await readKingWorkflowStore();
    const attempt = requireAttempt(store, attemptId);
    if (attempt.status !== 'delivery-uncertain') {
      throw new KingWorkflowError('invalid-state', `Attempt ${attempt.id} has no pending delivery.`);
    }
    attempt.status = 'dispatched';
    attempt.dispatchedAt = now;
    attempt.updatedAt = now;
    const task = requireTask(store, attempt.taskId);
    task.status = 'running';
    task.updatedAt = now;
    addInboxEvent(store, attempt, 'attempt-dispatched', `Attempt ${attempt.id} was dispatched.`, now);
    await writeStore(store);
    return structuredClone(attempt);
  });
}

export async function markKingAttemptDeliveryFailed(
  attemptId: string,
  message: string,
  now = Date.now()
): Promise<KingAttempt> {
  return withMutation(async () => {
    const store = await readKingWorkflowStore();
    const attempt = requireAttempt(store, attemptId);
    if (attempt.status !== 'delivery-uncertain') {
      throw new KingWorkflowError('invalid-state', `Attempt ${attempt.id} has no pending delivery.`);
    }
    attempt.status = 'failed';
    attempt.updatedAt = now;
    const task = requireTask(store, attempt.taskId);
    task.status = 'failed';
    task.updatedAt = now;
    addInboxEvent(store, attempt, 'attempt-delivery-failed', normalizeText(message, 'message', MAX_ITEM_LENGTH), now);
    refreshRun(store, attempt.runId, now);
    await writeStore(store);
    return structuredClone(attempt);
  });
}

export async function requireKingAttemptOwner(
  attemptId: string,
  reason: string,
  now = Date.now()
): Promise<KingAttempt> {
  return withMutation(async () => {
    const store = await readKingWorkflowStore();
    const attempt = requireAttempt(store, attemptId);
    if (attempt.status === 'accepted' || attempt.status === 'rejected' || attempt.status === 'failed') {
      throw new KingWorkflowError('invalid-state', `Attempt ${attempt.id} is already terminal.`);
    }
    const normalizedReason = normalizeText(reason, 'reason', MAX_ITEM_LENGTH);
    attempt.status = 'needs-owner';
    attempt.updatedAt = now;
    attempt.verdict = {
      outcome: 'owner-required',
      reason: normalizedReason,
      decidedBy: 'vampire',
      decidedAt: now,
    };
    const task = requireTask(store, attempt.taskId);
    task.status = 'needs-owner';
    task.updatedAt = now;
    addInboxEvent(store, attempt, 'owner-required', normalizedReason, now);
    refreshRun(store, attempt.runId, now);
    await writeStore(store);
    return structuredClone(attempt);
  });
}

function attemptWasNeverDelivered(attempt: KingAttempt): boolean {
  return (
    attempt.deliveryTarget === null &&
    attempt.result === null &&
    attempt.verification === null &&
    attempt.startedEventHash === null &&
    attempt.startedEventConflictHash === null &&
    attempt.resultEventHash === null &&
    attempt.resultEventConflictHash === null &&
    attempt.deliveryAttemptedAt === null &&
    attempt.dispatchedAt === null &&
    attempt.startedAt === null &&
    attempt.resultSubmittedAt === null
  );
}

export async function resumeKingAttemptPreparation(
  attemptId: string,
  expectedReason: string,
  now = Date.now()
): Promise<KingAttempt> {
  return withMutation(async () => {
    const store = await readKingWorkflowStore();
    const attempt = requireAttempt(store, attemptId);
    const reason = normalizeText(expectedReason, 'expectedReason', MAX_ITEM_LENGTH);
    if (
      attempt.status !== 'needs-owner' ||
      attempt.verdict?.outcome !== 'owner-required' ||
      attempt.verdict.decidedBy !== 'vampire' ||
      attempt.verdict.reason !== reason ||
      !attemptWasNeverDelivered(attempt)
    ) {
      throw new KingWorkflowError('invalid-state', `Attempt ${attempt.id} cannot resume preparation.`);
    }
    attempt.status = 'queued';
    attempt.verdict = null;
    attempt.updatedAt = now;
    const task = requireTask(store, attempt.taskId);
    task.status = 'queued';
    task.updatedAt = now;
    task.completedAt = null;
    refreshRun(store, attempt.runId, now);
    await writeStore(store);
    return structuredClone(attempt);
  });
}

async function recordStartedEvent(
  store: KingWorkflowStore,
  attempt: KingAttempt,
  event: KingAttemptStartedEvent,
  hash: string,
  now: number
): Promise<'recorded' | 'unchanged' | 'conflict'> {
  if (attempt.startedEventHash === hash) return 'unchanged';
  if (attempt.startedEventConflictHash === hash) return 'unchanged';
  if (attempt.startedEventHash !== null) {
    attempt.startedEventConflictHash = hash;
    setAttemptConflict(store, attempt, `started.json changed after it was recorded for Attempt ${attempt.id}.`, now);
    return 'conflict';
  }
  if (['accepted', 'rejected', 'blocked', 'failed'].includes(attempt.status)) return 'unchanged';
  if (
    event.attemptId !== attempt.id ||
    event.schemaVersion !== KING_EVENT_SCHEMA_VERSION ||
    !Number.isFinite(event.startedAt)
  ) {
    throw new KingWorkflowError('invalid-input', `started.json does not match Attempt ${attempt.id}.`);
  }
  if (attempt.status === 'queued') {
    throw new KingWorkflowError(
      'invalid-state',
      `Attempt ${attempt.id} reported a start before Vampire dispatched it.`
    );
  }
  attempt.startedEventHash = hash;
  attempt.startedAt = event.startedAt;
  if (attempt.status === 'delivery-uncertain' || attempt.status === 'dispatched') {
    attempt.status = 'working';
  }
  attempt.updatedAt = now;
  const task = requireTask(store, attempt.taskId);
  if (task.status === 'planned' || task.status === 'queued' || task.status === 'running') task.status = 'running';
  task.updatedAt = now;
  addInboxEvent(store, attempt, 'attempt-started', `Attempt ${attempt.id} reported that work started.`, now);
  return 'recorded';
}

async function recordResultEvent(
  store: KingWorkflowStore,
  attempt: KingAttempt,
  result: KingAttemptResult,
  hash: string,
  now: number
): Promise<'recorded' | 'unchanged' | 'conflict'> {
  if (attempt.resultEventHash === hash) return 'unchanged';
  if (attempt.resultEventConflictHash === hash) return 'unchanged';
  if (attempt.resultEventHash !== null) {
    attempt.resultEventConflictHash = hash;
    setAttemptConflict(store, attempt, `result.json changed after it was recorded for Attempt ${attempt.id}.`, now);
    return 'conflict';
  }
  if (['accepted', 'rejected', 'blocked', 'failed'].includes(attempt.status)) return 'unchanged';
  if (!isResult(result) || result.attemptId !== attempt.id) {
    throw new KingWorkflowError('invalid-input', `result.json does not match Attempt ${attempt.id}.`);
  }
  if (attempt.startedEventHash === null) {
    throw new KingWorkflowError('invalid-state', `Attempt ${attempt.id} submitted a Result without a started event.`);
  }
  const task = requireTask(store, attempt.taskId);
  const normalizedResult = normalizeResultForTask(result, task);
  attempt.resultEventHash = hash;
  attempt.result = normalizedResult;
  attempt.resultSubmittedAt = now;
  const preserveOwnerReview = attempt.status === 'needs-owner';
  if (!preserveOwnerReview) attempt.status = 'result-submitted';
  attempt.updatedAt = now;
  if (!preserveOwnerReview) task.status = 'result-submitted';
  task.updatedAt = now;
  addInboxEvent(
    store,
    attempt,
    'attempt-result',
    `Attempt ${attempt.id} submitted a ${result.status} ${task.kind === 'analysis' ? 'plan' : 'Result'}; verification is still required.`,
    now
  );
  refreshRun(store, attempt.runId, now);
  return 'recorded';
}

async function readEvent(path: string): Promise<{ value: unknown; hash: string } | null> {
  try {
    const content = await readRegularFile(path, MAX_EVENT_BYTES);
    return {
      value: JSON.parse(content.toString('utf8')) as unknown,
      hash: createHash('sha256').update(content).digest('hex'),
    };
  } catch (error) {
    if (errorHasCode(error, 'ENOENT')) return null;
    throw error;
  }
}

export async function scanKingAttemptEvents(
  attemptId?: string,
  now = Date.now()
): Promise<KingAttemptEventScanResult[]> {
  return withMutation(async () => {
    const store = await readKingWorkflowStore();
    const attempts = attemptId ? [requireAttempt(store, attemptId)] : store.attempts;
    const scans: KingAttemptEventScanResult[] = [];
    let changed = false;
    for (const attempt of attempts) {
      const scan: KingAttemptEventScanResult = {
        attemptId: attempt.id,
        started: 'missing',
        result: 'missing',
        errors: [],
      };
      const eventsPath = kingAttemptEventsPath(attempt.taskId, attempt.id);
      try {
        const event = await readEvent(join(eventsPath, 'started.json'));
        if (event) {
          try {
            if (!isRecord(event.value)) throw new Error('started.json must contain an object.');
            scan.started = await recordStartedEvent(
              store,
              attempt,
              event.value as KingAttemptStartedEvent,
              event.hash,
              now
            );
            changed ||= scan.started !== 'unchanged';
          } catch (error) {
            scan.started = 'invalid';
            scan.errors.push(error instanceof Error ? error.message : 'Invalid started.json.');
            if (attempt.startedEventHash === null) {
              attempt.startedEventConflictHash = event.hash;
              setAttemptConflict(store, attempt, `Invalid started.json for Attempt ${attempt.id}.`, now);
              changed = true;
            }
          }
        }
      } catch (error) {
        scan.started = 'invalid';
        scan.errors.push(error instanceof Error ? error.message : 'Could not read started.json.');
      }
      try {
        const event = await readEvent(join(eventsPath, 'result.json'));
        if (event) {
          try {
            scan.result = await recordResultEvent(store, attempt, event.value as KingAttemptResult, event.hash, now);
            changed ||= scan.result !== 'unchanged';
          } catch (error) {
            scan.result = 'invalid';
            scan.errors.push(error instanceof Error ? error.message : 'Invalid result.json.');
            if (attempt.resultEventHash === null) {
              attempt.resultEventConflictHash = event.hash;
              setAttemptConflict(store, attempt, `Invalid result.json for Attempt ${attempt.id}.`, now);
              changed = true;
            }
          }
        }
      } catch (error) {
        scan.result = 'invalid';
        scan.errors.push(error instanceof Error ? error.message : 'Could not read result.json.');
      }
      scans.push(scan);
    }
    if (changed) await writeStore(store);
    return scans;
  });
}

export async function recordKingAttemptVerification(
  attemptId: string,
  verification: KingAttemptVerification,
  now = Date.now()
): Promise<KingAttempt> {
  return withMutation(async () => {
    if (!isVerification(verification))
      throw new KingWorkflowError('invalid-input', 'Verification evidence is invalid.');
    const store = await readKingWorkflowStore();
    const attempt = requireAttempt(store, attemptId);
    if (attempt.status !== 'result-submitted' || !attempt.result) {
      throw new KingWorkflowError('invalid-state', `Attempt ${attempt.id} has no Result ready to verify.`);
    }
    attempt.verification = structuredClone(verification);
    attempt.updatedAt = now;
    const task = requireTask(store, attempt.taskId);
    if (verification.outcome === 'passed' && task.approvalPolicy === 'auto') {
      attempt.status = 'verified';
      task.status = 'verified';
    } else if (verification.outcome === 'passed') {
      attempt.status = 'needs-owner';
      task.status = 'needs-owner';
      attempt.verdict = {
        outcome: 'owner-required',
        reason: 'The Task approval policy requires an owner decision.',
        decidedBy: 'vampire',
        decidedAt: now,
      };
      addInboxEvent(store, attempt, 'owner-required', `Attempt ${attempt.id} requires owner approval.`, now);
    } else if (verification.outcome === 'needs-owner') {
      attempt.status = 'needs-owner';
      task.status = 'needs-owner';
      attempt.verdict = {
        outcome: 'owner-required',
        reason: verification.reasons.join(' ') || 'Owner review is required.',
        decidedBy: 'vampire',
        decidedAt: now,
      };
      addInboxEvent(store, attempt, 'owner-required', `Attempt ${attempt.id} requires owner review.`, now);
    } else {
      const blocked = attempt.result.status === 'blocked';
      attempt.status = blocked ? 'blocked' : 'failed';
      task.status = blocked ? 'blocked' : 'failed';
    }
    task.updatedAt = now;
    addInboxEvent(
      store,
      attempt,
      'verification-complete',
      `Verification for Attempt ${attempt.id}: ${verification.outcome}.`,
      now
    );
    refreshRun(store, attempt.runId, now);
    await writeStore(store);
    return structuredClone(attempt);
  });
}

export async function decideKingAttempt(
  attemptId: string,
  decision: { outcome: 'accepted' | 'rejected'; reason: string; decidedBy: 'king' | 'owner' },
  now = Date.now()
): Promise<KingAttempt> {
  return withMutation(async () => {
    const store = await readKingWorkflowStore();
    const attempt = requireAttempt(store, attemptId);
    const task = requireTask(store, attempt.taskId);
    const reason = normalizeText(decision.reason, 'reason', MAX_ITEM_LENGTH);
    if (decision.outcome === 'accepted') {
      if (!attempt.verification) {
        throw new KingWorkflowError('verification-required', `Attempt ${attempt.id} has not been verified.`);
      }
      if (attempt.verification.outcome === 'failed') {
        throw new KingWorkflowError('verification-required', 'A failed verification cannot be accepted.');
      }
      if (
        decision.decidedBy === 'king' &&
        (task.approvalPolicy !== 'auto' || attempt.verification.outcome !== 'passed')
      ) {
        throw new KingWorkflowError('owner-required', 'This Attempt requires an owner decision.');
      }
      if (task.kind === 'analysis') {
        if (!attempt.result?.plan || attempt.result.plan.recommendation !== 'proceed') {
          throw new KingWorkflowError(
            'invalid-state',
            'Only an analysis plan with a proceed recommendation can be approved.'
          );
        }
        if (store.decisions.some((candidate) => candidate.attemptId === attempt.id && candidate.status === 'pending')) {
          throw new KingWorkflowError('owner-required', 'This plan is waiting for an owner answer.');
        }
      }
      attempt.status = 'accepted';
      task.status = 'completed';
      task.completedAt = now;
      if (task.kind === 'analysis') {
        addInboxEvent(store, attempt, 'plan-approved', `Plan from ${task.workspaceId} was approved.`, now);
      }
      addInboxEvent(store, attempt, 'task-completed', `Task ${task.id} was accepted and completed.`, now);
    } else {
      attempt.status = 'rejected';
      task.status = 'failed';
      task.completedAt = null;
    }
    attempt.verdict = { outcome: decision.outcome, reason, decidedBy: decision.decidedBy, decidedAt: now };
    if (decision.decidedBy === 'owner') {
      addInboxEvent(
        store,
        attempt,
        'owner-decision',
        `The owner ${decision.outcome === 'accepted' ? 'approved' : 'rejected'} Attempt ${attempt.id}.`,
        now
      );
    }
    attempt.updatedAt = now;
    task.updatedAt = now;
    refreshRun(store, attempt.runId, now);
    await writeStore(store);
    return structuredClone(attempt);
  });
}

export async function listKingRuns(): Promise<KingRun[]> {
  const runs = (await readKingWorkflowStore()).runs;
  const relevant = new Map(
    runs
      .filter((run) => run.status === 'active' || run.status === 'needs-owner')
      .concat(runs.slice(-MAX_LISTED_RUNS))
      .map((run) => [run.id, run])
  );
  return structuredClone([...relevant.values()].sort((left, right) => right.updatedAt - left.updatedAt));
}

export async function readKingRun(
  id: string
): Promise<{ run: KingRun; tasks: KingTask[]; attempts: KingAttempt[]; decisions: KingDecisionRequest[] }> {
  const store = await readKingWorkflowStore();
  const run = requireRun(store, id);
  return structuredClone({
    run,
    tasks: store.tasks.filter((task) => task.runId === id),
    attempts: store.attempts.filter((attempt) => attempt.runId === id),
    decisions: store.decisions.filter((decision) => decision.runId === id),
  });
}

export async function readKingAttempt(id: string): Promise<KingAttempt> {
  return structuredClone(requireAttempt(await readKingWorkflowStore(), id));
}

export async function readKingTask(id: string): Promise<KingTask> {
  return structuredClone(requireTask(await readKingWorkflowStore(), id));
}

export async function createKingDecisionRequest(
  input: KingCreateDecisionInput,
  now = Date.now()
): Promise<KingDecisionRequest> {
  return withMutation(async () => {
    const store = await readKingWorkflowStore();
    const attempt = requireAttempt(store, normalizeText(input.attemptId, 'attemptId', 200));
    const task = requireTask(store, attempt.taskId);
    const run = requireRun(store, attempt.runId);
    if (task.kind !== 'analysis' || !attempt.result?.plan || !attempt.verification) {
      throw new KingWorkflowError('invalid-state', 'Owner questions can be created only for a verified analysis plan.');
    }
    if (attempt.verification.outcome !== 'passed' || attempt.status !== 'verified') {
      throw new KingWorkflowError(
        'invalid-state',
        `Attempt ${attempt.id} must pass automatic verification before King can ask a plan question.`
      );
    }
    if (store.decisions.some((decision) => decision.attemptId === attempt.id && decision.status === 'pending')) {
      throw new KingWorkflowError('invalid-state', `Attempt ${attempt.id} already has a pending owner question.`);
    }
    const options = normalizeList(input.options ?? [], 'options');
    if (options.length > 10) {
      throw new KingWorkflowError('invalid-input', 'An owner question may offer at most 10 options.');
    }
    const decision: KingDecisionRequest = {
      id: randomUUID(),
      runId: run.id,
      taskId: task.id,
      attemptId: attempt.id,
      workspaceId: attempt.workspaceId,
      question: normalizeText(input.question, 'question', MAX_OBJECTIVE_LENGTH),
      context: normalizeOptionalText(input.context, 'context', MAX_OBJECTIVE_LENGTH),
      options,
      status: 'pending',
      answer: null,
      createdAt: now,
      answeredAt: null,
    };
    store.decisions.push(decision);
    addInboxEvent(store, attempt, 'owner-required', `King asked the owner: ${decision.question}`, now);
    refreshRun(store, run.id, now);
    await writeStore(store);
    return structuredClone(decision);
  });
}

export async function answerKingDecisionRequest(
  id: string,
  answer: string,
  now = Date.now()
): Promise<KingDecisionRequest> {
  return withMutation(async () => {
    const store = await readKingWorkflowStore();
    const decision = requireDecision(store, normalizeText(id, 'decisionId', 200));
    if (decision.status !== 'pending') {
      throw new KingWorkflowError('invalid-state', `Decision ${decision.id} was already answered.`);
    }
    decision.status = 'answered';
    decision.answer = normalizeText(answer, 'answer', MAX_OBJECTIVE_LENGTH);
    decision.answeredAt = now;
    const attempt = requireAttempt(store, decision.attemptId);
    addInboxEvent(store, attempt, 'owner-answer', `The owner answered Decision ${decision.id}.`, now);
    refreshRun(store, decision.runId, now);
    await writeStore(store);
    return structuredClone(decision);
  });
}

export async function listKingDecisionRequests(
  options: { pendingOnly?: boolean } = {}
): Promise<KingDecisionRequest[]> {
  const decisions = (await readKingWorkflowStore()).decisions;
  return structuredClone(
    options.pendingOnly ? decisions.filter((decision) => decision.status === 'pending') : decisions.slice(-200)
  );
}

export async function listKingInbox(options: { pendingOnly?: boolean } = {}): Promise<KingInboxEvent[]> {
  const inbox = (await readKingWorkflowStore()).inbox;
  return structuredClone(
    options.pendingOnly
      ? inbox.filter((event) => event.acknowledgedAt === null).slice(0, MAX_LISTED_INBOX_EVENTS)
      : inbox.slice(-MAX_LISTED_INBOX_EVENTS)
  );
}

export async function acknowledgeKingInbox(ids: string[], now = Date.now()): Promise<KingInboxEvent[]> {
  return withMutation(async () => {
    const normalizedIds = new Set(normalizeList(ids, 'ids'));
    const store = await readKingWorkflowStore();
    const updated: KingInboxEvent[] = [];
    for (const event of store.inbox) {
      if (normalizedIds.has(event.id) && event.acknowledgedAt === null) {
        event.acknowledgedAt = now;
        updated.push(event);
      }
    }
    await writeStore(store);
    return structuredClone(updated);
  });
}

export async function markKingInboxNotified(ids: string[], now = Date.now()): Promise<KingInboxEvent[]> {
  return withMutation(async () => {
    const normalizedIds = new Set(normalizeList(ids, 'ids'));
    const store = await readKingWorkflowStore();
    const updated: KingInboxEvent[] = [];
    for (const event of store.inbox) {
      if (normalizedIds.has(event.id) && event.notifiedAt === null) {
        event.notifiedAt = now;
        updated.push(event);
      }
    }
    if (updated.length > 0) await writeStore(store);
    return structuredClone(updated);
  });
}

export async function readKingWorkflowSummary(): Promise<KingWorkflowSummary> {
  const store = await readKingWorkflowStore();
  const pendingDecisions = store.decisions.filter((decision) => decision.status === 'pending').length;
  return {
    activeRuns: store.runs.filter((run) => run.status === 'active' || run.status === 'needs-owner').length,
    activeTasks: store.tasks.filter((task) => !['completed', 'blocked', 'failed'].includes(task.status)).length,
    queuedAttempts: store.attempts.filter((attempt) => attempt.status === 'queued').length,
    needsOwner: store.attempts.filter((attempt) => attempt.status === 'needs-owner').length + pendingDecisions,
    pendingDecisions,
    pendingInbox: store.inbox.filter((event) => event.acknowledgedAt === null).length,
    recentInbox: structuredClone(store.inbox.slice(-20).reverse()),
  };
}
