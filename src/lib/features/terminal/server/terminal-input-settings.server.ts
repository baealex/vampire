import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { errorHasCode } from '~/lib/server/path-policy.ts';
import { VAMPIRE_GLOBAL_TERMINAL_INPUT_FILE, vampireGlobalStatePath } from '~/lib/server/state-path.ts';
import {
  DEFAULT_TERMINAL_INPUT_SETTINGS,
  isTerminalInputSettings,
  type TerminalInputSettings,
} from '~/lib/shared/contracts/terminal-input.ts';

const TERMINAL_INPUT_SETTINGS_VERSION = 2;
const MAX_TERMINAL_INPUT_SETTINGS_BYTES = 64 * 1_024;

type TerminalInputSettingsDocument = TerminalInputSettings & {
  version: typeof TERMINAL_INPUT_SETTINGS_VERSION;
};

export class TerminalInputSettingsError extends Error {}

export function managedTerminalInputSettingsPath(): string {
  return vampireGlobalStatePath(VAMPIRE_GLOBAL_TERMINAL_INPUT_FILE);
}

async function settingsFileExists(path: string): Promise<boolean> {
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error('The managed terminal input settings path is not a regular file.');
    }
    if (details.size > MAX_TERMINAL_INPUT_SETTINGS_BYTES) {
      throw new Error('The managed terminal input settings file is too large to read safely.');
    }
    return true;
  } catch (error) {
    if (errorHasCode(error, 'ENOENT')) return false;
    throw error;
  }
}

async function writeSettings(settings: TerminalInputSettings): Promise<void> {
  const path = managedTerminalInputSettingsPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const document: TerminalInputSettingsDocument = { version: TERMINAL_INPUT_SETTINGS_VERSION, ...settings };
  try {
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
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

export async function readManagedTerminalInputSettings(): Promise<TerminalInputSettings> {
  const path = managedTerminalInputSettingsPath();
  if (!(await settingsFileExists(path))) return { ...DEFAULT_TERMINAL_INPUT_SETTINGS };
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ((value as Record<string, unknown>).version !== 1 &&
      (value as Record<string, unknown>).version !== TERMINAL_INPUT_SETTINGS_VERSION) ||
    !isTerminalInputSettings(value)
  ) {
    throw new Error('The terminal input settings file is invalid.');
  }
  const { mode, slashHandoff } = value;
  return { mode, slashHandoff };
}

export async function updateManagedTerminalInputSettings(value: unknown): Promise<TerminalInputSettings> {
  if (!isTerminalInputSettings(value)) {
    throw new TerminalInputSettingsError('Terminal input settings are invalid.');
  }
  const settings = {
    mode: value.mode,
    slashHandoff: value.slashHandoff,
  };
  await writeSettings(settings);
  return settings;
}
