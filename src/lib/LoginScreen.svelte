<script lang="ts">
	import ThemeToggle from '$lib/theme/ThemeToggle.svelte';

	let {
		token,
		error,
		onTokenChange,
		onSubmit
	}: {
		token: string;
		error: string;
		onTokenChange: (token: string) => void;
		onSubmit: () => void;
	} = $props();
</script>

<section class="login-screen" aria-label="Vampire access">
	<form class="login-panel" onsubmit={(event) => { event.preventDefault(); onSubmit(); }}>
		<header class="login-heading">
			<div class="login-brand">
				<img class="login-mark" src="/icon.svg" alt="" />
				<strong>Vampire</strong>
			</div>
			<ThemeToggle />
		</header>
		<div class="field">
			<label for="token">Access token</label>
			<input
				id="token"
				type="password"
				value={token}
				oninput={(event) => onTokenChange(event.currentTarget.value)}
				autocomplete="current-password"
				aria-invalid={error ? 'true' : undefined}
				aria-describedby={error ? 'login-error' : undefined}
				required
			/>
		</div>
		<button type="submit">Continue</button>
		{#if error}<p id="login-error" class="error" role="alert">{error}</p>{/if}
	</form>
</section>

<style>
	.login-screen { display: grid; min-height: 100dvh; place-items: center; overflow: hidden; padding: max(1rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) max(1rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left)); background: var(--color-canvas); color: var(--color-text); }
	.login-panel { display: grid; width: min(100%, 25rem); min-width: 0; gap: 1.25rem; padding: 1.5rem; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); box-shadow: var(--shadow-dialog); }
	.login-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
	.login-brand { display: flex; min-width: 0; align-items: center; gap: 0.7rem; }
	.login-brand strong { font-size: var(--text-heading); font-weight: var(--weight-strong); line-height: var(--leading-tight); }
	.login-mark { display: block; width: 2.75rem; height: 2.75rem; border-radius: var(--radius-md); }
	.field { display: grid; gap: 0.5rem; }
	label { color: var(--color-text); font-size: var(--text-label); font-weight: var(--weight-medium); }
	input { width: 100%; min-width: 0; min-height: var(--control-height-lg); padding: 0 0.8rem; border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); outline: none; background: var(--color-field-background); color: var(--color-text); font: inherit; font-size: var(--text-body); }
	input:focus { border-color: var(--color-accent); box-shadow: var(--shadow-accent-focus); }
	input[aria-invalid='true'] { border-color: var(--color-danger-border-strong); }
	button { display: inline-flex; min-height: var(--control-height-lg); align-items: center; justify-content: center; gap: 0.5rem; border: 0; border-radius: var(--radius-sm); background: var(--color-accent); color: var(--color-accent-ink); font: inherit; font-size: var(--text-label); font-weight: var(--weight-strong); cursor: pointer; }
	button:hover { background: var(--color-accent-hover); }
	button:focus-visible { outline: none; box-shadow: var(--shadow-accent-focus); }
	.error { margin: 0.1rem 0 0; color: var(--color-danger); font-size: var(--text-label); line-height: var(--leading-ui); }

	@media (max-width: 48rem) {
		.login-screen { overflow: auto; }
		input { font-size: 1rem; }
	}
</style>
