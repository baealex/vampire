import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_TTL_SECONDS = 24 * 60 * 60;

function signature(token: string, payload: string): string {
  return createHmac('sha256', token).update(payload).digest('base64url');
}

function equal(left: string, right: string): boolean {
  const leftHash = createHmac('sha256', 'vampire-compare').update(left).digest();
  const rightHash = createHmac('sha256', 'vampire-compare').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

export function createSessionCookie(token: string): { value: string; maxAge: number } {
  const expiresAt = Math.floor(Date.now() / 1_000) + SESSION_TTL_SECONDS;
  const payload = `${expiresAt}.${randomBytes(18).toString('base64url')}`;
  return { value: `${payload}.${signature(token, payload)}`, maxAge: SESSION_TTL_SECONDS };
}

export function isSessionCookieValid(value: string | undefined, token: string | undefined): boolean {
  if (!value || !token) return false;
  const separator = value.lastIndexOf('.');
  if (separator < 1) return false;
  const payload = value.slice(0, separator);
  const suppliedSignature = value.slice(separator + 1);
  const [expiresAt] = payload.split('.');
  if (!/^\d+$/.test(expiresAt) || Number(expiresAt) <= Math.floor(Date.now() / 1_000)) return false;
  return equal(suppliedSignature, signature(token, payload));
}

export function sessionCookieExpiresAt(value: string | undefined, token: string | undefined): number | undefined {
  if (!value || !token || !isSessionCookieValid(value, token)) return undefined;
  const expiresAt = Number(value.slice(0, value.indexOf('.')));
  return Number.isFinite(expiresAt) ? expiresAt * 1_000 : undefined;
}

export function isAuthorized({
  authorization,
  sessionCookie,
  token,
}: {
  authorization?: string;
  sessionCookie?: string;
  token?: string;
}): boolean {
  if (!token) return true;
  if (authorization?.startsWith('Bearer ') && equal(authorization.slice(7), token)) return true;
  return isSessionCookieValid(sessionCookie, token);
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
