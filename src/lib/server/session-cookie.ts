import { createHash, randomBytes } from 'node:crypto';

const SESSION_TTL_SECONDS = 24 * 60 * 60;
const MAX_SESSIONS = 64;
const SESSION_STATE_KEY = '__vampireAuthenticationSessionsV2' as const;

export const SESSION_COOKIE_NAME = 'vampire_session';
export const SECURE_SESSION_COOKIE_NAME = '__Host-vampire_session';

interface SessionRecord {
  expiresAt: number;
}

interface SessionState {
  authenticationRequired: boolean;
  sessions: Map<string, SessionRecord>;
  revocationListeners: Map<string, Set<() => void>>;
}

interface SessionRuntimeGlobal {
  [SESSION_STATE_KEY]?: SessionState;
}

export interface AuthorizedSession {
  authorized: true;
  expiresAt?: number;
  sessionId?: string;
}

export interface RejectedSession {
  authorized: false;
}

function state(): SessionState {
  const runtimeGlobal = globalThis as typeof globalThis & SessionRuntimeGlobal;
  runtimeGlobal[SESSION_STATE_KEY] ??= {
    authenticationRequired: true,
    sessions: new Map(),
    revocationListeners: new Map(),
  };
  return runtimeGlobal[SESSION_STATE_KEY];
}

function sessionId(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function removeSession(id: string): void {
  const runtime = state();
  runtime.sessions.delete(id);
  const listeners = runtime.revocationListeners.get(id);
  runtime.revocationListeners.delete(id);
  for (const listener of listeners ?? []) listener();
}

function clearSessions(): void {
  for (const id of [...state().sessions.keys()]) removeSession(id);
}

function pruneExpiredSessions(now: number): void {
  for (const [id, session] of state().sessions) {
    if (session.expiresAt <= now) removeSession(id);
  }
}

export function configureSessionAuthentication(authenticationRequired: boolean): void {
  clearSessions();
  state().authenticationRequired = authenticationRequired;
}

export function authenticationSessionRequired(): boolean {
  return state().authenticationRequired;
}

export function createSessionCookie(now = Date.now()): { value: string; maxAge: number; expiresAt: number } {
  const runtime = state();
  if (!runtime.authenticationRequired) {
    throw new Error('Cannot create an authentication session when authentication is disabled.');
  }

  pruneExpiredSessions(now);
  while (runtime.sessions.size >= MAX_SESSIONS) {
    const oldestSessionId = runtime.sessions.keys().next().value;
    if (oldestSessionId === undefined) break;
    removeSession(oldestSessionId);
  }

  const value = randomBytes(32).toString('base64url');
  const expiresAt = now + SESSION_TTL_SECONDS * 1_000;
  runtime.sessions.set(sessionId(value), { expiresAt });
  return { value, maxAge: SESSION_TTL_SECONDS, expiresAt };
}

export function authorizeSession(value: string | undefined, now = Date.now()): AuthorizedSession | RejectedSession {
  const runtime = state();
  if (!runtime.authenticationRequired) return { authorized: true };
  if (!value) return { authorized: false };

  const id = sessionId(value);
  const session = runtime.sessions.get(id);
  if (!session) return { authorized: false };
  if (session.expiresAt <= now) {
    removeSession(id);
    return { authorized: false };
  }
  return { authorized: true, expiresAt: session.expiresAt, sessionId: id };
}

export function revokeSession(value: string | undefined): void {
  if (!value) return;
  removeSession(sessionId(value));
}

export function onSessionRevoked(id: string, listener: () => void): () => void {
  const runtime = state();
  if (!runtime.sessions.has(id)) {
    listener();
    return () => undefined;
  }

  const listeners = runtime.revocationListeners.get(id) ?? new Set();
  listeners.add(listener);
  runtime.revocationListeners.set(id, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) runtime.revocationListeners.delete(id);
  };
}

export function parseCookie(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').flatMap((part) => {
      const [key, ...value] = part.trim().split('=');
      if (!key) return [];
      try {
        return [[key, decodeURIComponent(value.join('='))]];
      } catch {
        return [];
      }
    })
  );
}
