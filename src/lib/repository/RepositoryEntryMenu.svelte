<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import FilePlus from '@lucide/svelte/icons/file-plus';
	import FolderPlus from '@lucide/svelte/icons/folder-plus';
	import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import DropdownMenuShell from '$lib/ui/DropdownMenuShell.svelte';
	import type { WorkspaceEntryKind } from './types';

	let {
		path,
		kind,
		open = false,
		onOpenChange,
		onCreateFile,
		onCreateFolder,
		onInsertPath,
		onDelete
	}: {
		path: string;
		kind: WorkspaceEntryKind;
		open?: boolean;
		onOpenChange: (open: boolean) => void;
		onCreateFile: () => void;
		onCreateFolder: () => void;
		onInsertPath: () => void;
		onDelete: () => void;
	} = $props();

	const name = $derived(path.split('/').pop() || path);
</script>

<DropdownMenuShell
	{open}
	{onOpenChange}
	triggerLabel={`Actions for ${kind === 'directory' ? 'folder' : 'file'} ${path}`}
	triggerTitle="More actions"
	triggerClass="repository-entry-menu-trigger"
	align="end"
>
	{#snippet trigger()}
		<Ellipsis size={16} strokeWidth={1.9} aria-hidden="true" />
	{/snippet}

	{#snippet children()}
		<div class="vampire-menu-heading" role="presentation">
			<strong>{name}</strong>
			<span>{kind === 'directory' ? 'Folder actions' : 'File actions'}</span>
		</div>
		<DropdownMenu.Separator class="vampire-menu-separator" />
		{#if kind === 'directory'}
			<DropdownMenu.Item class="vampire-menu-item" onSelect={onCreateFile}>
				<FilePlus size={16} strokeWidth={1.8} aria-hidden="true" />
				New file
			</DropdownMenu.Item>
			<DropdownMenu.Item class="vampire-menu-item" onSelect={onCreateFolder}>
				<FolderPlus size={16} strokeWidth={1.8} aria-hidden="true" />
				New folder
			</DropdownMenu.Item>
			<DropdownMenu.Separator class="vampire-menu-separator" />
		{/if}
		<DropdownMenu.Item class="vampire-menu-item" onSelect={onInsertPath}>
			<SquareTerminal size={16} strokeWidth={1.8} aria-hidden="true" />
			Insert path into terminal
		</DropdownMenu.Item>
		<DropdownMenu.Separator class="vampire-menu-separator" />
		<DropdownMenu.Item class="vampire-menu-item danger" onSelect={onDelete}>
			<Trash2 size={16} strokeWidth={1.8} aria-hidden="true" />
			Delete
		</DropdownMenu.Item>
	{/snippet}
</DropdownMenuShell>

<style>
	:global(.repository-entry-menu-trigger) { display: grid; place-items: center; width: 1.8rem; height: 1.8rem; padding: 0; border: 0; border-radius: 0.35rem; background: transparent; color: var(--color-text-tertiary); cursor: pointer; }
	:global(.repository-entry-menu-trigger:hover), :global(.repository-entry-menu-trigger:focus-visible), :global(.repository-entry-menu-trigger[data-state='open']) { background: var(--color-control-hover); color: var(--color-text); }
</style>
