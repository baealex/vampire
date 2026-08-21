const WINDOW_MS = 5 * 60 * 1_000;
const MAX_FAILURES = 5;
const BASE_BLOCK_MS = 30 * 1_000;
const MAX_BLOCK_MS = 15 * 60 * 1_000;
const MAX_TRACKED_CLIENTS = 1_000;

interface LoginEntry {
  failures: number[];
  blockedUntil: number;
}

const clients = new Map<string, LoginEntry>();

function recentFailures(entry: LoginEntry, now: number): number[] {
  entry.failures = entry.failures.filter((timestamp) => timestamp > now - WINDOW_MS);
  return entry.failures;
}

function prune(now: number): void {
  for (const [key, entry] of clients) {
    if (entry.blockedUntil <= now && recentFailures(entry, now).length === 0) clients.delete(key);
  }

  while (clients.size >= MAX_TRACKED_CLIENTS) {
    const oldest = clients.keys().next().value;
    if (oldest === undefined) break;
    clients.delete(oldest);
  }
}

export function loginRetryAfter(key: string, now = Date.now()): number {
  const entry = clients.get(key);
  if (!entry) return 0;
  recentFailures(entry, now);
  return Math.max(0, Math.ceil((entry.blockedUntil - now) / 1_000));
}

export function recordLoginFailure(key: string, now = Date.now()): number {
  prune(now);
  const entry = clients.get(key) ?? { failures: [], blockedUntil: 0 };
  recentFailures(entry, now).push(now);
  if (entry.failures.length >= MAX_FAILURES) {
    const exponent = Math.min(entry.failures.length - MAX_FAILURES, 5);
    entry.blockedUntil = now + Math.min(MAX_BLOCK_MS, BASE_BLOCK_MS * 2 ** exponent);
  }
  clients.delete(key);
  clients.set(key, entry);
  return loginRetryAfter(key, now);
}

export function resetLoginFailures(key: string): void {
  clients.delete(key);
}

export const loginRateLimit = { WINDOW_MS, MAX_FAILURES, BASE_BLOCK_MS, MAX_BLOCK_MS };
