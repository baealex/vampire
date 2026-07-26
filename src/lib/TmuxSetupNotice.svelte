<script lang="ts">
	import type { TmuxStatus } from '$lib/tmux-status';

	let { status }: { status: TmuxStatus } = $props();
</script>

{#if !status.available}
	<section class="tmux-notice" aria-labelledby="tmux-notice-title">
		<div class="tmux-notice-copy">
			<p class="eyebrow">Terminal runtime</p>
			<h2 id="tmux-notice-title">tmux is not installed</h2>
			<p>Vampire needs tmux on the computer running this server. Your browser and other devices do not need it.</p>
		</div>
		<div class="tmux-commands" aria-label={`${status.install.platform} installation commands`}>
			{#each status.install.commands as command}
				<code>{command}</code>
			{/each}
		</div>
		<p class="tmux-note">{status.install.note}</p>
		<div class="tmux-actions">
			<button type="button" onclick={() => location.reload()}>Check again</button>
			<span>Installation is never attempted automatically.</span>
		</div>
	</section>
{/if}

<style>
	.tmux-notice { display: grid; gap: 0.8rem; width: min(calc(100% - 2rem), 42rem); margin: 1rem auto 0; padding: 1rem; border: 1px solid #6b4d2e; border-radius: 0.75rem; background: #292016; color: #f0dfc4; }
	.tmux-notice-copy { display: grid; gap: 0.35rem; }
	.eyebrow { margin: 0; color: #d59e5c; font-size: var(--text-caption); font-weight: var(--weight-medium); line-height: var(--leading-ui); }
	.tmux-notice h2 { margin: 0; font-size: var(--text-title); font-weight: var(--weight-strong); line-height: var(--leading-tight); }
	.tmux-notice-copy > p:last-child, .tmux-note { margin: 0; color: #d9c5a8; font-size: var(--text-body); line-height: var(--leading-body); }
	.tmux-commands { display: grid; gap: 0.45rem; }
	.tmux-commands code { display: block; overflow-x: auto; padding: 0.62rem 0.7rem; border: 1px solid #5a4329; border-radius: 0.45rem; background: #17120d; color: #f2d8ae; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--text-caption); white-space: pre-wrap; overflow-wrap: anywhere; }
	.tmux-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 0.7rem; }
	.tmux-actions button { min-height: 2.25rem; padding: 0 0.75rem; border: 1px solid #8c6338; border-radius: 0.45rem; background: #49321d; color: #ffe4bd; font: inherit; font-size: var(--text-label); font-weight: var(--weight-medium); cursor: pointer; }
	.tmux-actions button:hover { background: #5a3d23; }
	.tmux-actions span { color: #bfa98b; font-size: var(--text-caption); }

	@media (min-width: 64rem) {
		.tmux-notice { width: auto; margin: 1rem; }
	}
</style>
