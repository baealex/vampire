<script lang="ts">
	import { Dialog } from 'bits-ui';
	import LogOut from '@lucide/svelte/icons/log-out';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import DialogShell from '$lib/ui/DialogShell.svelte';
	import type { ManagedSession } from './types';
	import { projectName } from './view';

	let {
		session,
		action,
		errorMessage,
		close,
		closeSession,
		remove,
	}: {
		session: ManagedSession;
		action?: 'restart' | 'close' | 'remove';
		errorMessage: string;
		close: () => void;
		closeSession: (session: ManagedSession) => Promise<void>;
		remove: (session: ManagedSession) => Promise<void>;
	} = $props();

	let confirming = $state<'close' | 'remove'>();
</script>

<DialogShell eyebrow="Workspace actions" title={projectName(session.cwd)} {close} closeDisabled={Boolean(action)}>
	{#snippet children()}
		<code class="session-actions-code">{session.cwd}</code>

		{#if session.state === 'running'}
			{#if confirming === 'close'}
				<div class="vampire-dialog-destructive" role="alert">
					<strong>Close this session?</strong>
					<p>This stops the shell and processes running inside it. The workspace stays in the list and can be reopened later.</p>
				</div>
				<div class="vampire-dialog-actions">
					<button class="vampire-dialog-secondary-button" type="button" onclick={() => confirming = undefined} disabled={Boolean(action)}>Cancel</button>
					<button class="vampire-dialog-danger-button" type="button" onclick={() => void closeSession(session)} disabled={Boolean(action)}>
						<LogOut size={16} strokeWidth={1.8} aria-hidden="true" />
						{action === 'close' ? 'Closing…' : 'Close session'}
					</button>
				</div>
			{:else}
				<Dialog.Description class="vampire-dialog-description">The shell is still running. Close the session to stop it while keeping this workspace in the list.</Dialog.Description>
				<div class="vampire-dialog-actions vampire-dialog-actions--split">
					<button class="vampire-dialog-danger-outline-button" type="button" onclick={() => confirming = 'close'} disabled={Boolean(action)}>
						<LogOut size={16} strokeWidth={1.8} aria-hidden="true" />
						Close session
					</button>
					<button class="vampire-dialog-danger-outline-button" type="button" disabled title="Close the session before removing the workspace">
						<Trash2 size={16} strokeWidth={1.8} aria-hidden="true" />
						Remove workspace
					</button>
				</div>
				<p class="action-hint">Close the session before removing the workspace.</p>
			{/if}
		{:else}
			{#if confirming === 'remove'}
				<div class="vampire-dialog-destructive" role="alert">
					<strong>Remove this workspace?</strong>
					<p>This removes the workspace entry from Vampire. Its shell has already ended.</p>
				</div>
				<div class="vampire-dialog-actions">
					<button class="vampire-dialog-secondary-button" type="button" onclick={() => confirming = undefined} disabled={Boolean(action)}>Cancel</button>
					<button class="vampire-dialog-danger-button" type="button" onclick={() => void remove(session)} disabled={Boolean(action)}>
						<Trash2 size={16} strokeWidth={1.8} aria-hidden="true" />
						{action === 'remove' ? 'Removing…' : 'Remove workspace'}
					</button>
				</div>
			{:else}
				<Dialog.Description class="vampire-dialog-description">This shell has ended. You can remove the workspace entry from Vampire.</Dialog.Description>
				<button class="vampire-dialog-danger-outline-button" type="button" onclick={() => confirming = 'remove'} disabled={Boolean(action)}>
					<Trash2 size={16} strokeWidth={1.8} aria-hidden="true" />
					Remove workspace…
				</button>
			{/if}
		{/if}
		{#if errorMessage}<p class="error" role="alert">{errorMessage}</p>{/if}
	{/snippet}
</DialogShell>

<style>
	.session-actions-code {
		display: block;
		min-width: 0;
		overflow: hidden;
		padding: 0.65rem 0.7rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: 0.5rem;
		background: var(--color-surface-sunken);
		color: var(--color-text-secondary);
		font-size: var(--text-caption);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.action-hint {
		margin: -0.45rem 0 0;
		color: var(--color-text-tertiary);
		font-size: var(--text-caption);
		line-height: var(--leading-ui);
	}

	.error {
		margin: 0;
		color: var(--color-danger);
		font-size: var(--text-label);
		line-height: var(--leading-ui);
	}
</style>
