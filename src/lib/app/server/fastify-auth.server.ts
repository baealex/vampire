import type { FastifyRequest } from 'fastify';
import {
  authorizeSession,
  parseCookie,
  SECURE_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  type AuthorizedSession,
  type RejectedSession,
} from '~/lib/server/session-cookie.ts';

export function authorizeFastifySession(request: FastifyRequest): AuthorizedSession | RejectedSession {
  const cookies = parseCookie(request.headers.cookie);
  const secureSession = authorizeSession(cookies[SECURE_SESSION_COOKIE_NAME]);
  return secureSession.authorized ? secureSession : authorizeSession(cookies[SESSION_COOKIE_NAME]);
}
