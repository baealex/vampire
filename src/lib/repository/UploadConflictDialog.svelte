<script lang="ts">
	import { AlertDialog } from 'bits-ui';
	import AlertDialogShell from '$lib/ui/AlertDialogShell.svelte';

	let {
		count,
		firstPath,
		onResolve
	}: {
		count: number;
		firstPath: string;
		onResolve: (conflict: 'skip' | 'rename' | 'overwrite') => Promise<void>;
	} = $props();

	let action = $state<'skip' | 'rename' | 'overwrite'>();
	let errorMessage = $state('');

	async function resolve(conflict: 'skip' | 'rename' | 'overwrite') {
		if (action) return;
		action = conflict;
		errorMessage = '';
		try {
			await onResolve(conflict);
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'The file conflicts could not be resolved.';
			action = undefined;
		}
	}
</script>

<AlertDialogShell
	eyebrow="File conflict"
	title={`${count} ${count === 1 ? 'file already exists' : 'files already exist'}`}
	close={() => void resolve('skip')}
	closeDisabled={Boolean(action)}
>
	{#snippet children()}
		<AlertDialog.Description class="upload-conflict-description">
			{count === 1
				? `“${firstPath}” is already in this workspace.`
				: `“${firstPath}” and ${count - 1} more files are already in this workspace.`}
		</AlertDialog.Description>
		<p class="upload-conflict-help">Keep both adds a numbered copy. Replace overwrites the existing files.</p>
		<div class="vampire-dialog-actions upload-conflict-actions">
			<AlertDialog.Cancel
				class="vampire-dialog-secondary-button"
				disabled={Boolean(action)}
				onclick={(event) => { event.preventDefault(); void resolve('skip'); }}
			>
				{action === 'skip' ? 'Skipping…' : 'Skip existing'}
			</AlertDialog.Cancel>
			<AlertDialog.Action
				class="vampire-dialog-secondary-button"
				disabled={Boolean(action)}
				onclick={(event) => { event.preventDefault(); void resolve('rename'); }}
			>
				{action === 'rename' ? 'Saving copies…' : 'Keep both'}
			</AlertDialog.Action>
			<AlertDialog.Action
				class="vampire-dialog-danger-button"
				disabled={Boolean(action)}
				onclick={(event) => { event.preventDefault(); void resolve('overwrite'); }}
			>
				{action === 'overwrite' ? 'Replacing…' : 'Replace'}
			</AlertDialog.Action>
		</div>
		{#if errorMessage}<p class="upload-conflict-error" role="alert">{errorMessage}</p>{/if}
	{/snippet}
</AlertDialogShell>

<style>
	:global(.upload-conflict-description) { margin: 0; overflow-wrap: anywhere; color: var(--color-text); font-size: var(--text-body); line-height: var(--leading-body); }
	.upload-conflict-help { margin: -0.55rem 0 0; color: var(--color-text-secondary); font-size: var(--text-caption); line-height: var(--leading-ui); }
	.upload-conflict-actions { align-items: stretch; }
	.upload-conflict-error { margin: 0; color: var(--color-danger-text); font-size: var(--text-label); line-height: var(--leading-ui); }
	@media (max-width: 39.999rem) {
		.upload-conflict-actions { display: grid; grid-template-columns: minmax(0, 1fr); }
	}
</style>
