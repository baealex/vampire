import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { errorHasCode } from '~/lib/server/path-policy.ts';
import { vampireStatePath } from '~/lib/server/state-path.ts';
import {
  readStructuredWorkspaceState,
  structuredWorkspaceStateExists,
  writeStructuredWorkspaceState,
} from '~/lib/server/workspace-state-files.ts';
import {
  parseWorkspaceStore,
  WORKSPACE_STATE_VERSION,
  type StoredWorkspace,
  type WorkspaceStore,
} from '~/lib/shared/contracts/workspace-store.ts';

export {
  BACKGROUND_COMMAND_MAX_LENGTH,
  MAX_FAVORITE_COMMANDS,
  WORKSPACE_STATE_VERSION,
} from '~/lib/shared/contracts/workspace-store.ts';
export type { StoredWorkspace, WorkspaceStore } from '~/lib/shared/contracts/workspace-store.ts';

export interface WorkspaceConnection {
  tmuxSession: string;
  cwd: string;
}

type WorkspaceStoreGlobal = typeof globalThis & {
  __vampireWorkspaceStoreMutationState?: { queue: Promise<void> };
};

const storeGlobal = globalThis as WorkspaceStoreGlobal;
const mutationState = (storeGlobal.__vampireWorkspaceStoreMutationState ??= {
  queue: Promise.resolve(),
});

export async function withWorkspaceStoreMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = mutationState.queue;
  let release: () => void;
  mutationState.queue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release!();
  }
}

export async function readWorkspaceStateFile(file = vampireStatePath()): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readLegacyWorkspaceStore(file: string): Promise<WorkspaceStore> {
  try {
    return parseWorkspaceStore(await readWorkspaceStateFile(file));
  } catch (error) {
    if (errorHasCode(error, 'ENOENT'))
      return {
        version: WORKSPACE_STATE_VERSION,
        workspaces: [],
        launchProfiles: [],
        defaultStartupProfileId: null,
      };
    throw new Error('Vampire workspace registry is unreadable; refusing to overwrite it.', { cause: error });
  }
}

export async function readWorkspaceStore(file?: string): Promise<WorkspaceStore> {
  try {
    if (file === undefined && (await structuredWorkspaceStateExists())) {
      return await readStructuredWorkspaceState();
    }
    return await readLegacyWorkspaceStore(file ?? vampireStatePath());
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Vampire workspace registry is unreadable')) throw error;
    throw new Error('Vampire workspace registry is unreadable; refusing to overwrite it.', { cause: error });
  }
}

async function writeLegacyWorkspaceStore(state: WorkspaceStore, file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporaryFile = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryFile, file);
}

export async function writeWorkspaceStore(state: WorkspaceStore, file?: string): Promise<void> {
  if (file === undefined && (await structuredWorkspaceStateExists())) {
    await writeStructuredWorkspaceState(state);
    return;
  }
  await writeLegacyWorkspaceStore(state, file ?? vampireStatePath());
}

export async function findWorkspaceConnection(id: string, file?: string): Promise<WorkspaceConnection | undefined> {
  try {
    if (file === undefined && (await structuredWorkspaceStateExists())) {
      const workspace = (await readStructuredWorkspaceState()).workspaces.find((candidate) => candidate.id === id);
      return workspace ? { tmuxSession: workspace.tmuxSession, cwd: workspace.cwd } : undefined;
    }
    const value = await readWorkspaceStateFile(file);
    if (!isRecord(value)) return undefined;
    const rawWorkspaces = value.workspaces ?? value.sessions;
    if (!Array.isArray(rawWorkspaces)) return undefined;
    const workspace = rawWorkspaces.find((candidate) => isRecord(candidate) && candidate.id === id);
    if (!isRecord(workspace) || typeof workspace.tmuxSession !== 'string' || typeof workspace.cwd !== 'string') {
      return undefined;
    }
    return { tmuxSession: workspace.tmuxSession, cwd: workspace.cwd };
  } catch {
    return undefined;
  }
}
