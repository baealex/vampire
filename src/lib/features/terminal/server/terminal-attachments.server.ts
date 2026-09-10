export interface TerminalGeometry {
  columns: number;
  rows: number;
}

export interface ManagedTerminalAttachment {
  clientId?: string;
  connectionAttempt?: number;
  sessionId?: string;
  released: boolean;
  setIgnoreSize?: (ignored: boolean) => Promise<void>;
  terminate?: () => void;
}

export interface TerminalAttachmentState<T extends ManagedTerminalAttachment> {
  attachments: Set<T>;
  activeAttachment?: T;
  activationQueue: Promise<void>;
  controlHistory: T[];
  geometry?: TerminalGeometry;
  operationQueue: Promise<void>;
}

export function createTerminalAttachmentState<T extends ManagedTerminalAttachment>(): TerminalAttachmentState<T> {
  return {
    attachments: new Set(),
    activeAttachment: undefined,
    activationQueue: Promise.resolve(),
    controlHistory: [],
    geometry: undefined,
    operationQueue: Promise.resolve(),
  };
}

export function runTerminalOperation<T extends ManagedTerminalAttachment, R>(
  state: TerminalAttachmentState<T>,
  operation: () => Promise<R>,
): Promise<R> {
  const result = state.operationQueue.catch(() => undefined).then(operation);
  state.operationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function activateTerminalAttachment<T extends ManagedTerminalAttachment>(
  state: TerminalAttachmentState<T>,
  attachment: T,
  options: { onlyIfUnclaimed?: boolean; replaces?: T } = {},
): Promise<boolean> {
  const activation = state.activationQueue
    .catch(() => undefined)
    .then(async () => {
      if (attachment.released || !attachment.setIgnoreSize) return false;
      const previous = state.activeAttachment;
      if (options.onlyIfUnclaimed && previous && previous !== attachment && previous !== options.replaces) return false;
      if (previous === attachment) {
        await attachment.setIgnoreSize(false);
        return false;
      }

      state.activeAttachment = attachment;
      try {
        // Make the new controller authoritative before removing the previous one.
        // This avoids a transient tmux state with no size-owning client.
        await attachment.setIgnoreSize(false);
      } catch (error) {
        const fallback = previous && !previous.released && previous.setIgnoreSize ? previous : undefined;
        state.activeAttachment = fallback;
        await Promise.allSettled([attachment.setIgnoreSize(true), fallback?.setIgnoreSize?.(false)]);
        throw error;
      }
      if (attachment.released || state.activeAttachment !== attachment) return false;
      if (previous && !previous.released && previous.setIgnoreSize) {
        try {
          await previous.setIgnoreSize(true);
        } catch {
          // Once the new controller owns a size, an unhealthy former controller
          // must not roll the terminal back to an ownerless state. Disconnect it
          // so tmux cannot keep considering its stale geometry.
          previous.terminate?.();
        }
      }
      if (attachment.released || state.activeAttachment !== attachment) return false;
      // The raw tmux stream already carries the redraw caused by a size
      // handoff. Do not inject an authoritative full-screen replacement into
      // every attachment here; that turns a normal control handoff into a
      // visible reset and can make reconnects oscillate.
      state.controlHistory = state.controlHistory.filter((candidate) => candidate !== attachment);
      state.controlHistory.push(attachment);
      return true;
    });
  state.activationQueue = activation.then(
    () => undefined,
    () => undefined,
  );
  return activation;
}

export function releaseTerminalAttachment<T extends ManagedTerminalAttachment>(
  state: TerminalAttachmentState<T>,
  attachment: T,
): T | undefined {
  if (attachment.released) return undefined;
  const wasActive = state.activeAttachment === attachment;
  attachment.released = true;
  state.attachments.delete(attachment);
  state.controlHistory = state.controlHistory.filter((candidate) => candidate !== attachment);
  if (!wasActive) return undefined;
  state.activeAttachment = undefined;
  return fallbackTerminalAttachment(state);
}

export function fallbackTerminalAttachment<T extends ManagedTerminalAttachment>(
  state: TerminalAttachmentState<T>,
): T | undefined {
  // Prefer the most recent previous controller, but never leave a live terminal
  // without a size-owning client. A viewer already has its latest requested size,
  // so promoting it keeps tmux and every browser on the same geometry.
  return (
    state.controlHistory.findLast((candidate) => !candidate.released && Boolean(candidate.setIgnoreSize)) ??
    [...state.attachments].findLast((candidate) => !candidate.released && Boolean(candidate.setIgnoreSize))
  );
}

export function updateTerminalGeometry<T extends ManagedTerminalAttachment>(
  state: TerminalAttachmentState<T>,
  attachment: T,
  geometry: TerminalGeometry,
): boolean {
  if (state.activeAttachment && state.activeAttachment !== attachment) return false;
  if (state.geometry?.columns === geometry.columns && state.geometry.rows === geometry.rows) return false;
  state.geometry = geometry;
  return true;
}

export function terminalAttachmentKey(workspaceId: string, terminalId?: string): string {
  return `${workspaceId}\u0000${terminalId ?? 'main'}`;
}

export function previousTerminalConnection<T extends ManagedTerminalAttachment>(
  state: TerminalAttachmentState<T>,
  incoming: T,
): T | undefined {
  if (!incoming.clientId) return undefined;
  return [...state.attachments]
    .filter(
      (candidate) =>
        candidate !== incoming &&
        !candidate.released &&
        candidate.clientId === incoming.clientId &&
        candidate.sessionId === incoming.sessionId,
    )
    .sort((left, right) => (right.connectionAttempt ?? 0) - (left.connectionAttempt ?? 0))[0];
}
