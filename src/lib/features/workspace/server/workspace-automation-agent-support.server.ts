import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorHasCode } from '~/lib/server/path-policy.ts';
import { vampireStateDirectory } from '~/lib/server/state-path.ts';
import {
  MAX_AUTOMATION_INTERVAL_MS,
  MAX_WORKSPACE_AUTOMATIONS,
  MIN_AUTOMATION_INTERVAL_MS,
  WORKSPACE_AUTOMATION_NAME_MAX_LENGTH,
  WORKSPACE_AUTOMATION_PROMPT_MAX_LENGTH,
} from '~/lib/shared/contracts/workspace-automations.ts';
import {
  createManagedWorkspaceAutomationFromAgentRequest,
  WorkspaceAutomationMutationError,
} from './workspace-automations.server.ts';
import { readWorkspaceStore, withWorkspaceStoreMutation } from './workspace-store.server.ts';
import {
  pendingWorkspaceAutomationRequestCount,
  WORKSPACE_AUTOMATION_REQUEST_DIRECTORY_NAME,
  workspaceAutomationRequestKey,
} from './workspace-automation-request-files.server.ts';

const GUIDE_DIRECTORY_NAME = 'agent-guides';
const GUIDE_FILE_NAME = 'workspace-automation.md';
const APPLY_FILE_NAME = 'apply-workspace-automation.mjs';
const REQUEST_VERSION = 1;

function automationGuide(): string {
  return `# Vampire workspace automation agent guide

Create one automation by editing the supplied draft JSON file. Preserve its version, workspaceId, and requestId fields.

The automation object has this shape:

\`\`\`ts
type Automation = {
  name: string;   // 1..${WORKSPACE_AUTOMATION_NAME_MAX_LENGTH} characters, one line
  prompt: string; // 1..${WORKSPACE_AUTOMATION_PROMPT_MAX_LENGTH} characters
  schedule:
    | { type: 'once'; runAt: number }
    | { type: 'interval'; intervalMs: number; startAt: number }
    | {
        type: 'weekly';
        weekdays: Array<0 | 1 | 2 | 3 | 4 | 5 | 6>; // Sunday is 0
        hour: number;   // 0..23 local wall-clock hour
        minute: number; // 0..59
        timeZone: string; // IANA name such as Asia/Seoul
        startAt: number;
      };
};
\`\`\`

All timestamps are Unix milliseconds. Use \`Date.parse('ISO timestamp with offset')\` when calculating one. Intervals must be integer milliseconds from ${MIN_AUTOMATION_INTERVAL_MS} to ${MAX_AUTOMATION_INTERVAL_MS}. Weekly weekdays must be unique and non-empty.

After editing, run the exact apply command supplied by Vampire. It validates and stages the request atomically. The running server imports a valid staged request automatically; do not edit the Vampire session store or restart Vampire.
`;
}

function automationApplyScript(): string {
  return `#!/usr/bin/env node
import { link, lstat, readFile, unlink, writeFile } from 'node:fs/promises';

const [draftPath, readyPath] = process.argv.slice(2);
if (!draftPath || !readyPath) throw new Error('Provide the automation draft and destination paths.');
const details = await lstat(draftPath);
if (!details.isFile() || details.isSymbolicLink()) throw new Error('The automation draft must be a regular file.');
const request = JSON.parse(await readFile(draftPath, 'utf8'));
const fail = (message) => { throw new Error(message); };
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const schedule = request?.automation?.schedule;
if (!request || typeof request !== 'object' || Array.isArray(request) || request.version !== ${REQUEST_VERSION} || typeof request.workspaceId !== 'string' || !request.workspaceId || typeof request.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(request.requestId)) fail('Invalid automation request envelope.');
if (!request.automation || typeof request.automation !== 'object' || Array.isArray(request.automation)) fail('automation must be an object.');
const { name, prompt } = request.automation;
if (typeof name !== 'string' || !name.trim() || name.trim().length > ${WORKSPACE_AUTOMATION_NAME_MAX_LENGTH} || /[\\0\\r\\n\\t]/.test(name.trim())) fail('automation.name is invalid.');
if (typeof prompt !== 'string' || !prompt.trim() || prompt.trim().length > ${WORKSPACE_AUTOMATION_PROMPT_MAX_LENGTH} || prompt.includes('\\0')) fail('automation.prompt is invalid.');
if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) fail('automation.schedule is invalid.');
if (schedule.type === 'once') {
  if (!timestamp(schedule.runAt)) fail('schedule.runAt is invalid.');
} else if (schedule.type === 'interval') {
  if (!timestamp(schedule.startAt) || !Number.isSafeInteger(schedule.intervalMs) || schedule.intervalMs < ${MIN_AUTOMATION_INTERVAL_MS} || schedule.intervalMs > ${MAX_AUTOMATION_INTERVAL_MS}) fail('The interval schedule is invalid.');
} else if (schedule.type === 'weekly') {
  if (!timestamp(schedule.startAt) || !Array.isArray(schedule.weekdays) || schedule.weekdays.length < 1 || schedule.weekdays.length > 7 || new Set(schedule.weekdays).size !== schedule.weekdays.length || !schedule.weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) || !Number.isInteger(schedule.hour) || schedule.hour < 0 || schedule.hour > 23 || !Number.isInteger(schedule.minute) || schedule.minute < 0 || schedule.minute > 59 || typeof schedule.timeZone !== 'string' || !schedule.timeZone || schedule.timeZone.length > 100) fail('The weekly schedule is invalid.');
  try { new Intl.DateTimeFormat('en-US', { timeZone: schedule.timeZone }).format(0); } catch { fail('schedule.timeZone must be an IANA time zone.'); }
} else {
  fail('Unsupported automation schedule type.');
}
const temporaryPath = readyPath + '.' + process.pid + '.' + Date.now() + '.tmp';
await writeFile(temporaryPath, JSON.stringify(request, null, 2) + '\\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
try { await link(temporaryPath, readyPath); } finally { await unlink(temporaryPath).catch(() => undefined); }
await unlink(draftPath).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
console.log('Workspace automation request validated and staged.');
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

export type WorkspaceAutomationAgentSupport = {
  requestPath: string;
  guidePath: string;
  applyPath: string;
  applyCommand: string;
};

export async function discardWorkspaceAutomationAgentSupport(support: WorkspaceAutomationAgentSupport): Promise<void> {
  await unlink(support.requestPath).catch((error) => {
    if (!errorHasCode(error, 'ENOENT')) throw error;
  });
}

async function assertCapacityWithoutLock(workspaceId: string): Promise<void> {
  const state = await readWorkspaceStore();
  const stored = state.workspaces.find((workspace) => workspace.id === workspaceId);
  if (!stored) throw new WorkspaceAutomationMutationError('not-found', 'Workspace was not found.');
  const customCount = stored.automations.filter((automation) => automation.kind === 'custom').length;
  const pendingCount = await pendingWorkspaceAutomationRequestCount(workspaceId);
  if (customCount + pendingCount >= MAX_WORKSPACE_AUTOMATIONS) {
    throw new WorkspaceAutomationMutationError(
      'limit',
      `A workspace can save up to ${MAX_WORKSPACE_AUTOMATIONS} automations.`
    );
  }
}

export async function assertWorkspaceAutomationAgentCapacity(workspaceId: string): Promise<void> {
  await withWorkspaceStoreMutation(() => assertCapacityWithoutLock(workspaceId));
}

export async function reserveWorkspaceAutomationAgentSupport(
  workspaceId: string,
  now = Date.now()
): Promise<WorkspaceAutomationAgentSupport> {
  return withWorkspaceStoreMutation(async () => {
    await assertCapacityWithoutLock(workspaceId);
    return ensureWorkspaceAutomationAgentSupport(workspaceId, now);
  });
}

export async function ensureWorkspaceAutomationAgentSupport(
  workspaceId: string,
  now = Date.now()
): Promise<WorkspaceAutomationAgentSupport> {
  const stateDirectory = vampireStateDirectory();
  const guideDirectory = join(stateDirectory, GUIDE_DIRECTORY_NAME);
  const requestDirectory = join(stateDirectory, WORKSPACE_AUTOMATION_REQUEST_DIRECTORY_NAME);
  const key = workspaceAutomationRequestKey(workspaceId);
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
    writeManagedSupportFile(guidePath, automationGuide(), 0o600),
    writeManagedSupportFile(applyPath, automationApplyScript(), 0o700),
  ]);
  await writeFile(
    requestPath,
    `${JSON.stringify(
      {
        version: REQUEST_VERSION,
        workspaceId,
        requestId,
        automation: {
          name: '',
          prompt: '',
          schedule: { type: 'once', runAt: now + 5 * 60_000 },
        },
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

export type WorkspaceAutomationAgentImport = {
  requestPath: string;
  status: 'imported' | 'rejected';
  error?: string;
};

export async function importWorkspaceAutomationAgentRequests(): Promise<WorkspaceAutomationAgentImport[]> {
  const directory = join(vampireStateDirectory(), WORKSPACE_AUTOMATION_REQUEST_DIRECTORY_NAME);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (errorHasCode(error, 'ENOENT')) return [];
    throw error;
  }
  const results: WorkspaceAutomationAgentImport[] = [];
  for (const entry of entries.filter((name) => name.endsWith('.ready.json')).sort()) {
    const requestPath = join(directory, entry);
    try {
      const details = await lstat(requestPath);
      if (!details.isFile() || details.isSymbolicLink()) throw new Error('The staged request is not a regular file.');
      const request = JSON.parse(await readFile(requestPath, 'utf8')) as unknown;
      if (!request || typeof request !== 'object' || Array.isArray(request))
        throw new Error('Invalid request envelope.');
      const envelope = request as Record<string, unknown>;
      if (
        envelope.version !== REQUEST_VERSION ||
        typeof envelope.workspaceId !== 'string' ||
        typeof envelope.requestId !== 'string'
      ) {
        throw new Error('Invalid request envelope.');
      }
      if (entry !== `${workspaceAutomationRequestKey(envelope.workspaceId)}.${envelope.requestId}.ready.json`) {
        throw new Error('The staged request does not belong to its workspace.');
      }
      await createManagedWorkspaceAutomationFromAgentRequest(
        envelope.workspaceId,
        envelope.requestId,
        envelope.automation
      );
      const draftPath = join(
        directory,
        `${workspaceAutomationRequestKey(envelope.workspaceId)}.${envelope.requestId}.draft.json`
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
        error: error instanceof Error ? error.message : 'The automation request could not be imported.',
      });
    }
  }
  return results;
}
