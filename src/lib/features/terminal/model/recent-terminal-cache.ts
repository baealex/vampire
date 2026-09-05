interface RecentTerminal {
  canSuspend: boolean;
  suspend(): void;
  dispose(): void;
}

interface CacheEntry<T> {
  value: T;
  timer: ReturnType<typeof setTimeout>;
}

/** Keeps only a few recently visited terminals warm; active terminals are not owned by this cache. */
export class RecentTerminalCache<T extends RecentTerminal> {
  #entries = new Map<string, CacheEntry<T>>();
  #maximum: number;
  #lifetimeMs: number;

  constructor(maximum = 3, lifetimeMs = 30_000) {
    this.#maximum = maximum;
    this.#lifetimeMs = lifetimeMs;
  }

  take(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    this.#entries.delete(key);
    if (!entry.value.canSuspend) {
      entry.value.dispose();
      return undefined;
    }
    return entry.value;
  }

  release(key: string, value: T): void {
    this.#remove(key);
    if (!value.canSuspend || this.#maximum <= 0) {
      value.dispose();
      return;
    }
    value.suspend();
    const timer = setTimeout(() => this.#remove(key), this.#lifetimeMs);
    this.#entries.set(key, { value, timer });
    while (this.#entries.size > this.#maximum) this.#remove(this.#entries.keys().next().value!);
  }

  clear(): void {
    for (const key of this.#entries.keys()) this.#remove(key);
  }

  #remove(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.#entries.delete(key);
    entry.value.dispose();
  }
}

export function terminalSessionKey(workspaceId: string, terminalId?: string): string {
  return JSON.stringify([workspaceId, terminalId ?? null]);
}
