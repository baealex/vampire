import type { RepositoryChange } from './repository.ts';

export const KING_WORKFLOW_VERSION = 2;
export const KING_EVENT_SCHEMA_VERSION = 1;
export const KING_RESULT_SCHEMA_VERSION = 1;

export type KingRunStatus = 'active' | 'needs-owner' | 'completed' | 'cancelled';
export type KingRunPhase =
  | 'intake'
  | 'analyzing'
  | 'needs-owner'
  | 'approved'
  | 'executing'
  | 'verifying'
  | 'completed'
  | 'cancelled';
export type KingTaskKind = 'analysis' | 'change' | 'review';
export type KingTaskStatus =
  | 'planned'
  | 'queued'
  | 'running'
  | 'result-submitted'
  | 'verified'
  | 'needs-owner'
  | 'completed'
  | 'blocked'
  | 'failed';
export type KingAttemptStatus =
  | 'queued'
  | 'delivery-uncertain'
  | 'dispatched'
  | 'working'
  | 'result-submitted'
  | 'verified'
  | 'needs-owner'
  | 'accepted'
  | 'rejected'
  | 'blocked'
  | 'failed';

export type KingRun = {
  id: string;
  title: string;
  objective: string;
  ownerRequest: string;
  workspaceIds: string[];
  planningPolicy: 'managed' | 'direct';
  phase: KingRunPhase;
  status: KingRunStatus;
  contractRevision: string;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type KingTask = {
  id: string;
  runId: string;
  workspaceId: string;
  kind: KingTaskKind;
  title: string;
  objective: string;
  background: string;
  nonGoals: string[];
  dependsOnTaskIds: string[];
  acceptanceCriteria: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  verificationCommands: string[];
  approvalPolicy: 'auto' | 'owner';
  status: KingTaskStatus;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type KingAttemptBaseline = {
  capturedAt: number;
  workspaceLeaseKey?: string;
  isGitRepository: boolean;
  headRevision: string | null;
  changes: RepositoryChange[];
  dirty: boolean;
  repositoryStateHash?: string | null;
  changeFingerprints?: Array<RepositoryChange & { diffHash: string }>;
};

export type KingAttemptDeliveryTarget = {
  tmuxSession: string;
  terminalId: string;
  agentLabel: string;
};

export type KingResultVerificationClaim = {
  command: string;
  outcome: 'passed' | 'failed' | 'not-run';
  summary?: string;
};

export type KingProposedTask = {
  workspaceId: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  verificationCommands: string[];
  approvalPolicy: 'auto' | 'owner';
};

export type KingPlanResult = {
  candidateWorkspaceId: string;
  recommendation: 'proceed' | 'clarify' | 'reject';
  confidence: number;
  summary: string;
  steps: string[];
  assumptions: string[];
  risks: string[];
  questions: string[];
  proposedTasks: KingProposedTask[];
};

export type KingAttemptResult = {
  schemaVersion: typeof KING_RESULT_SCHEMA_VERSION;
  attemptId: string;
  status: 'succeeded' | 'blocked' | 'failed';
  summary: string;
  changedPaths: string[];
  verification: KingResultVerificationClaim[];
  blockers: string[];
  plan: KingPlanResult | null;
};

export type KingAttemptStartedEvent = {
  schemaVersion: typeof KING_EVENT_SCHEMA_VERSION;
  attemptId: string;
  startedAt: number;
};

export type KingVerificationCommandResult = {
  command: string;
  outcome: 'passed' | 'failed';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type KingAttemptVerification = {
  outcome: 'passed' | 'failed' | 'needs-owner';
  checkedAt: number;
  actualChanges: RepositoryChange[];
  attemptChangePaths: string[];
  unexpectedPaths: string[];
  baselineDirty: boolean;
  baselineHeadRevision: string | null;
  currentHeadRevision: string | null;
  headRevisionChanged: boolean;
  commands: KingVerificationCommandResult[];
  reasons: string[];
};

export type KingAttemptVerdict = {
  outcome: 'accepted' | 'rejected' | 'owner-required';
  reason: string;
  decidedBy: 'vampire' | 'king' | 'owner';
  decidedAt: number;
};

export type KingAttempt = {
  id: string;
  runId: string;
  taskId: string;
  workspaceId: string;
  status: KingAttemptStatus;
  taskPacketPath: string;
  baseline: KingAttemptBaseline;
  deliveryTarget: KingAttemptDeliveryTarget | null;
  result: KingAttemptResult | null;
  verification: KingAttemptVerification | null;
  verdict: KingAttemptVerdict | null;
  startedEventHash: string | null;
  startedEventConflictHash: string | null;
  resultEventHash: string | null;
  resultEventConflictHash: string | null;
  createdAt: number;
  updatedAt: number;
  deliveryAttemptedAt: number | null;
  dispatchedAt: number | null;
  startedAt: number | null;
  resultSubmittedAt: number | null;
};

export type KingInboxEventType =
  | 'attempt-dispatched'
  | 'attempt-started'
  | 'attempt-result'
  | 'attempt-delivery-failed'
  | 'attempt-event-conflict'
  | 'attempt-interrupted'
  | 'verification-complete'
  | 'owner-required'
  | 'owner-answer'
  | 'owner-decision'
  | 'plan-approved'
  | 'task-completed';

export type KingInboxEvent = {
  id: string;
  type: KingInboxEventType;
  runId: string;
  taskId: string;
  attemptId: string;
  workspaceId: string;
  message: string;
  createdAt: number;
  notifiedAt: number | null;
  acknowledgedAt: number | null;
};

export type KingDecisionRequest = {
  id: string;
  runId: string;
  taskId: string;
  attemptId: string;
  workspaceId: string;
  question: string;
  context: string;
  options: string[];
  status: 'pending' | 'answered';
  answer: string | null;
  createdAt: number;
  answeredAt: number | null;
};

export type KingWorkflowStore = {
  version: typeof KING_WORKFLOW_VERSION;
  runs: KingRun[];
  tasks: KingTask[];
  attempts: KingAttempt[];
  decisions: KingDecisionRequest[];
  inbox: KingInboxEvent[];
};

export type KingCreateRunInput = {
  title: string;
  objective: string;
  ownerRequest?: string;
  workspaceIds?: string[];
  planningPolicy?: 'managed' | 'direct';
};

export type KingCreateTaskInput = {
  runId: string;
  workspaceId: string;
  kind?: KingTaskKind;
  title: string;
  objective: string;
  background?: string;
  nonGoals?: string[];
  dependsOnTaskIds?: string[];
  acceptanceCriteria: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  verificationCommands?: string[];
  approvalPolicy?: 'auto' | 'owner';
};

export type KingCreateDecisionInput = {
  attemptId: string;
  question: string;
  context?: string;
  options?: string[];
};

export type KingWorkflowSummary = {
  activeRuns: number;
  activeTasks: number;
  queuedAttempts: number;
  needsOwner: number;
  pendingDecisions: number;
  pendingInbox: number;
  recentInbox: KingInboxEvent[];
};

export type KingControlCommand =
  | 'status'
  | 'workspaces.list'
  | 'workspace.inspect'
  | 'workspace.files'
  | 'workspace.read'
  | 'workspace.diff'
  | 'workspace.control.request'
  | 'runs.list'
  | 'run.show'
  | 'run.create'
  | 'task.create'
  | 'attempt.dispatch'
  | 'attempt.show'
  | 'attempt.verify'
  | 'attempt.decide'
  | 'decisions.list'
  | 'decision.create'
  | 'inbox.list'
  | 'inbox.ack';

export type KingControlRequest = {
  id: string;
  command: KingControlCommand;
  input?: unknown;
};

export type KingControlResponse = { id: string; ok: true; data: unknown } | { id: string; ok: false; error: string };
