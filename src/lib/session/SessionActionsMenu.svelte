<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import LogOut from '@lucide/svelte/icons/log-out';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import ConfirmDialog from '$lib/ConfirmDialog.svelte';
	import DropdownMenuShell from '$lib/ui/DropdownMenuShell.svelte';
	import type { ManagedSession } from './types';
	import { projectName } from './view';

	let {
		session,
		open = false,
		onOpenChange,
		action,
		closeSession,
		remove
	}: {
		session: ManagedSession;
		open?: boolean;
		onOpenChange: (open: boolean) => void;
		action?: 'restart' | 'close' | 'remove';
		closeSession: (session: ManagedSession) => Promise<{ ok: boolean; error?: string }>;
		remove: (session: ManagedSession) => Promise<{ ok: boolean; error?: string }>;
	} = $props();

	let confirming = $state<'close' | 'remove'>();

	async function confirmSelectedAction() {
		const selectedAction = confirming;
		if (!selectedAction) return;
		const result = selectedAction === 'close'
			? await closeSession(session)
			: await remove(session);
		if (!result.ok) {
			throw new Error(result.error || `Unable to ${selectedAction === 'close' ? 'close the session' : 'remove the workspace'}.`);
		}
		confirming = undefined;
	}
</script>

<DropdownMenuShell
	{open}
	{onOpenChange}
	triggerLabel={`Workspace actions for ${projectName(session.cwd)}`}
	triggerTitle="Workspace actions"
>
	{#snippet trigger()}
		<Ellipsis size={18} strokeWidth={1.9} aria-hidden="true" />
	{/snippet}

	{#snippet children()}
		<div class="vampire-menu-heading" role="presentation">
			<strong>{projectName(session.cwd)}</strong>
			<span>{session.cwd}</span>
		</div>
		<DropdownMenu.Separator class="vampire-menu-separator" />

		{#if session.state === 'running'}
			<DropdownMenu.Item class="vampire-menu-item" disabled={Boolean(action)} onSelect={() => confirming = 'close'}>
				<LogOut size={16} strokeWidth={1.8} aria-hidden="true" />
				Close session
			</DropdownMenu.Item>
			<DropdownMenu.Item class="vampire-menu-item danger" disabled title="Close the session before removing the workspace">
				<Trash2 size={16} strokeWidth={1.8} aria-hidden="true" />
				Remove workspace
			</DropdownMenu.Item>
			<p class="vampire-menu-hint">Close the session before removing the workspace.</p>
		{:else}
			<DropdownMenu.Item class="vampire-menu-item danger" disabled={Boolean(action)} onSelect={() => confirming = 'remove'}>
				<Trash2 size={16} strokeWidth={1.8} aria-hidden="true" />
				Remove workspace
			</DropdownMenu.Item>
		{/if}
	{/snippet}
</DropdownMenuShell>

{#if confirming === 'close'}
	<ConfirmDialog
		title="Close this session?"
		description="This stops the shell and processes running inside it. The workspace stays in the list and can be reopened later."
		confirmLabel="Close session"
		busyLabel="Closing…"
		close={() => confirming = undefined}
		onConfirm={confirmSelectedAction}
	/>
{:else if confirming === 'remove'}
	<ConfirmDialog
		title="Remove this workspace?"
		description="This removes the workspace entry from Vampire. Its shell has already ended."
		confirmLabel="Remove workspace"
		busyLabel="Removing…"
		close={() => confirming = undefined}
		onConfirm={confirmSelectedAction}
	/>
{/if}
