<script lang="ts">
	let {
		ready,
		visible,
		stage
	}: {
		ready: boolean;
		visible: boolean;
		stage: 'opening' | 'attaching' | 'restoring';
	} = $props();

	const stageLabels = {
		opening: 'Opening shell',
		attaching: 'Attaching to tmux',
		restoring: 'Restoring screen'
	} as const;
	const tunnelRibs = Array.from({ length: 8 }, (_, index) => index);
</script>

<div
	class="shell-opening"
	class:is-visible={visible && !ready}
	class:is-ready={ready}
	role="status"
	aria-hidden={ready || !visible}
>
	<div class="shell-opening__veil shell-opening__veil--top" aria-hidden="true"></div>
	<div class="shell-opening__veil shell-opening__veil--bottom" aria-hidden="true"></div>

	<div class="shell-opening__content">
		<div class="shell-opening__tunnel" aria-hidden="true">
			{#each tunnelRibs as rib}
				<span class="shell-opening__rib" style={`--rib-delay: ${rib * -225}ms`}></span>
			{/each}
			<span class="shell-opening__cursor"></span>
		</div>

		<div class="shell-opening__status">
			<span class="shell-opening__prompt" aria-hidden="true">&gt;</span>
			<span>{stageLabels[stage]}</span>
			<span class="shell-opening__caret" aria-hidden="true"></span>
		</div>
	</div>
</div>

<style>
	.shell-opening {
		position: absolute;
		z-index: 3;
		inset: 0;
		overflow: hidden;
		pointer-events: none;
		visibility: visible;
	}

	.shell-opening.is-ready {
		visibility: hidden;
		transition: visibility 0s linear 280ms;
	}

	.shell-opening__veil {
		position: absolute;
		z-index: 0;
		left: 0;
		width: 100%;
		height: 50%;
		background: #0d0c0d;
		transition: transform 260ms cubic-bezier(0.76, 0, 0.24, 1);
	}

	.shell-opening__veil--top {
		top: 0;
		box-shadow: 0 1px rgb(228 91 103 / 0.1);
	}

	.shell-opening__veil--bottom {
		bottom: 0;
		box-shadow: 0 -1px rgb(228 91 103 / 0.1);
	}

	.shell-opening.is-ready .shell-opening__veil--top {
		transform: translateY(-100%);
	}

	.shell-opening.is-ready .shell-opening__veil--bottom {
		transform: translateY(100%);
	}

	.shell-opening__content {
		position: absolute;
		z-index: 1;
		inset: 0;
		display: grid;
		place-items: center;
		opacity: 0;
		transform: scale(0.97);
		transition: opacity 180ms ease-out, transform 220ms ease-out;
	}

	.shell-opening.is-visible .shell-opening__content {
		opacity: 1;
		transform: scale(1);
	}

	.shell-opening.is-ready .shell-opening__content {
		opacity: 0;
		transform: scale(1.06);
		transition-duration: 100ms;
	}

	.shell-opening__tunnel {
		position: absolute;
		top: 50%;
		left: 50%;
		width: clamp(12rem, 42vw, 30rem);
		aspect-ratio: 16 / 9;
		perspective: 480px;
		transform: translate(-50%, -62%);
		transform-style: preserve-3d;
	}

	.shell-opening__rib {
		position: absolute;
		inset: 0;
		border: 1px solid rgb(228 91 103 / 0.34);
		border-radius: 0.32rem;
		box-shadow: inset 0 0 1.25rem rgb(228 91 103 / 0.035);
		opacity: 0;
		animation: shell-rib-flight 1.8s linear infinite;
		animation-delay: var(--rib-delay);
		will-change: opacity, transform;
	}

	.shell-opening__cursor {
		position: absolute;
		top: 50%;
		left: 50%;
		width: 0.38rem;
		height: 1.1rem;
		background: var(--color-accent);
		box-shadow: 0 0 1rem rgb(228 91 103 / 0.28);
		transform: translate(-50%, -50%);
		animation: shell-cursor-pulse 900ms steps(1, end) infinite;
	}

	.shell-opening__status {
		position: absolute;
		top: calc(50% + clamp(5.4rem, 13vw, 8.6rem));
		left: 50%;
		display: flex;
		align-items: center;
		gap: 0.42rem;
		min-width: max-content;
		color: var(--color-text-tertiary);
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: var(--text-caption);
		font-weight: var(--weight-medium);
		letter-spacing: 0.025em;
		transform: translateX(-50%);
	}

	.shell-opening__prompt {
		color: var(--color-accent);
	}

	.shell-opening__caret {
		width: 0.38rem;
		height: 0.85rem;
		background: rgb(228 91 103 / 0.72);
		animation: shell-cursor-pulse 900ms steps(1, end) infinite;
	}

	@keyframes shell-rib-flight {
		0% {
			opacity: 0;
			transform: translateZ(-360px) scale(0.48);
		}

		20% { opacity: 0.2; }
		68% { opacity: 0.62; }

		100% {
			opacity: 0;
			transform: translateZ(90px) scale(1.04);
		}
	}

	@keyframes shell-cursor-pulse {
		0%, 46% { opacity: 0.9; }
		47%, 100% { opacity: 0.18; }
	}

	@media (max-width: 40rem) {
		.shell-opening__tunnel { width: min(72vw, 20rem); }
		.shell-opening__status { top: calc(50% + clamp(4.4rem, 22vw, 6.8rem)); }
	}

	@media (prefers-reduced-motion: reduce) {
		.shell-opening,
		.shell-opening__veil,
		.shell-opening__content {
			transition: none;
		}

		.shell-opening.is-ready { display: none; }
		.shell-opening__rib { animation: none; }
		.shell-opening__rib:nth-child(3) {
			opacity: 0.28;
			transform: scale(0.76);
		}
		.shell-opening__cursor,
		.shell-opening__caret { animation: none; }
	}
</style>
