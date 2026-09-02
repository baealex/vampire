import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { errorHasCode } from '~/lib/server/path-policy.ts';
import { vampireStateDirectory } from '~/lib/server/state-path.ts';

export const WORKSPACE_AUTOMATION_REQUEST_DIRECTORY_NAME = 'agent-support/requests/automations';
export const WORKSPACE_AUTOMATION_DRAFT_RESERVATION_MS = 24 * 60 * 60_000;

export function workspaceAutomationRequestKey(workspaceId: string): string {
  return createHash('sha256').update(workspaceId).digest('hex').slice(0, 24);
}

function requestEntry(workspaceId: string, entry: string): { requestId: string; state: 'draft' | 'ready' } | undefined {
  const prefix = `${workspaceAutomationRequestKey(workspaceId)}.`;
  if (!entry.startsWith(prefix)) return undefined;
  const match = entry.slice(prefix.length).match(/^([a-zA-Z0-9-]{1,128})\.(draft|ready)\.json$/);
  if (!match) return undefined;
  return { requestId: match[1], state: match[2] as 'draft' | 'ready' };
}

async function pendingWorkspaceAutomationRequests(
  workspaceId: string,
  now: number
): Promise<Map<string, Set<'draft' | 'ready'>>> {
  const directory = join(vampireStateDirectory(), WORKSPACE_AUTOMATION_REQUEST_DIRECTORY_NAME);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (errorHasCode(error, 'ENOENT')) return new Map();
    throw error;
  }
  const requests = new Map<string, Set<'draft' | 'ready'>>();
  for (const entry of entries) {
    const parsed = requestEntry(workspaceId, entry);
    if (!parsed) continue;
    const states = requests.get(parsed.requestId) ?? new Set<'draft' | 'ready'>();
    states.add(parsed.state);
    requests.set(parsed.requestId, states);
  }
  for (const [requestId, states] of requests) {
    if (!states.has('draft') || states.has('ready')) continue;
    const requestBase = `${workspaceAutomationRequestKey(workspaceId)}.${requestId}`;
    const draftPath = join(directory, `${requestBase}.draft.json`);
    try {
      const details = await lstat(draftPath);
      if (
        details.isFile() &&
        !details.isSymbolicLink() &&
        details.mtimeMs <= now - WORKSPACE_AUTOMATION_DRAFT_RESERVATION_MS
      ) {
        const expiredPath = join(directory, `${requestBase}.expired-${process.pid}-${now}.json`);
        try {
          await rename(draftPath, expiredPath);
        } catch (error) {
          if (!errorHasCode(error, 'ENOENT')) throw error;
        }
        let readyExists = false;
        try {
          await lstat(join(directory, `${requestBase}.ready.json`));
          readyExists = true;
        } catch (error) {
          if (!errorHasCode(error, 'ENOENT')) throw error;
        }
        await unlink(expiredPath).catch((error) => {
          if (!errorHasCode(error, 'ENOENT')) throw error;
        });
        if (!readyExists) requests.delete(requestId);
      }
    } catch (error) {
      if (!errorHasCode(error, 'ENOENT')) throw error;
      try {
        await lstat(join(directory, `${requestBase}.ready.json`));
      } catch (readyError) {
        if (errorHasCode(readyError, 'ENOENT')) requests.delete(requestId);
        else throw readyError;
      }
    }
  }
  return requests;
}

export async function pendingWorkspaceAutomationRequestCount(workspaceId: string, now = Date.now()): Promise<number> {
  return (await pendingWorkspaceAutomationRequests(workspaceId, now)).size;
}

async function requestReservesCreateSlot(
  workspaceId: string,
  requestId: string,
  states: Set<'draft' | 'ready'>
): Promise<boolean> {
  const state = states.has('ready') ? 'ready' : 'draft';
  const path = join(
    vampireStateDirectory(),
    WORKSPACE_AUTOMATION_REQUEST_DIRECTORY_NAME,
    `${workspaceAutomationRequestKey(workspaceId)}.${requestId}.${state}.json`
  );
  try {
    const request = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!request || typeof request !== 'object' || Array.isArray(request)) return true;
    const envelope = request as Record<string, unknown>;
    if (envelope.version === 1) return true;
    if (envelope.version !== 2) return true;
    const operation = envelope.operation;
    return Boolean(
      operation &&
        typeof operation === 'object' &&
        !Array.isArray(operation) &&
        (operation as Record<string, unknown>).type === 'create'
    );
  } catch (error) {
    if (errorHasCode(error, 'ENOENT')) return false;
    // A partially edited or malformed request must not let a competing manual
    // create consume the slot before the request is validated or rejected.
    return true;
  }
}

export async function pendingWorkspaceAutomationCreateRequestCount(
  workspaceId: string,
  throughRequestId?: string,
  now = Date.now()
): Promise<number> {
  const requests = await pendingWorkspaceAutomationRequests(workspaceId, now);
  let count = 0;
  for (const [requestId, states] of [...requests].sort(([left], [right]) => left.localeCompare(right))) {
    if (throughRequestId !== undefined && requestId.localeCompare(throughRequestId) > 0) continue;
    if (await requestReservesCreateSlot(workspaceId, requestId, states)) count += 1;
  }
  return count;
}

export async function prepareWorkspaceAutomationRequestRemoval(workspaceId: string): Promise<() => Promise<void>> {
  const directory = join(vampireStateDirectory(), WORKSPACE_AUTOMATION_REQUEST_DIRECTORY_NAME);
  let paths: string[];
  try {
    paths = (await readdir(directory))
      .filter((entry) => entry.startsWith(`${workspaceAutomationRequestKey(workspaceId)}.`))
      .map((entry) => join(directory, entry));
  } catch (error) {
    if (errorHasCode(error, 'ENOENT')) return async () => undefined;
    throw error;
  }
  for (const path of paths) {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error(`Vampire automation request path is not a regular file: ${path}`);
    }
  }
  return async () => {
    await Promise.all(
      paths.map((path) =>
        unlink(path).catch((error) => {
          if (!errorHasCode(error, 'ENOENT')) throw error;
        })
      )
    );
  };
}
