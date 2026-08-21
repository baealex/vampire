<script lang="ts">
import GitBranchPlus from '@lucide/svelte/icons/git-branch-plus';
import LoaderCircle from '@lucide/svelte/icons/loader-circle';
import DialogShell from '~/lib/shared/ui/DialogShell.svelte';
import type { ManagedWorkspace } from '~/lib/shared/contracts/workspace.ts';
import { workspaceName, workspaceRepositoryName } from './workspace-view.ts';

let {
  source,
  close,
  onCreate,
}: {
  source: ManagedWorkspace;
  close: () => void;
  onCreate: (name: string) => Promise<{ ok: boolean; error?: string }>;
} = $props();

let name = $state('');
let creating = $state(false);
let errorMessage = $state('');
const repositoryName = $derived(workspaceRepositoryName(source));
const sourceName = $derived(workspaceName(source));

async function submit(event: SubmitEvent) {
  event.preventDefault();
  if (creating) return;
  const normalizedName = name.trim();
  if (!normalizedName) {
    errorMessage = 'Enter a task name.';
    return;
  }

  creating = true;
  errorMessage = '';
  try {
    const result = await onCreate(normalizedName);
    if (!result.ok) errorMessage = result.error ?? 'Unable to create the isolated workspace.';
  } finally {
    creating = false;
  }
}
</script>

<DialogShell eyebrow={repositoryName} title="New isolated workspace" {close} closeDisabled={creating}>
  {#snippet children()}
    <form id="new-worktree-form" class="worktree-form" onsubmit={submit}>
      <div class="worktree-intro">
        <span class="worktree-intro__icon" aria-hidden="true"><GitBranchPlus size={20} strokeWidth={1.8} /></span>
        <div>
          <strong>Start a separate task from {sourceName}</strong>
          <p>
            Vampire creates a new branch and linked working directory from the current commit. Uncommitted changes in
            the source workspace are not copied.
          </p>
        </div>
      </div>

      <label class="worktree-field" for="worktree-task-name">
        <span>Task name</span>
        <input
          id="worktree-task-name"
          type="text"
          bind:value={name}
          maxlength="80"
          autocomplete="off"
          autocapitalize="sentences"
          disabled={creating}
        >
      </label>

      <p class="worktree-note">
        The source workspace's startup profile selection and favorite background commands are inherited. Removing this
        workspace deletes its managed working copy but keeps its Git branch.
      </p>
      {#if errorMessage}
        <p class="worktree-error" role="alert">{errorMessage}</p>
      {/if}
    </form>
  {/snippet}

  {#snippet footer()}
    <div class="vampire-dialog-actions">
      <button class="vampire-dialog-secondary-button" type="button" onclick={close} disabled={creating}>Cancel</button>
      <button
        class="vampire-dialog-primary-button"
        type="submit"
        form="new-worktree-form"
        disabled={creating || !name.trim()}
      >
        {#if creating}
          <LoaderCircle class="worktree-spinner" size={15} strokeWidth={1.9} aria-hidden="true" />
        {/if}
        <span>{creating ? 'Creating…' : 'Create workspace'}</span>
      </button>
    </div>
  {/snippet}
</DialogShell>

<style>
.worktree-form {
  display: grid;
  min-width: 0;
  gap: 1rem;
}
.worktree-intro {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: 0.75rem;
}
.worktree-intro__icon {
  display: grid;
  place-items: center;
  width: 2.35rem;
  height: 2.35rem;
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  color: var(--color-accent);
}
.worktree-intro strong {
  display: block;
  color: var(--color-text);
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
  line-height: var(--leading-ui);
}
.worktree-intro p,
.worktree-note {
  margin: 0.3rem 0 0;
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
  line-height: var(--leading-body);
}
.worktree-field {
  display: grid;
  gap: 0.4rem;
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
  font-weight: var(--weight-medium);
}
.worktree-field input {
  width: 100%;
  min-height: var(--control-height-md);
  padding: 0 0.7rem;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: var(--color-field-background);
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-label);
}
.worktree-field input:focus-visible {
  border-color: var(--color-accent);
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}
.worktree-field input:disabled {
  cursor: wait;
  opacity: 0.62;
}
.worktree-note {
  margin: 0;
  padding: 0.7rem 0.75rem;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  background: var(--color-surface-sunken);
  color: var(--color-text-tertiary);
}
.worktree-error {
  margin: 0;
  padding: 0.65rem 0.75rem;
  border-radius: var(--radius-sm);
  background: var(--color-danger-surface-hover);
  color: var(--color-danger-text);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
:global(.worktree-spinner) {
  animation: worktree-spin 0.8s linear infinite;
}

@keyframes worktree-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  :global(.worktree-spinner) {
    animation: none;
  }
}
</style>
