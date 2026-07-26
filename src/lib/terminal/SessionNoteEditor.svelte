<script lang="ts">
	import { onMount } from 'svelte';
	import X from '@lucide/svelte/icons/x';

	let {
		note,
		close,
		save
	}: {
		note: string;
		close: () => void;
		save: (note: string) => Promise<void>;
	} = $props();

	let draft = $state('');
	let saving = $state(false);
	let saveError = $state('');
	let textarea: HTMLTextAreaElement;

	onMount(() => {
		draft = note;
		textarea.focus();
	});

	async function submit() {
		if (saving) return;
		saving = true;
		saveError = '';
		try {
			await save(draft);
		} catch (error) {
			saveError = error instanceof Error ? error.message : 'The note could not be saved.';
		} finally {
			saving = false;
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			close();
		} else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			void submit();
		}
	}
</script>

<div class="note-editor" role="dialog" aria-labelledby="workspace-note-title" tabindex="-1" onkeydown={handleKeydown}>
	<header>
		<div>
			<h2 id="workspace-note-title">Workspace note</h2>
			<p>Keep the intent, decisions, and next step close to this shell.</p>
		</div>
		<button type="button" class="close-button" onclick={close} aria-label="Close workspace note">
			<X size={17} strokeWidth={1.9} aria-hidden="true" />
		</button>
	</header>
	<form onsubmit={(event) => { event.preventDefault(); void submit(); }}>
		<textarea
			bind:this={textarea}
			bind:value={draft}
			maxlength="4000"
			placeholder="What is this workspace for? What changed? What comes next?"
			aria-label="Workspace note"
		></textarea>
		<div class="note-footer">
			<span>{draft.length.toLocaleString()} / 4,000</span>
			<div class="note-actions">
				<button type="button" class="cancel-button" onclick={close}>Cancel</button>
				<button type="submit" class="save-button" disabled={saving}>{saving ? 'Saving…' : 'Save note'}</button>
			</div>
		</div>
		{#if saveError}<p class="note-error" role="alert">{saveError}</p>{/if}
	</form>
</div>

<style>
	.note-editor { position: absolute; z-index: 12; top: calc(100% + 0.5rem); right: 0.75rem; display: grid; gap: 0.9rem; width: min(30rem, calc(100vw - 1.5rem)); padding: 1rem; border: 1px solid var(--color-border-strong); border-radius: 0.8rem; background: var(--color-surface-overlay); box-shadow: var(--shadow-popover); }
	header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
	h2 { margin: 0; font-size: var(--text-title); font-weight: var(--weight-strong); line-height: var(--leading-tight); }
	header p { margin: 0.25rem 0 0; color: var(--color-text-tertiary); font-size: var(--text-caption); line-height: var(--leading-ui); }
	.close-button { display: grid; flex: 0 0 auto; place-items: center; width: 2rem; height: 2rem; padding: 0; border: 0; border-radius: 0.42rem; background: transparent; color: var(--color-text-secondary); cursor: pointer; }
	.close-button:hover { background: var(--color-control-hover); color: var(--color-text); }
	form { display: grid; gap: 0.65rem; }
	textarea { width: 100%; min-height: 8.5rem; resize: vertical; padding: 0.75rem; border: 1px solid var(--color-border); border-radius: 0.55rem; outline: none; background: var(--color-field-background); color: var(--color-text); font: inherit; font-size: var(--text-body); line-height: var(--leading-body); }
	textarea::placeholder { color: var(--color-field-placeholder); }
	textarea:focus { border-color: var(--color-accent); box-shadow: var(--shadow-accent-focus); }
	.note-footer { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
	.note-footer > span { color: var(--color-text-tertiary); font-size: var(--text-caption); font-variant-numeric: tabular-nums; }
	.note-actions { display: flex; gap: 0.45rem; }
	.cancel-button, .save-button { min-height: 2.25rem; padding: 0 0.75rem; border-radius: 0.45rem; font: inherit; font-size: var(--text-label); font-weight: var(--weight-medium); cursor: pointer; }
	.cancel-button { border: 1px solid var(--color-border); background: transparent; color: var(--color-text-secondary); }
	.cancel-button:hover { background: var(--color-control-hover); color: var(--color-text); }
	.save-button { border: 0; background: var(--color-accent); color: var(--color-accent-ink); }
	.save-button:hover:not(:disabled) { background: var(--color-accent-hover); }
	.save-button:disabled { cursor: wait; opacity: 0.6; }
	.note-error { margin: 0; color: var(--color-danger-text); font-size: var(--text-label); line-height: var(--leading-ui); }

	@media (max-width: 32rem) {
		.note-editor { right: 0.5rem; width: calc(100vw - 1rem); }
		textarea { min-height: 7.5rem; font-size: 1rem; }
	}
</style>
