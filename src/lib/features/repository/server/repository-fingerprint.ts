import { createHash } from 'node:crypto';
import type { RepositoryChange, RepositoryDiff, RepositorySnapshot } from '~/lib/shared/contracts/repository.ts';
import { readRepositoryDiff } from './repository.ts';

const MAX_FINGERPRINT_CHANGES = 256;
const FINGERPRINT_BATCH_SIZE = 16;
const FINGERPRINT_TIME_BUDGET_MS = 45_000;

export type RepositoryChangeFingerprint = RepositoryChange & { diffHash: string };

export type RepositoryFingerprint = {
  repositoryStateHash: string;
  changes: RepositoryChangeFingerprint[];
};

export function repositoryChangeKey(change: RepositoryChange): string {
  return `${change.path}\0${change.status}\0${change.previousPath ?? ''}`;
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function fingerprintChanges(
  cwd: string,
  changes: RepositoryChange[],
  readDiff: (cwd: string, path: string) => Promise<RepositoryDiff>
): Promise<RepositoryChangeFingerprint[]> {
  if (changes.length > MAX_FINGERPRINT_CHANGES) {
    throw new Error(`Repository fingerprint exceeds ${MAX_FINGERPRINT_CHANGES} changes.`);
  }
  const deadline = Date.now() + FINGERPRINT_TIME_BUDGET_MS;
  const fingerprints: RepositoryChangeFingerprint[] = [];
  for (let offset = 0; offset < changes.length; offset += FINGERPRINT_BATCH_SIZE) {
    if (Date.now() >= deadline) throw new Error('Repository fingerprint timed out.');
    const batch = changes.slice(offset, offset + FINGERPRINT_BATCH_SIZE);
    fingerprints.push(
      ...(await Promise.all(
        batch.map(async (change) => ({ ...change, diffHash: hashJson(await readDiff(cwd, change.path)) }))
      ))
    );
  }
  return fingerprints;
}

export async function captureRepositoryFingerprint(
  cwd: string,
  snapshot: RepositorySnapshot,
  readDiff: (cwd: string, path: string) => Promise<RepositoryDiff> = readRepositoryDiff
): Promise<RepositoryFingerprint | null> {
  if (!snapshot.isGitRepository) return null;
  try {
    const changes = [...snapshot.changes].sort((left, right) =>
      repositoryChangeKey(left).localeCompare(repositoryChangeKey(right))
    );
    const fingerprints = await fingerprintChanges(cwd, changes, readDiff);
    return { repositoryStateHash: hashJson(fingerprints), changes: fingerprints };
  } catch {
    return null;
  }
}
