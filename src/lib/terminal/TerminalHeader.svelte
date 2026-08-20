<script lang="ts">
	import { Popover } from 'bits-ui';
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import Network from '@lucide/svelte/icons/network';
	import PanelLeft from '@lucide/svelte/icons/panel-left';
	import PanelRight from '@lucide/svelte/icons/panel-right';
	import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	import StickyNote from '@lucide/svelte/icons/sticky-note';
	import type { Snippet } from 'svelte';
	import ListeningPortsDialog from '$lib/system/ListeningPortsDialog.svelte';
	import TerminalDisplayMenu from './TerminalDisplayMenu.svelte';

	let {
		projectName,
		cwd,
		isWorktree,
		repositoryName,
		worktreeBranch,
		hasNote,
		noteOpen,
		fontSize,
		minimumFontSize,
		maximumFontSize,
		close,
		repositoryOpen,
		isGitRepository,
		workspaceAvailable,
		changeCount,
		worktreeCount,
		backgroundOpen,
		backgroundCount,
		backgroundPanelId,
		backgroundTriggerId,
		toggleRepository,
		toggleBackground,
		toggleNote,
		noteEditor,
		decreaseFontSize,
		increaseFontSize
	}: {
		projectName: string;
		cwd: string;
		isWorktree: boolean;
		repositoryName: string;
		worktreeBranch?: string;
		hasNote: boolean;
		noteOpen: boolean;
		fontSize: number;
		minimumFontSize: number;
		maximumFontSize: number;
		close: () => void;
		repositoryOpen: boolean;
		isGitRepository?: boolean;
		workspaceAvailable: boolean;
		changeCount: number;
		worktreeCount: number;
		backgroundOpen: boolean;
		backgroundCount: number;
		backgroundPanelId: string;
		backgroundTriggerId: string;
		toggleRepository: () => void;
		toggleBackground: () => void;
		toggleNote: () => void;
		noteEditor?: Snippet;
		decreaseFontSize: () => void;
		increaseFontSize: () => void;
	} = $props();

	let listeningPortsOpen = $state(false);

	function handleNoteOpenChange(nextOpen: boolean) {
		if (nextOpen !== noteOpen) toggleNote();
	}

</script>

<header class="terminal-header">
	<button class="back-button" onclick={close} aria-label="Open workspaces">
		<PanelLeft size={18} strokeWidth={1.8} aria-hidden="true" />
		<span>Workspaces</span>
	</button>
	<div class="terminal-identity">
		<div class="terminal-identity-title">
			<strong>{projectName}</strong>
			{#if isWorktree}
				<span class="worktree-badge" title={`${repositoryName}${worktreeBranch ? ` · ${worktreeBranch}` : ''}`}>
					<GitBranch size={11} strokeWidth={1.9} aria-hidden="true" />
					Worktree
				</span>
			{/if}
			{#if !workspaceAvailable}
				<span class="working-copy-missing" title="The working directory was removed outside Vampire">Working copy missing</span>
			{/if}
			{#if isGitRepository && worktreeCount > 1}
				<span class="worktree-count" title="Git worktrees in this repository">{worktreeCount > 99 ? '99+' : worktreeCount} worktrees</span>
			{/if}
			<Popover.Root open={noteOpen} onOpenChange={handleNoteOpenChange}>
				<Popover.Trigger
					type="button"
					class={`note-button${hasNote ? ' has-note' : ''}${noteOpen ? ' active' : ''}`}
					aria-label={hasNote ? 'Open workspace note' : 'Add workspace note'}
					aria-expanded={noteOpen}
				>
					<StickyNote size={16} strokeWidth={1.8} aria-hidden="true" />
				</Popover.Trigger>
				<Popover.Portal>
					{#if noteOpen && noteEditor}
						<Popover.Content class="workspace-note-popover" side="bottom" align="start" sideOffset={8}>
							{@render noteEditor()}
						</Popover.Content>
					{/if}
				</Popover.Portal>
			</Popover.Root>
		</div>
		<span title={cwd}>{cwd}</span>
	</div>
	<div class="terminal-controls">
		<div class="terminal-tools" role="group" aria-label="Terminal tools">
			<button
				type="button"
				class="listening-ports-button"
				class:active={listeningPortsOpen}
				onclick={() => listeningPortsOpen = true}
				aria-label="Inspect listening ports"
				aria-expanded={listeningPortsOpen}
			>
				<Network size={16} strokeWidth={1.8} aria-hidden="true" />
				<span>Ports</span>
			</button>
			<TerminalDisplayMenu
				{fontSize}
				{minimumFontSize}
				{maximumFontSize}
				{decreaseFontSize}
				{increaseFontSize}
			/>
			<button
				id={backgroundTriggerId}
				type="button"
				class="background-button"
				class:active={backgroundOpen}
				onclick={toggleBackground}
				aria-label={backgroundOpen ? 'Close background processes' : 'Open background processes'}
				aria-expanded={backgroundOpen}
				aria-controls={backgroundPanelId}
			>
				<SquareTerminal size={16} strokeWidth={1.8} aria-hidden="true" />
				{#if backgroundCount > 0}<span>{backgroundCount > 99 ? '99+' : backgroundCount}</span>{/if}
			</button>
			{#if !repositoryOpen}
				<button
					type="button"
					class="repository-button"
					onclick={toggleRepository}
					aria-label={isGitRepository === false ? 'Open workspace files' : 'Open repository'}
					aria-expanded={repositoryOpen}
				>
					<PanelRight size={16} strokeWidth={1.8} aria-hidden="true" />
					{#if isGitRepository && changeCount > 0}<span aria-label={`${changeCount} changed files`}>{changeCount > 99 ? '99+' : changeCount}</span>{/if}
				</button>
			{/if}
		</div>
	</div>
</header>

{#if listeningPortsOpen}
	<ListeningPortsDialog close={() => listeningPortsOpen = false} />
{/if}

<style>
	.terminal-header { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 0.75rem; min-width: 0; padding: max(0.65rem, env(safe-area-inset-top)) max(0.75rem, env(safe-area-inset-right)) 0.65rem max(0.75rem, env(safe-area-inset-left)); background: var(--color-panel); }
	.back-button { display: inline-flex; align-items: center; gap: 0.25rem; min-height: 2.65rem; padding: 0 0.65rem 0 0.45rem; border: 1px solid var(--color-border); border-radius: 0.55rem; background: var(--color-control-background); color: var(--color-text); font: inherit; font-weight: var(--weight-medium); cursor: pointer; }
	.back-button:hover { background: var(--color-surface-hover); }
	.terminal-identity { display: grid; min-width: 0; justify-items: center; gap: 0.18rem; }
	.terminal-identity-title { display: flex; align-items: center; gap: 0.45rem; min-width: 0; max-width: 100%; }
	.terminal-identity-title strong { min-width: 0; overflow: hidden; font-size: var(--text-body); font-weight: var(--weight-medium); line-height: var(--leading-tight); text-overflow: ellipsis; white-space: nowrap; }
	.terminal-identity > span { max-width: 100%; overflow: hidden; color: var(--color-text-tertiary); font-family: var(--font-mono); font-size: var(--text-caption); line-height: var(--leading-tight); text-overflow: ellipsis; white-space: nowrap; }
	.worktree-count { flex: 0 0 auto; padding: 0.08rem 0.3rem; border: 1px solid var(--color-border); border-radius: var(--radius-pill); color: var(--color-text-tertiary); font-size: var(--text-nano); font-variant-numeric: tabular-nums; line-height: 1.25; }
	.worktree-badge { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 0.2rem; padding: 0.08rem 0.32rem; border: 1px solid var(--color-accent); border-radius: var(--radius-pill); color: var(--color-accent); font-size: var(--text-nano); line-height: 1.25; }
	.working-copy-missing { flex: 0 0 auto; padding: 0.08rem 0.3rem; border: 1px solid var(--color-warning-accent); border-radius: var(--radius-pill); color: var(--color-warning-accent); font-size: var(--text-nano); line-height: 1.25; }
	.terminal-controls { display: flex; align-items: center; justify-content: flex-end; gap: 0.5rem; min-width: max-content; }
	.terminal-tools { display: flex; align-items: center; gap: 0.15rem; }
	:global(.note-button), .background-button, .listening-ports-button, .repository-button { position: relative; display: grid; place-items: center; min-width: 2.35rem; height: 2.35rem; padding: 0; border: 1px solid transparent; border-radius: var(--radius-control); background: transparent; color: var(--color-text-tertiary); font: inherit; cursor: pointer; }
	:global(.note-button), .background-button, .repository-button { width: 2.35rem; }
	.listening-ports-button { grid-auto-flow: column; gap: 0.38rem; padding-inline: 0.55rem; font-size: var(--text-caption); font-weight: var(--weight-medium); }
	:global(.note-button:hover), :global(.note-button:focus-visible), :global(.note-button.active), .background-button:hover, .background-button:focus-visible, .background-button.active, .listening-ports-button:hover, .listening-ports-button:focus-visible, .listening-ports-button.active, .repository-button:hover, .repository-button:focus-visible { border-color: var(--color-border-strong); background: transparent; color: var(--color-text); outline: none; }
	:global(.note-button.has-note) { color: var(--color-command); }
	:global(.note-button.has-note::after) { position: absolute; top: 0.38rem; right: 0.38rem; width: 0.32rem; height: 0.32rem; border-radius: 50%; background: var(--color-accent); content: ""; }
	.background-button span, .repository-button span { position: absolute; z-index: 1; top: -0.18rem; right: -0.28rem; display: grid; place-items: center; min-width: 1.15rem; height: 1.15rem; padding: 0 0.24rem; border-radius: var(--radius-pill); background: var(--color-accent); box-shadow: 0 0 0 2px var(--color-panel); color: var(--color-accent-ink); font-size: var(--text-nano); font-weight: var(--weight-strong); font-variant-numeric: tabular-nums; pointer-events: none; }
	:global(.workspace-note-popover) { z-index: 60; width: min(30rem, calc(100vw - 1rem)); max-width: calc(100vw - 1rem); outline: none; }

	@media (min-width: 64rem) {
		.terminal-header { grid-template-columns: minmax(0, 1fr) auto; }
		.back-button { display: none; }
		.terminal-identity { justify-items: start; }
		.background-button { display: none; }
	}

	@media (max-width: 63.999rem) {
		.terminal-header { gap: 0.5rem; }
		.back-button { width: 2.65rem; padding: 0; justify-content: center; }
		.back-button span, .terminal-identity > span { display: none; }
		.terminal-identity { justify-items: start; }
		:global(.terminal-display-menu) { display: none; }
	}

	@media (max-width: 32rem) {
		.terminal-header { grid-template-columns: 2.75rem minmax(0, 1fr) auto; gap: 0.35rem; padding-inline: max(0.5rem, env(safe-area-inset-left)) max(0.5rem, env(safe-area-inset-right)); }
		.back-button { width: 2.75rem; min-height: 2.75rem; }
		.terminal-identity-title { gap: 0.2rem; }
		.terminal-controls, .terminal-tools { gap: 0; }
		.listening-ports-button span { display: none; }
		:global(.note-button), .background-button, .listening-ports-button, .repository-button { width: 2.75rem; min-width: 2.75rem; height: 2.75rem; }
		.listening-ports-button { padding: 0; }
	}

	@media (max-width: 22rem) {
		.terminal-identity-title strong, .worktree-count, .working-copy-missing { display: none; }
	}
</style>
