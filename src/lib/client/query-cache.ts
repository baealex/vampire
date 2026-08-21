export type QueryLoader<T> = () => Promise<T>;

export interface QuerySnapshot<T> {
  data: T | undefined;
  error: unknown;
  isFetching: boolean;
  isStale: boolean;
  updatedAt: number;
}

export type QuerySubscriber<T> = (snapshot: QuerySnapshot<T>) => void;

interface PendingRequest {
  promise: Promise<unknown>;
  version: number;
}

interface QueryEntry {
  data: unknown;
  error: unknown;
  hasData: boolean;
  isFetching: boolean;
  isStale: boolean;
  pending?: PendingRequest;
  subscribers: Set<QuerySubscriber<unknown>>;
  updatedAt: number;
  version: number;
}

export class QueryCache {
  #entries = new Map<string, QueryEntry>();

  get<T>(key: string): T | undefined {
    const entry = this.#entries.get(key);
    return entry?.hasData ? entry.data as T : undefined;
  }

  has(key: string): boolean {
    return this.#entries.get(key)?.hasData ?? false;
  }

  subscribe<T>(key: string, subscriber: QuerySubscriber<T>): () => void {
    const entry = this.#getOrCreate(key);
    const typedSubscriber = subscriber as QuerySubscriber<unknown>;
    entry.subscribers.add(typedSubscriber);
    subscriber(this.#snapshot<T>(entry));
    return () => entry.subscribers.delete(typedSubscriber);
  }

  fetch<T>(key: string, loader: QueryLoader<T>, force = false): Promise<T> {
    const entry = this.#getOrCreate(key);
    if (!force && entry.hasData && !entry.isStale) return Promise.resolve(entry.data as T);
    if (entry.pending && entry.pending.version === entry.version) return entry.pending.promise as Promise<T>;

    const requestVersion = entry.version;
    entry.error = undefined;
    entry.isFetching = true;
    this.#notify(entry);

    const request = Promise.resolve().then(loader);
    let trackedRequest: Promise<T>;
    trackedRequest = request.then(
      (value) => {
        if (this.#isCurrent(key, entry, requestVersion, trackedRequest)) {
          entry.data = value;
          entry.error = undefined;
          entry.hasData = true;
          entry.isFetching = false;
          entry.isStale = false;
          entry.pending = undefined;
          entry.updatedAt = Date.now();
          this.#notify(entry);
        }
        return value;
      },
      (error: unknown) => {
        if (this.#isCurrent(key, entry, requestVersion, trackedRequest)) {
          entry.error = error;
          entry.isFetching = false;
          entry.pending = undefined;
          this.#notify(entry);
        }
        throw error;
      }
    );
    entry.pending = { promise: trackedRequest, version: requestVersion };
    return trackedRequest;
  }

  invalidate(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    entry.pending = undefined;
    entry.isFetching = false;
    entry.isStale = true;
    entry.version += 1;
    this.#notify(entry);
  }

  set<T>(key: string, value: T): void {
    const entry = this.#getOrCreate(key);
    entry.data = value;
    entry.error = undefined;
    entry.hasData = true;
    entry.isFetching = false;
    entry.isStale = false;
    entry.pending = undefined;
    entry.updatedAt = Date.now();
    entry.version += 1;
    this.#notify(entry);
  }

  clear(): void {
    for (const [key, entry] of this.#entries) {
      entry.data = undefined;
      entry.error = undefined;
      entry.hasData = false;
      entry.isFetching = false;
      entry.isStale = true;
      entry.pending = undefined;
      entry.version += 1;
      this.#notify(entry);
      if (entry.subscribers.size === 0) this.#entries.delete(key);
    }
  }

  #getOrCreate(key: string): QueryEntry {
    const existing = this.#entries.get(key);
    if (existing) return existing;
    const entry: QueryEntry = {
      data: undefined,
      error: undefined,
      hasData: false,
      isFetching: false,
      isStale: true,
      subscribers: new Set(),
      updatedAt: 0,
      version: 0
    };
    this.#entries.set(key, entry);
    return entry;
  }

  #isCurrent(key: string, entry: QueryEntry, version: number, request: Promise<unknown>): boolean {
    return this.#entries.get(key) === entry
      && entry.version === version
      && entry.pending?.promise === request;
  }

  #notify(entry: QueryEntry): void {
    const snapshot = this.#snapshot<unknown>(entry);
    for (const subscriber of entry.subscribers) subscriber(snapshot);
  }

  #snapshot<T>(entry: QueryEntry): QuerySnapshot<T> {
    return {
      data: entry.hasData ? entry.data as T : undefined,
      error: entry.error,
      isFetching: entry.isFetching,
      isStale: entry.isStale,
      updatedAt: entry.updatedAt
    };
  }
}

export const queryCache = new QueryCache();
