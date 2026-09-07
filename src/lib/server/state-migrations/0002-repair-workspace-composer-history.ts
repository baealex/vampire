import { randomUUID } from 'node:crypto';
import { lstat, link, open, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { errorHasFileCode, syncDirectory } from '../atomic-file.ts';
import {
  VAMPIRE_WORKSPACE_COMPOSER_HISTORY_FILE,
  VAMPIRE_WORKSPACES_DIRECTORY,
  vampireWorkspaceStateKey,
} from '../state-path.ts';
import { readStructuredWorkspaceState } from '../workspace-state-files.ts';
import { validateOrganizedStateDirectory } from './0001-organize-state-directory.ts';
import type { StateMigrationContext, StateMigrationSource } from './types.ts';

export const WORKSPACE_COMPOSER_HISTORY_MIGRATION_NAME = '0002-repair-workspace-composer-history';
const EMPTY_COMPOSER_HISTORY = `${JSON.stringify({ version: 1, prompts: [] }, null, 2)}\n`;

async function createEmptyHistoryFile(path: string): Promise<void> {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(EMPTY_COMPOSER_HISTORY, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;

    try {
      await link(temporaryPath, path);
    } catch (error) {
      if (!errorHasFileCode(error, 'EEXIST')) throw error;
    }
    await unlink(temporaryPath);
    await syncDirectory(dirname(path));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function ensureWorkspaceComposerHistoryFile(stateDirectory: string, workspaceId: string): Promise<void> {
  const directory = join(stateDirectory, VAMPIRE_WORKSPACES_DIRECTORY, vampireWorkspaceStateKey(workspaceId));
  const directoryDetails = await lstat(directory).catch((error) => {
    if (errorHasFileCode(error, 'ENOENT')) {
      throw new Error(`The organized workspace directory is missing: ${workspaceId}`, { cause: error });
    }
    throw error;
  });
  if (directoryDetails.isSymbolicLink() || !directoryDetails.isDirectory()) {
    throw new Error(`The organized workspace directory is invalid: ${workspaceId}`);
  }

  const path = join(directory, VAMPIRE_WORKSPACE_COMPOSER_HISTORY_FILE);
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new Error(`The organized Composer history is invalid: ${workspaceId}`);
    }
    return;
  } catch (error) {
    if (!errorHasFileCode(error, 'ENOENT')) throw error;
  }

  await createEmptyHistoryFile(path);
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error(`The organized Composer history is invalid: ${workspaceId}`);
  }
}

async function repairWorkspaceComposerHistory({ stateDirectory }: StateMigrationContext): Promise<void> {
  const state = await readStructuredWorkspaceState(stateDirectory);
  await Promise.all(
    state.workspaces.map((workspace) => ensureWorkspaceComposerHistoryFile(stateDirectory, workspace.id))
  );
}

export const repairWorkspaceComposerHistoryMigration = {
  name: WORKSPACE_COMPOSER_HISTORY_MIGRATION_NAME,
  layoutVersion: 2,
  checksumInput: 'vampire-state-migration:0002-repair-workspace-composer-history:ownership-layout:v1',
  up: repairWorkspaceComposerHistory,
  validate: ({ stateDirectory }: StateMigrationContext) => validateOrganizedStateDirectory(stateDirectory),
} satisfies StateMigrationSource;
