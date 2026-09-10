import type { RequestHandler } from '~/lib/server/http-handler.server.ts';
import {
  subscribeWorkspaceStatus,
  type WorkspaceStatusSubscriber,
} from '~/lib/app/server/workspace-status-hub.server.ts';
import { authorizeEventSession, requireAuthentication } from '~/lib/features/auth/server/auth.server.ts';
import { onSessionRevoked } from '~/lib/server/session-cookie.ts';
import {
  encodeWorkspaceAuthenticationEvent,
  encodeWorkspaceEvent,
  WORKSPACE_EVENT_STREAM_HEARTBEAT,
  type WorkspaceAuthenticationEvent,
} from '~/lib/shared/contracts/workspace-event-stream.ts';

const HEARTBEAT_INTERVAL_MS = 20_000;
const STREAM_HIGH_WATER_MARK_BYTES = 256 * 1024;

export const GET: RequestHandler = (event) => {
  requireAuthentication(event);
  const session = authorizeEventSession(event);
  if (!session.authorized) throw new Error('Authenticated workspace event stream lost its session.');

  const encoder = new TextEncoder();
  let closeStream: () => void = () => undefined;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let closed = false;
        let unsubscribeWorkspace: () => void = () => undefined;
        let unsubscribeSession: () => void = () => undefined;
        let expiryTimer: ReturnType<typeof setTimeout> | undefined;
        const heartbeat = setInterval(() => {
          if (!closed) controller.enqueue(encoder.encode(WORKSPACE_EVENT_STREAM_HEARTBEAT));
        }, HEARTBEAT_INTERVAL_MS);

        const cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          if (expiryTimer) clearTimeout(expiryTimer);
          unsubscribeSession();
          unsubscribeWorkspace();
          event.request.signal.removeEventListener('abort', closeStream);
        };
        const close = () => {
          if (closed) return;
          cleanup();
          controller.close();
        };
        const closeForAuthentication = (type: WorkspaceAuthenticationEvent) => {
          if (closed) return;
          controller.enqueue(encoder.encode(encodeWorkspaceAuthenticationEvent(type)));
          close();
        };
        closeStream = close;
        event.request.signal.addEventListener('abort', close, { once: true });

        if (session.expiresAt !== undefined) {
          expiryTimer = setTimeout(
            () => closeForAuthentication('authentication-expired'),
            Math.max(0, session.expiresAt! - Date.now())
          );
          expiryTimer.unref?.();
        }
        if (session.sessionId) {
          unsubscribeSession = onSessionRevoked(session.sessionId, () =>
            closeForAuthentication('authentication-revoked')
          );
        }

        const subscriber: WorkspaceStatusSubscriber = {
          close,
          send(payload) {
            if (closed) return false;
            controller.enqueue(encoder.encode(encodeWorkspaceEvent(payload)));
            return controller.desiredSize === null || controller.desiredSize > 0;
          },
        };
        void subscribeWorkspaceStatus(subscriber)
          .then((unsubscribe) => {
            if (closed) unsubscribe();
            else unsubscribeWorkspace = unsubscribe;
          })
          .catch(close);
      },
      cancel() {
        closeStream();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: STREAM_HIGH_WATER_MARK_BYTES })
  );

  return new Response(stream, {
    headers: {
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    },
  });
};
