<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import GitBranchPlus from '@lucide/svelte/icons/git-branch-plus';
	import LogOut from '@lucide/svelte/icons/log-out';
	import Tags from '@lucide/svelte/icons/tags';
	import SquarePlay from '@lucide/svelte/icons/square-play';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import DropdownMenuShell from '$lib/ui/DropdownMenuShell.svelte';
	import type { ManagedSession } from './types';
	import { isWorktreeWorkspace, workspaceName } from './view';

	let {
		session,
		open = false,
		onOpenChange,
		action,
		closeSession,
		remove,
		onSettings,
		onAlias,
		onNewWorktree
	}: {
		session: ManagedSession;
		open?: boolean;
		onOpenChange: (open: boolean) => void;
		action?: 'restart' | 'close' | 'remove';
		closeSession: (session: ManagedSession) => Promise<{ ok: boolean; error?: string }>;
		remove: (session: ManagedSession) => Promise<{ ok: boolean; error?: string }>;
		onSettings: (session: ManagedSession) => void;
		onAlias: (session: ManagedSession) => void;
		onNewWorktree: (session: ManagedSession) => void;
	} = $props();

	let confirming = $state<'close' | 'remove'>();
	let confirmError = $state('');

	function handleMenuOpenChange(nextOpen: boolean) {
		if (!nextOpen) {
			confirming = undefined;
			confirmError = '';
		}
		onOpenChange(nextOpen);
	}

	function requestConfirmation(event: Event, selectedAction: 'close' | 'remove') {
		event.preventDefault();
		if (action) return;
		confirmError = '';
		confirming = selectedAction;
	}

	async function confirmSelectedAction() {
		const selectedAction = confirming;
		if (!selectedAction || action) return;
		confirmError = '';
		const result = selectedAction === 'close'
			? await closeSession(session)
			: await remove(session);
		if (!result.ok) {
			confirmError = result.error || `Unable to ${selectedAction === 'close' ? 'close the session' : 'remove the workspace'}.`;
			return;
		}
		confirming = undefined;
		onOpenChange(false);
	}
</script>

<DropdownMenuShell
	{open}
	onOpenChange={handleMenuOpenChange}
	triggerLabel={`Workspace actions for ${workspaceName(session)}`}
	triggerTitle="Workspace actions"
>
	{#snippet trigger()}
		<Ellipsis size={18} strokeWidth={1.9} aria-hidden="true" />
	{/snippet}

	{#snippet children()}
		<div class="vampire-menu-heading" role="presentation">
			<strong>{workspaceName(session)}</strong>
			<span>{session.cwd}</span>
		</div>
		<DropdownMenu.Separator class="vampire-menu-separator" />

		{#if confirming}
			<div class="vampire-menu-confirm" role="group" aria-label={confirming === 'close' ? 'Confirm closing session' : 'Confirm removing workspace'}>
				<strong>{confirming === 'close' ? 'Close this session?' : 'Remove this workspace?'}</strong>
				<p>
					{#if confirming === 'close'}
						The shell and its processes will stop. The workspace stays available.
					{:else if isWorktreeWorkspace(session) && session.workspaceAvailable === false}
						Vampire will clear the missing working copy's Git registration. Its branch stays available.
					{:else if isWorktreeWorkspace(session)}
						{session.state === 'running' ? 'The running shell will stop. ' : ''}The managed working copy and any uncommitted files in it will be deleted. Its Git branch stays available.
					{:else if session.state === 'running'}
						The running shell will stop and the workspace will be removed. Project files stay on disk.
					{:else}
						The workspace will be removed from Vampire. Project files stay on disk.
					{/if}
				</p>
				<div class="vampire-menu-confirm-actions">
					<DropdownMenu.Item class="vampire-menu-item" onSelect={() => confirming = undefined}>
						Cancel
					</DropdownMenu.Item>
					<DropdownMenu.Item
						class="vampire-menu-item danger"
						disabled={Boolean(action)}
						onSelect={(event) => { event.preventDefault(); void confirmSelectedAction(); }}
					>
						{action ? (confirming === 'close' ? 'Closing…' : 'Removing…') : (confirming === 'close' ? 'Close session' : 'Remove workspace')}
					</DropdownMenu.Item>
				</div>
				{#if confirmError}<p class="vampire-menu-error" role="alert">{confirmError}</p>{/if}
			</div>
		{:else}
			<DropdownMenu.Item class="vampire-menu-item" onSelect={() => onAlias(session)}>
				<Tags size={16} strokeWidth={1.8} aria-hidden="true" />
				{session.workspaceLabel?.trim() ? 'Edit workspace alias' : 'Set workspace alias'}
			</DropdownMenu.Item>
			{#if session.isGitRepository && session.workspaceAvailable !== false}
				<DropdownMenu.Item class="vampire-menu-item" onSelect={() => onNewWorktree(session)}>
					<GitBranchPlus size={16} strokeWidth={1.8} aria-hidden="true" />
					New isolated workspace
				</DropdownMenu.Item>
			{/if}
			<DropdownMenu.Item class="vampire-menu-item" onSelect={() => onSettings(session)}>
				<SquarePlay size={16} strokeWidth={1.8} aria-hidden="true" />
				Startup profile
			</DropdownMenu.Item>
			<DropdownMenu.Separator class="vampire-menu-separator" />
			{#if session.state === 'running'}
				<DropdownMenu.Item class="vampire-menu-item" disabled={Boolean(action)} onSelect={(event) => requestConfirmation(event, 'close')}>
					<LogOut size={16} strokeWidth={1.8} aria-hidden="true" />
					Close session
				</DropdownMenu.Item>
			{/if}
			<DropdownMenu.Item class="vampire-menu-item danger" disabled={Boolean(action)} onSelect={(event) => requestConfirmation(event, 'remove')}>
				<Trash2 size={16} strokeWidth={1.8} aria-hidden="true" />
				Remove workspace
			</DropdownMenu.Item>
		{/if}
	{/snippet}
</DropdownMenuShell>

<style>
	.vampire-menu-confirm { display: grid; gap: 0.45rem; padding: 0.45rem 0.55rem 0.55rem; }
	.vampire-menu-confirm strong { color: var(--color-text); font-size: var(--text-label); font-weight: var(--weight-medium); }
	.vampire-menu-confirm p { margin: 0; color: var(--color-text-secondary); font-size: var(--text-caption); line-height: var(--leading-ui); }
	.vampire-menu-confirm-actions { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0.3rem; margin-top: 0.2rem; }
	:global(.vampire-menu-confirm-actions .vampire-menu-item) { justify-content: center; min-height: 2rem; padding-inline: 0.35rem; }
	.vampire-menu-error { color: var(--color-danger-text) !important; }
</style>
