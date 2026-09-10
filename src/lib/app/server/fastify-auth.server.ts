import type { FastifyRequest } from 'fastify';
import {
  type AuthorizedSession,
  authorizeSession,
  parseCookie,
  type RejectedSession,
  SECURE_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from '~/lib/server/session-cookie.ts';

export function authorizeFastifySession(request: FastifyRequest): AuthorizedSession | RejectedSession {
  const cookies = parseCookie(request.headers.cookie);
  const secureSession = authorizeSession(cookies[SECURE_SESSION_COOKIE_NAME]);
  return secureSession.authorized ? secureSession : authorizeSession(cookies[SESSION_COOKIE_NAME]);
}
