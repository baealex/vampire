<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import FilePlus from '@lucide/svelte/icons/file-plus';
	import FileText from '@lucide/svelte/icons/file-text';
	import Folder from '@lucide/svelte/icons/folder';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import FolderPlus from '@lucide/svelte/icons/folder-plus';
	import ImageIcon from '@lucide/svelte/icons/image';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { WORKSPACE_ENTRY_DRAG_TYPE, workspaceEntryDragText } from '$lib/workspace-entry-drag.ts';
	import RepositoryInlineEntry from './RepositoryInlineEntry.svelte';
	import { buildChangeKindMap, buildVisibleFileTree, isPreviewableImage } from './view';
	import type { RepositorySelection, RepositorySnapshot } from './types';

	let {
		snapshot,
		selected,
		onLoadDirectory,
		onCreateFile,
		onCreateDirectory,
		onRequestDelete,
		onSelect
	}: {
		snapshot: RepositorySnapshot;
		selected?: RepositorySelection;
		onLoadDirectory: (path: string) => Promise<void>;
		onCreateFile: (directory: string, name: string) => Promise<void>;
		onCreateDirectory: (directory: string, name: string) => Promise<void>;
		onRequestDelete: (path: string, kind: 'file' | 'directory') => void;
		onSelect: (selection: RepositorySelection) => void;
	} = $props();

	let expandedDirectories = $state<string[]>([]);
	let inlineCreation = $state<{ kind: 'file' | 'directory'; parent: string }>();
	let creationName = $state('');
	let creationError = $state('');
	let creating = $state(false);
	let loadingDirectories = $state<string[]>([]);
	let draggingPath = $state('');
	let treeRows = $derived(buildVisibleFileTree(snapshot.files, expandedDirectories, snapshot.directories));
	let changeKinds = $derived(buildChangeKindMap(snapshot.changes));
	let revealRequestPath = '';
	let revealRequestId = 0;

	function beginEntryDrag(event: DragEvent, path: string, kind: 'file' | 'directory') {
		if (!event.dataTransfer) return;
		const entry = { path, kind };
		event.dataTransfer.effectAllowed = 'copy';
		event.dataTransfer.setData(WORKSPACE_ENTRY_DRAG_TYPE, JSON.stringify(entry));
		event.dataTransfer.setData('text/plain', workspaceEntryDragText(entry));
		draggingPath = path;
	}

	function endEntryDrag() {
		draggingPath = '';
	}

	async function toggleDirectory(path: string) {
		if (expandedDirectories.includes(path)) {
			expandedDirectories = expandedDirectories.filter((directory) => directory !== path);
			return;
		}
		if (loadingDirectories.includes(path)) return;
		loadingDirectories = [...loadingDirectories, path];
		try {
			await onLoadDirectory(path);
			expandedDirectories = [...expandedDirectories, path];
		} catch {
			// The parent workbench exposes the request error in the repository panel.
		} finally {
			loadingDirectories = loadingDirectories.filter((directory) => directory !== path);
		}
	}

	function beginCreation(kind: 'file' | 'directory', parent: string) {
		inlineCreation = { kind, parent };
		creationName = '';
		creationError = '';
		if (parent && !expandedDirectories.includes(parent)) expandedDirectories = [...expandedDirectories, parent];
	}

	function cancelCreation() {
		if (creating) return;
		inlineCreation = undefined;
		creationName = '';
		creationError = '';
	}

	function validateCreationName(name: string): string | undefined {
		if (!name) return 'Enter a name.';
		if (name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
			return 'Use a single file or folder name.';
		}
		return undefined;
	}

	async function submitCreation() {
		if (!inlineCreation || creating) return;
		const name = creationName.trim();
		const validationError = validateCreationName(name);
		if (validationError) {
			creationError = validationError;
			return;
		}

		creating = true;
		creationError = '';
		try {
			if (inlineCreation.kind === 'file') await onCreateFile(inlineCreation.parent, name);
			else await onCreateDirectory(inlineCreation.parent, name);
			inlineCreation = undefined;
			creationName = '';
		} catch (error) {
			creationError = error instanceof Error ? error.message : 'The entry could not be created.';
		} finally {
			creating = false;
		}
	}

	function selectFile(path: string) {
		cancelCreation();
		onSelect({ kind: 'file', path });
	}

	async function revealFilePath(path: string, requestId: number) {
		const parts = path.split('/').filter(Boolean);
		let directory = '';
		for (let index = 0; index < parts.length - 1; index += 1) {
			if (requestId !== revealRequestId) return;
			directory = directory ? `${directory}/${parts[index]}` : parts[index];
			try {
				await onLoadDirectory(directory);
			} catch {
				return;
			}
			if (requestId !== revealRequestId) return;
			if (!expandedDirectories.includes(directory)) expandedDirectories = [...expandedDirectories, directory];
		}
	}

	$effect(() => {
		const targetPath = selected?.kind === 'file' ? selected.path : '';
		if (!targetPath) {
			revealRequestPath = '';
			return;
		}
		if (targetPath === revealRequestPath) return;
		revealRequestPath = targetPath;
		const requestId = ++revealRequestId;
		void revealFilePath(targetPath, requestId);
	});
</script>

<div role="tabpanel" aria-label="Workspace files">
	<div class="file-toolbar" role="toolbar" aria-label="Add workspace files">
		<span>Workspace files</span>
		<div class="file-toolbar-actions">
			<button type="button" onclick={() => beginCreation('file', '')} aria-label="Create file in workspace root" title="New file">
				<FilePlus size={15} strokeWidth={1.8} aria-hidden="true" />
				<span>File</span>
			</button>
			<button type="button" onclick={() => beginCreation('directory', '')} aria-label="Create folder in workspace root" title="New folder">
				<FolderPlus size={15} strokeWidth={1.8} aria-hidden="true" />
				<span>Folder</span>
			</button>
		</div>
	</div>
	{#if treeRows.length === 0 && !inlineCreation}
		<div class="repository-empty">
			<strong>No files yet</strong>
			<p>Create a file or folder from the toolbar above.</p>
		</div>
	{:else}
		<div class="file-tree">
			{#if inlineCreation?.parent === ''}
				<RepositoryInlineEntry
					kind={inlineCreation.kind}
					bind:value={creationName}
					error={creationError}
					{creating}
					onSubmit={() => void submitCreation()}
					onCancel={cancelCreation}
				/>
			{/if}
			{#each treeRows as row (row.path)}
				{@const changeKind = changeKinds.get(row.path)}
				<div class="tree-row-shell" class:directory={row.kind === 'directory'} class:dragging={draggingPath === row.path} class:selected={selected?.kind === 'file' && selected.path === row.path}>
					<button
						type="button"
						class="tree-row"
						class:modified={changeKind === 'modified'}
						class:added={changeKind === 'added'}
						draggable={true}
						ondragstart={(event) => beginEntryDrag(event, row.path, row.kind)}
						ondragend={endEntryDrag}
						onclick={() => row.kind === 'directory' ? void toggleDirectory(row.path) : selectFile(row.path)}
						aria-busy={row.kind === 'directory' && loadingDirectories.includes(row.path)}
						aria-expanded={row.kind === 'directory' ? expandedDirectories.includes(row.path) : undefined}
						aria-label={row.kind === 'directory' ? `${expandedDirectories.includes(row.path) ? 'Collapse' : 'Expand'} ${row.path}` : `Open ${row.path}`}
					>
						<span class="tree-indent" aria-hidden="true">
							{#each Array(row.depth) as _}<span></span>{/each}
						</span>
						{#if row.kind === 'directory'}
							<span class="tree-chevron" aria-hidden="true">
								{#if expandedDirectories.includes(row.path)}<ChevronDown size={14} strokeWidth={1.8} />{:else}<ChevronRight size={14} strokeWidth={1.8} />{/if}
							</span>
							<span class="tree-icon" class:modified={changeKind === 'modified'} class:added={changeKind === 'added'} aria-hidden="true">
								{#if expandedDirectories.includes(row.path)}<FolderOpen size={15} strokeWidth={1.7} />{:else}<Folder size={15} strokeWidth={1.7} />{/if}
							</span>
						{:else}
							<span class="tree-chevron" aria-hidden="true"></span>
							<span class="tree-icon file" class:image={isPreviewableImage(row.path)} class:modified={changeKind === 'modified'} class:added={changeKind === 'added'} aria-hidden="true">
								{#if isPreviewableImage(row.path)}<ImageIcon size={15} strokeWidth={1.6} />{:else}<FileText size={15} strokeWidth={1.6} />{/if}
							</span>
						{/if}
						<span class="tree-name" title={row.path}>{row.name}</span>
					</button>
					<div class="tree-actions">
						{#if row.kind === 'directory'}
							<button type="button" onclick={(event) => { event.stopPropagation(); beginCreation('file', row.path); }} aria-label={`Create file in ${row.path}`} title="New file here">
								<FilePlus size={14} strokeWidth={1.8} aria-hidden="true" />
							</button>
							<button type="button" onclick={(event) => { event.stopPropagation(); beginCreation('directory', row.path); }} aria-label={`Create folder in ${row.path}`} title="New folder here">
								<FolderPlus size={14} strokeWidth={1.8} aria-hidden="true" />
							</button>
						{/if}
						<button
							type="button"
							onclick={(event) => { event.stopPropagation(); onRequestDelete(row.path, row.kind); }}
							aria-label={`Delete ${row.kind === 'directory' ? 'folder' : 'file'} ${row.path}`}
							title={`Delete ${row.kind === 'directory' ? 'folder' : 'file'}`}
						>
							<Trash2 size={14} strokeWidth={1.8} aria-hidden="true" />
						</button>
					</div>
				</div>
				{#if inlineCreation?.parent === row.path}
					<RepositoryInlineEntry
						kind={inlineCreation.kind}
						depth={row.depth + 1}
						nested
						bind:value={creationName}
						error={creationError}
						{creating}
						onSubmit={() => void submitCreation()}
						onCancel={cancelCreation}
					/>
				{/if}
			{/each}
		</div>
	{/if}
</div>

<style>
	.repository-empty { padding: 1.5rem 1rem; }
	.repository-empty strong { font-size: var(--text-body); font-weight: var(--weight-medium); }
	.repository-empty p { margin: 0.35rem 0 0; color: var(--color-text-secondary); font-size: var(--text-caption); line-height: var(--leading-body); }
	.file-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 0.65rem; min-height: 2.7rem; padding: 0.35rem 0.65rem 0.35rem 0.85rem; border-bottom: 1px solid var(--color-border); color: var(--color-text-secondary); font-size: var(--text-caption); }
	.file-toolbar-actions { display: flex; align-items: center; gap: 0.25rem; }
	.file-toolbar-actions button { display: inline-flex; align-items: center; gap: 0.3rem; min-height: 2rem; padding: 0 0.45rem; border: 1px solid var(--color-border); border-radius: var(--radius-xs); background: var(--color-control-background); color: var(--color-text-secondary); font-size: var(--text-caption); cursor: pointer; }
	.file-toolbar-actions button:hover { background: var(--color-control-hover); color: var(--color-text); }
	.file-tree { padding: 0.35rem 0; }
	.tree-row-shell { display: flex; align-items: center; min-width: 0; min-height: 2rem; border-bottom: 1px solid transparent; }
	.tree-row-shell:hover, .tree-row-shell.selected { background: var(--color-surface-raised); }
	.tree-row-shell.selected { background: var(--color-surface-active); }
	.tree-row-shell.dragging { opacity: 0.45; }
	.tree-row { display: flex; flex: 1 1 auto; align-items: center; width: 0; min-width: 0; min-height: 2rem; padding: 0 0.2rem 0 0.65rem; border: 0; background: transparent; color: var(--color-text-secondary); text-align: left; cursor: pointer; }
	.tree-row[draggable="true"] { cursor: grab; }
	.tree-row-shell.dragging .tree-row { cursor: grabbing; }
	.tree-row:hover, .tree-row-shell.selected .tree-row { color: var(--color-text); }
	.tree-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 0.05rem; padding-right: 0.35rem; }
	.tree-actions button { display: grid; place-items: center; width: 1.8rem; height: 1.8rem; padding: 0; border: 0; border-radius: 0.35rem; background: transparent; color: var(--color-text-tertiary); cursor: pointer; }
	.tree-actions button:hover, .tree-actions button:focus-visible { background: var(--color-control-hover); color: var(--color-text); }
	.tree-indent { display: inline-flex; flex: 0 0 auto; }
	.tree-indent > span { width: 0.72rem; }
	.tree-chevron { display: grid; flex: 0 0 1rem; place-items: center; width: 1rem; color: var(--color-text-tertiary); }
	.tree-icon { display: grid; flex: 0 0 1.35rem; place-items: center; width: 1.35rem; color: var(--color-folder); }
	.tree-icon.file { color: var(--color-text-tertiary); }
	.tree-icon.file.image { color: var(--color-image); }
	.tree-name { min-width: 0; overflow: hidden; font-family: var(--font-mono); font-size: var(--text-caption); text-overflow: ellipsis; white-space: nowrap; }
	.tree-row.modified, .tree-row.modified:hover, .tree-row-shell.selected .tree-row.modified, .tree-row.modified .tree-icon { color: var(--color-warning); }
	.tree-row.added, .tree-row.added:hover, .tree-row-shell.selected .tree-row.added, .tree-row.added .tree-icon { color: var(--color-info); }
</style>
