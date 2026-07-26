<script lang="ts">
	import { onMount } from 'svelte';
	import LogOut from '@lucide/svelte/icons/log-out';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import X from '@lucide/svelte/icons/x';
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

	let dialog: HTMLElement;
	let confirming = $state<'close' | 'remove'>();

	onMount(() => dialog.focus());
</script>

<div class="dialog-layer">
	<button class="dialog-backdrop" type="button" onclick={close} aria-label="Close workspace actions"></button>
	<div
		class="actions-dialog"
		bind:this={dialog}
		tabindex="-1"
		role="dialog"
		aria-modal="true"
		aria-labelledby="workspace-actions-title"
	>
		<header>
			<div>
				<p class="section-label">Workspace actions</p>
				<h2 id="workspace-actions-title">{projectName(session.cwd)}</h2>
			</div>
			<button class="dialog-close" type="button" onclick={close} aria-label="Close">
				<X size={18} strokeWidth={1.8} aria-hidden="true" />
			</button>
		</header>
		<code>{session.cwd}</code>

		{#if session.state === 'running'}
			{#if confirming === 'close'}
				<div class="destructive-confirmation" role="alert">
					<strong>Close this session?</strong>
					<p>This stops the shell and processes running inside it. The workspace stays in the list and can be reopened later.</p>
				</div>
				<div class="dialog-actions">
					<button class="secondary-button" type="button" onclick={() => confirming = undefined} disabled={Boolean(action)}>Cancel</button>
					<button class="danger-button" type="button" onclick={() => void closeSession(session)} disabled={Boolean(action)}>
						<LogOut size={16} strokeWidth={1.8} aria-hidden="true" />
						{action === 'close' ? 'Closing…' : 'Close session'}
					</button>
				</div>
			{:else}
				<p class="dialog-description">The shell is still running. Close the session to stop it while keeping this workspace in the list.</p>
				<div class="dialog-actions dialog-actions--split">
					<button class="danger-outline-button" type="button" onclick={() => confirming = 'close'} disabled={Boolean(action)}>
						<LogOut size={16} strokeWidth={1.8} aria-hidden="true" />
						Close session
					</button>
					<button class="danger-outline-button" type="button" disabled title="Close the session before removing the workspace">
						<Trash2 size={16} strokeWidth={1.8} aria-hidden="true" />
						Remove workspace
					</button>
				</div>
				<p class="action-hint">Close the session before removing the workspace.</p>
			{/if}
		{:else}
			{#if confirming === 'remove'}
				<div class="destructive-confirmation" role="alert">
					<strong>Remove this workspace?</strong>
					<p>This removes the workspace entry from Vampire. Its shell has already ended.</p>
				</div>
				<div class="dialog-actions">
					<button class="secondary-button" type="button" onclick={() => confirming = undefined} disabled={Boolean(action)}>Cancel</button>
					<button class="danger-button" type="button" onclick={() => void remove(session)} disabled={Boolean(action)}>
						<Trash2 size={16} strokeWidth={1.8} aria-hidden="true" />
						{action === 'remove' ? 'Removing…' : 'Remove workspace'}
					</button>
				</div>
			{:else}
				<p class="dialog-description">This shell has ended. You can remove the workspace entry from Vampire.</p>
				<button class="danger-outline-button" type="button" onclick={() => confirming = 'remove'} disabled={Boolean(action)}>
					<Trash2 size={16} strokeWidth={1.8} aria-hidden="true" />
					Remove workspace…
				</button>
			{/if}
		{/if}
		{#if errorMessage}<p class="error" role="alert">{errorMessage}</p>{/if}
	</div>
</div>

<style>
	.dialog-layer { position: fixed; z-index: 50; inset: 0; display: grid; place-items: center; padding: 1rem; }
	.dialog-backdrop { position: absolute; inset: 0; width: 100%; height: 100%; padding: 0; border: 0; background: var(--color-backdrop); cursor: default; backdrop-filter: blur(3px); }
	.actions-dialog { position: relative; z-index: 1; display: grid; gap: 1rem; width: min(100%, 28rem); padding: 1.1rem; border: 1px solid var(--color-border-strong); border-radius: 0.9rem; outline: none; background: var(--color-surface-overlay); box-shadow: var(--shadow-dialog); }
	.actions-dialog > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
	.section-label { margin: 0; color: var(--color-text-tertiary); font-size: var(--text-caption); font-weight: var(--weight-medium); line-height: var(--leading-ui); }
	.actions-dialog h2 { margin: 0.2rem 0 0; font-size: var(--text-heading); font-weight: var(--weight-strong); line-height: var(--leading-tight); }
	.actions-dialog code { display: block; min-width: 0; overflow: hidden; padding: 0.65rem 0.7rem; border: 1px solid var(--color-border-subtle); border-radius: 0.5rem; background: var(--color-surface-sunken); color: var(--color-text-secondary); font-size: var(--text-caption); text-overflow: ellipsis; white-space: nowrap; }
	.dialog-close { display: grid; flex: 0 0 auto; place-items: center; width: 2.35rem; height: 2.35rem; padding: 0; border: 0; border-radius: 0.5rem; background: transparent; color: var(--color-text-secondary); cursor: pointer; }
	.dialog-close:hover { background: var(--color-surface-hover); color: var(--color-text); }
	.dialog-description, .destructive-confirmation p { margin: 0; color: var(--color-text-secondary); font-size: var(--text-body); line-height: var(--leading-body); }
	.destructive-confirmation { display: grid; gap: 0.4rem; padding: 0.8rem; border: 1px solid var(--color-danger-border); border-radius: 0.6rem; background: var(--color-danger-surface); }
	.destructive-confirmation strong { color: var(--color-danger-text-strong); font-size: var(--text-body); font-weight: var(--weight-medium); }
	.dialog-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 0.5rem; }
	.dialog-actions--split { justify-content: flex-start; }
	.action-hint { margin: -0.45rem 0 0; color: var(--color-text-tertiary); font-size: var(--text-caption); line-height: var(--leading-ui); }
	.secondary-button, .danger-button, .danger-outline-button { display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem; min-height: 2.5rem; padding: 0 0.85rem; border-radius: var(--radius-sm); font: inherit; font-size: var(--text-label); font-weight: var(--weight-medium); cursor: pointer; }
	.secondary-button { border: 0; background: var(--color-surface-raised); color: var(--color-text); }
	.danger-button { border: 0; background: var(--color-danger-action); color: var(--color-danger-action-ink); }
	.danger-button:hover { background: var(--color-danger-action-hover); }
	.danger-outline-button { justify-self: start; width: auto; border: 1px solid var(--color-danger-border); background: transparent; color: var(--color-danger-text); }
	.danger-outline-button:hover { background: var(--color-danger-surface-hover); }
	.danger-button:disabled, .danger-outline-button:disabled { cursor: wait; opacity: 0.62; }
	.danger-outline-button:disabled { cursor: not-allowed; }
	.error { margin: 0; color: var(--color-danger); font-size: var(--text-label); line-height: var(--leading-ui); }

	@media (max-width: 63.999rem) {
		.dialog-layer { align-items: end; padding: 0; }
		.actions-dialog { width: 100%; padding: 1.1rem max(1.1rem, env(safe-area-inset-right)) max(1.1rem, env(safe-area-inset-bottom)) max(1.1rem, env(safe-area-inset-left)); border-right: 0; border-bottom: 0; border-left: 0; border-radius: 1rem 1rem 0 0; }
	}
</style>
