<script lang="ts">
	import { AlertDialog } from 'bits-ui';
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
		<div class="vampire-dialog-destructive">
			<AlertDialog.Description data-dialog-description>{description}</AlertDialog.Description>
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
	.error { margin: 0; color: var(--color-danger-text); font-size: var(--text-label); line-height: var(--leading-ui); }
</style>
