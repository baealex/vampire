<script lang="ts">
import { onMount } from 'svelte';
import ArrowUp from '@lucide/svelte/icons/arrow-up';
import ChevronRight from '@lucide/svelte/icons/chevron-right';
import Folder from '@lucide/svelte/icons/folder';
import LoaderCircle from '@lucide/svelte/icons/loader-circle';
import Button from '~/lib/shared/ui/Button.svelte';
import DialogShell from '~/lib/shared/ui/DialogShell.svelte';
import Input from '~/lib/shared/ui/Input.svelte';
import { requestJson } from '~/lib/shared/api/request';

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
let directoryFilter = $state('');
let showHiddenDirectories = $state(false);
let submittedPath = $state('');
let requestSequence = 0;
const hiddenDirectoryCount = $derived(
  (listing?.directories ?? []).filter((directory) => directory.name.startsWith('.')).length
);
const visibleDirectories = $derived(
  (listing?.directories ?? []).filter((directory) => {
    if (!showHiddenDirectories && directory.name.startsWith('.')) return false;
    return directory.name.toLocaleLowerCase().includes(directoryFilter.trim().toLocaleLowerCase());
  })
);
const visibleStartError = $derived(manualPath === submittedPath ? startError : '');

async function load(path?: string, fallbackToRoots = false) {
  const sequence = ++requestSequence;
  loading = true;
  errorMessage = '';
  directoryFilter = '';
  const query = path ? `?path=${encodeURIComponent(path)}` : '';

  try {
    const nextListing = await requestJson<DirectoryListing>(
      `/api/workspace-directories${query}`,
      undefined,
      'Unable to read workspace directories.'
    );
    if (sequence !== requestSequence) return;
    if (!path && !nextListing.current && nextListing.roots.length === 1) {
      await load(nextListing.roots[0].path);
      return;
    }
    listing = nextListing;
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
  submittedPath = normalizedPath;
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

<DialogShell eyebrow="New workspace" title="Open a project" variant="form" {close} closeDisabled={starting}>
  {#snippet children()}
    <div class="directory-picker">
      <form class="directory-picker-manual" onsubmit={submitManualPath}>
        <div class="directory-picker-manual-heading">
          <label for="workspace-path">Project path</label>
          <span>Paste an absolute path from one of the server’s allowed workspace roots.</span>
        </div>
        <div class="directory-picker-input-row">
          <Input
            id="workspace-path"
            type="text"
            bind:value={manualPath}
            placeholder="/Users/you/project"
            autocapitalize="off"
            autocomplete="off"
            spellcheck="false"
            disabled={starting}
            ariaInvalid={Boolean(visibleStartError)}
            ariaDescribedby={visibleStartError ? 'workspace-start-error' : undefined}
            mono
          />
          <Button variant="primary" type="submit" disabled={starting || tmuxAvailable === false || !manualPath.trim()}>
            {starting ? 'Opening…' : 'Open'}
          </Button>
        </div>
        {#if visibleStartError}
          <p id="workspace-start-error" class="directory-picker-start-error" role="alert">{visibleStartError}</p>
        {/if}
        {#if tmuxAvailable === false}
          <p class="directory-picker-note">Install tmux on the server before opening a workspace.</p>
        {/if}
      </form>

      <section class="directory-browser" aria-labelledby="workspace-browser-heading">
        <header class="directory-browser-heading">
          <div>
            <h3 id="workspace-browser-heading">Browse folders</h3>
            <p>Only folders allowed by the server are shown.</p>
          </div>
        </header>

        {#if loading}
          <div class="directory-picker-status" role="status">
            <LoaderCircle class="directory-picker-loading-icon" size={17} strokeWidth={1.8} aria-hidden="true" />
            <span>Loading folders…</span>
          </div>
        {:else if errorMessage}
          <div class="directory-picker-error" role="alert">
            <p>{errorMessage}</p>
            <Button
              class="directory-picker-retry"
              size="sm"
              variant="secondary"
              onclick={() => load(listing?.current?.path)}
            >
              Try again
            </Button>
          </div>
        {:else if listing?.current}
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
            <Button
              class="directory-picker-open-current"
              size="sm"
              variant="secondary"
              onclick={() => submitWorkspace(listing?.current?.path ?? '')}
              disabled={starting || tmuxAvailable === false}
            >
              Open this folder
            </Button>
          </div>

          {#if listing.directories.length > 0}
            {#if (showHiddenDirectories ? listing.directories.length : listing.directories.length - hiddenDirectoryCount) > 8 || directoryFilter}
              <Input
                type="search"
                bind:value={directoryFilter}
                placeholder="Filter folders"
                ariaLabel="Filter folders"
                size="sm"
              />
            {/if}
            <div class="directory-picker-list">
              {#each visibleDirectories as directory (directory.path)}
                <button class="directory-picker-entry" type="button" onclick={() => load(directory.path)}>
                  <Folder size={17} strokeWidth={1.7} aria-hidden="true" />
                  <span class="directory-picker-entry-text">
                    <strong>{directory.name}</strong>
                    <small>{directory.path}</small>
                  </span>
                  <ChevronRight size={16} strokeWidth={1.8} aria-hidden="true" />
                </button>
              {/each}
              {#if visibleDirectories.length === 0}
                <p class="directory-picker-empty directory-picker-empty-list">
                  {directoryFilter ? 'No folders match this filter.' : 'No visible folders here.'}
                </p>
              {/if}
            </div>

            {#if hiddenDirectoryCount > 0}
              <button
                class="directory-picker-hidden-toggle"
                type="button"
                aria-pressed={showHiddenDirectories}
                onclick={() => (showHiddenDirectories = !showHiddenDirectories)}
              >
                {showHiddenDirectories ? 'Hide' : 'Show'} {hiddenDirectoryCount} hidden
                {hiddenDirectoryCount === 1 ? 'folder' : 'folders'}
              </button>
            {/if}
          {:else}
            <p class="directory-picker-empty">There are no folders inside this directory.</p>
          {/if}

          {#if listing.truncated}
            <p class="directory-picker-note">Only the first 512 folders are shown.</p>
          {/if}
        {:else if listing}
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
      </section>
    </div>
  {/snippet}
</DialogShell>

<style>
.directory-picker {
  display: grid;
  min-width: 0;
  gap: 1rem;
}
.directory-picker-empty,
.directory-picker-note {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--text-label);
  line-height: var(--leading-body);
}
.directory-browser {
  display: grid;
  min-width: 0;
  gap: 0.65rem;
  padding-top: 0.15rem;
}
.directory-browser-heading h3,
.directory-browser-heading p {
  margin: 0;
}
.directory-browser-heading h3 {
  color: var(--color-text);
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
}
.directory-browser-heading p {
  margin-top: 0.12rem;
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
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
.directory-picker-current-heading {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.6rem;
  min-width: 0;
  padding: 0.15rem 0;
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
.directory-picker-manual {
  display: grid;
  gap: 0.55rem;
  padding: 0.8rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface-sunken);
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
.directory-picker-status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 6rem;
  color: var(--color-text-secondary);
  font-size: var(--text-label);
}
:global(.directory-picker-loading-icon) {
  animation: directory-picker-spin 0.8s linear infinite;
}
.directory-picker-error {
  display: grid;
  gap: 0.75rem;
  padding: 0.75rem;
  border: 1px solid var(--color-danger-border);
  border-radius: var(--radius-sm);
  background: var(--color-danger-surface);
}
:global(.directory-picker-retry) {
  justify-self: start;
}
.directory-picker-error p {
  margin: 0;
  color: var(--color-danger);
  font-size: var(--text-label);
  line-height: var(--leading-body);
}
.directory-picker-start-error {
  margin: 0;
  color: var(--color-danger-text);
  font-size: var(--text-label);
  line-height: var(--leading-body);
}
.directory-picker-hidden-toggle {
  justify-self: start;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-text-tertiary);
  font: inherit;
  font-size: var(--text-caption);
  cursor: pointer;
}
@media (hover: hover) {
  .directory-picker-hidden-toggle:hover {
    color: var(--color-text);
  }
}
.directory-picker-empty-list {
  padding: 1rem;
  color: var(--color-text-tertiary);
  text-align: center;
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

@media (max-width: 32rem) {
  .directory-picker-input-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .directory-picker-current-heading {
    grid-template-columns: auto minmax(0, 1fr);
  }
  :global(.directory-picker-open-current) {
    grid-column: 1 / -1;
    width: 100%;
  }
}
</style>
