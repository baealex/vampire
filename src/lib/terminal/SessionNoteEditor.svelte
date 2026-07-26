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
	.note-editor { position: absolute; z-index: 12; top: calc(100% + 0.5rem); right: 0.75rem; display: grid; gap: 0.9rem; width: min(30rem, calc(100vw - 1.5rem)); padding: 1rem; border: 1px solid #4a4143; border-radius: 0.8rem; background: #1a1718; box-shadow: 0 1.25rem 3.5rem rgb(0 0 0 / 0.5); }
	header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
	h2 { margin: 0; font-size: var(--text-title); font-weight: var(--weight-strong); line-height: var(--leading-tight); }
	header p { margin: 0.25rem 0 0; color: #948b8d; font-size: var(--text-caption); line-height: var(--leading-ui); }
	.close-button { display: grid; flex: 0 0 auto; place-items: center; width: 2rem; height: 2rem; padding: 0; border: 0; border-radius: 0.42rem; background: transparent; color: #a69d9f; cursor: pointer; }
	.close-button:hover { background: #2c2728; color: #fff; }
	form { display: grid; gap: 0.65rem; }
	textarea { width: 100%; min-height: 8.5rem; resize: vertical; padding: 0.75rem; border: 1px solid #40393a; border-radius: 0.55rem; outline: none; background: #100f0f; color: #eee8e9; font: inherit; font-size: var(--text-body); line-height: var(--leading-body); }
	textarea::placeholder { color: #6f6769; }
	textarea:focus { border-color: #a94751; box-shadow: 0 0 0 0.18rem rgb(228 91 103 / 0.12); }
	.note-footer { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
	.note-footer > span { color: #746c6e; font-size: var(--text-caption); font-variant-numeric: tabular-nums; }
	.note-actions { display: flex; gap: 0.45rem; }
	.cancel-button, .save-button { min-height: 2.25rem; padding: 0 0.75rem; border-radius: 0.45rem; font: inherit; font-size: var(--text-label); font-weight: var(--weight-medium); cursor: pointer; }
	.cancel-button { border: 1px solid #40393a; background: transparent; color: #b8afb1; }
	.cancel-button:hover { background: #2a2526; color: #fff; }
	.save-button { border: 0; background: #e45b67; color: #260b0e; }
	.save-button:hover:not(:disabled) { background: #ed707a; }
	.save-button:disabled { cursor: wait; opacity: 0.6; }
	.note-error { margin: 0; color: #ffadb4; font-size: var(--text-label); line-height: var(--leading-ui); }

	@media (max-width: 32rem) {
		.note-editor { right: 0.5rem; width: calc(100vw - 1rem); }
		textarea { min-height: 7.5rem; font-size: 1rem; }
	}
</style>
