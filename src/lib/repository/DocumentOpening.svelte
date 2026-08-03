<script lang="ts">
	let {
		kind,
		path
	}: {
		kind: 'diff' | 'file' | 'image';
		path: string;
	} = $props();

	const portalFrames = Array.from({ length: 7 }, (_, index) => index);
	const codeRows = Array.from({ length: 6 }, (_, index) => index);
	const pixels = Array.from({ length: 20 }, (_, index) => index);
	const fileName = $derived(path.split('/').pop() || path);
	const command = $derived(kind === 'diff' ? 'git diff --' : kind === 'image' ? 'decode' : 'read');
	const status = $derived(kind === 'diff' ? 'Streaming changes' : kind === 'image' ? 'Decoding image' : 'Reading file');
</script>

<div class="document-opening" role="status" aria-live="polite">
	<div class="document-opening__scene" aria-hidden="true">
		{#each portalFrames as frame}
			<span class="document-opening__frame" style={`--frame-delay: ${frame * -180}ms`}></span>
		{/each}

		<div class="document-opening__payload" class:diff={kind === 'diff'} class:image={kind === 'image'}>
			<div class="document-opening__command">
				<span>&gt;</span>
				<code>{command}</code>
			</div>
			{#if kind === 'image'}
				<div class="document-opening__pixels">
					{#each pixels as pixel}
						<span style={`--cell-delay: ${(pixel % 7) * 90}ms`}></span>
					{/each}
				</div>
			{:else}
				<div class="document-opening__code">
					{#each codeRows as row}
						<span
							class:addition={kind === 'diff' && row === 2}
							class:deletion={kind === 'diff' && row === 4}
							style={`--row: ${row}; --row-width: ${48 + ((row * 17) % 43)}%`}
						></span>
					{/each}
				</div>
			{/if}
			<span class="document-opening__scan"></span>
		</div>
	</div>

	<div class="document-opening__message">
		<p><span aria-hidden="true">&gt;</span> {status}<span class="document-opening__caret" aria-hidden="true"></span></p>
		<code title={path}>{fileName}</code>
	</div>
</div>

<style>
	.document-opening {
		display: grid;
		min-width: 0;
		min-height: 100%;
		place-content: center;
		place-items: center;
		gap: clamp(1.4rem, 4vh, 2.2rem);
		padding: 2rem 1rem;
		overflow: hidden;
		background: var(--color-terminal-background);
		color: var(--color-text-tertiary);
	}

	.document-opening__scene {
		position: relative;
		width: clamp(10rem, 32vw, 17rem);
		aspect-ratio: 16 / 10;
		perspective: 520px;
		transform-style: preserve-3d;
	}

	.document-opening__frame {
		position: absolute;
		inset: -0.6rem;
		border: 1px solid var(--color-visual-accent-border);
		border-radius: var(--radius-control);
		opacity: 0;
		animation: document-frame-flight 1.45s linear infinite;
		animation-delay: var(--frame-delay);
		will-change: opacity, transform;
	}

	.document-opening__payload {
		position: absolute;
		z-index: 2;
		inset: 0;
		display: grid;
		grid-template-rows: auto minmax(0, 1fr);
		overflow: hidden;
		border: 1px solid var(--color-visual-frame);
		border-radius: 0.48rem;
		background: var(--color-panel);
		box-shadow: var(--shadow-document);
		transform: rotateX(2deg) translateZ(0);
	}

	.document-opening__command {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-width: 0;
		min-height: 1.8rem;
		padding: 0 0.65rem;
		border-bottom: 1px solid var(--color-border-subtle);
		background: var(--color-surface-overlay);
		color: var(--color-text-tertiary);
		font-family: var(--font-mono);
		font-size: 0.62rem;
	}

	.document-opening__command span { color: var(--color-accent); }
	.document-opening__command code { overflow: hidden; font: inherit; text-overflow: ellipsis; white-space: nowrap; }

	.document-opening__code {
		display: grid;
		align-content: center;
		gap: 0.52rem;
		padding: 0.85rem 1rem;
	}

	.document-opening__code span {
		display: block;
		width: var(--row-width);
		height: 0.24rem;
		border-radius: 99px;
		background: var(--color-visual-muted);
		opacity: 0.36;
		transform-origin: left;
		animation: document-row-read 1.45s ease-in-out infinite;
		animation-delay: calc(var(--row) * 70ms);
	}

	.document-opening__code span.addition { background: var(--color-visual-add); }
	.document-opening__code span.deletion { background: var(--color-visual-delete); }

	.document-opening__pixels {
		display: grid;
		grid-template-columns: repeat(5, 1fr);
		gap: 0.3rem;
		padding: 0.72rem 1.25rem 0.9rem;
	}

	.document-opening__pixels span {
		border-radius: 0.12rem;
		background: var(--color-visual-pixel);
		animation: document-pixel-load 1.2s steps(2, end) infinite;
		animation-delay: var(--cell-delay);
	}

	.document-opening__pixels span:nth-child(3n + 1) { background: var(--color-visual-pixel-accent); }
	.document-opening__pixels span:nth-child(4n + 2) { background: var(--color-visual-pixel-blue); }
	.document-opening__pixels span:nth-child(5n) { background: var(--color-visual-pixel-green); }

	.document-opening__scan {
		position: absolute;
		z-index: 3;
		top: 1.8rem;
		right: 0;
		left: 0;
		height: 1px;
		background: linear-gradient(90deg, transparent, var(--color-visual-accent-line), transparent);
		box-shadow: 0 0 0.7rem var(--color-visual-accent-glow);
		animation: document-scan 1.45s ease-in-out infinite;
	}

	.document-opening__message {
		display: grid;
		max-width: min(22rem, 78vw);
		justify-items: center;
		gap: 0.35rem;
		font-family: var(--font-mono);
		font-size: var(--text-caption);
	}

	.document-opening__message p {
		display: flex;
		align-items: center;
		gap: 0.38rem;
		margin: 0;
		color: var(--color-text-secondary);
		font: inherit;
		font-weight: var(--weight-medium);
		letter-spacing: 0.02em;
	}

	.document-opening__message p > span:first-child { color: var(--color-accent); }
	.document-opening__message > code {
		max-width: 100%;
		overflow: hidden;
		color: var(--color-text-disabled);
		font: inherit;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.document-opening__caret {
		width: 0.38rem;
		height: 0.78rem;
		background: var(--color-visual-accent-solid);
		animation: document-caret 900ms steps(1, end) infinite;
	}

	@keyframes document-frame-flight {
		0% { opacity: 0; transform: translateZ(-260px) scale(0.58); }
		24% { opacity: 0.16; }
		72% { opacity: 0.46; }
		100% { opacity: 0; transform: translateZ(70px) scale(1.03); }
	}

	@keyframes document-row-read {
		0%, 18% { opacity: 0.18; transform: scaleX(0.2); }
		48%, 78% { opacity: 0.52; transform: scaleX(1); }
		100% { opacity: 0.24; transform: scaleX(1); }
	}

	@keyframes document-pixel-load {
		0%, 24% { opacity: 0.16; transform: scale(0.86); }
		48%, 76% { opacity: 0.78; transform: scale(1); }
		100% { opacity: 0.24; transform: scale(0.92); }
	}

	@keyframes document-scan {
		0% { opacity: 0; transform: translateY(0); }
		16% { opacity: 0.8; }
		82% { opacity: 0.65; }
		100% { opacity: 0; transform: translateY(calc(clamp(10rem, 20vw, 17rem) * 0.52)); }
	}

	@keyframes document-caret {
		0%, 46% { opacity: 0.9; }
		47%, 100% { opacity: 0.16; }
	}

	@media (max-width: 40rem) {
		.document-opening { gap: 1.35rem; }
		.document-opening__scene { width: min(58vw, 14rem); }
	}

	@media (prefers-reduced-motion: reduce) {
		.document-opening__frame { animation: none; }
		.document-opening__frame:nth-child(4) { opacity: 0.28; transform: scale(0.82); }
		.document-opening__code span,
		.document-opening__pixels span,
		.document-opening__scan,
		.document-opening__caret { animation: none; }
		.document-opening__code span,
		.document-opening__pixels span { opacity: 0.48; transform: none; }
		.document-opening__scan { top: 62%; opacity: 0.55; }
	}
</style>
