import { spawn } from 'node:child_process';
import {
  captureRepositoryFingerprint,
  repositoryChangeKey,
  type RepositoryFingerprint,
} from '~/lib/features/repository/server/repository-fingerprint.server.ts';
import {
  readRepositoryDiff,
  readRepositoryHeadRevision,
  readRepositorySnapshot,
  readGitCheckoutIdentity,
  readWorkspaceDirectory,
  readWorkspaceFile,
} from '~/lib/features/repository/server/repository.server.ts';
import {
  acknowledgeKingInbox,
  createKingDecisionRequest,
  createKingAttempt,
  createKingRun,
  createKingTask,
  decideKingAttempt,
  listKingDecisionRequests,
  listKingInbox,
  listKingRuns,
  readKingAttempt,
  readKingRun,
  readKingTask,
  readKingWorkflowSummary,
  recordKingAttemptVerification,
} from '~/lib/features/workspace/server/king-workflow-store.server.ts';
import { KING_CONTRACT_REVISION } from '~/lib/features/workspace/server/king-workspace.server.ts';
import {
  isAgentProcessLabel,
  readWorkspaceAgentStates,
} from '~/lib/features/workspace/server/workspace-agent-activity.server.ts';
import type {
  KingAttempt,
  KingAttemptBaseline,
  KingAttemptVerification,
  KingControlRequest,
  KingControlResponse,
  KingCreateRunInput,
  KingCreateTaskInput,
  KingVerificationCommandResult,
} from '~/lib/shared/contracts/king-workflow.ts';
import type { RepositoryChange, RepositorySnapshot } from '~/lib/shared/contracts/repository.ts';
import type { ManagedWorkspace } from './workspace-registry.server.ts';
import {
  findManagedWorkspace,
  findManagedWorkspaceNote,
  listManagedWorkspaces,
  requestManagedWorkspaceKingControl,
} from './workspace-registry.server.ts';

const MAX_VERIFICATION_OUTPUT_BYTES = 64 * 1024;
const MAX_WORKSPACE_FILE_BYTES = 256 * 1024;
const VERIFICATION_TIMEOUT_MS = 5 * 60_000;
const MAX_REQUEST_ID_LENGTH = 200;

export type KingControlDependencies = {
  listWorkspaces: typeof listManagedWorkspaces;
  findWorkspace: typeof findManagedWorkspace;
  findWorkspaceNote: typeof findManagedWorkspaceNote;
  readAgentStates: typeof readWorkspaceAgentStates;
  readSnapshot: typeof readRepositorySnapshot;
  readHeadRevision: typeof readRepositoryHeadRevision;
  readDirectory: typeof readWorkspaceDirectory;
  readFile: typeof readWorkspaceFile;
  readDiff: typeof readRepositoryDiff;
  readCheckoutIdentity: typeof readGitCheckoutIdentity;
  requestWorkspaceControl: typeof requestManagedWorkspaceKingControl;
  createRun: typeof createKingRun;
  createTask: typeof createKingTask;
  createAttempt: typeof createKingAttempt;
  listRuns: typeof listKingRuns;
  readRun: typeof readKingRun;
  readTask: typeof readKingTask;
  readAttempt: typeof readKingAttempt;
  readSummary: typeof readKingWorkflowSummary;
  listInbox: typeof listKingInbox;
  acknowledgeInbox: typeof acknowledgeKingInbox;
  recordVerification: typeof recordKingAttemptVerification;
  decideAttempt: typeof decideKingAttempt;
  createDecision: typeof createKingDecisionRequest;
  listDecisions: typeof listKingDecisionRequests;
  runVerification: (cwd: string, command: string) => Promise<KingVerificationCommandResult>;
};

const defaultDependencies: KingControlDependencies = {
  listWorkspaces: listManagedWorkspaces,
  findWorkspace: findManagedWorkspace,
  findWorkspaceNote: findManagedWorkspaceNote,
  readAgentStates: readWorkspaceAgentStates,
  readSnapshot: readRepositorySnapshot,
  readHeadRevision: readRepositoryHeadRevision,
  readDirectory: readWorkspaceDirectory,
  readFile: readWorkspaceFile,
  readDiff: readRepositoryDiff,
  readCheckoutIdentity: readGitCheckoutIdentity,
  requestWorkspaceControl: requestManagedWorkspaceKingControl,
  createRun: createKingRun,
  createTask: createKingTask,
  createAttempt: createKingAttempt,
  listRuns: listKingRuns,
  readRun: readKingRun,
  readTask: readKingTask,
  readAttempt: readKingAttempt,
  readSummary: readKingWorkflowSummary,
  listInbox: listKingInbox,
  acknowledgeInbox: acknowledgeKingInbox,
  recordVerification: recordKingAttemptVerification,
  decideAttempt: decideKingAttempt,
  createDecision: createKingDecisionRequest,
  listDecisions: listKingDecisionRequests,
  runVerification: runKingVerificationCommand,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function inputRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Control command input must be an object.');
  return value;
}

function inputString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function inputStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${label} must be a text list.`);
  }
  return value;
}

function inputOptionalString(value: unknown, label: string): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  return value.trim();
}

const SENSITIVE_WORKSPACE_DIRECTORIES = new Set(['.aws', '.git', '.gnupg', '.ssh']);
const SENSITIVE_WORKSPACE_FILE_NAMES = new Set([
  '.netrc',
  '.npmrc',
  '.pypirc',
  'credentials',
  'credentials.json',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
]);

function assertKingReadableWorkspaceFile(path: string): void {
  const normalized = path.replaceAll('\\', '/');
  const segments = normalized
    .split('/')
    .map((segment) => segment.toLowerCase())
    .filter(Boolean);
  const name = segments.at(-1) ?? '';
  if (
    segments.some((segment) => SENSITIVE_WORKSPACE_DIRECTORIES.has(segment)) ||
    SENSITIVE_WORKSPACE_FILE_NAMES.has(name) ||
    (/^\.env(?:\.|$)/.test(name) && !/^\.env\.(?:example|sample|template)$/.test(name)) ||
    /\.(?:key|pem|p12|pfx)$/i.test(name)
  ) {
    throw new Error('King is not allowed to read likely secret files through the King control surface.');
  }
}

async function requireWorkspace(workspaceId: string, dependencies: KingControlDependencies): Promise<ManagedWorkspace> {
  const workspace = await dependencies.findWorkspace(workspaceId);
  if (!workspace) throw new Error(`Workspace ${workspaceId} was not found.`);
  if (!workspace.workspaceAvailable) throw new Error(`Workspace ${workspaceId} is unavailable.`);
  return workspace;
}

function assertExistingMainAgentTarget(workspace: ManagedWorkspace): void {
  if (workspace.workspaceKind === 'king') throw new Error('King cannot assign project work to itself.');
  if (workspace.state !== 'running') {
    throw new Error(`Workspace ${workspace.id} is stopped. Open it manually before using it with King.`);
  }
  const mainTerminal =
    workspace.terminals.find((terminal) => terminal.terminalKind === 'main') ?? workspace.terminals[0];
  const process = mainTerminal?.foregroundProcess ?? workspace.foregroundProcess;
  if (process?.kind !== 'command' || !isAgentProcessLabel(process.label)) {
    throw new Error(
      `Workspace ${workspace.id} has no recognized main agent. Start Codex or Claude manually before delegating it to King.`
    );
  }
}

function summarizeWorkspace(workspace: ManagedWorkspace, agentState: unknown): Record<string, unknown> {
  return {
    id: workspace.id,
    label: workspace.workspaceKind === 'king' ? 'King' : workspace.workspaceLabel || workspace.cwd,
    kind: workspace.workspaceKind ?? 'directory',
    cwd: workspace.cwd,
    repositoryPath: workspace.repositoryPath ?? null,
    worktreeBranch: workspace.worktreeBranch ?? null,
    checkoutKey: workspace.checkoutKey ?? null,
    kingControl: workspace.kingControl ?? {
      state: 'manual',
      reason: '',
      requestedAt: null,
      changedAt: null,
      lastAction: null,
      handoffSnapshot: null,
    },
    state: workspace.state,
    agentState,
    notePreview: workspace.notePreview,
    startupProfileId: workspace.startupProfileId,
    workspaceAvailable: workspace.workspaceAvailable,
    isGitRepository: workspace.isGitRepository,
    foregroundProcess: workspace.foregroundProcess,
    terminals: workspace.terminals.map((terminal) => ({
      id: terminal.id,
      index: terminal.index,
      state: terminal.state,
      foregroundProcess: terminal.foregroundProcess,
    })),
  };
}

async function listWorkspaceControlData(dependencies: KingControlDependencies): Promise<Record<string, unknown>> {
  const workspaces = await dependencies.listWorkspaces();
  const agentStates = await dependencies.readAgentStates(workspaces);
  return {
    workspaces: workspaces.map((workspace) => summarizeWorkspace(workspace, agentStates.get(workspace.id) ?? null)),
  };
}

async function inspectWorkspace(
  workspaceId: string,
  dependencies: KingControlDependencies
): Promise<Record<string, unknown>> {
  const workspace = await dependencies.findWorkspace(workspaceId);
  if (!workspace) throw new Error(`Workspace ${workspaceId} was not found.`);
  const agentStates = await dependencies.readAgentStates([workspace]);
  const [note, repository, headRevision] = await Promise.all([
    dependencies.findWorkspaceNote(workspaceId),
    dependencies.readSnapshot(workspace.cwd),
    dependencies.readHeadRevision(workspace.cwd),
  ]);
  return {
    workspace: summarizeWorkspace(workspace, agentStates.get(workspace.id) ?? null),
    note: note ?? '',
    repository,
    headRevision,
  };
}

async function showRunControlData(
  runId: string,
  dependencies: KingControlDependencies
): Promise<Record<string, unknown>> {
  const detail = await dependencies.readRun(runId);
  return {
    run: detail.run,
    tasks: detail.tasks,
    decisions: detail.decisions,
    attempts: detail.attempts.map((attempt) => ({
      id: attempt.id,
      taskId: attempt.taskId,
      workspaceId: attempt.workspaceId,
      status: attempt.status,
      deliveryTarget: attempt.deliveryTarget,
      createdAt: attempt.createdAt,
      updatedAt: attempt.updatedAt,
      startedAt: attempt.startedAt,
      resultSubmittedAt: attempt.resultSubmittedAt,
      result: attempt.result
        ? {
            status: attempt.result.status,
            summary: attempt.result.summary,
            changedPaths: attempt.result.changedPaths,
            blockers: attempt.result.blockers,
            plan: attempt.result.plan
              ? {
                  candidateWorkspaceId: attempt.result.plan.candidateWorkspaceId,
                  recommendation: attempt.result.plan.recommendation,
                  confidence: attempt.result.plan.confidence,
                  summary: attempt.result.plan.summary,
                  questions: attempt.result.plan.questions,
                  risks: attempt.result.plan.risks,
                  proposedTaskCount: attempt.result.plan.proposedTasks.length,
                }
              : null,
          }
        : null,
      verification: attempt.verification
        ? {
            outcome: attempt.verification.outcome,
            checkedAt: attempt.verification.checkedAt,
            attemptChangePaths: attempt.verification.attemptChangePaths,
            unexpectedPaths: attempt.verification.unexpectedPaths,
            headRevisionChanged: attempt.verification.headRevisionChanged,
            commands: attempt.verification.commands.map((command) => ({
              command: command.command,
              outcome: command.outcome,
              exitCode: command.exitCode,
              durationMs: command.durationMs,
            })),
            reasons: attempt.verification.reasons,
          }
        : null,
      verdict: attempt.verdict,
    })),
  };
}

function tokenizeVerificationCommand(command: string): string[] {
  if (!command || command.length > 1_000 || /[\0\r\n;&|<>`]/.test(command) || command.includes('$(')) {
    throw new Error('Verification command contains unsupported shell syntax.');
  }
  const tokens: string[] = [];
  let token = '';
  let quote: 'single' | 'double' | null = null;
  let escaping = false;
  for (const character of command.trim()) {
    if (escaping) {
      token += character;
      escaping = false;
      continue;
    }
    if (character === '\\' && quote !== 'single') {
      escaping = true;
      continue;
    }
    if (character === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single';
      continue;
    }
    if (character === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double';
      continue;
    }
    if (/\s/.test(character) && quote === null) {
      if (token) tokens.push(token);
      token = '';
      continue;
    }
    token += character;
  }
  if (escaping || quote !== null) throw new Error('Verification command has an unfinished escape or quote.');
  if (token) tokens.push(token);
  if (tokens.length === 0 || tokens.length > 100) throw new Error('Verification command is empty or too complex.');
  return tokens;
}

const SAFE_PACKAGE_SCRIPT_PATTERN =
  /^(?:(?:test|check|lint|typecheck|type-check|verify|validate|build)(?::[a-z0-9][a-z0-9._-]*)?|format:check)$/i;

function assertSafePackageScript(executable: string, script: string | undefined): void {
  if (!script || !SAFE_PACKAGE_SCRIPT_PATTERN.test(script)) {
    throw new Error(`${executable} must name an allowlisted verification script.`);
  }
}

function assertAllowedVerificationCommand(tokens: string[]): void {
  const [executable, action, ...rest] = tokens;
  if (!executable || !action) throw new Error('Verification command must name an executable and check.');
  if (executable === 'pnpm') {
    assertSafePackageScript(executable, action === 'run' ? rest[0] : action);
    return;
  }
  if (executable === 'npm') {
    if (action === 'test') return;
    if (action === 'run') assertSafePackageScript(executable, rest[0]);
    else throw new Error('npm verification must use test or an allowlisted run script.');
    return;
  }
  if (executable === 'yarn') {
    assertSafePackageScript(executable, action === 'run' ? rest[0] : action);
    return;
  }
  if (executable === 'bun') {
    if (action === 'test') return;
    if (action === 'run') assertSafePackageScript(executable, rest[0]);
    else throw new Error('bun verification must use test or an allowlisted run script.');
    return;
  }
  if (executable === 'cargo' && ['test', 'check', 'clippy'].includes(action)) return;
  if (executable === 'go' && ['test', 'vet'].includes(action)) return;
  if (
    (executable === 'python' || executable === 'python3') &&
    action === '-m' &&
    ['pytest', 'unittest'].includes(rest[0])
  ) {
    return;
  }
  if (executable === 'pytest') return;
  if (executable === 'git' && ['diff', 'status'].includes(action)) return;
  throw new Error(`${executable} ${action} is not in the verification allowlist.`);
}

function appendLimited(target: { value: string; bytes: number }, chunk: Buffer): void {
  if (target.bytes >= MAX_VERIFICATION_OUTPUT_BYTES) return;
  const remaining = MAX_VERIFICATION_OUTPUT_BYTES - target.bytes;
  const limited = chunk.subarray(0, remaining);
  target.value += limited.toString('utf8');
  target.bytes += limited.length;
  if (chunk.length > remaining) target.value += '\n[output truncated]\n';
}

export async function runKingVerificationCommand(cwd: string, command: string): Promise<KingVerificationCommandResult> {
  const tokens = tokenizeVerificationCommand(command);
  assertAllowedVerificationCommand(tokens);
  const executable = tokens[0];
  if (!executable) throw new Error('Verification executable is missing.');
  const startedAt = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn(executable, tokens.slice(1), {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, VAMPIRE_TOKEN: undefined },
    });
    const stdout = { value: '', bytes: 0 };
    const stderr = { value: '', bytes: 0 };
    let settled = false;
    const finish = (exitCode: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) appendLimited(stderr, Buffer.from(`${error.message}\n`));
      resolvePromise({
        command,
        outcome: exitCode === 0 && !error ? 'passed' : 'failed',
        exitCode,
        stdout: stdout.value,
        stderr: stderr.value,
        durationMs: Date.now() - startedAt,
      });
    };
    child.stdout.on('data', (chunk: Buffer) => appendLimited(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => appendLimited(stderr, chunk));
    child.once('error', (error) => finish(null, error));
    child.once('close', (code) => finish(code));
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
      finish(null, new Error(`Verification timed out after ${VERIFICATION_TIMEOUT_MS}ms.`));
    }, VERIFICATION_TIMEOUT_MS);
    timeout.unref();
  });
}

async function captureAttemptFingerprint(
  cwd: string,
  snapshot: RepositorySnapshot,
  dependencies: KingControlDependencies
): Promise<RepositoryFingerprint | null> {
  return captureRepositoryFingerprint(cwd, snapshot, dependencies.readDiff);
}

function addRepositoryChangePaths(paths: Set<string>, change: RepositoryChange): void {
  paths.add(change.path);
  if (change.previousPath) paths.add(change.previousPath);
}

function attemptChangePaths(
  baseline: KingAttemptBaseline,
  current: RepositorySnapshot,
  currentFingerprint: RepositoryFingerprint | null
): string[] {
  const baselineFingerprints = baseline.changeFingerprints;
  if (baselineFingerprints && currentFingerprint) {
    const baselineByKey = new Map(baselineFingerprints.map((change) => [repositoryChangeKey(change), change]));
    const currentByKey = new Map(currentFingerprint.changes.map((change) => [repositoryChangeKey(change), change]));
    const paths = new Set<string>();
    for (const key of new Set([...baselineByKey.keys(), ...currentByKey.keys()])) {
      const before = baselineByKey.get(key);
      const after = currentByKey.get(key);
      if (before?.diffHash === after?.diffHash) continue;
      if (before) addRepositoryChangePaths(paths, before);
      if (after) addRepositoryChangePaths(paths, after);
    }
    return [...paths].sort();
  }

  const baselineChanges = new Set(baseline.changes.map(repositoryChangeKey));
  const paths = new Set<string>();
  for (const change of current.changes) {
    if (!baselineChanges.has(repositoryChangeKey(change))) {
      addRepositoryChangePaths(paths, change);
    }
  }
  return [...paths].sort();
}

function pathMatchesRule(path: string, rule: string): boolean {
  return path === rule || path.startsWith(`${rule}/`);
}

function verificationOutcome(hardFailureReasons: string[], ownerReasons: string[]): KingAttemptVerification['outcome'] {
  if (hardFailureReasons.length > 0) return 'failed';
  if (ownerReasons.length > 0) return 'needs-owner';
  return 'passed';
}

async function verifyAttempt(
  attempt: KingAttempt,
  dependencies: KingControlDependencies,
  now = Date.now()
): Promise<KingAttempt> {
  if (!attempt.result || attempt.status !== 'result-submitted') {
    throw new Error(`Attempt ${attempt.id} has no Result ready for verification.`);
  }
  const [task, workspace] = await Promise.all([
    dependencies.readTask(attempt.taskId),
    dependencies.findWorkspace(attempt.workspaceId),
  ]);
  if (!workspace) throw new Error(`Workspace ${attempt.workspaceId} was not found.`);
  const commands: KingVerificationCommandResult[] = [];
  for (const command of task.verificationCommands) {
    commands.push(await dependencies.runVerification(workspace.cwd, command));
  }
  // Project checks execute repository code and may themselves change files or
  // HEAD. Capture the authoritative state after checks so those effects cannot
  // escape the verification evidence.
  const [snapshot, currentHeadRevision] = await Promise.all([
    dependencies.readSnapshot(workspace.cwd),
    dependencies.readHeadRevision(workspace.cwd),
  ]);
  const currentFingerprint = await captureAttemptFingerprint(workspace.cwd, snapshot, dependencies);
  const currentRepositoryStateHash = currentFingerprint?.repositoryStateHash ?? null;
  const changedPaths = attemptChangePaths(attempt.baseline, snapshot, currentFingerprint);
  const declaredPaths = [...new Set(attempt.result.changedPaths)].sort();
  const allowedUnexpected =
    task.allowedPaths.length === 0
      ? []
      : changedPaths.filter((path) => !task.allowedPaths.some((rule) => pathMatchesRule(path, rule)));
  const forbidden = changedPaths.filter((path) => task.forbiddenPaths.some((rule) => pathMatchesRule(path, rule)));
  const undeclared = changedPaths.filter((path) => !declaredPaths.includes(path));
  const nonexistent = declaredPaths.filter((path) => !changedPaths.includes(path));
  const unexpectedPaths = [...new Set([...allowedUnexpected, ...forbidden, ...undeclared, ...nonexistent])].sort();

  const hardFailureReasons: string[] = [];
  if (attempt.result.status !== 'succeeded')
    hardFailureReasons.push(`Worker Result status is ${attempt.result.status}.`);
  if (allowedUnexpected.length > 0) hardFailureReasons.push('Actual changes escaped the allowed paths.');
  if (forbidden.length > 0) hardFailureReasons.push('Actual changes touched forbidden paths.');
  if (undeclared.length > 0 || nonexistent.length > 0) {
    hardFailureReasons.push('The declared changedPaths do not match the repository state.');
  }
  if (commands.some((command) => command.outcome === 'failed'))
    hardFailureReasons.push('A verification command failed.');
  const headRevisionChanged = attempt.baseline.headRevision !== currentHeadRevision;
  if (headRevisionChanged) hardFailureReasons.push('Repository HEAD changed during the Attempt.');
  if (
    task.kind === 'analysis' &&
    attempt.baseline.dirty &&
    attempt.baseline.repositoryStateHash &&
    currentRepositoryStateHash &&
    attempt.baseline.repositoryStateHash !== currentRepositoryStateHash
  ) {
    hardFailureReasons.push('Repository diff content changed during the read-only analysis.');
  }
  const ownerReasons: string[] = [];
  if (
    attempt.baseline.dirty &&
    task.kind !== 'analysis' &&
    (!attempt.baseline.changeFingerprints || !currentFingerprint)
  ) {
    ownerReasons.push('The dirty repository baseline could not be fingerprinted for change attribution.');
  }
  if (
    attempt.baseline.dirty &&
    task.kind === 'analysis' &&
    (!attempt.baseline.repositoryStateHash || !currentRepositoryStateHash)
  ) {
    ownerReasons.push('The dirty repository baseline could not be fingerprinted for read-only verification.');
  }
  if (!snapshot.isGitRepository)
    ownerReasons.push('The workspace is not a Git repository, so Vampire cannot verify its diff.');
  if (task.kind !== 'analysis' && task.verificationCommands.length === 0) {
    ownerReasons.push('No independent verification command was declared.');
  }
  const reasons = [...hardFailureReasons, ...ownerReasons];
  const outcome = verificationOutcome(hardFailureReasons, ownerReasons);
  return dependencies.recordVerification(
    attempt.id,
    {
      outcome,
      checkedAt: now,
      actualChanges: snapshot.changes,
      attemptChangePaths: changedPaths,
      unexpectedPaths,
      baselineDirty: attempt.baseline.dirty,
      baselineHeadRevision: attempt.baseline.headRevision,
      currentHeadRevision,
      headRevisionChanged,
      commands,
      reasons,
    },
    now
  );
}

export async function verifyKingAttemptById(
  attemptId: string,
  dependencies: KingControlDependencies = defaultDependencies,
  now = Date.now()
): Promise<KingAttempt> {
  return verifyAttempt(await dependencies.readAttempt(attemptId), dependencies, now);
}

async function dispatchTask(taskId: string, dependencies: KingControlDependencies): Promise<KingAttempt> {
  const task = await dependencies.readTask(taskId);
  const workspace = await dependencies.findWorkspace(task.workspaceId);
  if (!workspace) throw new Error(`Workspace ${task.workspaceId} was not found.`);
  assertExistingMainAgentTarget(workspace);
  if (!workspace.workspaceAvailable) throw new Error(`Workspace ${workspace.id} is unavailable.`);
  if (task.kind !== 'analysis' && workspace.kingControl?.state !== 'king') {
    throw new Error(
      `Workspace ${workspace.id} is still under manual control. Request handoff with workspace control request before dispatching a change Task.`
    );
  }
  const [snapshot, headRevision, checkout] = await Promise.all([
    dependencies.readSnapshot(workspace.cwd),
    dependencies.readHeadRevision(workspace.cwd),
    dependencies.readCheckoutIdentity(workspace.cwd),
  ]);
  const fingerprint = await captureAttemptFingerprint(workspace.cwd, snapshot, dependencies);
  return dependencies.createAttempt(task.id, {
    capturedAt: Date.now(),
    workspaceLeaseKey: checkout?.checkoutKey ?? workspace.checkoutKey ?? workspace.cwd,
    isGitRepository: snapshot.isGitRepository,
    headRevision,
    changes: snapshot.changes,
    dirty: snapshot.changes.length > 0,
    repositoryStateHash: fingerprint?.repositoryStateHash ?? null,
    ...(fingerprint ? { changeFingerprints: fingerprint.changes } : {}),
  });
}

async function executeControlCommand(
  request: KingControlRequest,
  dependencies: KingControlDependencies
): Promise<unknown> {
  if (request.command === 'status') {
    return { contractRevision: KING_CONTRACT_REVISION, ...(await dependencies.readSummary()) };
  }
  if (request.command === 'workspaces.list') return listWorkspaceControlData(dependencies);
  if (request.command === 'workspace.inspect') {
    const input = inputRecord(request.input);
    return inspectWorkspace(inputString(input.workspaceId, 'workspaceId'), dependencies);
  }
  if (request.command === 'workspace.files') {
    const input = inputRecord(request.input);
    const workspace = await requireWorkspace(inputString(input.workspaceId, 'workspaceId'), dependencies);
    return dependencies.readDirectory(workspace.cwd, inputOptionalString(input.path, 'path'));
  }
  if (request.command === 'workspace.read') {
    const input = inputRecord(request.input);
    const workspace = await requireWorkspace(inputString(input.workspaceId, 'workspaceId'), dependencies);
    const path = inputString(input.path, 'path');
    assertKingReadableWorkspaceFile(path);
    const file = await dependencies.readFile(workspace.cwd, path);
    if (file.size > MAX_WORKSPACE_FILE_BYTES) {
      throw new Error(`King workspace reads are limited to ${MAX_WORKSPACE_FILE_BYTES} bytes.`);
    }
    return file;
  }
  if (request.command === 'workspace.diff') {
    const input = inputRecord(request.input);
    const workspaceId = inputString(input.workspaceId, 'workspaceId');
    const workspace = await dependencies.findWorkspace(workspaceId);
    if (!workspace) throw new Error(`Workspace ${workspaceId} was not found.`);
    return dependencies.readDiff(workspace.cwd, inputString(input.path, 'path'));
  }
  if (request.command === 'workspace.control.request') {
    const input = inputRecord(request.input);
    const workspaceId = inputString(input.workspaceId, 'workspaceId');
    const workspace = await dependencies.findWorkspace(workspaceId);
    if (!workspace) throw new Error(`Workspace ${workspaceId} was not found.`);
    assertExistingMainAgentTarget(workspace);
    return dependencies.requestWorkspaceControl(workspaceId, inputString(input.reason, 'reason'));
  }
  if (request.command === 'runs.list') return dependencies.listRuns();
  if (request.command === 'run.show') {
    const input = inputRecord(request.input);
    return showRunControlData(inputString(input.runId, 'runId'), dependencies);
  }
  if (request.command === 'run.create') {
    const input = inputRecord(request.input) as KingCreateRunInput;
    if (input.workspaceIds) {
      for (const workspaceId of inputStringArray(input.workspaceIds, 'workspaceIds')) {
        const workspace = await dependencies.findWorkspace(workspaceId);
        if (!workspace) throw new Error(`Workspace ${workspaceId} was not found.`);
        assertExistingMainAgentTarget(workspace);
      }
    }
    return dependencies.createRun(input);
  }
  if (request.command === 'task.create') {
    const input = inputRecord(request.input) as KingCreateTaskInput;
    const workspaceId = inputString(input.workspaceId, 'workspaceId');
    const workspace = await dependencies.findWorkspace(workspaceId);
    if (!workspace) throw new Error(`Workspace ${workspaceId} was not found.`);
    assertExistingMainAgentTarget(workspace);
    return dependencies.createTask(input);
  }
  if (request.command === 'attempt.dispatch') {
    const input = inputRecord(request.input);
    return dispatchTask(inputString(input.taskId, 'taskId'), dependencies);
  }
  if (request.command === 'attempt.show') {
    const input = inputRecord(request.input);
    return dependencies.readAttempt(inputString(input.attemptId, 'attemptId'));
  }
  if (request.command === 'attempt.verify') {
    const input = inputRecord(request.input);
    return verifyKingAttemptById(inputString(input.attemptId, 'attemptId'), dependencies);
  }
  if (request.command === 'decisions.list') {
    const input = request.input === undefined ? {} : inputRecord(request.input);
    return dependencies.listDecisions({ pendingOnly: input.pendingOnly === true });
  }
  if (request.command === 'decision.create') {
    const input = inputRecord(request.input);
    return dependencies.createDecision({
      attemptId: inputString(input.attemptId, 'attemptId'),
      question: inputString(input.question, 'question'),
      context: inputOptionalString(input.context, 'context'),
      options: input.options === undefined ? [] : inputStringArray(input.options, 'options'),
    });
  }
  if (request.command === 'attempt.decide') {
    const input = inputRecord(request.input);
    const outcome = input.outcome;
    const decidedBy = input.decidedBy;
    if (outcome !== 'accepted' && outcome !== 'rejected') throw new Error('outcome must be accepted or rejected.');
    if (decidedBy !== 'king' && decidedBy !== 'owner') throw new Error('decidedBy must be king or owner.');
    return dependencies.decideAttempt(inputString(input.attemptId, 'attemptId'), {
      outcome,
      reason: inputString(input.reason, 'reason'),
      decidedBy,
    });
  }
  if (request.command === 'inbox.list') {
    const input = request.input === undefined ? {} : inputRecord(request.input);
    const events = await dependencies.listInbox({ pendingOnly: input.pendingOnly === true });
    if (input.acknowledge === true && events.length > 0)
      await dependencies.acknowledgeInbox(events.map((event) => event.id));
    return events;
  }
  if (request.command === 'inbox.ack') {
    const input = inputRecord(request.input);
    return dependencies.acknowledgeInbox(inputStringArray(input.ids, 'ids'));
  }
  throw new Error(`Unsupported King control command: ${request.command}`);
}

export async function handleKingControlRequest(
  request: KingControlRequest,
  dependencies: KingControlDependencies = defaultDependencies
): Promise<KingControlResponse> {
  const id = typeof request?.id === 'string' ? request.id : '';
  if (!id || id.length > MAX_REQUEST_ID_LENGTH) return { id, ok: false, error: 'Control request id is invalid.' };
  try {
    return { id, ok: true, data: await executeControlCommand(request, dependencies) };
  } catch (error) {
    return { id, ok: false, error: error instanceof Error ? error.message : 'King control command failed.' };
  }
}
