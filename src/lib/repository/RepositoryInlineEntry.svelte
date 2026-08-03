<script lang="ts">
	import { tick } from 'svelte';
	import FilePlus from '@lucide/svelte/icons/file-plus';
	import FolderPlus from '@lucide/svelte/icons/folder-plus';

	let {
		kind,
		depth = 0,
		nested = false,
		value = $bindable(),
		error = '',
		creating = false,
		onSubmit,
		onCancel
	}: {
		kind: 'file' | 'directory';
		depth?: number;
		nested?: boolean;
		value: string;
		error?: string;
		creating?: boolean;
		onSubmit: () => void;
		onCancel: () => void;
	} = $props();

	let input = $state<HTMLInputElement>();

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			onSubmit();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			onCancel();
		}
	}

	$effect(() => {
		void tick().then(() => {
			input?.focus();
			input?.select();
		});
	});
</script>

<div class="tree-create-row" class:nested data-inline-repository-entry="true">
	<span class="tree-indent" aria-hidden="true">
		{#each Array(depth) as _}<span></span>{/each}
	</span>
	<span class="tree-chevron" aria-hidden="true"></span>
	<span class="tree-icon" aria-hidden="true">
		{#if kind === 'directory'}<FolderPlus size={15} strokeWidth={1.7} />{:else}<FilePlus size={15} strokeWidth={1.7} />{/if}
	</span>
	<input
		bind:this={input}
		bind:value
		class:error={Boolean(error)}
		placeholder={kind === 'directory' ? 'Folder name' : 'File name'}
		aria-label={kind === 'directory' ? 'New folder name' : 'New file name'}
		autocomplete="off"
		spellcheck="false"
		disabled={creating}
		onkeydown={handleKeydown}
	/>
	<button type="button" onclick={onSubmit} disabled={creating} aria-label="Create" title="Create">↵</button>
	<button type="button" onclick={onCancel} disabled={creating} aria-label="Cancel" title="Cancel">×</button>
</div>
{#if error}<p class="tree-create-error" class:nested-error={nested}>{error}</p>{/if}

<style>
	.tree-create-row { display: flex; align-items: center; min-width: 0; min-height: 2rem; padding: 0 0.35rem 0 0.65rem; background: var(--color-surface-active); }
	.tree-create-row.nested { background: var(--color-surface-raised); }
	.tree-create-row input { flex: 1 1 auto; min-width: 0; height: 1.7rem; padding: 0 0.4rem; border: 1px solid var(--color-accent); border-radius: 0.35rem; outline: none; background: var(--color-field-background); color: var(--color-text); font-family: var(--font-mono); font-size: var(--text-caption); }
	.tree-create-row input::placeholder { color: var(--color-field-placeholder); }
	.tree-create-row input.error { border-color: var(--color-danger-border-strong); }
	.tree-create-row button { display: grid; flex: 0 0 1.8rem; place-items: center; width: 1.8rem; height: 1.8rem; padding: 0; border: 0; border-radius: 0.35rem; background: transparent; color: var(--color-text-secondary); font-size: 1rem; cursor: pointer; }
	.tree-create-row button:hover:not(:disabled), .tree-create-row button:focus-visible { background: var(--color-control-hover); color: var(--color-text); }
	.tree-create-row button:disabled { cursor: wait; opacity: 0.5; }
	.tree-create-error { margin: -0.15rem 0 0.35rem; padding: 0 0.7rem 0 2.95rem; color: var(--color-danger-text); font-size: var(--text-micro); line-height: var(--leading-ui); }
	.tree-create-error.nested-error { padding-left: 3.7rem; }
	.tree-indent { display: inline-flex; flex: 0 0 auto; }
	.tree-indent > span { width: 0.72rem; }
	.tree-chevron { display: grid; flex: 0 0 1rem; place-items: center; width: 1rem; color: var(--color-text-tertiary); }
	.tree-icon { display: grid; flex: 0 0 1.35rem; place-items: center; width: 1.35rem; color: var(--color-folder); }
</style>
