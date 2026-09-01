import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';

import { closeRepositoryStatusObservers, observeRepositoryStatus } from './repository-status.server.ts';
import {
  activateTerminalAttachment,
  createTerminalAttachmentState,
  fallbackTerminalAttachment,
  releaseTerminalAttachment,
  runTerminalOperation,
  synchronizeTerminalAttachments,
  terminalAttachmentKey,
  updateTerminalGeometry,
  type ManagedTerminalAttachment,
  type TerminalAttachmentState,
} from '~/lib/features/terminal/server/terminal-attachments.server.ts';
import {
  attachTerminal,
  sendTerminalMessage,
  type TerminalScreenSynchronizer,
  type TerminalSize,
  type TerminalSizeController,
} from '~/lib/features/terminal/server/terminal.server.ts';
import { closeTerminalControlHubs } from '~/lib/features/terminal/server/terminal-control-hub.server.ts';
import { recordWorkspaceOutput, suppressWorkspaceActivity } from './workspace-websocket.server.ts';
import { findWorkspaceConnection } from '~/lib/features/workspace/server/workspace-store.server.ts';
import {
  TERMINAL_GEOMETRY_PROTOCOL_VERSION,
  TERMINAL_OUTPUT_SEQUENCE_PROTOCOL_VERSION,
  TERMINAL_RESET_SCREEN_SYNC_PROTOCOL_VERSION,
  TERMINAL_SIZE_LIMITS,
  TERMINAL_SNAPSHOT_ID_PROTOCOL_VERSION,
} from '~/lib/shared/contracts/terminal-protocol.ts';
import {
  authorizeWebSocketUpgrade,
  installWebSocketHeartbeat,
  rejectWebSocketUpgrade,
  scheduleAuthenticationExpiry,
  webSocketRequestUrl,
} from '~/lib/server/websocket-support.ts';

const MAX_CONNECTIONS = 32;
const MAX_PAYLOAD_BYTES = 72 * 1024;
const HEARTBEAT_INTERVAL_MS = 30_000;
const FALLBACK_ACTIVATION_RETRY_MS = 250;
const FALLBACK_ACTIVATION_ATTEMPTS = 3;
const WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_ID_PATTERN = /^@\d+$/;

interface TerminalAttachment extends ManagedTerminalAttachment {
  socket: WebSocket;
  supportsGeometry: boolean;
  readyPromise: Promise<void>;
  resolveReady: () => void;
  setIgnoreSize?: TerminalSizeController;
  synchronizeScreen?: TerminalScreenSynchronizer;
}

interface WorkspaceAttachmentState extends TerminalAttachmentState<TerminalAttachment> {
  geometryRevision: number;
  inputVersion: number;
  syntheticOutputDepth: number;
  syntheticOutputUntil: number;
}

interface TerminalConnectionContext {
  workspaceId: string;
  terminalId?: string;
  initialSize?: TerminalSize;
  historyLines?: number;
  lazyHistory: boolean;
  claimControl: boolean;
  supportsGeometry: boolean;
  supportsResetScreenSync: boolean;
  supportsSnapshotIds: boolean;
  supportsOutputSequences: boolean;
  expiresAt?: number;
  sessionId?: string;
}

const workspaceAttachmentStates = new Map<string, WorkspaceAttachmentState>();

function getAttachmentState(key: string): WorkspaceAttachmentState {
  let state = workspaceAttachmentStates.get(key);
  if (!state) {
    state = {
      ...createTerminalAttachmentState<TerminalAttachment>(),
      geometryRevision: 0,
      inputVersion: 0,
      syntheticOutputDepth: 0,
      syntheticOutputUntil: 0,
    };
    workspaceAttachmentStates.set(key, state);
  }
  return state;
}

function broadcastTerminalGeometry(state: WorkspaceAttachmentState, geometry: TerminalSize): void {
  for (const attachment of state.attachments) {
    if (!attachment.released && attachment.supportsGeometry) {
      sendTerminalMessage(attachment.socket, {
        type: 'geometry',
        ...geometry,
        active: state.activeAttachment === attachment,
      });
    }
  }
}

async function activateAttachment(
  state: WorkspaceAttachmentState,
  attachment: TerminalAttachment,
  options: { onlyIfUnclaimed?: boolean } = {}
): Promise<void> {
  const changed = await activateTerminalAttachment(state, attachment, options);
  if (changed && attachment.supportsGeometry && !attachment.released) {
    sendTerminalMessage(attachment.socket, { type: 'request-terminal-theme' });
  }
  if (changed && state.geometry) broadcastTerminalGeometry(state, state.geometry);
}

function promoteFallbackAttachment(state: WorkspaceAttachmentState, attempt = 0): void {
  if (state.activeAttachment) return;
  const fallback = fallbackTerminalAttachment(state);
  if (!fallback) return;
  const retryIfUnclaimed = () => {
    if (state.activeAttachment) return;
    if (fallback.released) {
      promoteFallbackAttachment(state, attempt);
      return;
    }
    if (attempt + 1 >= FALLBACK_ACTIVATION_ATTEMPTS) {
      if (state.geometry) broadcastTerminalGeometry(state, state.geometry);
      return;
    }
    const timer = setTimeout(() => promoteFallbackAttachment(state, attempt + 1), FALLBACK_ACTIVATION_RETRY_MS);
    timer.unref();
  };
  void activateAttachment(state, fallback, { onlyIfUnclaimed: true }).then(retryIfUnclaimed, retryIfUnclaimed);
}

function requestedTerminalSize(url: URL): TerminalSize | undefined {
  const columns = Number(url.searchParams.get('columns'));
  const rows = Number(url.searchParams.get('rows'));
  return Number.isInteger(columns) &&
    columns >= TERMINAL_SIZE_LIMITS.minimumColumns &&
    columns <= TERMINAL_SIZE_LIMITS.maximumColumns &&
    Number.isInteger(rows) &&
    rows >= TERMINAL_SIZE_LIMITS.minimumRows &&
    rows <= TERMINAL_SIZE_LIMITS.maximumRows
    ? { columns, rows }
    : undefined;
}

function requestedTerminalHistory(url: URL): number | undefined {
  const value = url.searchParams.get('history');
  if (value === null) return undefined;
  const historyLines = Number(value);
  return Number.isInteger(historyLines) ? historyLines : undefined;
}

export function installTerminalWebSocket(server: HttpServer): () => void {
  const terminalSockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });

  const connectionContexts = new WeakMap<WebSocket, TerminalConnectionContext>();
  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = webSocketRequestUrl(request);
    if (!url || url.pathname !== '/ws/terminal') return;
    if (terminalSockets.clients.size >= MAX_CONNECTIONS) {
      rejectWebSocketUpgrade(socket, 503, 'Service Unavailable');
      return;
    }

    const authorization = authorizeWebSocketUpgrade(request);
    if (!authorization.authorized) {
      rejectWebSocketUpgrade(socket, authorization.status, authorization.reason);
      return;
    }

    const workspaceId = url.searchParams.get('workspace');
    if (!workspaceId || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
      rejectWebSocketUpgrade(socket, 400, 'Bad Request');
      return;
    }
    const terminalId = url.searchParams.get('terminal') ?? undefined;
    if (terminalId !== undefined && !TERMINAL_ID_PATTERN.test(terminalId)) {
      rejectWebSocketUpgrade(socket, 400, 'Bad Request');
      return;
    }
    const initialSize = requestedTerminalSize(url);
    const historyLines = requestedTerminalHistory(url);
    const lazyHistory = url.searchParams.get('history-mode') === 'lazy';
    const claimControl = url.searchParams.get('active') === '1';
    const protocolVersion = Number(url.searchParams.get('protocol'));
    const supportsGeometry = protocolVersion >= TERMINAL_GEOMETRY_PROTOCOL_VERSION;
    const supportsResetScreenSync = protocolVersion >= TERMINAL_RESET_SCREEN_SYNC_PROTOCOL_VERSION;
    const supportsSnapshotIds = protocolVersion >= TERMINAL_SNAPSHOT_ID_PROTOCOL_VERSION;
    const supportsOutputSequences = protocolVersion >= TERMINAL_OUTPUT_SEQUENCE_PROTOCOL_VERSION;
    terminalSockets.handleUpgrade(request, socket, head, (websocket) => {
      connectionContexts.set(websocket, {
        workspaceId,
        terminalId,
        initialSize,
        historyLines,
        lazyHistory,
        claimControl,
        supportsGeometry,
        supportsResetScreenSync,
        supportsSnapshotIds,
        supportsOutputSequences,
        expiresAt: authorization.expiresAt,
        sessionId: authorization.sessionId,
      });
      terminalSockets.emit('connection', websocket, request);
    });
  };

  server.on('upgrade', handleUpgrade);
  terminalSockets.on('connection', (socket) => {
    const context = connectionContexts.get(socket);
    if (!context) {
      socket.close(1011, 'terminal context unavailable');
      return;
    }
    const authentication = scheduleAuthenticationExpiry(socket, context.expiresAt, context.sessionId);

    const attachmentKey = terminalAttachmentKey(context.workspaceId, context.terminalId);
    const state = getAttachmentState(attachmentKey);
    let resolveReady!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const attachment: TerminalAttachment = {
      socket,
      supportsGeometry: context.supportsGeometry,
      released: false,
      readyPromise,
      resolveReady,
      setIgnoreSize: undefined,
      synchronizeScreen: undefined,
      terminate: () => {
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      },
    };
    state.attachments.add(attachment);
    const releaseAttachment = () => {
      attachment.resolveReady();
      const wasActive = state.activeAttachment === attachment;
      const fallback = releaseTerminalAttachment(state, attachment);
      if (wasActive && state.geometry) broadcastTerminalGeometry(state, state.geometry);
      if (fallback) promoteFallbackAttachment(state);
      if (state.attachments.size === 0) workspaceAttachmentStates.delete(attachmentKey);
    };
    const unsubscribeAttachmentAuthorization = authentication.onRevoked(releaseAttachment);
    socket.once('close', () => {
      unsubscribeAttachmentAuthorization();
      releaseAttachment();
    });
    void observeRepositoryStatus(socket, context.workspaceId).catch(() => undefined);

    void findWorkspaceConnection(context.workspaceId)
      .then((connection) => {
        if (!connection) throw new Error('Unknown Vampire workspace.');
        return attachTerminal(socket, connection.tmuxSession, context.initialSize, {
          terminalId: context.terminalId,
          historyLines: context.historyLines,
          lazyHistory: context.lazyHistory,
          ignoreSize: true,
          isAuthorized: authentication.isAuthorized,
          onAuthorizationRevoked: authentication.onRevoked,
          canResize: () =>
            authentication.isAuthorized() && state.activeAttachment === attachment && !attachment.released,
          canReportTerminalColor: () =>
            authentication.isAuthorized() && state.activeAttachment === attachment && !attachment.released,
          getGeometry: () => state.geometry,
          getGeometryRevision: () => state.geometryRevision,
          hasControl: () =>
            authentication.isAuthorized() && state.activeAttachment === attachment && !attachment.released,
          sendGeometry: context.supportsGeometry,
          resetScreenSync: context.supportsResetScreenSync,
          snapshotIds: context.supportsSnapshotIds,
          outputSequences: context.supportsOutputSequences,
          scheduleOperation: (operation) => runTerminalOperation(state, operation),
          onAttached: async (setIgnoreSize, synchronizeScreen) => {
            attachment.setIgnoreSize = setIgnoreSize;
            attachment.synchronizeScreen = synchronizeScreen;
            attachment.resolveReady();
            if (attachment.released || !authentication.isAuthorized()) return;
            // A newly entered workspace may explicitly claim control on its first
            // attachment. Reconnects stay passive, but can fill an unclaimed terminal.
            await activateAttachment(state, attachment, context.claimControl ? {} : { onlyIfUnclaimed: true });
          },
          onActivate: async () => {
            await attachment.readyPromise;
            if (!attachment.released && authentication.isAuthorized()) await activateAttachment(state, attachment);
          },
          onGeometryChange: (geometry) => {
            if (updateTerminalGeometry(state, attachment, geometry)) {
              state.geometryRevision += 1;
              broadcastTerminalGeometry(state, geometry);
            }
          },
          onResizeComplete: async (geometry) => {
            await synchronizeTerminalAttachments(state, geometry);
          },
          onInput: () => {
            state.inputVersion += 1;
            // Once a screen synchronization has finished, genuine input owns
            // the next output even if the previous resize settle window remains.
            if (state.syntheticOutputDepth === 0) state.syntheticOutputUntil = 0;
          },
          onSyntheticOutput: (timestamp) => {
            state.syntheticOutputUntil = Math.max(state.syntheticOutputUntil, timestamp);
          },
          onSyntheticOutputGateChange: (active) => {
            state.syntheticOutputDepth = Math.max(0, state.syntheticOutputDepth + (active ? 1 : -1));
          },
          isOutputSuppressed: () => state.syntheticOutputDepth > 0,
          getInputVersion: () => state.inputVersion,
          onSyntheticActivity: (timestamp) => suppressWorkspaceActivity(context.workspaceId, timestamp),
          isOutputActivity: (timestamp) => timestamp > state.syntheticOutputUntil,
          onOutputActivity: (timestamp) => recordWorkspaceOutput(context.workspaceId, context.terminalId, timestamp),
        });
      })
      .catch(() => {
        socket.close(1011, 'terminal unavailable');
      });
  });
  const closeHeartbeat = installWebSocketHeartbeat(terminalSockets, HEARTBEAT_INTERVAL_MS);

  return () => {
    closeHeartbeat();
    server.off('upgrade', handleUpgrade);
    closeRepositoryStatusObservers();
    for (const socket of terminalSockets.clients) socket.terminate();
    closeTerminalControlHubs();
    terminalSockets.close();
  };
}
