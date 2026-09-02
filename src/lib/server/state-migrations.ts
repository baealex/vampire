import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Umzug, type UmzugStorage } from 'umzug';
import { organizeStateDirectoryMigration } from './state-migrations/0001-organize-state-directory.ts';
import type { StateMigrationContext, StateMigrationSource } from './state-migrations/types.ts';

export type { StateMigrationContext } from './state-migrations/types.ts';

export const STATE_LAYOUT_FILE = 'state-layout.json';
export const STATE_MIGRATION_LOCK_FILE = '.state-migrations.lock';
const STATE_LAYOUT_FORMAT_VERSION = 1;
const MAX_STATE_LAYOUT_BYTES = 1024 * 1024;
const MAX_MIGRATION_LOCK_BYTES = 16 * 1024;
const CORRUPT_LOCK_RECOVERY_MS = 5 * 60 * 1_000;

type StateMigrationDefinition = StateMigrationSource & {
  checksum: string;
};

type AppliedStateMigration = {
  name: string;
  checksum: string;
  appliedAt: string;
};

type StateLayoutDocument = {
  formatVersion: typeof STATE_LAYOUT_FORMAT_VERSION;
  layoutVersion: number;
  appliedMigrations: AppliedStateMigration[];
};

type MigrationLockDocument = {
  version: 1;
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
};

function errorHasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isExactIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWriteFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function ensureStateDirectory(path: string): Promise<string> {
  const requested = resolve(path);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const details = await lstat(requested);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`The Vampire state path must be a real directory: ${requested}`);
  }
  return realpath(requested);
}

async function validateRegularFile(path: string, maximumBytes: number, label: string): Promise<'missing' | 'regular'> {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile()) throw new Error(`${label} must be a regular file.`);
    if (details.size > maximumBytes) throw new Error(`${label} is too large to validate safely.`);
    return 'regular';
  } catch (error) {
    if (errorHasCode(error, 'ENOENT')) return 'missing';
    throw error;
  }
}

async function validateAppliedStateLayout(context: StateMigrationContext, layoutVersion: number): Promise<void> {
  const definition = STATE_MIGRATIONS.find((migration) => migration.layoutVersion === layoutVersion);
  if (!definition) throw new Error(`Vampire cannot validate state layout version ${layoutVersion}.`);
  await definition.validate(context);
}

const STATE_MIGRATION_SOURCES = [organizeStateDirectoryMigration] as const;
const STATE_MIGRATIONS: readonly StateMigrationDefinition[] = STATE_MIGRATION_SOURCES.map((migration) => ({
  ...migration,
  checksum: sha256(migration.checksumInput),
}));

export const CURRENT_STATE_LAYOUT_VERSION = STATE_MIGRATIONS.at(-1)?.layoutVersion ?? 0;

function emptyStateLayout(): StateLayoutDocument {
  return { formatVersion: STATE_LAYOUT_FORMAT_VERSION, layoutVersion: 0, appliedMigrations: [] };
}

function parseStateLayout(value: unknown): StateLayoutDocument {
  if (!isRecord(value) || value.formatVersion !== STATE_LAYOUT_FORMAT_VERSION) {
    throw new Error('The state migration history format is invalid.');
  }
  if (!Number.isSafeInteger(value.layoutVersion) || (value.layoutVersion as number) < 0) {
    throw new Error('The state layout version is invalid.');
  }
  if (!Array.isArray(value.appliedMigrations)) throw new Error('The applied migration history is invalid.');

  const appliedMigrations: AppliedStateMigration[] = [];
  for (const [index, value_] of value.appliedMigrations.entries()) {
    if (!isRecord(value_)) throw new Error('The applied migration history is invalid.');
    const definition = STATE_MIGRATIONS[index];
    if (!definition || value_.name !== definition.name) {
      throw new Error('The applied migrations are not a known ordered prefix.');
    }
    if (value_.checksum !== definition.checksum) {
      throw new Error(`The checksum for migration ${definition.name} does not match this Vampire build.`);
    }
    if (!isExactIsoTimestamp(value_.appliedAt)) {
      throw new Error(`The timestamp for migration ${definition.name} is invalid.`);
    }
    appliedMigrations.push({
      name: definition.name,
      checksum: definition.checksum,
      appliedAt: value_.appliedAt,
    });
  }

  const expectedLayoutVersion =
    appliedMigrations.length === 0 ? 0 : STATE_MIGRATIONS[appliedMigrations.length - 1]!.layoutVersion;
  if (value.layoutVersion !== expectedLayoutVersion) {
    throw new Error('The state layout version does not match the applied migration history.');
  }
  return {
    formatVersion: STATE_LAYOUT_FORMAT_VERSION,
    layoutVersion: expectedLayoutVersion,
    appliedMigrations,
  };
}

async function readStateLayout(stateDirectory: string): Promise<StateLayoutDocument> {
  const path = join(stateDirectory, STATE_LAYOUT_FILE);
  if ((await validateRegularFile(path, MAX_STATE_LAYOUT_BYTES, STATE_LAYOUT_FILE)) === 'missing') {
    return emptyStateLayout();
  }
  try {
    return parseStateLayout(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : '';
    throw new Error(`Vampire state migration history is unreadable; refusing to overwrite it.${detail}`, {
      cause: error,
    });
  }
}

class AtomicStateMigrationStorage implements UmzugStorage<StateMigrationContext> {
  private readonly stateDirectory: string;
  private readonly now: () => number;

  constructor(stateDirectory: string, now: () => number) {
    this.stateDirectory = stateDirectory;
    this.now = now;
  }

  async executed(): Promise<string[]> {
    return (await readStateLayout(this.stateDirectory)).appliedMigrations.map((migration) => migration.name);
  }

  async logMigration({ name }: { name: string; context: StateMigrationContext }): Promise<void> {
    const current = await readStateLayout(this.stateDirectory);
    const definition = STATE_MIGRATIONS[current.appliedMigrations.length];
    if (!definition || definition.name !== name) {
      throw new Error(`Migration ${name} is not the next expected state migration.`);
    }
    const updated: StateLayoutDocument = {
      formatVersion: STATE_LAYOUT_FORMAT_VERSION,
      layoutVersion: definition.layoutVersion,
      appliedMigrations: [
        ...current.appliedMigrations,
        {
          name,
          checksum: definition.checksum,
          appliedAt: new Date(this.now()).toISOString(),
        },
      ],
    };
    await atomicWriteFile(join(this.stateDirectory, STATE_LAYOUT_FILE), `${JSON.stringify(updated, null, 2)}\n`);
  }

  async unlogMigration(): Promise<void> {
    throw new Error('Automatic state downgrades are not supported. Restore a verified backup instead.');
  }
}

function parseMigrationLock(value: unknown): MigrationLockDocument {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.token !== 'string' ||
    value.token.length === 0 ||
    value.token.length > 128 ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    typeof value.hostname !== 'string' ||
    value.hostname.length === 0 ||
    !isExactIsoTimestamp(value.createdAt)
  ) {
    throw new Error('The state migration lock is malformed.');
  }
  return {
    version: 1,
    token: value.token,
    pid: value.pid as number,
    hostname: value.hostname,
    createdAt: value.createdAt,
  };
}

async function readMigrationLock(path: string): Promise<{ document: MigrationLockDocument; modifiedAt: number }> {
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isFile() || details.size > MAX_MIGRATION_LOCK_BYTES) {
    throw new Error('The state migration lock is not a safe regular file.');
  }
  return {
    document: parseMigrationLock(JSON.parse(await readFile(path, 'utf8')) as unknown),
    modifiedAt: details.mtimeMs,
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !errorHasCode(error, 'ESRCH');
  }
}

async function archiveMigrationLock(path: string, now: number): Promise<void> {
  const suffix = new Date(now).toISOString().replaceAll(':', '-');
  await rename(path, `${path}.stale-${suffix}-${randomUUID()}`);
  await syncDirectory(dirname(path));
}

async function acquireMigrationLock(stateDirectory: string, now: () => number): Promise<() => Promise<void>> {
  const path = join(stateDirectory, STATE_MIGRATION_LOCK_FILE);
  const token = randomUUID();
  const document: MigrationLockDocument = {
    version: 1,
    token,
    pid: process.pid,
    hostname: hostname(),
    createdAt: new Date(now()).toISOString(),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle: FileHandle | undefined;
    let createdLock = false;
    try {
      handle = await open(path, 'wx', 0o600);
      createdLock = true;
      await handle.writeFile(`${JSON.stringify(document)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await syncDirectory(stateDirectory);
      return async () => {
        const current = await readMigrationLock(path);
        if (current.document.token !== token) {
          throw new Error('The state migration lock changed ownership before it could be released.');
        }
        await unlink(path);
        await syncDirectory(stateDirectory);
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (createdLock) await unlink(path).catch(() => undefined);
      if (!errorHasCode(error, 'EEXIST')) throw error;
    }

    let lock;
    try {
      lock = await readMigrationLock(path);
    } catch (error) {
      const details = await lstat(path).catch(() => undefined);
      if (!details || now() - details.mtimeMs < CORRUPT_LOCK_RECOVERY_MS) throw error;
      await archiveMigrationLock(path, now());
      continue;
    }
    if (lock.document.hostname !== hostname()) {
      throw new Error(`Vampire state is locked by a migration on ${lock.document.hostname}.`);
    }
    if (processIsAlive(lock.document.pid)) {
      throw new Error(`Vampire state is locked by live process ${lock.document.pid}.`);
    }
    await archiveMigrationLock(path, now());
  }
  throw new Error('Unable to acquire the Vampire state migration lock.');
}

export type RunStateMigrationsOptions = {
  stateDirectory: string;
  now?: () => number;
};

export type StateMigrationResult = {
  applied: string[];
  layoutVersion: number;
};

export async function runStateMigrations(options: RunStateMigrationsOptions): Promise<StateMigrationResult> {
  const stateDirectory = await ensureStateDirectory(options.stateDirectory);
  const now = options.now ?? Date.now;
  const release = await acquireMigrationLock(stateDirectory, now);
  try {
    const context: StateMigrationContext = { stateDirectory };
    const migrator = new Umzug<StateMigrationContext>({
      migrations: STATE_MIGRATIONS.map((migration) => ({
        name: migration.name,
        up: async ({ context: migrationContext }) => migration.up(migrationContext),
      })),
      context,
      storage: new AtomicStateMigrationStorage(stateDirectory, now),
      logger: undefined,
    });
    const applied = (await migrator.up()).map((migration) => migration.name);
    const layout = await readStateLayout(stateDirectory);
    await validateAppliedStateLayout(context, layout.layoutVersion);
    return { applied, layoutVersion: layout.layoutVersion };
  } finally {
    await release();
  }
}
