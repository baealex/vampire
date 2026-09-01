export interface TerminalGeometry {
  columns: number;
  rows: number;
}

export interface ManagedTerminalAttachment {
  released: boolean;
  setIgnoreSize?: (ignored: boolean) => Promise<void>;
  synchronizeScreen?: (geometry?: TerminalGeometry) => Promise<void>;
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
  operation: () => Promise<R>
): Promise<R> {
  const result = state.operationQueue.catch(() => undefined).then(operation);
  state.operationQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

export async function synchronizeTerminalAttachments<T extends ManagedTerminalAttachment>(
  state: TerminalAttachmentState<T>,
  geometry: TerminalGeometry | undefined,
  excluded?: T
): Promise<void> {
  await Promise.all(
    [...state.attachments]
      .filter((candidate) => candidate !== excluded && !candidate.released && Boolean(candidate.synchronizeScreen))
      .map(async (candidate) => {
        try {
          await candidate.synchronizeScreen?.(geometry);
        } catch {
          // A subscriber that cannot accept the authoritative frame must start
          // a fresh connection. Do not leave its delivery fence permanently
          // paused, and do not let it roll back the shared pane geometry.
          candidate.terminate?.();
        }
      })
  );
}

export function activateTerminalAttachment<T extends ManagedTerminalAttachment>(
  state: TerminalAttachmentState<T>,
  attachment: T,
  options: { onlyIfUnclaimed?: boolean } = {}
): Promise<boolean> {
  const activation = state.activationQueue
    .catch(() => undefined)
    .then(async () => {
      if (attachment.released || !attachment.setIgnoreSize) return false;
      const previous = state.activeAttachment;
      let unhealthyPrevious: T | undefined;
      if (options.onlyIfUnclaimed && previous && previous !== attachment) return false;
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
          unhealthyPrevious = previous;
          previous.terminate?.();
        }
      }
      if (attachment.released || state.activeAttachment !== attachment) return false;
      // A browser that misses a redraw can recover independently. Layout
      // ownership must survive a transient synchronization failure.
      await synchronizeTerminalAttachments(state, state.geometry, unhealthyPrevious);
      if (attachment.released || state.activeAttachment !== attachment) return false;
      state.controlHistory = state.controlHistory.filter((candidate) => candidate !== attachment);
      state.controlHistory.push(attachment);
      return true;
    });
  state.activationQueue = activation.then(
    () => undefined,
    () => undefined
  );
  return activation;
}

export function releaseTerminalAttachment<T extends ManagedTerminalAttachment>(
  state: TerminalAttachmentState<T>,
  attachment: T
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
  state: TerminalAttachmentState<T>
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
  geometry: TerminalGeometry
): boolean {
  if (state.activeAttachment && state.activeAttachment !== attachment) return false;
  if (state.geometry?.columns === geometry.columns && state.geometry.rows === geometry.rows) return false;
  state.geometry = geometry;
  return true;
}

export function terminalAttachmentKey(workspaceId: string, terminalId?: string): string {
  return `${workspaceId}\u0000${terminalId ?? 'main'}`;
}
