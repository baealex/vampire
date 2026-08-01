<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import Play from '@lucide/svelte/icons/play';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import Square from '@lucide/svelte/icons/square';
	import Star from '@lucide/svelte/icons/star';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import type { SessionTerminal } from '$lib/session/types';

	let {
		sessionId,
		processes,
		favoriteCommands,
		starting = false,
		stoppingProcessId,
		updatingFavoriteCommand,
		actionError = '',
		onStart,
		onStop,
		onLoadOutput,
		onFavorite,
		onRemoveFavorite
	}: {
		sessionId: string;
		processes: SessionTerminal[];
		favoriteCommands: string[];
		starting?: boolean;
		stoppingProcessId?: string;
		updatingFavoriteCommand?: string;
		actionError?: string;
		onStart: (command: string) => Promise<SessionTerminal | undefined>;
		onStop: (process: SessionTerminal) => Promise<boolean>;
		onLoadOutput: (processId: string) => Promise<string>;
		onFavorite: (command: string) => Promise<boolean>;
		onRemoveFavorite: (command: string) => Promise<boolean>;
	} = $props();

	let open = $state(false);
	let command = $state('');
	let selectedProcessId = $state<string>();
	let output = $state('');
	let outputError = $state('');
	let outputLoading = $state(false);
	let now = $state(Date.now());
	let commandInput = $state<HTMLInputElement>();
	const orderedProcesses = $derived([...processes].sort((left, right) => left.index - right.index));
	const selectedProcess = $derived(orderedProcesses.find((process) => process.id === selectedProcessId));
	const favoriteSet = $derived(new Set(favoriteCommands));
	const runningCommands = $derived(new Set(
		orderedProcesses
			.filter((process) => process.state === 'running')
			.map(processCommand)
	));

	onMount(() => {
		const timer = window.setInterval(() => now = Date.now(), 1_000);
		return () => window.clearInterval(timer);
	});

	$effect(() => {
		if (selectedProcessId && !orderedProcesses.some((process) => process.id === selectedProcessId)) {
			selectedProcessId = undefined;
			output = '';
			outputError = '';
		}
	});

	$effect(() => {
		const processId = selectedProcessId;
		const expanded = open;
		if (!expanded || !processId) return;
		// Parent loaders close over reactive workspace state. Only expansion and
		// selection should control this polling lifecycle.
		return untrack(() => startOutputPolling(processId));
	});

	function startOutputPolling(processId: string): () => void {
		let disposed = false;
		let refreshing = false;
		const refresh = async (initial = false) => {
			if (refreshing) return;
			refreshing = true;
			if (initial) outputLoading = true;
			try {
				const next = await onLoadOutput(processId);
				if (!disposed) {
					output = next;
					outputError = '';
				}
			} catch (error) {
				if (!disposed) outputError = error instanceof Error ? error.message : 'Unable to read output';
			} finally {
				if (!disposed) outputLoading = false;
				refreshing = false;
			}
		};
		void refresh(true);
		const timer = window.setInterval(() => void refresh(), 1_500);
		return () => {
			disposed = true;
			window.clearInterval(timer);
		};
	}

	function processCommand(process: SessionTerminal): string {
		return process.command || process.name || process.foregroundProcess?.label || 'Background command';
	}

	function processStatus(process: SessionTerminal): string {
		if (process.state === 'running') return 'Running';
		if (process.exitCode === 0) return 'Finished';
		return process.exitCode === null ? 'Exited' : `Failed (${process.exitCode})`;
	}

	function processAge(process: SessionTerminal): string {
		if (!process.startedAt) return '';
		const seconds = Math.max(0, Math.floor((now - process.startedAt) / 1_000));
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `${minutes}m`;
		return `${Math.floor(minutes / 60)}h`;
	}

	function openRunner() {
		open = true;
		queueMicrotask(() => commandInput?.focus());
	}

	function toggleRunner() {
		if (open) {
			open = false;
			return;
		}
		openRunner();
	}

	async function runCommand(value: string): Promise<SessionTerminal | undefined> {
		const normalized = value.trim();
		if (!normalized || starting || runningCommands.has(normalized)) return undefined;
		const process = await onStart(normalized);
		if (!process) return;
		selectedProcessId = process.id;
		output = '';
		outputError = '';
		return process;
	}

	async function startProcess(event: SubmitEvent) {
		event.preventDefault();
		if (!await runCommand(command)) return;
		command = '';
	}

	async function stopProcess(event: MouseEvent, process: SessionTerminal) {
		event.stopPropagation();
		if (await onStop(process) && selectedProcessId === process.id) {
			selectedProcessId = undefined;
			output = '';
			outputError = '';
		}
	}

	function selectProcess(process: SessionTerminal) {
		selectedProcessId = selectedProcessId === process.id ? undefined : process.id;
		output = '';
		outputError = '';
	}

	async function toggleFavorite(event: MouseEvent, process: SessionTerminal) {
		event.stopPropagation();
		const processCommandValue = processCommand(process);
		if (favoriteSet.has(processCommandValue)) await onRemoveFavorite(processCommandValue);
		else await onFavorite(processCommandValue);
	}
</script>

<section class="background-processes" aria-label="Background processes">
	{#if open}
		<div class="background-drawer" id={`background-drawer-${sessionId}`}>
			<div class="background-runner">
				<div>
					<strong>Background</strong>
					<span>Only commands you star are saved.</span>
				</div>
				<form onsubmit={startProcess}>
					<input
						bind:this={commandInput}
						bind:value={command}
						placeholder="Command to run…"
						aria-label="Background command"
						autocomplete="off"
						spellcheck="false"
						maxlength="1000"
					/>
					<button type="submit" disabled={!command.trim() || starting}>{starting ? 'Starting…' : 'Run'}</button>
				</form>
				{#if actionError}<p class="background-error" role="alert">{actionError}</p>{/if}
			</div>

			<div class="favorite-strip" aria-label="Favorite background commands">
				<span class="favorite-heading"><Star size={13} strokeWidth={1.8} aria-hidden="true" /> Favorites</span>
				{#if favoriteCommands.length === 0}
					<span class="favorite-empty">Star a command below to keep it in this workspace.</span>
				{:else}
					<div class="favorite-list">
						{#each favoriteCommands as favoriteCommand (favoriteCommand)}
							<div class="favorite-command" title={favoriteCommand}>
								<code>{favoriteCommand}</code>
								<button
									type="button"
									disabled={starting || runningCommands.has(favoriteCommand)}
									onclick={() => void runCommand(favoriteCommand)}
									aria-label={`Run favorite ${favoriteCommand}`}
									title={runningCommands.has(favoriteCommand) ? 'Already running' : 'Run command'}
								>
									<Play size={13} strokeWidth={2} aria-hidden="true" />
								</button>
								<button
									type="button"
									disabled={Boolean(updatingFavoriteCommand)}
									onclick={() => void onRemoveFavorite(favoriteCommand)}
									aria-label={`Remove ${favoriteCommand} from favorites`}
									title="Remove favorite"
								>
									<Trash2 size={13} strokeWidth={1.9} aria-hidden="true" />
								</button>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<div class="background-content">
				<div class="process-list" aria-label="Background process list">
					{#if orderedProcesses.length === 0}
						<p class="empty-processes">No background commands are running.</p>
					{:else}
						{#each orderedProcesses as process (process.id)}
							<div class="process-row" class:selected={selectedProcessId === process.id}>
								<button
									type="button"
									class="process-summary"
									onclick={() => selectProcess(process)}
									aria-expanded={selectedProcessId === process.id}
									title={processCommand(process)}
								>
									<span class="process-state" class:exited={process.state === 'exited'} aria-hidden="true"></span>
									<code>{processCommand(process)}</code>
									<span>{processStatus(process)}</span>
									{#if processAge(process)}<time>{processAge(process)}</time>{/if}
								</button>
								<div class="process-actions">
									<button
										type="button"
										class="process-icon-action"
										class:favorite={favoriteSet.has(processCommand(process))}
										disabled={Boolean(updatingFavoriteCommand)}
										onclick={(event) => void toggleFavorite(event, process)}
										aria-pressed={favoriteSet.has(processCommand(process))}
										aria-label={favoriteSet.has(processCommand(process)) ? `Remove ${processCommand(process)} from favorites` : `Save ${processCommand(process)} as favorite`}
										title={favoriteSet.has(processCommand(process)) ? 'Remove favorite' : 'Save as favorite'}
									>
										<Star size={14} strokeWidth={1.9} fill={favoriteSet.has(processCommand(process)) ? 'currentColor' : 'none'} aria-hidden="true" />
									</button>
									{#if process.state === 'exited'}
										<button
											type="button"
											class="process-icon-action"
											disabled={starting || runningCommands.has(processCommand(process))}
											onclick={(event) => { event.stopPropagation(); void runCommand(processCommand(process)); }}
											aria-label={`Run ${processCommand(process)} again`}
											title={runningCommands.has(processCommand(process)) ? 'Already running' : 'Run again'}
										>
											<RotateCcw size={14} strokeWidth={1.9} aria-hidden="true" />
										</button>
									{/if}
									<button
										type="button"
										class="stop-process"
										disabled={Boolean(stoppingProcessId)}
										onclick={(event) => void stopProcess(event, process)}
										aria-label={process.state === 'running' ? `Stop ${processCommand(process)}` : `Delete ${processCommand(process)}`}
										title={process.state === 'running' ? 'Stop process' : 'Delete result'}
									>
										{#if process.state === 'running'}<Square size={12} strokeWidth={2} aria-hidden="true" />{:else}<Trash2 size={13} strokeWidth={1.9} aria-hidden="true" />{/if}
										<span>{stoppingProcessId === process.id ? 'Stopping…' : process.state === 'running' ? 'Stop' : 'Delete'}</span>
									</button>
								</div>
							</div>
						{/each}
					{/if}
				</div>

				{#if selectedProcess}
					<section class="process-output" aria-label={`Output for ${processCommand(selectedProcess)}`}>
						<header>
							<code>{processCommand(selectedProcess)}</code>
							<span>read-only output</span>
						</header>
						{#if outputError}
							<p class="background-error" role="alert">{outputError}</p>
						{:else if outputLoading}
							<p class="output-placeholder">Loading output…</p>
						{:else}
							<pre>{output || 'No output yet.'}</pre>
						{/if}
					</section>
				{/if}
			</div>
		</div>
	{/if}

	<footer class="background-bar">
		<button
			type="button"
			class="background-toggle"
			class:open
			onclick={toggleRunner}
			aria-expanded={open}
			aria-controls={`background-drawer-${sessionId}`}
			aria-label={open ? 'Close background commands' : 'Run background command'}
		>
			<ChevronUp size={14} strokeWidth={1.8} aria-hidden="true" />
			<span>Background</span>
			{#if orderedProcesses.length > 0}<span class="process-count">{orderedProcesses.length}</span>{/if}
		</button>
	</footer>
</section>

<style>
	.background-processes { position: relative; z-index: 8; display: grid; min-width: 0; border-top: 1px solid var(--color-border-subtle); background: var(--color-panel); color: var(--color-text); }
	.background-drawer { position: absolute; right: 0; bottom: 100%; left: 0; display: flex; flex-direction: column; height: min(20rem, 52dvh); border: 1px solid var(--color-border-subtle); border-right: 0; border-left: 0; background: var(--color-panel); box-shadow: var(--shadow-terminal-dock); }
	.background-runner { display: grid; grid-template-columns: minmax(11rem, 0.75fr) minmax(16rem, 1.25fr); align-items: center; gap: 0.75rem 1rem; padding: 0.8rem max(0.85rem, env(safe-area-inset-right)) 0.8rem max(0.85rem, env(safe-area-inset-left)); border-bottom: 1px solid var(--color-border-subtle); }
	.background-runner > div { display: grid; gap: 0.12rem; min-width: 0; }
	.background-runner strong { font-size: var(--text-label); font-weight: var(--weight-medium); }
	.background-runner span { overflow: hidden; color: var(--color-text-tertiary); font-size: var(--text-caption); text-overflow: ellipsis; white-space: nowrap; }
	.background-runner form { display: grid; grid-template-columns: minmax(0, 1fr) auto; min-width: 0; }
	.background-runner input { min-width: 0; height: 2.35rem; padding: 0 0.72rem; border: 1px solid var(--color-border); border-right: 0; border-radius: var(--radius-control) 0 0 var(--radius-control); outline: none; background: var(--color-terminal-background); color: var(--color-terminal-foreground); font: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--text-caption); }
	.background-runner input:focus { border-color: var(--color-accent); box-shadow: inset 0 0 0 1px var(--color-accent); }
	.background-runner form button { min-width: 4.5rem; padding: 0 0.85rem; border: 0; border-radius: 0 var(--radius-control) var(--radius-control) 0; background: var(--color-accent); color: var(--color-accent-ink); font: inherit; font-size: var(--text-label); font-weight: var(--weight-medium); cursor: pointer; }
	.background-runner form button:disabled { cursor: wait; opacity: 0.55; }
	.background-error { grid-column: 1 / -1; margin: 0; color: var(--color-danger-text); font-size: var(--text-caption); }
	.favorite-strip { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 0.7rem; min-height: 2.7rem; padding: 0.35rem max(0.85rem, env(safe-area-inset-right)) 0.35rem max(0.85rem, env(safe-area-inset-left)); border-bottom: 1px solid var(--color-border-subtle); }
	.favorite-heading { display: inline-flex; align-items: center; gap: 0.35rem; color: var(--color-text-secondary); font-size: var(--text-caption); font-weight: var(--weight-medium); white-space: nowrap; }
	.favorite-empty { overflow: hidden; color: var(--color-text-disabled); font-size: var(--text-caption); text-overflow: ellipsis; white-space: nowrap; }
	.favorite-list { display: flex; gap: 0.4rem; min-width: 0; overflow-x: auto; scrollbar-width: thin; }
	.favorite-command { display: grid; grid-template-columns: minmax(3rem, auto) 1.9rem 1.9rem; flex: 0 0 auto; align-items: center; max-width: min(24rem, 62vw); overflow: hidden; border: 1px solid var(--color-border); border-radius: var(--radius-control); background: var(--color-surface-sunken); }
	.favorite-command code { min-width: 0; overflow: hidden; padding: 0 0.6rem; color: var(--color-text-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--text-nano); text-overflow: ellipsis; white-space: nowrap; }
	.favorite-command button { display: grid; place-items: center; width: 1.9rem; height: 1.85rem; padding: 0; border: 0; border-left: 1px solid var(--color-border); background: transparent; color: var(--color-text-tertiary); cursor: pointer; }
	.favorite-command button:hover:not(:disabled) { background: var(--color-surface-hover); color: var(--color-text); }
	.favorite-command button:disabled { cursor: default; opacity: 0.42; }
	.background-content { display: grid; grid-template-columns: minmax(17rem, 0.82fr) minmax(0, 1.18fr); flex: 1 1 auto; min-height: 0; overflow: hidden; }
	.process-list { min-width: 0; overflow-y: auto; border-right: 1px solid var(--color-border-subtle); }
	.empty-processes, .output-placeholder { margin: 0; padding: 1rem; color: var(--color-text-tertiary); font-size: var(--text-caption); }
	.process-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; min-width: 0; border-bottom: 1px solid var(--color-border-subtle); }
	.process-row.selected { background: var(--color-surface-selected); }
	.process-summary, .process-icon-action, .stop-process, .background-toggle { border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }
	.process-summary { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 0.5rem; min-width: 0; min-height: 2.85rem; padding: 0.45rem 0.65rem 0.45rem max(0.85rem, env(safe-area-inset-left)); text-align: left; }
	.process-summary:hover, .process-icon-action:hover:not(:disabled), .stop-process:hover:not(:disabled), .background-toggle:hover { background: var(--color-surface-hover); }
	.process-state { width: 0.48rem; height: 0.48rem; border-radius: 50%; background: var(--color-success); box-shadow: var(--shadow-status-active); }
	.process-state.exited { background: var(--color-text-disabled); box-shadow: none; }
	.process-summary code, .process-output code { min-width: 0; overflow: hidden; color: var(--color-text); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--text-caption); font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
	.process-summary > span:not(.process-state), .process-summary time { color: var(--color-text-tertiary); font-size: var(--text-nano); white-space: nowrap; }
	.process-actions { display: flex; align-items: stretch; min-width: 0; }
	.process-icon-action { display: grid; place-items: center; width: 2.25rem; padding: 0; color: var(--color-text-disabled); }
	.process-icon-action.favorite { color: var(--color-warning-accent); }
	.process-icon-action:disabled, .stop-process:disabled { cursor: wait; opacity: 0.5; }
	.stop-process { display: inline-flex; align-items: center; gap: 0.35rem; min-width: 4.6rem; padding: 0 0.7rem; color: var(--color-text-tertiary); font-size: var(--text-caption); }
	.process-output { display: grid; grid-template-rows: auto minmax(0, 1fr); min-width: 0; min-height: 0; background: var(--color-terminal-background); }
	.process-output header { display: flex; align-items: center; gap: 0.55rem; min-width: 0; min-height: 2.4rem; padding: 0 0.8rem; border-bottom: 1px solid var(--color-border-subtle); }
	.process-output header code { flex: 1 1 auto; }
	.process-output header span { flex: 0 0 auto; color: var(--color-text-disabled); font-size: var(--text-nano); }
	.process-output pre { min-width: 0; min-height: 0; overflow: auto; margin: 0; padding: 0.8rem; color: var(--color-terminal-foreground); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--text-caption); line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
	.background-bar { display: flex; align-items: stretch; min-width: 0; height: 2.35rem; padding: 0 max(0.65rem, env(safe-area-inset-right)) env(safe-area-inset-bottom) max(0.65rem, env(safe-area-inset-left)); }
	.background-toggle { display: inline-flex; flex: 1 1 auto; align-items: center; justify-content: flex-start; gap: 0.42rem; min-width: 0; padding: 0 0.55rem; color: var(--color-text-tertiary); font-size: var(--text-caption); text-align: left; }
	.background-toggle :global(svg) { transition: transform 150ms ease; }
	.background-toggle.open :global(svg) { transform: rotate(180deg); }
	.process-count { display: grid; place-items: center; min-width: 1.2rem; height: 1.2rem; padding: 0 0.25rem; border-radius: var(--radius-pill); background: var(--color-surface-raised); color: var(--color-text-secondary); font-size: var(--text-nano); font-variant-numeric: tabular-nums; }

	@media (max-width: 46rem) {
		.background-drawer { height: min(28rem, 68dvh); }
		.background-runner { grid-template-columns: minmax(0, 1fr); gap: 0.55rem; }
		.background-runner > div span { display: none; }
		.favorite-strip { grid-template-columns: minmax(0, 1fr); gap: 0.3rem; }
		.favorite-empty { display: none; }
		.background-content { grid-template-columns: minmax(0, 1fr); }
		.process-list { max-height: 12rem; border-right: 0; border-bottom: 1px solid var(--color-border-subtle); }
		.process-output { min-height: 8rem; }
	}

	@media (prefers-reduced-motion: reduce) {
		.background-toggle :global(svg) { transition: none; }
	}
</style>
