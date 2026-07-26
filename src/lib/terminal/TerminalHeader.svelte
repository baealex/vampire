<script lang="ts">
	import PanelLeft from '@lucide/svelte/icons/panel-left';
	import PanelRight from '@lucide/svelte/icons/panel-right';
	import Minus from '@lucide/svelte/icons/minus';
	import Plus from '@lucide/svelte/icons/plus';
	import StickyNote from '@lucide/svelte/icons/sticky-note';

	let {
		projectName,
		cwd,
		hasNote,
		noteOpen,
		fontSize,
		minimumFontSize,
		maximumFontSize,
		close,
		repositoryOpen,
		changeCount,
		toggleRepository,
		toggleNote,
		decreaseFontSize,
		increaseFontSize
	}: {
		projectName: string;
		cwd: string;
		hasNote: boolean;
		noteOpen: boolean;
		fontSize: number;
		minimumFontSize: number;
		maximumFontSize: number;
		close: () => void;
		repositoryOpen: boolean;
		changeCount: number;
		toggleRepository: () => void;
		toggleNote: () => void;
		decreaseFontSize: () => void;
		increaseFontSize: () => void;
	} = $props();
</script>

<header class="terminal-header">
	<button class="back-button" onclick={close} aria-label="Open workspaces">
		<PanelLeft size={18} strokeWidth={1.8} aria-hidden="true" />
		<span>Workspaces</span>
	</button>
	<div class="terminal-identity">
		<strong>{projectName}</strong>
		<span title={cwd}>{cwd}</span>
	</div>
	<div class="terminal-controls">
		<button
			type="button"
			class="repository-button"
			class:active={repositoryOpen}
			onclick={toggleRepository}
			aria-label={repositoryOpen ? 'Close repository' : 'Open repository'}
			aria-expanded={repositoryOpen}
			title="Repository"
		>
			<PanelRight size={16} strokeWidth={1.8} aria-hidden="true" />
			{#if changeCount > 0}<span aria-label={`${changeCount} changed files`}>{changeCount > 99 ? '99+' : changeCount}</span>{/if}
		</button>
		<button
			type="button"
			class="note-button"
			class:has-note={hasNote}
			class:active={noteOpen}
			onclick={toggleNote}
			aria-label={hasNote ? 'Open workspace note' : 'Add workspace note'}
			aria-expanded={noteOpen}
			title={hasNote ? 'Workspace note' : 'Add a workspace note'}
		>
			<StickyNote size={16} strokeWidth={1.8} aria-hidden="true" />
		</button>
		<div class="font-size-control" role="group" aria-label="Terminal text size">
			<button
				type="button"
				onclick={decreaseFontSize}
				disabled={fontSize <= minimumFontSize}
				aria-label="Decrease terminal text size"
				title="Decrease text size"
			><Minus size={14} strokeWidth={2} aria-hidden="true" /></button>
			<output aria-label={`Terminal text size ${fontSize} pixels`}>{fontSize}</output>
			<button
				type="button"
				onclick={increaseFontSize}
				disabled={fontSize >= maximumFontSize}
				aria-label="Increase terminal text size"
				title="Increase text size"
			><Plus size={14} strokeWidth={2} aria-hidden="true" /></button>
		</div>
	</div>
</header>

<style>
	.terminal-header { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 0.75rem; min-width: 0; padding: max(0.65rem, env(safe-area-inset-top)) max(0.75rem, env(safe-area-inset-right)) 0.65rem max(0.75rem, env(safe-area-inset-left)); border-bottom: 1px solid #2d292a; background: #131112; }
	.back-button { display: inline-flex; align-items: center; gap: 0.25rem; min-height: 2.65rem; padding: 0 0.65rem 0 0.45rem; border: 1px solid #393334; border-radius: 0.55rem; background: #1c191a; color: #eee8e9; font: inherit; font-weight: var(--weight-medium); cursor: pointer; }
	.back-button:hover { background: #282324; }
	.terminal-identity { display: grid; min-width: 0; justify-items: center; gap: 0.18rem; }
	.terminal-identity strong, .terminal-identity span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.terminal-identity strong { font-size: var(--text-body); font-weight: var(--weight-medium); line-height: var(--leading-tight); }
	.terminal-identity span { color: #8e8688; font-family: ui-monospace, monospace; font-size: var(--text-caption); line-height: var(--leading-tight); }
	.terminal-controls { display: flex; align-items: center; justify-content: flex-end; gap: 0.45rem; min-width: 0; }
	.note-button, .repository-button { position: relative; display: grid; place-items: center; width: 2.35rem; height: 2.35rem; padding: 0; border: 1px solid transparent; border-radius: 0.5rem; background: transparent; color: #8e8688; cursor: pointer; }
	.note-button:hover, .note-button.active, .repository-button:hover, .repository-button.active { border-color: #393334; background: #252122; color: #eee8e9; }
	.note-button.has-note { color: #e7b06a; }
	.note-button.has-note::after { position: absolute; top: 0.38rem; right: 0.38rem; width: 0.32rem; height: 0.32rem; border-radius: 50%; background: #e45b67; content: ""; }
	.repository-button span { position: absolute; top: -0.25rem; right: -0.35rem; display: grid; place-items: center; min-width: 1.15rem; height: 1.15rem; padding: 0 0.24rem; border: 2px solid #131112; border-radius: 999px; background: var(--color-accent); color: var(--color-accent-ink); font-size: 0.62rem; font-weight: var(--weight-strong); font-variant-numeric: tabular-nums; }
	.font-size-control { display: inline-grid; grid-template-columns: 1.9rem 2.1rem 1.9rem; align-items: center; height: 1.9rem; overflow: hidden; border: 1px solid #393334; border-radius: 0.42rem; background: #191617; }
	.font-size-control button { display: grid; place-items: center; width: 100%; height: 100%; padding: 0; border: 0; background: transparent; color: #c8c0c2; font: inherit; cursor: pointer; }
	.font-size-control button:hover:not(:disabled) { background: #2a2526; color: #fff; }
	.font-size-control button:disabled { color: #514a4c; cursor: default; }
	.font-size-control output { display: grid; place-items: center; height: 100%; border-inline: 1px solid #332e2f; color: #8e8688; font-family: ui-monospace, monospace; font-size: var(--text-caption); font-variant-numeric: tabular-nums; }

	@media (min-width: 64rem) {
		.terminal-header { grid-template-columns: minmax(0, 1fr) auto; }
		.back-button { display: none; }
		.terminal-identity { justify-items: start; }
	}

	@media (max-width: 32rem) {
		.terminal-header { grid-template-columns: 2.65rem minmax(0, 1fr) auto; }
		.back-button { width: 2.65rem; padding: 0; justify-content: center; }
		.back-button span, .font-size-control { display: none; }
	}
</style>
