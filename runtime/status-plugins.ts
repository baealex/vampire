import {
	runStatusPluginCommand,
	StatusPluginCommandError,
	type StatusPluginCommandOptions,
	type StatusPluginCommandResult
} from '../src/lib/server/status-plugin-command.ts';
import { parseStatusPluginOutput } from '../src/lib/server/status-plugin-output.ts';
import { readStatusPluginStore, type StatusPluginStore } from '../src/lib/server/status-plugin-store.ts';
import {
	cloneStatusPlugins,
	type StatusPlugin,
	type StatusPluginOutput,
	type StatusPluginSnapshot
} from '../src/lib/status/status-plugin.ts';

const CONFIG_REFRESH_INTERVAL_MS = 1_000;

interface StatusPluginEntry {
	plugin: StatusPlugin;
	executionSignature: string;
	snapshot: StatusPluginSnapshot;
	timer?: NodeJS.Timeout;
	controller?: AbortController;
	running: boolean;
	rerunAfterCurrent: boolean;
}

interface StatusPluginCachedAttempt {
	executionSignature: string;
	snapshot: StatusPluginSnapshot;
	attemptedAt: number;
}

export interface StatusPluginRuntimeOptions {
	readStore?: () => Promise<StatusPluginStore>;
	runCommand?: (
		command: string,
		options?: StatusPluginCommandOptions
	) => Promise<StatusPluginCommandResult>;
	now?: () => number;
	configRefreshIntervalMs?: number;
}

function executionSignature(plugin: StatusPlugin): string {
	return JSON.stringify({ intervalMs: plugin.intervalMs, source: plugin.source });
}

function commandErrorMessage(error: unknown): string {
	if (error instanceof StatusPluginCommandError) {
		if (error.kind === 'timeout') return 'Command timed out after 10 seconds.';
		if (error.kind === 'output-limit') return 'Command output exceeded 32 KB.';
		if (error.kind === 'exit') return `Command exited with code ${error.exitCode ?? 'unknown'}.`;
		if (error.kind === 'spawn') return 'Command could not be started.';
		return 'Command was cancelled.';
	}
	if (error instanceof TypeError) return error.message;
	return 'Plugin execution failed.';
}

function cloneSnapshots(snapshots: readonly StatusPluginSnapshot[]): StatusPluginSnapshot[] {
	return snapshots.map((snapshot) => {
		const cloned = { ...snapshot };
		if (snapshot.menu) {
			cloned.menu = snapshot.menu.map((entry) => entry.type === 'item' && entry.time
				? { ...entry, time: { ...entry.time } }
				: { ...entry });
		}
		return cloned;
	});
}

function cloneSnapshot(snapshot: StatusPluginSnapshot): StatusPluginSnapshot {
	return cloneSnapshots([snapshot])[0]!;
}

export class StatusPluginRuntime {
	#active = false;
	#generation = 0;
	#configurationSignature: string | undefined;
	#plugins: StatusPlugin[] = [];
	#entries = new Map<string, StatusPluginEntry>();
	#attemptCache = new Map<string, StatusPluginCachedAttempt>();
	#configRefreshTimer: NodeJS.Timeout | undefined;
	#refreshPromise: Promise<void> | undefined;
	#startPromise: Promise<void> | undefined;
	#onUpdate: (snapshots: StatusPluginSnapshot[]) => void;
	#readStore: () => Promise<StatusPluginStore>;
	#runCommand: NonNullable<StatusPluginRuntimeOptions['runCommand']>;
	#now: () => number;
	#configRefreshIntervalMs: number;

	constructor(
		onUpdate: (snapshots: StatusPluginSnapshot[]) => void,
		options: StatusPluginRuntimeOptions = {}
	) {
		this.#onUpdate = onUpdate;
		this.#readStore = options.readStore ?? (() => readStatusPluginStore());
		this.#runCommand = options.runCommand ?? runStatusPluginCommand;
		this.#now = options.now ?? Date.now;
		this.#configRefreshIntervalMs = Math.max(10, options.configRefreshIntervalMs ?? CONFIG_REFRESH_INTERVAL_MS);
	}

	start(): Promise<void> {
		if (this.#active) return this.#startPromise ?? Promise.resolve();
		this.#active = true;
		const generation = ++this.#generation;
		const promise = this.refreshConfiguration()
			.then(() => {
				if (!this.#active || generation !== this.#generation) return;
				this.#configRefreshTimer = setInterval(
					() => void this.refreshConfiguration().catch(() => undefined),
					this.#configRefreshIntervalMs
				);
				this.#configRefreshTimer.unref();
			})
			.catch((error) => {
				if (generation === this.#generation) this.stop();
				throw error;
			})
			.finally(() => {
				if (this.#startPromise === promise) this.#startPromise = undefined;
			});
		this.#startPromise = promise;
		return promise;
	}

	stop(): void {
		if (!this.#active && this.#entries.size === 0) return;
		this.#active = false;
		this.#generation += 1;
		if (this.#configRefreshTimer !== undefined) clearInterval(this.#configRefreshTimer);
		this.#configRefreshTimer = undefined;
		for (const entry of this.#entries.values()) this.#disposeEntry(entry);
		this.#entries.clear();
		this.#plugins = [];
		this.#configurationSignature = undefined;
		this.#refreshPromise = undefined;
	}

	snapshots(): StatusPluginSnapshot[] {
		return cloneSnapshots(this.#orderedSnapshots());
	}

	async refreshConfiguration(): Promise<void> {
		if (!this.#active) return;
		if (this.#refreshPromise) return this.#refreshPromise;
		const generation = this.#generation;
		const promise = (async () => {
			const state = await this.#readStore();
			if (!this.#active || generation !== this.#generation) return;
			const plugins = cloneStatusPlugins(state.plugins);
			const signature = JSON.stringify(plugins);
			if (signature === this.#configurationSignature) return;
			const rerunAll = this.#configurationSignature !== undefined;
			this.#configurationSignature = signature;
			this.#applyConfiguration(plugins, rerunAll);
		})();
		this.#refreshPromise = promise;
		try {
			await promise;
		} finally {
			if (this.#refreshPromise === promise) this.#refreshPromise = undefined;
		}
	}

	runNow(pluginId: string): boolean {
		const entry = this.#entries.get(pluginId);
		if (!this.#active || !entry || entry.running) return false;
		if (entry.timer !== undefined) clearTimeout(entry.timer);
		entry.timer = undefined;
		void this.#execute(entry);
		return true;
	}

	#applyConfiguration(plugins: StatusPlugin[], rerunAll: boolean): void {
		const configuredIds = new Set(plugins.map((plugin) => plugin.id));
		for (const id of this.#attemptCache.keys()) {
			if (!configuredIds.has(id)) this.#attemptCache.delete(id);
		}
		const enabledIds = new Set(plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.id));
		for (const [id, entry] of this.#entries) {
			if (!enabledIds.has(id)) {
				this.#disposeEntry(entry);
				this.#entries.delete(id);
			}
		}

		const created: Array<{ entry: StatusPluginEntry; delayMs: number }> = [];
		for (const plugin of plugins) {
			if (!plugin.enabled) continue;
			const signature = executionSignature(plugin);
			const current = this.#entries.get(plugin.id);
			if (current?.executionSignature === signature) {
				current.plugin = plugin;
				current.snapshot = { ...current.snapshot, name: plugin.name };
				if (rerunAll) {
					if (current.running) current.rerunAfterCurrent = true;
					else {
						if (current.timer !== undefined) clearTimeout(current.timer);
						current.timer = undefined;
						this.#schedule(current, 0);
					}
				}
				continue;
			}
			if (current) this.#disposeEntry(current);
			const cached = this.#attemptCache.get(plugin.id);
			const reusableSnapshot = cached?.executionSignature === signature
				? cloneSnapshot(cached.snapshot)
				: undefined;
			const entry: StatusPluginEntry = {
				plugin,
				executionSignature: signature,
				snapshot: reusableSnapshot
					? { ...reusableSnapshot, name: plugin.name }
					: { id: plugin.id, name: plugin.name, state: 'loading' },
				running: false,
				rerunAfterCurrent: false
			};
			this.#entries.set(plugin.id, entry);
			const elapsedMs = reusableSnapshot === undefined
				? plugin.intervalMs
				: Math.max(0, this.#now() - cached!.attemptedAt);
			created.push({
				entry,
				delayMs: rerunAll ? 0 : Math.max(0, plugin.intervalMs - elapsedMs)
			});
		}
		this.#plugins = plugins;
		this.#emit();
		for (const { entry, delayMs } of created) this.#schedule(entry, delayMs);
	}

	#disposeEntry(entry: StatusPluginEntry): void {
		if (entry.timer !== undefined) clearTimeout(entry.timer);
		entry.timer = undefined;
		entry.controller?.abort();
		entry.controller = undefined;
	}

	#schedule(entry: StatusPluginEntry, delayMs: number): void {
		if (!this.#active || this.#entries.get(entry.plugin.id) !== entry) return;
		if (entry.timer !== undefined) clearTimeout(entry.timer);
		entry.timer = setTimeout(() => {
			entry.timer = undefined;
			void this.#execute(entry);
		}, delayMs);
		entry.timer.unref();
	}

	async #execute(entry: StatusPluginEntry): Promise<void> {
		if (!this.#active || entry.running || this.#entries.get(entry.plugin.id) !== entry) return;
		entry.running = true;
		const controller = new AbortController();
		entry.controller = controller;
		try {
			const output = await this.#executePlugin(entry.plugin, controller.signal);
			if (!this.#active || controller.signal.aborted || this.#entries.get(entry.plugin.id) !== entry) return;
			entry.snapshot = {
				id: entry.plugin.id,
				name: entry.plugin.name,
				state: 'ready',
				...output,
				updatedAt: this.#now()
			};
			this.#attemptCache.set(entry.plugin.id, {
				executionSignature: entry.executionSignature,
				snapshot: cloneSnapshot(entry.snapshot),
				attemptedAt: entry.snapshot.updatedAt!
			});
			this.#emit();
		} catch (error) {
			if (!this.#active || controller.signal.aborted || this.#entries.get(entry.plugin.id) !== entry) return;
			const previous = entry.snapshot;
			const hasLastValue = previous.state === 'ready' || previous.state === 'stale';
			entry.snapshot = hasLastValue
				? { ...previous, name: entry.plugin.name, state: 'stale', error: commandErrorMessage(error) }
				: {
					id: entry.plugin.id,
					name: entry.plugin.name,
					state: 'error',
					text: '—',
					error: commandErrorMessage(error),
					updatedAt: this.#now()
				};
			this.#attemptCache.set(entry.plugin.id, {
				executionSignature: entry.executionSignature,
				snapshot: cloneSnapshot(entry.snapshot),
				attemptedAt: this.#now()
			});
			this.#emit();
		} finally {
			entry.running = false;
			if (entry.controller === controller) entry.controller = undefined;
			if (this.#active && this.#entries.get(entry.plugin.id) === entry) {
				const delayMs = entry.rerunAfterCurrent ? 0 : entry.plugin.intervalMs;
				entry.rerunAfterCurrent = false;
				this.#schedule(entry, delayMs);
			}
		}
	}

	async #executePlugin(plugin: StatusPlugin, signal: AbortSignal): Promise<StatusPluginOutput> {
		const result = await this.#runCommand(plugin.source.command, { signal });
		return parseStatusPluginOutput(result.stdout);
	}

	#orderedSnapshots(): StatusPluginSnapshot[] {
		return this.#plugins
			.filter((plugin) => plugin.enabled)
			.map((plugin) => this.#entries.get(plugin.id)?.snapshot)
			.filter((snapshot): snapshot is StatusPluginSnapshot => Boolean(snapshot));
	}

	#emit(): void {
		try {
			this.#onUpdate(cloneSnapshots(this.#orderedSnapshots()));
		} catch {
			// UI delivery failures must not stop plugin scheduling.
		}
	}
}
