import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type WebSocket from 'ws';
import type { WebSocketServer } from 'ws';

import {
  authorizeSession,
  onSessionRevoked,
  parseCookie,
  SECURE_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from '~/lib/server/session-cookie.ts';
import { expectedRequestOrigin } from '~/lib/server/runtime-config.ts';

const AUTHENTICATION_CLOSE_GRACE_MS = 1_000;
const WEBSOCKET_CLOSED = 3;

export interface AuthorizedUpgrade {
  authorized: true;
  expiresAt?: number;
  sessionId?: string;
}

export interface RejectedUpgrade {
  authorized: false;
  status: number;
  reason: string;
}

export interface WebSocketAuthenticationLifetime {
  isAuthorized: () => boolean;
  onRevoked: (listener: () => void) => () => void;
}

export function webSocketRequestUrl(request: IncomingMessage): URL | undefined {
  try {
    return new URL(request.url ?? '/', 'http://localhost');
  } catch {
    return undefined;
  }
}

export function authorizeWebSocketUpgrade(
  request: IncomingMessage,
  env: NodeJS.ProcessEnv = process.env
): AuthorizedUpgrade | RejectedUpgrade {
  const origin = request.headers.origin;
  try {
    const expectedOrigin = expectedRequestOrigin(request.headers, env);
    if (!origin || !expectedOrigin || new URL(origin).origin !== expectedOrigin) {
      return { authorized: false, status: 403, reason: 'Forbidden' };
    }
  } catch {
    return { authorized: false, status: 403, reason: 'Forbidden' };
  }

  const cookies = parseCookie(request.headers.cookie);
  const secureSession = authorizeSession(cookies[SECURE_SESSION_COOKIE_NAME]);
  const session = secureSession.authorized ? secureSession : authorizeSession(cookies[SESSION_COOKIE_NAME]);
  if (!session.authorized) {
    return { authorized: false, status: 401, reason: 'Unauthorized' };
  }

  return {
    authorized: true,
    expiresAt: session.expiresAt,
    sessionId: session.sessionId,
  };
}

export function rejectWebSocketUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
}

export function scheduleAuthenticationExpiry(
  socket: WebSocket,
  expiresAt: number | undefined,
  sessionId?: string
): WebSocketAuthenticationLifetime {
  let authorized = true;
  let forcedCloseTimer: ReturnType<typeof setTimeout> | undefined;
  const revocationListeners = new Set<() => void>();
  const revoke = (reason: 'authentication expired' | 'authentication revoked') => {
    if (!authorized) return;
    authorized = false;
    for (const listener of [...revocationListeners]) {
      try {
        listener();
      } catch {
        // Authorization must still be revoked if a transport cleanup callback fails.
      }
    }
    revocationListeners.clear();
    try {
      socket.close(1008, reason);
    } catch {
      try {
        socket.terminate();
      } catch {
        // The authorization state is already closed even if transport teardown fails.
      }
    } finally {
      forcedCloseTimer = setTimeout(() => {
        if (socket.readyState === WEBSOCKET_CLOSED) return;
        try {
          socket.terminate();
        } catch {
          // A concurrently closed socket needs no further cleanup.
        }
      }, AUTHENTICATION_CLOSE_GRACE_MS);
      forcedCloseTimer.unref();
    }
  };

  const expiryTimer =
    expiresAt === undefined
      ? undefined
      : setTimeout(() => revoke('authentication expired'), Math.max(0, expiresAt - Date.now()));
  expiryTimer?.unref();
  const unsubscribeSession = sessionId
    ? onSessionRevoked(sessionId, () => revoke('authentication revoked'))
    : () => undefined;
  socket.once('close', () => {
    authorized = false;
    revocationListeners.clear();
    if (expiryTimer) clearTimeout(expiryTimer);
    if (forcedCloseTimer) clearTimeout(forcedCloseTimer);
    unsubscribeSession();
  });

  return {
    isAuthorized: () => authorized,
    onRevoked: (listener) => {
      if (!authorized) {
        try {
          listener();
        } catch {
          // Match the isolated listener behavior used during asynchronous revocation.
        }
        return () => undefined;
      }
      revocationListeners.add(listener);
      return () => revocationListeners.delete(listener);
    },
  };
}

export function installWebSocketHeartbeat(server: WebSocketServer, intervalMs: number): () => void {
  const liveSockets = new WeakSet<WebSocket>();
  const handleConnection = (socket: WebSocket) => {
    liveSockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('pong', () => liveSockets.add(socket));
  };
  server.on('connection', handleConnection);

  const heartbeat = setInterval(() => {
    for (const socket of server.clients) {
      if (!liveSockets.has(socket)) {
        socket.terminate();
        continue;
      }
      liveSockets.delete(socket);
      socket.ping();
    }
  }, intervalMs);
  heartbeat.unref();

  return () => {
    clearInterval(heartbeat);
    server.off('connection', handleConnection);
  };
}
