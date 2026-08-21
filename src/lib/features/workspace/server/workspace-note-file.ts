import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { errorHasCode } from '~/lib/shared/server/path-policy.ts';
import { normalizeWorkspaceNote, workspaceNoteByteLength, WORKSPACE_NOTE_MAX_BYTES } from './workspace-note.ts';
import { workspaceStatePath } from './workspace-store.ts';

const SAFE_WORKSPACE_NOTE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function managedWorkspaceNoteFileName(workspaceId: string): string {
  if (SAFE_WORKSPACE_NOTE_ID.test(workspaceId)) return `${workspaceId}.note.md`;
  return `${createHash('sha256').update(workspaceId).digest('hex')}.note.md`;
}

export function managedWorkspaceNotePath(workspaceId: string): string {
  return join(dirname(workspaceStatePath()), managedWorkspaceNoteFileName(workspaceId));
}

async function ensureStateDirectory(path: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await stat(directory);
  if (!details.isDirectory()) throw new Error('The Vampire state path is not a directory.');
}

async function assertRegularNoteFile(path: string): Promise<'missing' | 'regular'> {
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error('The managed Vampire note path is not a regular file.');
    }
    if (details.size > WORKSPACE_NOTE_MAX_BYTES + 1) {
      throw new Error('The managed Vampire note is too large to read safely.');
    }
    return 'regular';
  } catch (error) {
    if (errorHasCode(error, 'ENOENT')) return 'missing';
    throw error;
  }
}

function assertNoteSize(note: string): void {
  if (workspaceNoteByteLength(note) > WORKSPACE_NOTE_MAX_BYTES) {
    throw new Error('The managed Vampire note is too large to save safely.');
  }
}

export async function ensureManagedWorkspaceNoteFile(workspaceId: string, note: string): Promise<string> {
  const path = managedWorkspaceNotePath(workspaceId);
  await ensureStateDirectory(path);
  if ((await assertRegularNoteFile(path)) === 'regular') return path;
  const normalized = normalizeWorkspaceNote(note);
  assertNoteSize(normalized);
  try {
    await writeFile(path, normalized ? `${normalized}\n` : '', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  } catch (error) {
    if (!errorHasCode(error, 'EEXIST')) throw error;
    await assertRegularNoteFile(path);
  }
  return path;
}

export async function readManagedWorkspaceNoteFile(workspaceId: string): Promise<string | undefined> {
  const path = managedWorkspaceNotePath(workspaceId);
  if ((await assertRegularNoteFile(path)) === 'missing') return undefined;
  return normalizeWorkspaceNote(await readFile(path, 'utf8'));
}

export async function writeManagedWorkspaceNoteFile(workspaceId: string, note: string): Promise<void> {
  const path = managedWorkspaceNotePath(workspaceId);
  await ensureStateDirectory(path);
  if ((await assertRegularNoteFile(path)) === 'missing') {
    await ensureManagedWorkspaceNoteFile(workspaceId, note);
    return;
  }
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const normalized = normalizeWorkspaceNote(note);
  assertNoteSize(normalized);
  try {
    await writeFile(temporaryPath, normalized ? `${normalized}\n` : '', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporaryPath, path);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}
