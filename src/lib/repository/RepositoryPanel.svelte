<script lang="ts">
	import PanelRightClose from '@lucide/svelte/icons/panel-right-close';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Spinner from '$lib/ui/Spinner.svelte';
	import RepositoryChanges from './RepositoryChanges.svelte';
	import RepositoryFileTree from './RepositoryFileTree.svelte';
	import type { RepositorySelection, RepositorySnapshot, RepositoryTab } from './types';

	let {
		projectName,
		snapshot,
		loading,
		errorMessage,
		selected,
		activeTab = 'changes',
		open,
		onRefresh,
		onLoadDirectory,
		onCreateFile,
		onCreateDirectory,
		onRequestDelete,
		onClose,
		onSelect,
		onTabChange = () => undefined
	}: {
		projectName: string;
		snapshot?: RepositorySnapshot;
		loading: boolean;
		errorMessage: string;
		selected?: RepositorySelection;
		activeTab?: RepositoryTab;
		open: boolean;
		onRefresh: () => void;
		onLoadDirectory: (path: string) => Promise<void>;
		onCreateFile: (directory: string, name: string) => Promise<void>;
		onCreateDirectory: (directory: string, name: string) => Promise<void>;
		onRequestDelete: (path: string, kind: 'file' | 'directory') => void;
		onClose: () => void;
		onSelect: (selection: RepositorySelection) => void;
		onTabChange?: (tab: RepositoryTab) => void;
	} = $props();

	const visibleTab = $derived(snapshot?.isGitRepository === false ? 'files' : activeTab);
</script>

<aside
	class="repository-panel"
	class:open
	aria-label={`${snapshot?.isGitRepository === false ? 'Files' : 'Repository'} for ${projectName}`}
	aria-hidden={!open}
	inert={!open}
>
	<header class="repository-header">
		<div class="repository-title">
			<strong>{snapshot?.isGitRepository === false ? 'Files' : 'Repository'}</strong>
			<span title={projectName}>{projectName}</span>
		</div>
		<div class="repository-actions">
			<button class:spinning={loading} onclick={onRefresh} disabled={loading} aria-label="Refresh repository" title="Refresh repository">
				<RefreshCw size={17} strokeWidth={1.8} aria-hidden="true" />
			</button>
			<button onclick={onClose} aria-label="Close repository" title="Close repository">
				<PanelRightClose size={18} strokeWidth={1.8} aria-hidden="true" />
			</button>
		</div>
	</header>

	{#if snapshot?.isGitRepository !== false}
		<div class="repository-tabs" role="tablist" aria-label="Repository view">
			<button
				type="button"
				role="tab"
				class:active={visibleTab === 'changes'}
				aria-selected={visibleTab === 'changes'}
				onclick={() => onTabChange('changes')}
			>
				Changes
				{#if snapshot?.changes.length}<span>{snapshot.changes.length}</span>{/if}
			</button>
			<button
				type="button"
				role="tab"
				class:active={visibleTab === 'files'}
				aria-selected={visibleTab === 'files'}
				onclick={() => onTabChange('files')}
			>Files</button>
		</div>
	{/if}

	{#if errorMessage}
		<p class="repository-warning" role="status">{errorMessage}</p>
	{/if}

	<div class="repository-content">
		{#if loading && !snapshot}
			<div class="repository-state" aria-live="polite">
				<Spinner size="small" />
				Reading repository…
			</div>
		{:else if !snapshot}
			<div class="repository-state">Repository information is unavailable.</div>
		{:else if visibleTab === 'changes'}
			<RepositoryChanges
				{snapshot}
				{selected}
				{onSelect}
				onOpenFiles={() => onTabChange('files')}
			/>
		{:else}
			<RepositoryFileTree
				{snapshot}
				{selected}
				{onLoadDirectory}
				{onCreateFile}
				{onCreateDirectory}
				{onRequestDelete}
				{onSelect}
			/>
		{/if}
	</div>

	{#if snapshot?.truncated}
		<p class="repository-limit">Some folders contain more entries than shown.</p>
	{/if}
</aside>

<style>
	.repository-panel { position: absolute; z-index: 10; top: 0; right: 0; display: flex; flex-direction: column; width: min(22rem, calc(100% - 3rem)); height: 100%; min-width: 0; min-height: 0; overflow: hidden; transform: translateX(100%); border-left: 1px solid var(--color-border); background: var(--color-panel); box-shadow: var(--shadow-repository-panel); color: var(--color-text); pointer-events: none; transition: transform 180ms ease; }
	.repository-panel.open { transform: translateX(0); pointer-events: auto; }
	.repository-header { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 0.75rem; min-height: 4rem; padding: 0.75rem 0.8rem 0.75rem 1rem; border-bottom: 1px solid var(--color-border); }
	.repository-title { display: grid; min-width: 0; gap: 0.15rem; }
	.repository-title strong, .repository-title span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.repository-title strong { font-size: var(--text-title); font-weight: var(--weight-strong); }
	.repository-title span { color: var(--color-text-tertiary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--text-caption); }
	.repository-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 0.15rem; }
	.repository-actions button { display: grid; place-items: center; width: var(--control-height-md); height: var(--control-height-md); padding: 0; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--color-text-secondary); cursor: pointer; }
	.repository-actions button:hover { background: var(--color-surface-raised); color: var(--color-text); }
	.repository-actions button:disabled { cursor: wait; opacity: 0.6; }
	.repository-actions button.spinning :global(svg) { animation: spin 0.8s linear infinite; }
	.repository-tabs { display: grid; flex: 0 0 auto; grid-template-columns: 1fr 1fr; padding: 0 0.75rem; border-bottom: 1px solid var(--color-border); }
	.repository-tabs button { display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem; min-height: 2.7rem; padding: 0 0.5rem; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--color-text-tertiary); font-size: var(--text-label); font-weight: var(--weight-medium); cursor: pointer; }
	.repository-tabs button:hover { color: var(--color-text); }
	.repository-tabs button.active { border-bottom-color: var(--color-accent); color: var(--color-text); }
	.repository-tabs button span { display: grid; place-items: center; min-width: 1.25rem; height: 1.25rem; padding: 0 0.28rem; border-radius: var(--radius-pill); background: var(--color-accent-soft); color: var(--color-accent-soft-text); font-size: var(--text-micro); font-variant-numeric: tabular-nums; }
	.repository-warning { flex: 0 0 auto; margin: 0; padding: 0.6rem 0.85rem; border-bottom: 1px solid var(--color-danger-border); background: var(--color-danger-surface); color: var(--color-danger-text); font-size: var(--text-caption); line-height: var(--leading-ui); }
	.repository-content { flex: 1 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain; }
	.repository-state { display: flex; align-items: center; justify-content: center; gap: 0.55rem; min-height: 8rem; padding: 1rem; color: var(--color-text-secondary); font-size: var(--text-label); text-align: center; }
	.repository-limit { flex: 0 0 auto; margin: 0; padding: 0.55rem 0.8rem; border-top: 1px solid var(--color-border); color: var(--color-text-tertiary); font-size: var(--text-micro); }

	@keyframes spin { to { transform: rotate(360deg); } }

	@media (max-width: 79.999rem) {
		.repository-panel { position: fixed; z-index: 40; width: min(23rem, calc(100% - 2.5rem)); height: 100dvh; padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom); }
	}

	@media (prefers-reduced-motion: reduce) {
		.repository-actions button.spinning :global(svg) { animation-duration: 1.6s; }
		.repository-panel { transition: none; }
	}
</style>
