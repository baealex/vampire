<script lang="ts">
	import X from '@lucide/svelte/icons/x';
	import DocumentOpening from './DocumentOpening.svelte';
	import { isPreviewableImage, parseDiffLines } from './view';
	import type { RepositoryDiff, RepositorySelection, WorkspaceFile } from './types';

	let {
		sessionId,
		selection,
		refreshToken,
		onClose
	}: {
		sessionId: string;
		selection: RepositorySelection;
		refreshToken: number;
		onClose: () => void;
	} = $props();

	let file = $state<WorkspaceFile>();
	let diff = $state<RepositoryDiff>();
	let imageUrl = $state('');
	let imageVersion = '';
	let loading = $state(true);
	let errorMessage = $state('');
	let lastSelectionKey = '';
	let parsedSections = $derived(diff?.sections.map((section) => ({
		...section,
		lines: parseDiffLines(section.patch)
	})) ?? []);
	const fileName = $derived(selection.path.split('/').pop() || selection.path);
	const imagePreview = $derived(selection.kind === 'file' && isPreviewableImage(selection.path));

	async function request<T>(url: string, signal: AbortSignal): Promise<T> {
		const response = await fetch(url, { signal });
		if (!response.ok) {
			const body: unknown = await response.json().catch(() => undefined);
			const message = body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
				? body.message
				: 'Unable to read this file.';
			throw new Error(message);
		}
		return response.json() as Promise<T>;
	}

	$effect(() => {
		const requestedRefresh = refreshToken;
		const requestedSelection = selection;
		const selectionKey = `${sessionId}:${requestedSelection.kind}:${requestedSelection.path}`;
		const firstLoad = selectionKey !== lastSelectionKey;
		lastSelectionKey = selectionKey;
		if (firstLoad) {
			file = undefined;
			diff = undefined;
			imageUrl = '';
			imageVersion = '';
			loading = true;
			errorMessage = '';
		}

		const controller = new AbortController();
		void (async () => {
			const query = new URLSearchParams({ path: requestedSelection.path });
			const endpoint = requestedSelection.kind === 'diff' ? 'diff' : 'file';
			let waitingForImage = false;
			try {
				if (requestedSelection.kind === 'file' && isPreviewableImage(requestedSelection.path)) {
					const mediaUrl = `/api/sessions/${encodeURIComponent(sessionId)}/repository/media?${query}`;
					const response = await fetch(mediaUrl, { method: 'HEAD', signal: controller.signal });
					if (!response.ok) throw new Error('This image cannot be previewed.');
					const version = response.headers.get('etag') ?? `${response.headers.get('content-length') ?? ''}:${requestedRefresh}`;
					if (!imageVersion || version !== imageVersion) {
						imageVersion = version;
						imageUrl = `${mediaUrl}&version=${encodeURIComponent(version)}`;
						loading = true;
						waitingForImage = true;
					} else {
						loading = false;
					}
					file = undefined;
					diff = undefined;
				} else if (requestedSelection.kind === 'diff') {
					diff = await request<RepositoryDiff>(`/api/sessions/${encodeURIComponent(sessionId)}/repository/${endpoint}?${query}`, controller.signal);
					file = undefined;
					imageUrl = '';
				} else {
					file = await request<WorkspaceFile>(`/api/sessions/${encodeURIComponent(sessionId)}/repository/${endpoint}?${query}`, controller.signal);
					diff = undefined;
					imageUrl = '';
				}
				errorMessage = '';
			} catch (error) {
				if (controller.signal.aborted) return;
				errorMessage = error instanceof Error ? error.message : 'Unable to read this file.';
			} finally {
				if (!controller.signal.aborted && !waitingForImage) loading = false;
			}
		})();

		return () => controller.abort();
	});
</script>

<section class="repository-viewer" aria-label={`${selection.kind === 'diff' ? 'Diff' : 'File'} for ${selection.path}`}>
	<header class="document-header">
		<span class="document-kind">{selection.kind === 'diff' ? 'Diff' : 'File'}</span>
		<strong title={selection.path}>{selection.path}</strong>
		<button class="mobile-close" type="button" onclick={onClose} aria-label={`Close ${selection.kind}`} title={`Close ${selection.kind}`}>
			<X size={17} strokeWidth={1.8} aria-hidden="true" />
		</button>
	</header>

	{#if errorMessage}
		<p class="viewer-warning" role="status">{errorMessage}</p>
	{/if}

	<div class="viewer-content">
		{#if imagePreview && imageUrl}
			<div class="image-document">
				<img
					class:is-ready={!loading && !errorMessage}
					src={imageUrl}
					alt={fileName}
					onload={() => loading = false}
					onerror={() => {
						loading = false;
						errorMessage = 'This image cannot be previewed.';
					}}
				/>
				{#if loading}
					<div class="image-opening">
						<DocumentOpening kind="image" path={selection.path} />
					</div>
				{/if}
			</div>
		{:else if loading && !file && !diff}
			<DocumentOpening kind={imagePreview ? 'image' : selection.kind} path={selection.path} />
		{:else if selection.kind === 'diff' && diff}
			{#if parsedSections.length === 0}
				<div class="viewer-state">
					<div>
						<strong>No diff remains</strong>
						<p>The agent may have reverted or committed this change.</p>
					</div>
				</div>
			{:else}
				<div class="diff-document">
					{#each parsedSections as section (`${section.kind}:${section.patch}`)}
						<section class="diff-section" aria-label={`${section.kind} changes`}>
							<header>
								<strong>{section.kind === 'staged' ? 'Staged changes' : section.kind === 'working' ? 'Working tree' : 'Untracked file'}</strong>
							</header>
							<div class="diff-lines">
								{#each section.lines as line, index (`${index}:${line.content}`)}
									<div class="diff-line" class:addition={line.kind === 'addition'} class:deletion={line.kind === 'deletion'} class:hunk={line.kind === 'hunk'} class:meta={line.kind === 'meta'}>
										<span class="line-number" aria-hidden="true">{line.oldLine ?? ''}</span>
										<span class="line-number" aria-hidden="true">{line.newLine ?? ''}</span>
										<code>{line.content || ' '}</code>
									</div>
								{/each}
							</div>
						</section>
					{/each}
				</div>
			{/if}
		{:else if selection.kind === 'file' && file}
			<div class="file-document">
				<pre><code>{file.content}</code></pre>
			</div>
		{:else if !loading}
			<div class="viewer-state">This content is unavailable.</div>
		{/if}
	</div>
</section>

<style>
	.repository-viewer { position: absolute; z-index: 5; inset: 0; display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; background: #0d0c0d; color: var(--color-text); }
	.document-header { display: grid; flex: 0 0 auto; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 0.65rem; min-width: 0; min-height: 2.65rem; padding: 0.4rem 0.8rem; border-bottom: 1px solid #2d292a; background: #131112; }
	.document-header strong { min-width: 0; overflow: hidden; color: var(--color-text-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--text-caption); font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
	.document-kind { color: #ef9da5; font-size: 0.68rem; font-weight: var(--weight-strong); letter-spacing: 0.05em; text-transform: uppercase; }
	.mobile-close { display: none; place-items: center; width: 2.25rem; height: 2.25rem; padding: 0; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--color-text-secondary); cursor: pointer; }
	.mobile-close:hover { background: var(--color-surface-raised); color: var(--color-text); }
	.viewer-warning { z-index: 2; margin: 0; padding: 0.5rem 0.75rem; border-bottom: 1px solid #5a343a; background: #28191c; color: #efafb5; font-size: var(--text-caption); line-height: var(--leading-ui); }
	.viewer-content { flex: 1 1 auto; min-width: 0; min-height: 0; overflow: auto; overscroll-behavior: contain; }
	.viewer-state { display: grid; min-height: 100%; place-items: center; padding: 2rem 1rem; color: var(--color-text-secondary); font-size: var(--text-label); text-align: center; }
	.viewer-state > div { max-width: 24rem; }
	.viewer-state strong { color: var(--color-text); font-size: var(--text-body); font-weight: var(--weight-medium); }
	.viewer-state p { margin: 0.4rem 0 1rem; line-height: var(--leading-body); }
	.file-document { min-width: 100%; min-height: 100%; width: max-content; padding: 1rem 1.1rem 3rem; }
	.file-document pre { min-width: 100%; margin: 0; tab-size: 4; }
	.file-document code { color: #e4dfe0; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 0.8125rem; line-height: 1.55; white-space: pre; }
	.image-document { position: relative; display: grid; min-width: 100%; min-height: 100%; place-items: center; padding: 1.5rem; background-color: #0d0c0d; background-image: linear-gradient(45deg, #151315 25%, transparent 25%), linear-gradient(-45deg, #151315 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #151315 75%), linear-gradient(-45deg, transparent 75%, #151315 75%); background-position: 0 0, 0 0.5rem, 0.5rem -0.5rem, -0.5rem 0; background-size: 1rem 1rem; }
	.image-document img { display: block; max-width: 100%; max-height: calc(100dvh - 7rem); opacity: 0; object-fit: contain; box-shadow: 0 0 0 1px rgb(255 255 255 / 0.08), 0 0.75rem 2rem rgb(0 0 0 / 0.3); transition: opacity 140ms ease-out; }
	.image-document img.is-ready { opacity: 1; }
	.image-opening { position: absolute; inset: 0; background: #0d0c0d; }
	.diff-document { min-width: 100%; min-height: 100%; width: max-content; padding-bottom: 3rem; }
	.diff-section > header { position: sticky; z-index: 2; top: 0; min-width: 100%; padding: 0.55rem 0.85rem; border-bottom: 1px solid #302b2c; background: #171415; color: var(--color-text-secondary); font-size: var(--text-caption); }
	.diff-section + .diff-section { border-top: 1px solid #4a3f41; }
	.diff-lines { min-width: 100%; width: max-content; padding: 0.45rem 0; }
	.diff-line { display: grid; grid-template-columns: 3.1rem 3.1rem minmax(max-content, 1fr); min-width: 100%; min-height: 1.35rem; color: #cfc8ca; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 0.75rem; line-height: 1.5; }
	.diff-line.addition { background: #13251a; color: #b9dfc6; }
	.diff-line.deletion { background: #2b171b; color: #e8b8bc; }
	.diff-line.hunk { margin: 0.35rem 0; background: #1d2030; color: #aeb8e4; }
	.diff-line.meta { color: #8e8688; }
	.diff-line code { padding: 0 0.8rem; font: inherit; white-space: pre; }
	.line-number { padding: 0 0.55rem; border-right: 1px solid rgb(255 255 255 / 0.045); color: #625b5d; text-align: right; user-select: none; }
	.diff-line.addition .line-number { color: #56846a; }
	.diff-line.deletion .line-number { color: #8d5960; }

	@media (max-width: 63.999rem) {
		.mobile-close { display: grid; }
	}

	@media (max-width: 40rem) {
		.document-header { gap: 0.5rem; padding: 0.28rem 0.45rem 0.28rem 0.65rem; }
		.diff-line { grid-template-columns: 2.5rem 2.5rem minmax(max-content, 1fr); font-size: 0.7rem; }
		.line-number { padding-inline: 0.35rem; }
	}

	@media (prefers-reduced-motion: reduce) {
		.image-document img { transition: none; }
	}
</style>
