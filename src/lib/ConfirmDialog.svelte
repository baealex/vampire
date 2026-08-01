<script lang="ts">
	import { AlertDialog } from 'bits-ui';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import AlertDialogShell from '$lib/ui/AlertDialogShell.svelte';

	let {
		title,
		description,
		confirmLabel = 'Confirm',
		busyLabel = 'Working…',
		close,
		onConfirm
	}: {
		title: string;
		description: string;
		confirmLabel?: string;
		busyLabel?: string;
		close: () => void;
		onConfirm: () => Promise<void>;
	} = $props();

	let action = $state(false);
	let errorMessage = $state('');

	async function confirm() {
		if (action) return;
		action = true;
		errorMessage = '';
		try {
			await onConfirm();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'The action could not be completed.';
		} finally {
			action = false;
		}
	}

</script>

<AlertDialogShell eyebrow="Confirm action" {title} close={close} closeDisabled={action}>
	{#snippet children()}
		<div class="confirm-dialog-message">
			<span class="confirm-dialog-icon" aria-hidden="true">
				<TriangleAlert size={16} strokeWidth={1.9} />
			</span>
			<AlertDialog.Description class="confirm-dialog-description">{description}</AlertDialog.Description>
		</div>

		<div class="vampire-dialog-actions">
			<AlertDialog.Cancel class="vampire-dialog-secondary-button" disabled={action}>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				class="vampire-dialog-danger-button"
				disabled={action}
				onclick={(event) => { event.preventDefault(); void confirm(); }}
			>
				{action ? busyLabel : confirmLabel}
			</AlertDialog.Action>
		</div>
		{#if errorMessage}<p class="error" role="alert">{errorMessage}</p>{/if}
	{/snippet}
</AlertDialogShell>

<style>
	.confirm-dialog-message { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 0.65rem; padding: 0.1rem 0; }
	.confirm-dialog-icon { display: grid; place-items: center; width: 1.8rem; height: 1.8rem; margin-top: 0.05rem; border-radius: 50%; background: var(--color-danger-surface); color: var(--color-danger-text); }
	.confirm-dialog-message :global(.confirm-dialog-description) { margin: 0; overflow-wrap: anywhere; color: var(--color-text-secondary); font-size: var(--text-body); line-height: var(--leading-body); }
	.error { margin: 0; color: var(--color-danger-text); font-size: var(--text-label); line-height: var(--leading-ui); }
</style>
