import type { WorkspaceTerminal } from '~/lib/shared/contracts/workspace.ts';

type TerminalOverrides = {
  started: Map<string, WorkspaceTerminal>;
  stopped: Set<string>;
};

/**
 * Keeps successful local background-process mutations visible until the
 * workspace stream reports the same state. This prevents an older stream poll
 * from briefly undoing an HTTP mutation that completed after that poll began.
 */
export class BackgroundTerminalReconciler {
  readonly #byWorkspace = new Map<string, TerminalOverrides>();

  applyStarted(workspaceId: string, current: WorkspaceTerminal[], process: WorkspaceTerminal): WorkspaceTerminal[] {
    const overrides = this.#overridesFor(workspaceId);
    overrides.stopped.delete(process.id);
    overrides.started.set(process.id, process);
    if (current.some((terminal) => terminal.id === process.id)) {
      overrides.started.delete(process.id);
    }
    this.#deleteIfEmpty(workspaceId, overrides);

    return [...current.filter((terminal) => terminal.id !== process.id), process].sort(
      (left, right) => left.index - right.index
    );
  }

  applyStopped(workspaceId: string, current: WorkspaceTerminal[], processId: string): WorkspaceTerminal[] {
    const overrides = this.#overridesFor(workspaceId);
    overrides.started.delete(processId);
    overrides.stopped.add(processId);
    if (!current.some((terminal) => terminal.id === processId)) {
      overrides.stopped.delete(processId);
    }
    this.#deleteIfEmpty(workspaceId, overrides);

    return current.filter((terminal) => terminal.id !== processId);
  }

  reconcile(workspaceId: string, incoming: WorkspaceTerminal[]): WorkspaceTerminal[] {
    const overrides = this.#byWorkspace.get(workspaceId);
    if (!overrides) return incoming;

    const incomingIds = new Set(incoming.map((terminal) => terminal.id));
    for (const processId of overrides.started.keys()) {
      if (incomingIds.has(processId)) overrides.started.delete(processId);
    }
    for (const processId of overrides.stopped) {
      if (!incomingIds.has(processId)) overrides.stopped.delete(processId);
    }

    const terminals = incoming.filter((terminal) => !overrides.stopped.has(terminal.id));
    for (const process of overrides.started.values()) {
      if (!incomingIds.has(process.id)) terminals.push(process);
    }

    this.#deleteIfEmpty(workspaceId, overrides);
    return terminals.sort((left, right) => left.index - right.index);
  }

  clearWorkspace(workspaceId: string): void {
    this.#byWorkspace.delete(workspaceId);
  }

  clear(): void {
    this.#byWorkspace.clear();
  }

  #overridesFor(workspaceId: string): TerminalOverrides {
    let overrides = this.#byWorkspace.get(workspaceId);
    if (!overrides) {
      overrides = { started: new Map(), stopped: new Set() };
      this.#byWorkspace.set(workspaceId, overrides);
    }
    return overrides;
  }

  #deleteIfEmpty(workspaceId: string, overrides: TerminalOverrides): void {
    if (overrides.started.size === 0 && overrides.stopped.size === 0) {
      this.#byWorkspace.delete(workspaceId);
    }
  }
}
