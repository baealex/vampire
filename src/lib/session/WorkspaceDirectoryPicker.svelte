<script lang="ts">
import { onMount } from 'svelte';
import ArrowUp from '@lucide/svelte/icons/arrow-up';
import ChevronRight from '@lucide/svelte/icons/chevron-right';
import Folder from '@lucide/svelte/icons/folder';
import LoaderCircle from '@lucide/svelte/icons/loader-circle';
import DialogShell from '$lib/ui/DialogShell.svelte';
import { requestJson } from '$lib/client/request';

type WorkspaceRoot = {
  id: string;
  label: string;
  path: string;
};

type DirectoryEntry = {
  name: string;
  path: string;
};

type DirectoryListing = {
  roots: WorkspaceRoot[];
  current: { rootId: string; label: string; path: string } | null;
  parentPath: string | null;
  directories: DirectoryEntry[];
  truncated: boolean;
};

let {
  close,
  onCreate,
  initialPath = '',
  starting = false,
  startError = '',
  tmuxAvailable,
}: {
  close: () => void;
  onCreate: (path: string) => void;
  initialPath?: string;
  starting?: boolean;
  startError?: string;
  tmuxAvailable?: boolean;
} = $props();

let manualPath = $state('');
let listing = $state<DirectoryListing>();
let loading = $state(false);
let errorMessage = $state('');
let requestSequence = 0;

async function load(path?: string, fallbackToRoots = false) {
  const sequence = ++requestSequence;
  loading = true;
  errorMessage = '';
  const query = path ? `?path=${encodeURIComponent(path)}` : '';

  try {
    const nextListing = await requestJson<DirectoryListing>(
      `/api/workspace-directories${query}`,
      undefined,
      'Unable to read workspace directories.'
    );
    if (sequence === requestSequence) listing = nextListing;
  } catch (cause) {
    if (fallbackToRoots && path && sequence === requestSequence) {
      await load();
      return;
    }
    if (sequence === requestSequence) {
      errorMessage = cause instanceof Error ? cause.message : 'Unable to read workspace directories.';
    }
  } finally {
    if (sequence === requestSequence) loading = false;
  }
}

function submitWorkspace(path: string) {
  const normalizedPath = path.trim();
  if (!normalizedPath || starting || tmuxAvailable === false) return;
  manualPath = normalizedPath;
  onCreate(normalizedPath);
}

function submitManualPath(event: SubmitEvent) {
  event.preventDefault();
  submitWorkspace(manualPath);
}

onMount(() => {
  manualPath = initialPath;
  void load(initialPath || undefined, Boolean(initialPath));
});
</script>

<DialogShell eyebrow="New workspace" title="Open a project" {close} closeDisabled={starting}>
  {#snippet children()}
    <div class="directory-picker">
      <p class="directory-picker-description">
        Choose a folder on the server. Only directories configured as workspace roots are available.
      </p>

      {#if loading}
        <div class="directory-picker-status" role="status">
          <LoaderCircle class="directory-picker-loading-icon" size={17} strokeWidth={1.8} aria-hidden="true" />
          <span>Loading folders…</span>
        </div>
      {:else if errorMessage}
        <div class="directory-picker-error" role="alert">
          <p>{errorMessage}</p>
          <button class="directory-picker-secondary-button" type="button" onclick={() => load(listing?.current?.path)}>
            Try again
          </button>
        </div>
      {:else if listing?.current}
        <div class="directory-picker-current">
          <div class="directory-picker-current-heading">
            <button
              class="directory-picker-icon-button"
              type="button"
              onclick={() => listing?.parentPath && load(listing.parentPath)}
              disabled={!listing.parentPath}
              aria-label="Go to parent folder"
              title="Go to parent folder"
            >
              <ArrowUp size={17} strokeWidth={1.8} aria-hidden="true" />
            </button>
            <div class="directory-picker-current-path">
              <strong>{listing.current.label}</strong>
              <span title={listing.current.path}>{listing.current.path}</span>
            </div>
          </div>
          <button
            class="directory-picker-primary-button"
            type="button"
            onclick={() => submitWorkspace(listing?.current?.path ?? '')}
            disabled={starting || tmuxAvailable === false}
          >
            {starting ? 'Opening…' : 'Open workspace here'}
          </button>
        </div>

        {#if listing.directories.length > 0}
          <div class="directory-picker-list">
            {#each listing.directories as directory (directory.path)}
              <button class="directory-picker-entry" type="button" onclick={() => load(directory.path)}>
                <Folder size={17} strokeWidth={1.7} aria-hidden="true" />
                <span class="directory-picker-entry-text">
                  <strong>{directory.name}</strong>
                  <small>{directory.path}</small>
                </span>
                <ChevronRight size={16} strokeWidth={1.8} aria-hidden="true" />
              </button>
            {/each}
          </div>
        {:else}
          <p class="directory-picker-empty">There are no folders inside this directory.</p>
        {/if}

        {#if listing.truncated}
          <p class="directory-picker-note">Only the first 512 folders are shown.</p>
        {/if}
      {:else if listing}
        <p class="directory-picker-description">Select one of the server’s allowed roots to start browsing.</p>
        {#if listing.roots.length > 0}
          <div class="directory-picker-list">
            {#each listing.roots as root (root.id)}
              <button class="directory-picker-entry" type="button" onclick={() => load(root.path)}>
                <Folder size={17} strokeWidth={1.7} aria-hidden="true" />
                <span class="directory-picker-entry-text">
                  <strong>{root.label}</strong>
                  <small>{root.path}</small>
                </span>
                <ChevronRight size={16} strokeWidth={1.8} aria-hidden="true" />
              </button>
            {/each}
          </div>
        {:else}
          <p class="directory-picker-empty">
            No workspace roots are available. Configure <code>VAMPIRE_WORKSPACE_ROOTS</code> on the server.
          </p>
        {/if}
      {/if}

      {#if startError}
        <p class="directory-picker-start-error" role="alert">{startError}</p>
      {/if}
      {#if tmuxAvailable === false}
        <p class="directory-picker-note">Install tmux on the server before opening a workspace.</p>
      {/if}

      <form class="directory-picker-manual" onsubmit={submitManualPath}>
        <div class="directory-picker-manual-heading">
          <label for="workspace-path">Or enter a path manually</label>
          <span>Use an absolute path on the server.</span>
        </div>
        <div class="directory-picker-input-row">
          <input
            id="workspace-path"
            type="text"
            bind:value={manualPath}
            placeholder="/Users/you/project"
            autocapitalize="off"
            autocomplete="off"
            spellcheck="false"
            disabled={starting}
          >
          <button
            class="directory-picker-secondary-button"
            type="submit"
            disabled={starting || tmuxAvailable === false}
          >
            Open path
          </button>
        </div>
      </form>
    </div>
  {/snippet}
</DialogShell>

<style>
.directory-picker {
  display: grid;
  min-width: 0;
  gap: 0.85rem;
}
.directory-picker-description,
.directory-picker-empty,
.directory-picker-note {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--text-label);
  line-height: var(--leading-body);
}
.directory-picker-list {
  display: grid;
  max-height: min(24rem, 46dvh);
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface-sunken);
}
.directory-picker-entry {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.7rem;
  width: 100%;
  min-width: 0;
  padding: 0.75rem 0.8rem;
  border: 0;
  border-bottom: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-secondary);
  text-align: left;
  cursor: pointer;
}
.directory-picker-entry:last-child {
  border-bottom: 0;
}
@media (hover: hover) {
  .directory-picker-entry:hover {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }
}
.directory-picker-entry-text {
  display: grid;
  min-width: 0;
  gap: 0.18rem;
}
.directory-picker-entry-text strong {
  overflow: hidden;
  color: var(--color-text);
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
  line-height: var(--leading-ui);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.directory-picker-entry-text small,
.directory-picker-current-path span {
  overflow: hidden;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.directory-picker-current {
  display: grid;
  gap: 0.75rem;
  padding-bottom: 0.1rem;
}
.directory-picker-current-heading {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 0.6rem;
  min-width: 0;
}
.directory-picker-current-path {
  display: grid;
  min-width: 0;
  gap: 0.18rem;
}
.directory-picker-current-path strong {
  overflow: hidden;
  color: var(--color-text);
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
  line-height: var(--leading-ui);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.directory-picker-icon-button {
  display: grid;
  place-items: center;
  width: 2.25rem;
  height: 2.25rem;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--color-surface-raised);
  color: var(--color-text-secondary);
  cursor: pointer;
}
@media (hover: hover) {
  .directory-picker-icon-button:hover:not(:disabled) {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }
}
.directory-picker-icon-button:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}
.directory-picker-primary-button,
.directory-picker-secondary-button {
  min-height: var(--control-height-md);
  padding: 0 0.85rem;
  border: 0;
  border-radius: var(--radius-sm);
  font: inherit;
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
  cursor: pointer;
}
.directory-picker-primary-button {
  width: 100%;
  background: var(--color-accent);
  color: var(--color-accent-ink);
}
@media (hover: hover) {
  .directory-picker-primary-button:hover:not(:disabled) {
    background: var(--color-accent-hover);
  }
}
.directory-picker-primary-button:disabled,
.directory-picker-secondary-button:disabled {
  cursor: wait;
  opacity: 0.62;
}
.directory-picker-secondary-button {
  justify-self: start;
  background: var(--color-surface-raised);
  color: var(--color-text);
}
@media (hover: hover) {
  .directory-picker-secondary-button:hover {
    background: var(--color-surface-hover);
  }
}
.directory-picker-manual {
  display: grid;
  gap: 0.55rem;
  padding-top: 0.85rem;
  border-top: 1px solid var(--color-border);
}
.directory-picker-manual-heading {
  display: grid;
  gap: 0.15rem;
}
.directory-picker-manual-heading label {
  color: var(--color-text);
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
}
.directory-picker-manual-heading span {
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
.directory-picker-input-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}
.directory-picker-input-row input {
  width: 100%;
  min-width: 0;
  min-height: var(--control-height-md);
  padding: 0 0.7rem;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: var(--color-field-background);
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-label);
}
.directory-picker-input-row input::placeholder {
  color: var(--color-field-placeholder);
}
.directory-picker-input-row input:disabled {
  cursor: wait;
  opacity: 0.62;
}
.directory-picker-status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 8rem;
  color: var(--color-text-secondary);
  font-size: var(--text-label);
}
:global(.directory-picker-loading-icon) {
  animation: directory-picker-spin 0.8s linear infinite;
}
.directory-picker-error {
  display: grid;
  gap: 0.75rem;
}
.directory-picker-error p {
  margin: 0;
  color: var(--color-danger);
  font-size: var(--text-label);
  line-height: var(--leading-body);
}
.directory-picker-start-error {
  margin: 0;
  color: var(--color-danger);
  font-size: var(--text-label);
  line-height: var(--leading-body);
}
.directory-picker-note {
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
}
.directory-picker-empty code {
  font-family: var(--font-mono);
  font-size: 0.92em;
}

@keyframes directory-picker-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  :global(.directory-picker-loading-icon) {
    animation: none;
  }
}
</style>
