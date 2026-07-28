<script lang="ts">
	import { tick } from 'svelte';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import FilePlus from '@lucide/svelte/icons/file-plus';
	import FileText from '@lucide/svelte/icons/file-text';
	import Folder from '@lucide/svelte/icons/folder';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import FolderPlus from '@lucide/svelte/icons/folder-plus';
	import ImageIcon from '@lucide/svelte/icons/image';
	import PanelRightClose from '@lucide/svelte/icons/panel-right-close';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { WORKSPACE_ENTRY_DRAG_TYPE, workspaceEntryDragText } from '$lib/workspace-entry-drag.mjs';
	import { buildVisibleFileTree, changeBadge, describeChange, isPreviewableImage } from './view';
	import type { RepositorySelection, RepositorySnapshot } from './types';

	let {
		projectName,
		snapshot,
		loading,
		errorMessage,
		selected,
		open,
		onRefresh,
		onLoadDirectory,
		onCreateFile,
		onCreateDirectory,
		onRequestDelete,
		onClose,
		onSelect
	}: {
		projectName: string;
		snapshot?: RepositorySnapshot;
		loading: boolean;
		errorMessage: string;
		selected?: RepositorySelection;
		open: boolean;
		onRefresh: () => void;
		onLoadDirectory: (path: string) => Promise<void>;
		onCreateFile: (directory: string, name: string) => Promise<void>;
		onCreateDirectory: (directory: string, name: string) => Promise<void>;
		onRequestDelete: (path: string, kind: 'file' | 'directory') => void;
		onClose: () => void;
		onSelect: (selection: RepositorySelection) => void;
	} = $props();

	let activeTab = $state<'changes' | 'files'>('changes');
	let expandedDirectories = $state<string[]>([]);
	let inlineCreation = $state<{ kind: 'file' | 'directory'; parent: string }>();
	let creationName = $state('');
	let creationError = $state('');
	let creationInput = $state<HTMLInputElement>();
	let creating = $state(false);
	let loadingDirectories = $state<string[]>([]);
	let draggingPath = $state('');
	let treeRows = $derived(buildVisibleFileTree(snapshot?.files ?? [], expandedDirectories, snapshot?.directories ?? []));

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

	function handleCreationKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			void submitCreation();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			cancelCreation();
		}
	}

	function selectFile(path: string) {
		cancelCreation();
		onSelect({ kind: 'file', path });
	}

	function selectDiff(path: string) {
		cancelCreation();
		onSelect({ kind: 'diff', path });
	}

	$effect(() => {
		if (!inlineCreation) return;
		void tick().then(() => {
			creationInput?.focus();
			creationInput?.select();
		});
	});
</script>

<aside
	class="repository-panel"
	class:open
	aria-label={`Repository for ${projectName}`}
	aria-hidden={!open}
	inert={!open}
>
	<header class="repository-header">
		<div class="repository-title">
			<strong>Repository</strong>
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

	<div class="repository-tabs" role="tablist" aria-label="Repository view">
		<button
			type="button"
			role="tab"
			class:active={activeTab === 'changes'}
			aria-selected={activeTab === 'changes'}
			onclick={() => activeTab = 'changes'}
		>
			Changes
			{#if snapshot?.changes.length}<span>{snapshot.changes.length}</span>{/if}
		</button>
		<button
			type="button"
			role="tab"
			class:active={activeTab === 'files'}
			aria-selected={activeTab === 'files'}
			onclick={() => activeTab = 'files'}
		>Files</button>
	</div>

	{#if errorMessage}
		<p class="repository-warning" role="status">{errorMessage}</p>
	{/if}

	<div class="repository-content">
		{#if loading && !snapshot}
			<div class="repository-state" aria-live="polite">
				<span class="state-spinner" aria-hidden="true"></span>
				Reading repository…
			</div>
		{:else if !snapshot}
			<div class="repository-state">Repository information is unavailable.</div>
		{:else if activeTab === 'changes'}
			<div role="tabpanel" aria-label="Changed files">
				{#if !snapshot.isGitRepository}
					<div class="repository-empty">
						<strong>Not a Git repository</strong>
						<p>Files are still available from the Files tab.</p>
						<button type="button" onclick={() => activeTab = 'files'}>Open files</button>
					</div>
				{:else if snapshot.changes.length === 0}
					<div class="repository-empty">
						<strong>No changes</strong>
						<p>The working tree is clean.</p>
					</div>
				{:else}
					<div class="change-list">
						{#each snapshot.changes as change (change.path)}
							{@const badge = changeBadge(change)}
							<button
								type="button"
								class="change-row"
								class:selected={selected?.kind === 'diff' && selected.path === change.path}
								onclick={() => selectDiff(change.path)}
								aria-label={`Open diff for ${change.path}. ${describeChange(change)}`}
							>
								<span
									class="change-badge"
									class:added={badge === 'A' || badge === 'U'}
									class:deleted={badge === 'D'}
									class:renamed={badge === 'R' || badge === 'C'}
									class:conflicted={badge === 'U' && change.status !== '??'}
									aria-hidden="true"
								>{badge}</span>
								<span class="change-summary">
									<strong title={change.path}>{change.path.split('/').pop()}</strong>
									<span title={change.path}>{change.path}</span>
									<small>{describeChange(change)}</small>
								</span>
							</button>
						{/each}
					</div>
				{/if}
			</div>
		{:else}
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
							<div class="tree-create-row" data-inline-repository-entry="true">
								<span class="tree-indent" aria-hidden="true"></span>
								<span class="tree-chevron" aria-hidden="true"></span>
								<span class="tree-icon" aria-hidden="true">
									{#if inlineCreation.kind === 'directory'}<FolderPlus size={15} strokeWidth={1.7} />{:else}<FilePlus size={15} strokeWidth={1.7} />{/if}
								</span>
								<input
									bind:this={creationInput}
									bind:value={creationName}
									class:error={Boolean(creationError)}
									placeholder={inlineCreation.kind === 'directory' ? 'Folder name' : 'File name'}
									aria-label={inlineCreation.kind === 'directory' ? 'New folder name' : 'New file name'}
									autocomplete="off"
									spellcheck="false"
									disabled={creating}
									onkeydown={handleCreationKeydown}
								/>
								<button type="button" onclick={() => void submitCreation()} disabled={creating} aria-label="Create" title="Create">↵</button>
								<button type="button" onclick={cancelCreation} disabled={creating} aria-label="Cancel" title="Cancel">×</button>
							</div>
							{#if creationError}<p class="tree-create-error">{creationError}</p>{/if}
						{/if}
						{#each treeRows as row (row.path)}
							<div class="tree-row-shell" class:directory={row.kind === 'directory'} class:dragging={draggingPath === row.path} class:selected={selected?.kind === 'file' && selected.path === row.path}>
								<button
									type="button"
									class="tree-row"
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
									<span class="tree-icon" aria-hidden="true">
										{#if expandedDirectories.includes(row.path)}<FolderOpen size={15} strokeWidth={1.7} />{:else}<Folder size={15} strokeWidth={1.7} />{/if}
									</span>
								{:else}
									<span class="tree-chevron" aria-hidden="true"></span>
									<span class="tree-icon file" class:image={isPreviewableImage(row.path)} aria-hidden="true">
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
								<div class="tree-create-row nested" data-inline-repository-entry="true">
									<span class="tree-indent" aria-hidden="true">
										{#each Array(row.depth + 1) as _}<span></span>{/each}
									</span>
									<span class="tree-chevron" aria-hidden="true"></span>
									<span class="tree-icon" aria-hidden="true">
										{#if inlineCreation.kind === 'directory'}<FolderPlus size={15} strokeWidth={1.7} />{:else}<FilePlus size={15} strokeWidth={1.7} />{/if}
									</span>
									<input
										bind:this={creationInput}
										bind:value={creationName}
										class:error={Boolean(creationError)}
										placeholder={inlineCreation.kind === 'directory' ? 'Folder name' : 'File name'}
										aria-label={inlineCreation.kind === 'directory' ? 'New folder name' : 'New file name'}
										autocomplete="off"
										spellcheck="false"
										disabled={creating}
										onkeydown={handleCreationKeydown}
									/>
									<button type="button" onclick={() => void submitCreation()} disabled={creating} aria-label="Create" title="Create">↵</button>
									<button type="button" onclick={cancelCreation} disabled={creating} aria-label="Cancel" title="Cancel">×</button>
								</div>
								{#if creationError}<p class="tree-create-error nested-error">{creationError}</p>{/if}
							{/if}
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	</div>

	{#if snapshot?.truncated}
		<p class="repository-limit">Some folders contain more entries than shown.</p>
	{/if}
</aside>

<style>
	.repository-panel { position: absolute; z-index: 10; top: 0; right: 0; display: flex; flex-direction: column; width: min(22rem, calc(100% - 3rem)); height: 100%; min-width: 0; min-height: 0; overflow: hidden; transform: translateX(100%); border-left: 1px solid var(--color-border-strong); background: var(--color-panel); box-shadow: var(--shadow-repository-panel); color: var(--color-text); pointer-events: none; transition: transform 180ms ease; }
	.repository-panel.open { transform: translateX(0); pointer-events: auto; }
	.repository-header { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 0.75rem; min-height: 4rem; padding: 0.75rem 0.8rem 0.75rem 1rem; border-bottom: 1px solid var(--color-border); }
	.repository-title { display: grid; min-width: 0; gap: 0.15rem; }
	.repository-title strong, .repository-title span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.repository-title strong { font-size: var(--text-title); font-weight: var(--weight-strong); }
	.repository-title span { color: var(--color-text-tertiary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--text-caption); }
	.repository-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 0.15rem; }
	.repository-actions button { display: grid; place-items: center; width: 2.5rem; height: 2.5rem; padding: 0; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--color-text-secondary); cursor: pointer; }
	.repository-actions button:hover { background: var(--color-surface-raised); color: var(--color-text); }
	.repository-actions button:disabled { cursor: wait; opacity: 0.6; }
	.repository-actions button.spinning :global(svg) { animation: spin 0.8s linear infinite; }
	.repository-tabs { display: grid; flex: 0 0 auto; grid-template-columns: 1fr 1fr; padding: 0 0.75rem; border-bottom: 1px solid var(--color-border); }
	.repository-tabs button { display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem; min-height: 2.7rem; padding: 0 0.5rem; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--color-text-tertiary); font-size: var(--text-label); font-weight: var(--weight-medium); cursor: pointer; }
	.repository-tabs button:hover { color: var(--color-text); }
	.repository-tabs button.active { border-bottom-color: var(--color-accent); color: var(--color-text); }
	.repository-tabs button span { display: grid; place-items: center; min-width: 1.25rem; height: 1.25rem; padding: 0 0.28rem; border-radius: 999px; background: var(--color-accent-soft); color: var(--color-accent-soft-text); font-size: 0.68rem; font-variant-numeric: tabular-nums; }
	.repository-warning { flex: 0 0 auto; margin: 0; padding: 0.6rem 0.85rem; border-bottom: 1px solid var(--color-danger-border); background: var(--color-danger-surface); color: var(--color-danger-text); font-size: var(--text-caption); line-height: var(--leading-ui); }
	.repository-content { flex: 1 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain; }
	.repository-state { display: flex; align-items: center; justify-content: center; gap: 0.55rem; min-height: 8rem; padding: 1rem; color: var(--color-text-secondary); font-size: var(--text-label); text-align: center; }
	.state-spinner { width: 0.9rem; height: 0.9rem; border: 2px solid var(--color-border-strong); border-top-color: var(--color-accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
	.repository-empty { padding: 1.5rem 1rem; }
	.repository-empty strong { font-size: var(--text-body); font-weight: var(--weight-medium); }
	.repository-empty p { margin: 0.35rem 0 0; color: var(--color-text-secondary); font-size: var(--text-caption); line-height: var(--leading-body); }
	.repository-empty button { min-height: 2.2rem; margin-top: 0.9rem; padding: 0 0.75rem; border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); background: var(--color-surface-raised); color: var(--color-text); font-size: var(--text-label); cursor: pointer; }
	.file-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 0.65rem; min-height: 2.7rem; padding: 0.35rem 0.65rem 0.35rem 0.85rem; border-bottom: 1px solid var(--color-border); color: var(--color-text-secondary); font-size: var(--text-caption); }
	.file-toolbar-actions { display: flex; align-items: center; gap: 0.25rem; }
	.file-toolbar-actions button { display: inline-flex; align-items: center; gap: 0.3rem; min-height: 2rem; padding: 0 0.45rem; border: 1px solid var(--color-border); border-radius: 0.4rem; background: var(--color-control-background); color: var(--color-text-secondary); font-size: var(--text-caption); cursor: pointer; }
	.file-toolbar-actions button:hover { background: var(--color-control-hover); color: var(--color-text); }
	.change-row { display: grid; grid-template-columns: 1.6rem minmax(0, 1fr); align-items: start; gap: 0.65rem; width: 100%; min-width: 0; padding: 0.72rem 0.85rem; border: 0; border-bottom: 1px solid var(--color-divider-subtle); background: transparent; color: inherit; text-align: left; cursor: pointer; }
	.change-row:hover { background: var(--color-surface-raised); }
	.change-row.selected { background: var(--color-surface-active); box-shadow: inset 0.16rem 0 var(--color-accent); }
	.change-badge { display: grid; place-items: center; width: 1.4rem; height: 1.4rem; margin-top: 0.08rem; border-radius: 0.3rem; background: var(--color-change-background); color: var(--color-change-text); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.68rem; font-weight: var(--weight-strong); }
	.change-badge.added { background: var(--color-change-add-background); color: var(--color-change-add-text); }
	.change-badge.deleted, .change-badge.conflicted { background: var(--color-change-delete-background); color: var(--color-change-delete-text); }
	.change-badge.renamed { background: var(--color-change-rename-background); color: var(--color-renamed); }
	.change-summary { display: grid; min-width: 0; gap: 0.18rem; }
	.change-summary strong, .change-summary span, .change-summary small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.change-summary strong { font-size: var(--text-label); font-weight: var(--weight-medium); }
	.change-summary span { color: var(--color-text-tertiary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.68rem; }
	.change-summary small { color: var(--color-text-secondary); font-size: 0.68rem; }
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
	.tree-create-row { display: flex; align-items: center; min-width: 0; min-height: 2rem; padding: 0 0.35rem 0 0.65rem; background: var(--color-surface-active); }
	.tree-create-row.nested { background: var(--color-surface-raised); }
	.tree-create-row input { flex: 1 1 auto; min-width: 0; height: 1.7rem; padding: 0 0.4rem; border: 1px solid var(--color-accent); border-radius: 0.35rem; outline: none; background: var(--color-field-background); color: var(--color-text); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--text-caption); }
	.tree-create-row input::placeholder { color: var(--color-field-placeholder); }
	.tree-create-row input.error { border-color: var(--color-danger-border-strong); }
	.tree-create-row button { display: grid; flex: 0 0 1.8rem; place-items: center; width: 1.8rem; height: 1.8rem; padding: 0; border: 0; border-radius: 0.35rem; background: transparent; color: var(--color-text-secondary); font-size: 1rem; cursor: pointer; }
	.tree-create-row button:hover:not(:disabled), .tree-create-row button:focus-visible { background: var(--color-control-hover); color: var(--color-text); }
	.tree-create-row button:disabled { cursor: wait; opacity: 0.5; }
	.tree-create-error { margin: -0.15rem 0 0.35rem; padding: 0 0.7rem 0 2.95rem; color: var(--color-danger-text); font-size: 0.68rem; line-height: var(--leading-ui); }
	.tree-create-error.nested-error { padding-left: 3.7rem; }
	.tree-indent { display: inline-flex; flex: 0 0 auto; }
	.tree-indent > span { width: 0.72rem; }
	.tree-chevron { display: grid; flex: 0 0 1rem; place-items: center; width: 1rem; color: var(--color-text-tertiary); }
	.tree-icon { display: grid; flex: 0 0 1.35rem; place-items: center; width: 1.35rem; color: var(--color-folder); }
	.tree-icon.file { color: var(--color-text-tertiary); }
	.tree-icon.file.image { color: var(--color-image); }
	.tree-name { min-width: 0; overflow: hidden; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--text-caption); text-overflow: ellipsis; white-space: nowrap; }
	.repository-limit { flex: 0 0 auto; margin: 0; padding: 0.55rem 0.8rem; border-top: 1px solid var(--color-border); color: var(--color-text-tertiary); font-size: 0.68rem; }

	@keyframes spin { to { transform: rotate(360deg); } }

	@media (max-width: 63.999rem) {
		.repository-panel { position: fixed; z-index: 40; width: min(23rem, calc(100% - 2.5rem)); height: 100dvh; padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom); }
	}

	@media (prefers-reduced-motion: reduce) {
		.repository-actions button.spinning :global(svg), .state-spinner { animation-duration: 1.6s; }
		.repository-panel { transition: none; }
	}
</style>
