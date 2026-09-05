import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorHasCode } from '~/lib/server/path-policy.ts';
import {
  VAMPIRE_AGENT_GUIDES_DIRECTORY,
  vampireAgentSupportPath,
  vampireStateDirectory,
} from '~/lib/server/state-path.ts';
import { BACKGROUND_COMMAND_MAX_LENGTH, MAX_FAVORITE_COMMANDS } from '~/lib/shared/contracts/workspace-store.ts';
import { readWorkspaceStore, withWorkspaceStoreMutation, writeWorkspaceStore } from './workspace-store.server.ts';
import {
  MAX_PENDING_WORKSPACE_BACKGROUND_REQUESTS,
  pendingWorkspaceBackgroundRequestCount,
  WORKSPACE_BACKGROUND_REQUEST_DIRECTORY_NAME,
  workspaceBackgroundRequestKey,
} from './workspace-background-request-files.server.ts';

const GUIDE_FILE_NAME = 'workspace-background.md';
const APPLY_FILE_NAME = 'apply-workspace-background.mjs';
const REQUEST_VERSION = 1;
const MAX_REQUEST_FILE_BYTES = 128 * 1024;

export type WorkspaceBackgroundMutationErrorReason = 'not-found' | 'invalid-input' | 'conflict' | 'limit';

export class WorkspaceBackgroundMutationError extends Error {
  readonly reason: WorkspaceBackgroundMutationErrorReason;

  constructor(reason: WorkspaceBackgroundMutationErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

type WorkspaceBackgroundOperation = {
  add: string[];
  remove: string[];
};

type WorkspaceBackgroundRequest = {
  version: typeof REQUEST_VERSION;
  workspaceId: string;
  requestId: string;
  preparedAt: number;
  currentFavoriteCommands: string[];
  operation: WorkspaceBackgroundOperation;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 8_640_000_000_000_000;
}

function isEnvironmentReference(value: string): boolean {
  const unquoted =
    value.length >= 2 &&
    ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))
      ? value.slice(1, -1)
      : value;
  return /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(unquoted);
}

export function backgroundCommandContainsInlineSecret(command: string): boolean {
  const sensitiveName =
    /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY|SECRET_KEY|CLIENT_SECRET)$/i;
  const assignments = /(?:^|[\s;&|])(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|]+)/g;
  for (const match of command.matchAll(assignments)) {
    if (sensitiveName.test(match[1] ?? '') && !isEnvironmentReference(match[2] ?? '')) return true;
  }
  const options =
    /(?:^|\s)--(?:token|secret|password|passwd|api-key|access-key|client-secret)(?:=|\s+)("[^"]*"|'[^']*'|[^\s;&|]+)/gi;
  for (const match of command.matchAll(options)) {
    if (!isEnvironmentReference(match[1] ?? '')) return true;
  }
  if (/[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@/i.test(command)) return true;
  return /(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+(?!\$|["']\$)/i.test(command);
}

function normalizeCommand(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new WorkspaceBackgroundMutationError('invalid-input', `${label} must contain only command strings.`);
  }
  const command = value.trim();
  if (command !== value || !command || command.length > BACKGROUND_COMMAND_MAX_LENGTH || /[\0\r\n\t]/.test(command)) {
    throw new WorkspaceBackgroundMutationError(
      'invalid-input',
      `${label} commands must be trimmed, single-line values up to ${BACKGROUND_COMMAND_MAX_LENGTH.toLocaleString('en-US')} characters.`
    );
  }
  if (backgroundCommandContainsInlineSecret(command)) {
    throw new WorkspaceBackgroundMutationError(
      'invalid-input',
      `${label} contains a command with an inline secret. Use an environment reference without storing the value.`
    );
  }
  return command;
}

function normalizeCommandList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_FAVORITE_COMMANDS) {
    throw new WorkspaceBackgroundMutationError(
      'invalid-input',
      `${label} must contain at most ${MAX_FAVORITE_COMMANDS} commands.`
    );
  }
  const commands = value.map((command) => normalizeCommand(command, label));
  if (new Set(commands).size !== commands.length) {
    throw new WorkspaceBackgroundMutationError('invalid-input', `${label} must not contain duplicate commands.`);
  }
  return commands;
}

function normalizeOperation(value: unknown, currentFavoriteCommands: string[]): WorkspaceBackgroundOperation {
  if (!isRecord(value)) {
    throw new WorkspaceBackgroundMutationError('invalid-input', 'operation must contain add and remove arrays.');
  }
  const add = normalizeCommandList(value.add, 'operation.add');
  const remove = normalizeCommandList(value.remove, 'operation.remove');
  if (add.length === 0 && remove.length === 0) {
    throw new WorkspaceBackgroundMutationError('invalid-input', 'operation must add or remove at least one command.');
  }
  const current = new Set(currentFavoriteCommands);
  if (add.some((command) => current.has(command))) {
    throw new WorkspaceBackgroundMutationError('invalid-input', 'operation.add contains an already saved command.');
  }
  if (remove.some((command) => !current.has(command))) {
    throw new WorkspaceBackgroundMutationError(
      'invalid-input',
      'operation.remove contains a command outside the snapshot.'
    );
  }
  const removeSet = new Set(remove);
  if (add.some((command) => removeSet.has(command))) {
    throw new WorkspaceBackgroundMutationError('invalid-input', 'The same command cannot be added and removed.');
  }
  if (currentFavoriteCommands.length - remove.length + add.length > MAX_FAVORITE_COMMANDS) {
    throw new WorkspaceBackgroundMutationError(
      'limit',
      `A workspace can save up to ${MAX_FAVORITE_COMMANDS} favorite commands.`
    );
  }
  return { add, remove };
}

function parseRequest(value: unknown): WorkspaceBackgroundRequest {
  if (
    !isRecord(value) ||
    value.version !== REQUEST_VERSION ||
    typeof value.workspaceId !== 'string' ||
    !value.workspaceId ||
    typeof value.requestId !== 'string' ||
    !/^[a-zA-Z0-9-]{1,128}$/.test(value.requestId) ||
    !isTimestamp(value.preparedAt)
  ) {
    throw new WorkspaceBackgroundMutationError('invalid-input', 'Invalid Background request envelope.');
  }
  const currentFavoriteCommands = normalizeCommandList(value.currentFavoriteCommands, 'currentFavoriteCommands');
  return {
    version: REQUEST_VERSION,
    workspaceId: value.workspaceId,
    requestId: value.requestId,
    preparedAt: value.preparedAt,
    currentFavoriteCommands,
    operation: normalizeOperation(value.operation, currentFavoriteCommands),
  };
}

function nextFavoriteCommands(snapshot: string[], operation: WorkspaceBackgroundOperation): string[] {
  const removed = new Set(operation.remove);
  return [...snapshot.filter((command) => !removed.has(command)), ...operation.add];
}

function equalCommands(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((command, index) => command === right[index]);
}

async function applyWorkspaceBackgroundRequest(request: WorkspaceBackgroundRequest): Promise<string[]> {
  return withWorkspaceStoreMutation(async () => {
    const state = await readWorkspaceStore();
    const index = state.workspaces.findIndex((workspace) => workspace.id === request.workspaceId);
    if (index < 0) throw new WorkspaceBackgroundMutationError('not-found', 'Workspace was not found.');
    const stored = state.workspaces[index];
    const favoriteCommands = nextFavoriteCommands(request.currentFavoriteCommands, request.operation);
    if (equalCommands(stored.favoriteCommands, favoriteCommands)) return stored.favoriteCommands;
    if (!equalCommands(stored.favoriteCommands, request.currentFavoriteCommands)) {
      throw new WorkspaceBackgroundMutationError(
        'conflict',
        'Favorite commands changed after this request was prepared. Ask the agent again with a fresh snapshot.'
      );
    }
    const workspaces = [...state.workspaces];
    workspaces[index] = { ...stored, favoriteCommands };
    await writeWorkspaceStore({ ...state, workspaces });
    return favoriteCommands;
  });
}

function backgroundGuide(): string {
  return `# Vampire workspace Background agent guide

Manage saved Background commands by editing the supplied draft JSON file. Preserve its version, workspaceId, requestId, preparedAt, and currentFavoriteCommands fields. Edit only the operation field:

\`\`\`json
{
  "add": ["pnpm dev"],
  "remove": []
}
\`\`\`

Follow these rules:

- Preserve existing commands unless the user explicitly asks to remove or clean them up.
- Do not add a command already present in currentFavoriteCommands.
- Add only commands intended to stay running or to be restarted frequently, such as a development server or test watcher.
- Exclude installation, one-time builds, deployment, migration, deletion, and other destructive commands by default.
- Never store a secret value. A command may refer to an environment variable, but must not embed a token, password, key, or authenticated URL.
- If a command is uncertain, do not add it. Report it as a candidate in your terminal response instead.
- Unless the user explicitly asks for more, add only a small number of commands.

After editing, run the exact apply command supplied by Vampire. It validates and stages the request atomically. The running server applies a valid staged request to the workspace's Background favorites. Saving a favorite never runs the command. Do not edit Vampire's registry or workspace state files, and do not restart Vampire.
`;
}

function backgroundApplyScript(): string {
  return `#!/usr/bin/env node
import { link, lstat, readFile, unlink, writeFile } from 'node:fs/promises';

const [draftPath, readyPath] = process.argv.slice(2);
if (!draftPath || !readyPath) throw new Error('Provide the Background draft and destination paths.');
const details = await lstat(draftPath);
if (!details.isFile() || details.isSymbolicLink() || details.size > ${MAX_REQUEST_FILE_BYTES}) throw new Error('The Background draft must be a bounded regular file.');
const request = JSON.parse(await readFile(draftPath, 'utf8'));
const fail = (message) => { throw new Error(message); };
const record = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const environmentReference = (value) => {
  const unquoted = value.length >= 2 && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) ? value.slice(1, -1) : value;
  return /^\\$(?:[A-Za-z_][A-Za-z0-9_]*|\\{[A-Za-z_][A-Za-z0-9_]*\\})$/.test(unquoted);
};
const containsSecret = (command) => {
  const sensitiveName = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY|SECRET_KEY|CLIENT_SECRET)$/i;
  const assignments = /(?:^|[\\s;&|])(?:export\\s+)?([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\\s;&|]+)/g;
  for (const match of command.matchAll(assignments)) if (sensitiveName.test(match[1] ?? '') && !environmentReference(match[2] ?? '')) return true;
  const options = /(?:^|\\s)--(?:token|secret|password|passwd|api-key|access-key|client-secret)(?:=|\\s+)("[^"]*"|'[^']*'|[^\\s;&|]+)/gi;
  for (const match of command.matchAll(options)) if (!environmentReference(match[1] ?? '')) return true;
  if (/[a-z][a-z0-9+.-]*:\\/\\/[^/\\s:@]+:[^@\\s/]+@/i.test(command)) return true;
  return /(?:authorization|proxy-authorization)\\s*:\\s*(?:bearer|basic)\\s+(?!\\$|["']\\$)/i.test(command);
};
const commandList = (value, label) => {
  if (!Array.isArray(value) || value.length > ${MAX_FAVORITE_COMMANDS}) fail(label + ' must be a bounded array.');
  const commands = value.map((command) => {
    if (typeof command !== 'string' || command !== command.trim() || !command || command.length > ${BACKGROUND_COMMAND_MAX_LENGTH} || /[\\0\\r\\n\\t]/.test(command)) fail(label + ' contains an invalid command.');
    if (containsSecret(command)) fail(label + ' contains an inline secret.');
    return command;
  });
  if (new Set(commands).size !== commands.length) fail(label + ' contains duplicate commands.');
  return commands;
};
if (!record(request) || request.version !== ${REQUEST_VERSION} || typeof request.workspaceId !== 'string' || !request.workspaceId || typeof request.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(request.requestId) || !timestamp(request.preparedAt)) fail('Invalid Background request envelope.');
const current = commandList(request.currentFavoriteCommands, 'currentFavoriteCommands');
if (!record(request.operation)) fail('operation must contain add and remove arrays.');
const add = commandList(request.operation.add, 'operation.add');
const remove = commandList(request.operation.remove, 'operation.remove');
if (add.length === 0 && remove.length === 0) fail('operation must add or remove at least one command.');
const currentSet = new Set(current);
if (add.some((command) => currentSet.has(command))) fail('operation.add contains an already saved command.');
if (remove.some((command) => !currentSet.has(command))) fail('operation.remove contains a command outside the snapshot.');
const removeSet = new Set(remove);
if (add.some((command) => removeSet.has(command))) fail('The same command cannot be added and removed.');
if (current.length - remove.length + add.length > ${MAX_FAVORITE_COMMANDS}) fail('The operation exceeds the favorite command limit.');
const temporaryPath = readyPath + '.' + process.pid + '.' + Date.now() + '.tmp';
await writeFile(temporaryPath, JSON.stringify(request, null, 2) + '\\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
try { await link(temporaryPath, readyPath); } finally { await unlink(temporaryPath).catch(() => undefined); }
await unlink(draftPath).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
console.log('Workspace Background request validated and staged.');
`;
}

async function writeManagedSupportFile(path: string, content: string, mode: number): Promise<void> {
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error(`Vampire agent support path is not a regular file: ${path}`);
    }
    if ((await readFile(path, 'utf8')) === content) {
      await chmod(path, mode);
      return;
    }
  } catch (error) {
    if (!errorHasCode(error, 'ENOENT')) throw error;
  }
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, { encoding: 'utf8', mode, flag: 'wx' });
  await rename(temporaryPath, path);
  await chmod(path, mode);
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export type WorkspaceBackgroundAgentSupport = {
  requestPath: string;
  guidePath: string;
  applyPath: string;
  applyCommand: string;
};

export async function discardWorkspaceBackgroundAgentSupport(support: WorkspaceBackgroundAgentSupport): Promise<void> {
  await unlink(support.requestPath).catch((error) => {
    if (!errorHasCode(error, 'ENOENT')) throw error;
  });
}

async function assertCapacityWithoutLock(workspaceId: string): Promise<void> {
  const stored = (await readWorkspaceStore()).workspaces.find((workspace) => workspace.id === workspaceId);
  if (!stored) throw new WorkspaceBackgroundMutationError('not-found', 'Workspace was not found.');
  normalizeCommandList(stored.favoriteCommands, 'currentFavoriteCommands');
  const pendingCount = await pendingWorkspaceBackgroundRequestCount(workspaceId);
  if (pendingCount >= MAX_PENDING_WORKSPACE_BACKGROUND_REQUESTS) {
    throw new WorkspaceBackgroundMutationError(
      'limit',
      `A workspace can have up to ${MAX_PENDING_WORKSPACE_BACKGROUND_REQUESTS} pending Background agent requests.`
    );
  }
}

export async function assertWorkspaceBackgroundAgentCapacity(workspaceId: string): Promise<void> {
  await withWorkspaceStoreMutation(() => assertCapacityWithoutLock(workspaceId));
}

export async function reserveWorkspaceBackgroundAgentSupport(
  workspaceId: string,
  now = Date.now()
): Promise<WorkspaceBackgroundAgentSupport> {
  return withWorkspaceStoreMutation(async () => {
    await assertCapacityWithoutLock(workspaceId);
    return ensureWorkspaceBackgroundAgentSupport(workspaceId, now);
  });
}

export async function ensureWorkspaceBackgroundAgentSupport(
  workspaceId: string,
  now = Date.now()
): Promise<WorkspaceBackgroundAgentSupport> {
  const stored = (await readWorkspaceStore()).workspaces.find((workspace) => workspace.id === workspaceId);
  if (!stored) throw new WorkspaceBackgroundMutationError('not-found', 'Workspace was not found.');
  const currentFavoriteCommands = normalizeCommandList(stored.favoriteCommands, 'currentFavoriteCommands');
  const stateDirectory = vampireStateDirectory();
  const guideDirectory = vampireAgentSupportPath(VAMPIRE_AGENT_GUIDES_DIRECTORY);
  const requestDirectory = join(stateDirectory, WORKSPACE_BACKGROUND_REQUEST_DIRECTORY_NAME);
  const key = workspaceBackgroundRequestKey(workspaceId);
  const requestId = randomUUID();
  const requestPath = join(requestDirectory, `${key}.${requestId}.draft.json`);
  const readyPath = join(requestDirectory, `${key}.${requestId}.ready.json`);
  const guidePath = join(guideDirectory, GUIDE_FILE_NAME);
  const applyPath = join(guideDirectory, APPLY_FILE_NAME);
  await Promise.all([
    mkdir(guideDirectory, { recursive: true, mode: 0o700 }),
    mkdir(requestDirectory, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([chmod(guideDirectory, 0o700), chmod(requestDirectory, 0o700)]);
  await Promise.all([
    writeManagedSupportFile(guidePath, backgroundGuide(), 0o600),
    writeManagedSupportFile(applyPath, backgroundApplyScript(), 0o700),
  ]);
  await writeFile(
    requestPath,
    `${JSON.stringify(
      {
        version: REQUEST_VERSION,
        workspaceId,
        requestId,
        preparedAt: now,
        currentFavoriteCommands,
        operation: null,
      },
      null,
      2
    )}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' }
  );
  return {
    requestPath,
    guidePath,
    applyPath,
    applyCommand: `node ${shellArgument(applyPath)} ${shellArgument(requestPath)} ${shellArgument(readyPath)}`,
  };
}

export type WorkspaceBackgroundAgentImport = {
  requestPath: string;
  status: 'imported' | 'rejected';
  error?: string;
};

export async function importWorkspaceBackgroundAgentRequests(): Promise<WorkspaceBackgroundAgentImport[]> {
  const directory = join(vampireStateDirectory(), WORKSPACE_BACKGROUND_REQUEST_DIRECTORY_NAME);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (errorHasCode(error, 'ENOENT')) return [];
    throw error;
  }
  const results: WorkspaceBackgroundAgentImport[] = [];
  for (const entry of entries.filter((name) => name.endsWith('.ready.json')).sort()) {
    const requestPath = join(directory, entry);
    try {
      const details = await lstat(requestPath);
      if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_REQUEST_FILE_BYTES) {
        throw new Error('The staged request is not a bounded regular file.');
      }
      const request = parseRequest(JSON.parse(await readFile(requestPath, 'utf8')) as unknown);
      if (entry !== `${workspaceBackgroundRequestKey(request.workspaceId)}.${request.requestId}.ready.json`) {
        throw new Error('The staged request does not belong to its workspace.');
      }
      await applyWorkspaceBackgroundRequest(request);
      const draftPath = join(
        directory,
        `${workspaceBackgroundRequestKey(request.workspaceId)}.${request.requestId}.draft.json`
      );
      await Promise.all(
        [requestPath, draftPath].map((path) =>
          unlink(path).catch((error) => {
            if (!errorHasCode(error, 'ENOENT')) throw error;
          })
        )
      );
      results.push({ requestPath, status: 'imported' });
    } catch (error) {
      const rejectedPath = `${requestPath}.rejected-${Date.now()}`;
      try {
        await rename(requestPath, rejectedPath);
      } catch {
        // Keep the original error as the import result even if quarantine fails.
      }
      results.push({
        requestPath,
        status: 'rejected',
        error: error instanceof Error ? error.message : 'The Background request could not be imported.',
      });
    }
  }
  return results;
}
