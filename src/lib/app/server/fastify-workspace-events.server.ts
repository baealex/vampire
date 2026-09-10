import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { onSessionRevoked } from '~/lib/server/session-cookie.ts';
import {
  encodeWorkspaceAuthenticationEvent,
  encodeWorkspaceEvent,
  WORKSPACE_EVENT_STREAM_HEARTBEAT,
  type WorkspaceAuthenticationEvent,
} from '~/lib/shared/contracts/workspace-event-stream.ts';
import { subscribeWorkspaceStatus, type WorkspaceStatusSubscriber } from './workspace-status-hub.server.ts';
import { authorizeFastifySession } from './fastify-auth.server.ts';

const HEARTBEAT_INTERVAL_MS = 20_000;
const MAX_EVENT_STREAMS = 32;
let activeEventStreams = 0;

function rejectEventStream(reply: FastifyReply, status: number, message: string): void {
  void reply.status(status).send({ message });
}

async function openWorkspaceEventStream(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const session = authorizeFastifySession(request);
  if (!session.authorized) {
    rejectEventStream(reply, 401, 'Unauthorized');
    return;
  }
  if (activeEventStreams >= MAX_EVENT_STREAMS) {
    rejectEventStream(reply, 503, 'Service Unavailable');
    return;
  }

  activeEventStreams += 1;
  reply.hijack();
  reply.raw.writeHead(200, {
    'cache-control': 'no-cache, no-store',
    connection: 'keep-alive',
    'content-type': 'text/event-stream; charset=utf-8',
    'x-accel-buffering': 'no',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  });
  reply.raw.flushHeaders();

  let closed = false;
  let unsubscribeWorkspace: () => void = () => undefined;
  let unsubscribeSession: () => void = () => undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const heartbeat = setInterval(() => {
    if (!closed) reply.raw.write(WORKSPACE_EVENT_STREAM_HEARTBEAT);
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  const close = () => {
    if (closed) return;
    closed = true;
    activeEventStreams -= 1;
    clearInterval(heartbeat);
    if (expiryTimer) clearTimeout(expiryTimer);
    unsubscribeSession();
    unsubscribeWorkspace();
    request.raw.off('close', close);
    reply.raw.end();
  };
  const closeForAuthentication = (type: WorkspaceAuthenticationEvent) => {
    if (closed) return;
    reply.raw.write(encodeWorkspaceAuthenticationEvent(type));
    close();
  };
  request.raw.once('close', close);

  if (session.expiresAt !== undefined) {
    expiryTimer = setTimeout(
      () => closeForAuthentication('authentication-expired'),
      Math.max(0, session.expiresAt - Date.now())
    );
    expiryTimer.unref();
  }
  if (session.sessionId) {
    unsubscribeSession = onSessionRevoked(session.sessionId, () => closeForAuthentication('authentication-revoked'));
  }

  const subscriber: WorkspaceStatusSubscriber = {
    close,
    send(payload) {
      return !closed && reply.raw.write(encodeWorkspaceEvent(payload));
    },
  };
  try {
    const unsubscribe = await subscribeWorkspaceStatus(subscriber);
    if (closed) unsubscribe();
    else unsubscribeWorkspace = unsubscribe;
  } catch {
    close();
  }
}

export async function registerWorkspaceEventRoutes(app: FastifyInstance): Promise<void> {
  app.get('/events/workspaces', openWorkspaceEventStream);
}
