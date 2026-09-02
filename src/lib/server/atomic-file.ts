import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export function errorHasFileCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`Persistent state directory is not a safe real directory: ${path}`);
  }
}

export async function atomicWriteFile(path: string, contents: string | Buffer, mode = 0o600): Promise<void> {
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryPath, 'wx', mode);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function durableUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (errorHasFileCode(error, 'ENOENT')) return;
    throw error;
  }
  await syncDirectory(dirname(path));
}
