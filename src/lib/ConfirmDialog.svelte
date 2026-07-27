<script lang="ts">
	import { onMount } from 'svelte';
	import X from '@lucide/svelte/icons/x';

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

	let dialog = $state<HTMLDivElement>();
	let action = $state(false);
	let errorMessage = $state('');

	onMount(() => dialog?.focus());

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

	function handleKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape' || action) return;
		event.preventDefault();
		close();
	}
</script>

<div class="dialog-layer">
	<button class="dialog-backdrop" type="button" onclick={close} disabled={action} aria-label="Close confirmation"></button>
	<div
		bind:this={dialog}
		class="confirm-dialog"
		tabindex="-1"
		role="dialog"
		aria-modal="true"
		aria-labelledby="confirm-dialog-title"
		aria-describedby="confirm-dialog-description"
		onkeydown={handleKeydown}
	>
		<header>
			<div>
				<p class="section-label">Confirm action</p>
				<h2 id="confirm-dialog-title">{title}</h2>
			</div>
			<button class="dialog-close" type="button" onclick={close} disabled={action} aria-label="Close confirmation">
				<X size={18} strokeWidth={1.8} aria-hidden="true" />
			</button>
		</header>

		<div class="destructive-confirmation">
			<p id="confirm-dialog-description">{description}</p>
		</div>

		<div class="dialog-actions">
			<button class="secondary-button" type="button" onclick={close} disabled={action}>Cancel</button>
			<button class="danger-button" type="button" onclick={() => void confirm()} disabled={action}>
				{action ? busyLabel : confirmLabel}
			</button>
		</div>
		{#if errorMessage}<p class="error" role="alert">{errorMessage}</p>{/if}
	</div>
</div>

<style>
	.dialog-layer { position: fixed; z-index: 60; inset: 0; display: grid; place-items: center; padding: 1rem; }
	.dialog-backdrop { position: absolute; inset: 0; width: 100%; height: 100%; padding: 0; border: 0; background: var(--color-backdrop); cursor: default; backdrop-filter: blur(3px); }
	.dialog-backdrop:disabled { cursor: wait; }
	.confirm-dialog { position: relative; z-index: 1; display: grid; gap: 1rem; width: min(100%, 28rem); padding: 1.1rem; border: 1px solid var(--color-border-strong); border-radius: 0.9rem; outline: none; background: var(--color-surface-overlay); box-shadow: var(--shadow-dialog); }
	.confirm-dialog > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
	.section-label { margin: 0; color: var(--color-text-tertiary); font-size: var(--text-caption); font-weight: var(--weight-medium); line-height: var(--leading-ui); }
	.confirm-dialog h2 { margin: 0.2rem 0 0; font-size: var(--text-heading); font-weight: var(--weight-strong); line-height: var(--leading-tight); }
	.dialog-close { display: grid; flex: 0 0 auto; place-items: center; width: 2.35rem; height: 2.35rem; padding: 0; border: 0; border-radius: 0.5rem; background: transparent; color: var(--color-text-secondary); cursor: pointer; }
	.dialog-close:hover:not(:disabled) { background: var(--color-surface-hover); color: var(--color-text); }
	.dialog-close:disabled { cursor: wait; opacity: 0.62; }
	.destructive-confirmation { display: grid; gap: 0.4rem; padding: 0.8rem; border: 1px solid var(--color-danger-border); border-radius: 0.6rem; background: var(--color-danger-surface); }
	.destructive-confirmation p { margin: 0; color: var(--color-text-secondary); font-size: var(--text-body); line-height: var(--leading-body); overflow-wrap: anywhere; }
	.dialog-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 0.5rem; }
	.secondary-button, .danger-button { display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem; min-height: 2.5rem; padding: 0 0.85rem; border-radius: var(--radius-sm); font: inherit; font-size: var(--text-label); font-weight: var(--weight-medium); cursor: pointer; }
	.secondary-button { border: 0; background: var(--color-surface-raised); color: var(--color-text); }
	.secondary-button:hover:not(:disabled) { background: var(--color-surface-hover); }
	.danger-button { border: 0; background: var(--color-danger-action); color: var(--color-danger-action-ink); }
	.danger-button:hover:not(:disabled) { background: var(--color-danger-action-hover); }
	.secondary-button:disabled, .danger-button:disabled { cursor: wait; opacity: 0.62; }
	.error { margin: 0; color: var(--color-danger-text); font-size: var(--text-label); line-height: var(--leading-ui); }

	@media (max-width: 63.999rem) {
		.dialog-layer { align-items: end; padding: 0; }
		.confirm-dialog { width: 100%; padding: 1.1rem max(1.1rem, env(safe-area-inset-right)) max(1.1rem, env(safe-area-inset-bottom)) max(1.1rem, env(safe-area-inset-left)); border-right: 0; border-bottom: 0; border-left: 0; border-radius: 1rem 1rem 0 0; }
	}
</style>
