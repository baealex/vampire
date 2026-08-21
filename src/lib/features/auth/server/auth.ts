import { env } from '$env/dynamic/private';
import { error, type RequestEvent } from '@sveltejs/kit';
import { createSessionCookie, isAuthorized } from './session-cookie.ts';
import { loginRetryAfter, recordLoginFailure, resetLoginFailures } from './login-rate-limit.ts';

const MAX_LOGIN_BODY_BYTES = 8 * 1024;

function configuredToken(): string | undefined {
  return env.VAMPIRE_TOKEN?.trim() || undefined;
}

export function authenticationRequired(): boolean {
  return Boolean(configuredToken());
}

export function isAuthenticated(event: RequestEvent): boolean {
  const token = configuredToken();
  if (!token) return true;

  return isAuthorized({
    authorization: event.request.headers.get('authorization') ?? undefined,
    sessionCookie: event.cookies.get('vampire_session'),
    token,
  });
}

export function requireAuthentication(event: RequestEvent): void {
  if (!isAuthenticated(event)) throw error(401, 'Unauthorized');
}

export async function authenticate(event: RequestEvent): Promise<void> {
  const clientKey = (() => {
    try {
      return event.getClientAddress();
    } catch {
      return 'unknown-client';
    }
  })();
  const retryAfter = loginRetryAfter(clientKey);
  if (retryAfter > 0) throw error(429, `Too many login attempts. Try again in ${retryAfter} seconds.`);

  const declaredLength = Number(event.request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_LOGIN_BODY_BYTES) {
    recordLoginFailure(clientKey);
    throw error(413, 'Login request is too large.');
  }

  const body: unknown = await event.request.json().catch(() => undefined);
  const suppliedToken =
    body && typeof body === 'object' && !Array.isArray(body) && 'token' in body ? body.token : undefined;
  const token = configuredToken();
  if (
    !token ||
    typeof suppliedToken !== 'string' ||
    suppliedToken.length > MAX_LOGIN_BODY_BYTES ||
    !isAuthorized({ authorization: `Bearer ${suppliedToken}`, sessionCookie: undefined, token })
  ) {
    recordLoginFailure(clientKey);
    throw error(401, 'Unauthorized');
  }
  resetLoginFailures(clientKey);

  const workspace = createSessionCookie(token);
  event.cookies.set('vampire_session', workspace.value, {
    httpOnly: true,
    sameSite: 'strict',
    secure: event.url.protocol === 'https:',
    path: '/',
    maxAge: workspace.maxAge,
  });
}

export function clearAuthentication(event: RequestEvent): void {
  event.cookies.delete('vampire_session', {
    httpOnly: true,
    sameSite: 'strict',
    secure: event.url.protocol === 'https:',
    path: '/',
  });
}
