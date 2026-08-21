<script lang="ts">
import { onDestroy } from 'svelte';
import FilePenLine from '@lucide/svelte/icons/file-pen-line';
import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
import X from '@lucide/svelte/icons/x';
import DocumentOpening from './DocumentOpening.svelte';
import { RepositoryClient } from './client';
import { isPreviewableImage, parseDiffLines } from './view';
import type { RepositoryDiff, RepositorySelection, WorkspaceFile } from './types';

let {
  sessionId,
  selection,
  refreshToken,
  initialFile,
  onClose,
  onEditFile = () => undefined,
  onRequestDiscardChange = () => undefined,
  onFileSaved = () => undefined,
  onFileDirtyChange = () => undefined,
}: {
  sessionId: string;
  selection: RepositorySelection;
  refreshToken: number;
  initialFile?: WorkspaceFile;
  onClose: () => void;
  onEditFile?: (path: string) => void;
  onRequestDiscardChange?: (path: string) => void;
  onFileSaved?: (file: WorkspaceFile) => void;
  onFileDirtyChange?: (dirty: boolean) => void;
} = $props();

let file = $state<WorkspaceFile>();
let diff = $state<RepositoryDiff>();
let imageUrl = $state('');
let imageVersion = '';
let loading = $state(true);
let errorMessage = $state('');
let lastSelectionKey = '';
let fileDirty = $state(false);
let editorModule: Promise<typeof import('./RepositoryCodeEditor.svelte')> | undefined;
let textFileRequest:
  | {
      controller: AbortController;
      key: string;
      promise: Promise<WorkspaceFile>;
    }
  | undefined;
let parsedSections = $derived(
  diff?.sections.map((section) => ({
    ...section,
    lines: parseDiffLines(section.patch),
  })) ?? []
);
const fileName = $derived(selection.path.split('/').pop() || selection.path);
const imagePreview = $derived(selection.kind === 'file' && isPreviewableImage(selection.path));
const repositoryApi = $derived(new RepositoryClient(sessionId));

function loadEditor() {
  editorModule ??= import('./RepositoryCodeEditor.svelte').catch((error) => {
    editorModule = undefined;
    throw error;
  });
  return editorModule;
}

function setFileDirty(dirty: boolean) {
  fileDirty = dirty;
  onFileDirtyChange?.(dirty);
}

function handleFileSaved(saved: WorkspaceFile) {
  file = saved;
  setFileDirty(false);
  onFileSaved?.(saved);
}

function readTextFile(selectionKey: string, path: string): Promise<WorkspaceFile> {
  if (textFileRequest?.key === selectionKey) return textFileRequest.promise;
  textFileRequest?.controller.abort();
  const controller = new AbortController();
  const promise = repositoryApi.readFile(path, controller.signal);
  textFileRequest = { controller, key: selectionKey, promise };
  return promise;
}

onDestroy(() => textFileRequest?.controller.abort());

$effect(() => {
  const requestedSelection = selection;
  // A repository status refresh must not cancel an in-flight text file open.
  const refreshesWithRepository = requestedSelection.kind === 'diff' || isPreviewableImage(requestedSelection.path);
  const selectionKey = `${sessionId}:${requestedSelection.kind}:${requestedSelection.path}`;
  if (textFileRequest && textFileRequest.key !== selectionKey) {
    textFileRequest.controller.abort();
    textFileRequest = undefined;
  }
  const requestedRefresh = refreshesWithRepository ? refreshToken : 0;
  const firstLoad = selectionKey !== lastSelectionKey;
  lastSelectionKey = selectionKey;
  if (firstLoad) {
    file = undefined;
    diff = undefined;
    imageUrl = '';
    imageVersion = '';
    loading = true;
    errorMessage = '';
    setFileDirty(false);
  }

  const controller = new AbortController();
  let active = true;
  void (async () => {
    let waitingForImage = false;
    try {
      if (requestedSelection.kind === 'file' && isPreviewableImage(requestedSelection.path)) {
        const mediaUrl = repositoryApi.mediaUrl(requestedSelection.path);
        const response = await repositoryApi.checkMedia(requestedSelection.path, controller.signal);
        const version =
          response.headers.get('etag') ?? `${response.headers.get('content-length') ?? ''}:${requestedRefresh}`;
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
        diff = await repositoryApi.readDiff(requestedSelection.path, controller.signal);
        file = undefined;
        imageUrl = '';
      } else if (!firstLoad && file) {
        loading = false;
      } else if (initialFile?.path === requestedSelection.path) {
        file = initialFile;
        diff = undefined;
        imageUrl = '';
        loading = false;
      } else {
        const loadedFile = await readTextFile(selectionKey, requestedSelection.path);
        if (!active) return;
        file = loadedFile;
        diff = undefined;
        imageUrl = '';
      }
      errorMessage = '';
    } catch (error) {
      if (!active || controller.signal.aborted) return;
      errorMessage = error instanceof Error ? error.message : 'Unable to read this file.';
    } finally {
      if (active && !controller.signal.aborted && !waitingForImage) loading = false;
    }
  })();

  return () => {
    active = false;
    if (refreshesWithRepository) controller.abort();
  };
});
</script>

<section class="repository-viewer" aria-label={`${selection.kind === 'diff' ? 'Diff' : 'File'} for ${selection.path}`}>
  <header class="document-header">
    <span class="document-kind">{selection.kind === 'diff' ? 'Diff' : 'File'}</span>
    <strong title={selection.path}>{selection.path}</strong>
    <div class="document-actions">
      {#if selection.kind === 'file' && file && !imagePreview && fileDirty}
        <span class="dirty-indicator" role="status">Unsaved</span>
      {/if}
      {#if selection.kind === 'diff'}
        <button
          class="document-action edit-file"
          type="button"
          onclick={() => onEditFile(selection.path)}
          aria-label={`Edit ${selection.path}`}
          title="Edit file"
        >
          <FilePenLine size={17} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <button
          class="document-action discard-file"
          type="button"
          onclick={() => onRequestDiscardChange(selection.path)}
          aria-label={`Discard changes for ${selection.path}`}
          title="Discard changes"
        >
          <RotateCcw size={17} strokeWidth={1.8} aria-hidden="true" />
        </button>
      {/if}
      <button
        class="document-action viewer-close"
        type="button"
        onclick={onClose}
        aria-label={`Close ${selection.kind} and return to terminal`}
        title={`Close ${selection.kind} and return to terminal`}
      >
        <X size={17} strokeWidth={1.8} aria-hidden="true" />
      </button>
    </div>
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
        >
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
                <strong
                  >{section.kind === 'staged' ? 'Staged changes' : section.kind === 'working' ? 'Working tree' : 'Untracked file'}</strong
                >
              </header>
              <div class="diff-lines">
                {#each section.lines as line, index (`${index}:${line.content}`)}
                  <div
                    class="diff-line"
                    class:addition={line.kind === 'addition'}
                    class:deletion={line.kind === 'deletion'}
                    class:hunk={line.kind === 'hunk'}
                    class:meta={line.kind === 'meta'}
                  >
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
    {:else if selection.kind === 'file' && file && !imagePreview}
      <div class="file-document">
        {#await loadEditor()}
          <DocumentOpening kind="file" path={selection.path} />
        {:then loadedEditor}
          {@const RepositoryCodeEditor = loadedEditor.default}
          <RepositoryCodeEditor {sessionId} {file} onSaved={handleFileSaved} onDirtyChange={setFileDirty} />
        {:catch}
          <div class="viewer-state">The editor could not be loaded.</div>
        {/await}
      </div>
    {:else if !loading}
      <div class="viewer-state">This content is unavailable.</div>
    {/if}
  </div>
</section>

<style>
.repository-viewer {
  position: absolute;
  z-index: 5;
  inset: 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--color-code-background);
  color: var(--color-text);
}
.document-header {
  display: grid;
  flex: 0 0 auto;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.65rem;
  min-width: 0;
  min-height: 2.65rem;
  padding: 0.4rem 0.8rem;
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-panel);
}
.document-header strong {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-size: var(--text-caption);
  font-weight: var(--weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.document-kind {
  color: var(--color-accent-soft-text);
  font-size: var(--text-micro);
  font-weight: var(--weight-strong);
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.document-actions {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}
.dirty-indicator {
  color: var(--color-warning-text);
  font-size: var(--text-caption);
}
.document-action {
  display: grid;
  place-items: center;
  width: 2.15rem;
  height: 2.15rem;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}
.document-action:focus-visible {
  background: var(--color-surface-raised);
  color: var(--color-text);
  outline: none;
}
.discard-file:focus-visible {
  background: var(--color-danger-surface-hover);
  color: var(--color-danger-text);
  outline: none;
}
@media (hover: hover) {
  .document-action:hover {
    background: var(--color-surface-raised);
    color: var(--color-text);
  }
  .discard-file:hover {
    background: var(--color-danger-surface-hover);
    color: var(--color-danger-text);
  }
}
.viewer-warning {
  z-index: 2;
  margin: 0;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--color-danger-border);
  background: var(--color-danger-surface);
  color: var(--color-danger-text);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
.viewer-content {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
}
.viewer-state {
  display: grid;
  min-height: 100%;
  place-items: center;
  padding: 2rem 1rem;
  color: var(--color-text-secondary);
  font-size: var(--text-label);
  text-align: center;
}
.viewer-state > div {
  max-width: 24rem;
}
.viewer-state strong {
  color: var(--color-text);
  font-size: var(--text-body);
  font-weight: var(--weight-medium);
}
.viewer-state p {
  margin: 0.4rem 0 1rem;
  line-height: var(--leading-body);
}
.file-document {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 100%;
  overflow: hidden;
}
.image-document {
  position: relative;
  display: grid;
  min-width: 100%;
  min-height: 100%;
  place-items: center;
  padding: 1.5rem;
  background-color: var(--color-code-background);
  background-image:
    linear-gradient(45deg, var(--color-checkerboard) 25%, transparent 25%),
    linear-gradient(-45deg, var(--color-checkerboard) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--color-checkerboard) 75%),
    linear-gradient(-45deg, transparent 75%, var(--color-checkerboard) 75%);
  background-position:
    0 0,
    0 0.5rem,
    0.5rem -0.5rem,
    -0.5rem 0;
  background-size: 1rem 1rem;
}
.image-document img {
  display: block;
  max-width: 100%;
  max-height: calc(100dvh - 7rem);
  opacity: 0;
  object-fit: contain;
  box-shadow: var(--shadow-image);
  transition: opacity 140ms ease-out;
}
.image-document img.is-ready {
  opacity: 1;
}
.image-opening {
  position: absolute;
  inset: 0;
  background: var(--color-code-background);
}
.diff-document {
  min-width: 100%;
  min-height: 100%;
  width: max-content;
  padding-bottom: 3rem;
}
.diff-section > header {
  position: sticky;
  z-index: 2;
  top: 0;
  min-width: 100%;
  padding: 0.55rem 0.85rem;
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
}
.diff-section + .diff-section {
  border-top: 1px solid var(--color-border-strong);
}
.diff-lines {
  min-width: 100%;
  width: max-content;
  padding: 0.45rem 0;
}
.diff-line {
  display: grid;
  grid-template-columns: 3.1rem 3.1rem minmax(max-content, 1fr);
  min-width: 100%;
  min-height: 1.35rem;
  color: var(--color-diff-text);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.5;
}
.diff-line.addition {
  background: var(--color-diff-add-background);
  color: var(--color-diff-add-text);
}
.diff-line.deletion {
  background: var(--color-diff-delete-background);
  color: var(--color-diff-delete-text);
}
.diff-line.hunk {
  margin: 0.35rem 0;
  background: var(--color-diff-hunk-background);
  color: var(--color-diff-hunk-text);
}
.diff-line.meta {
  color: var(--color-text-tertiary);
}
.diff-line code {
  padding: 0 0.8rem;
  font: inherit;
  white-space: pre;
}
.line-number {
  padding: 0 0.55rem;
  border-right: 1px solid var(--color-border-subtle);
  color: var(--color-text-disabled);
  text-align: right;
  user-select: none;
}
.diff-line.addition .line-number {
  color: var(--color-diff-add-line);
}
.diff-line.deletion .line-number {
  color: var(--color-diff-delete-line);
}

@media (max-width: 40rem) {
  .document-header {
    gap: 0.5rem;
    padding: 0.28rem 0.45rem 0.28rem 0.65rem;
  }
  .diff-line {
    grid-template-columns: 2.5rem 2.5rem minmax(max-content, 1fr);
    font-size: 0.7rem;
  }
  .line-number {
    padding-inline: 0.35rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .image-document img {
    transition: none;
  }
}
</style>
