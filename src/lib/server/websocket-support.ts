import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type WebSocket from 'ws';
import type { WebSocketServer } from 'ws';

import { isAuthorized, parseCookie, sessionCookieExpiresAt } from '~/lib/server/session-cookie.ts';
import { configuredToken, expectedRequestOrigin } from '~/lib/server/runtime-config.ts';

export interface AuthorizedUpgrade {
  authorized: true;
  expiresAt?: number;
}

export interface RejectedUpgrade {
  authorized: false;
  status: number;
  reason: string;
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

  const token = configuredToken(env);
  const cookies = parseCookie(request.headers.cookie);
  if (
    !isAuthorized({
      authorization: request.headers.authorization,
      sessionCookie: cookies.vampire_session,
      token,
    })
  ) {
    return { authorized: false, status: 401, reason: 'Unauthorized' };
  }

  return {
    authorized: true,
    expiresAt: token ? sessionCookieExpiresAt(cookies.vampire_session, token) : undefined,
  };
}

export function rejectWebSocketUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function scheduleAuthenticationExpiry(socket: WebSocket, expiresAt: number | undefined): void {
  if (!expiresAt) return;
  const timer = setTimeout(() => socket.close(1008, 'authentication expired'), Math.max(0, expiresAt - Date.now()));
  timer.unref();
  socket.once('close', () => clearTimeout(timer));
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
