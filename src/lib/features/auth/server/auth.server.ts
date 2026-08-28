import { error, type RequestEvent } from '@sveltejs/kit';
import {
  authenticationSessionRequired,
  authorizeSession,
  createSessionCookie,
  revokeSession,
  SECURE_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from '~/lib/server/session-cookie.ts';
import { configuredPublicOrigin, MAXIMUM_TOKEN_BYTES } from '~/lib/server/runtime-config.ts';
import { verifyConfiguredToken } from '~/lib/server/token-authentication.ts';
import {
  acquireLoginAdmission,
  loginRateLimit,
  loginRetryAfter,
  recordLoginFailure,
  resetLoginFailures,
} from './login-rate-limit.server.ts';

const MAX_LOGIN_BODY_BYTES = MAXIMUM_TOKEN_BYTES * 6 + 1_024;
const LOGIN_BODY_TIMEOUT_MS = 5_000;
const GLOBAL_LOGIN_KEY = 'account:shared-token';

function authorizeEventSession(event: RequestEvent) {
  const secureSession = authorizeSession(event.cookies.get(SECURE_SESSION_COOKIE_NAME));
  return secureSession.authorized ? secureSession : authorizeSession(event.cookies.get(SESSION_COOKIE_NAME));
}

function loginClientKey(event: RequestEvent): string | undefined {
  if (configuredPublicOrigin() && !process.env.VAMPIRE_ADAPTER_ADDRESS_HEADER?.trim()) return undefined;
  try {
    return `client:${event.getClientAddress()}`;
  } catch {
    return undefined;
  }
}

function loginRetryDelay(clientKey: string | undefined): number {
  return Math.max(clientKey ? loginRetryAfter(clientKey) : 0, loginRetryAfter(GLOBAL_LOGIN_KEY));
}

function recordFailedLogin(clientKey: string | undefined): void {
  const now = Date.now();
  if (clientKey) recordLoginFailure(clientKey, now);
  recordLoginFailure(GLOBAL_LOGIN_KEY, now, loginRateLimit.GLOBAL_MAX_FAILURES);
}

function resetSuccessfulLogin(clientKey: string | undefined): void {
  if (clientKey) resetLoginFailures(clientKey);
  resetLoginFailures(GLOBAL_LOGIN_KEY);
}

async function readLoginBody(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_LOGIN_BODY_BYTES) {
    await request.body?.cancel().catch(() => undefined);
    throw error(413, 'Login request is too large.');
  }
  if (!request.body) return undefined;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, LOGIN_BODY_TIMEOUT_MS);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) throw error(408, 'Login request timed out.');
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_LOGIN_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw error(413, 'Login request is too large.');
      }
      chunks.push(value);
    }
    if (timedOut) throw error(408, 'Login request timed out.');
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

export function authenticationRequired(): boolean {
  return authenticationSessionRequired();
}

export function isAuthenticated(event: RequestEvent): boolean {
  return authorizeEventSession(event).authorized;
}

export function requireAuthentication(event: RequestEvent): void {
  if (!isAuthenticated(event)) throw error(401, 'Unauthorized');
}

export async function authenticate(event: RequestEvent): Promise<void> {
  const clientKey = loginClientKey(event);
  let retryAfter = loginRetryDelay(clientKey);
  if (retryAfter > 0) throw error(429, `Too many login attempts. Try again in ${retryAfter} seconds.`);
  const releaseAdmission = acquireLoginAdmission();
  if (!releaseAdmission) throw error(429, 'Too many login requests are already in progress.');

  try {
    const body = await readLoginBody(event.request);
    const suppliedToken =
      body && typeof body === 'object' && !Array.isArray(body) && 'token' in body ? body.token : undefined;
    if (typeof suppliedToken !== 'string' || Buffer.byteLength(suppliedToken, 'utf8') > MAXIMUM_TOKEN_BYTES) {
      throw error(401, 'Unauthorized');
    }

    retryAfter = loginRetryDelay(clientKey);
    if (retryAfter > 0) throw error(429, `Too many login attempts. Try again in ${retryAfter} seconds.`);

    const verified = await verifyConfiguredToken(suppliedToken);
    if (verified === undefined) throw error(429, 'Another login attempt is already being verified.');
    if (!verified) {
      recordFailedLogin(clientKey);
      throw error(401, 'Unauthorized');
    }
    resetSuccessfulLogin(clientKey);

    revokeSession(event.cookies.get(SECURE_SESSION_COOKIE_NAME));
    revokeSession(event.cookies.get(SESSION_COOKIE_NAME));
    const session = createSessionCookie();
    const secure = event.url.protocol === 'https:';
    const cookieName = secure ? SECURE_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME;
    event.cookies.set(cookieName, session.value, {
      httpOnly: true,
      sameSite: 'strict',
      secure,
      path: '/',
      maxAge: session.maxAge,
    });
    const staleCookieName = secure ? SESSION_COOKIE_NAME : SECURE_SESSION_COOKIE_NAME;
    event.cookies.delete(staleCookieName, {
      httpOnly: true,
      sameSite: 'strict',
      secure: staleCookieName === SECURE_SESSION_COOKIE_NAME,
      path: '/',
    });
  } finally {
    releaseAdmission();
  }
}

export function clearAuthentication(event: RequestEvent): void {
  revokeSession(event.cookies.get(SECURE_SESSION_COOKIE_NAME));
  revokeSession(event.cookies.get(SESSION_COOKIE_NAME));
  event.cookies.delete(SECURE_SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'strict',
    secure: true,
    path: '/',
  });
  event.cookies.delete(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'strict',
    secure: event.url.protocol === 'https:',
    path: '/',
  });
}
