<script lang="ts">
import LoaderCircle from '@lucide/svelte/icons/loader-circle';
import Tags from '@lucide/svelte/icons/tags';
import DialogShell from '$lib/ui/DialogShell.svelte';
import type { ManagedSession } from './types.ts';
import { projectName, workspaceName } from './view.ts';

let {
  session,
  close,
  onSave,
}: {
  session: ManagedSession;
  close: () => void;
  onSave: (alias: string) => Promise<{ ok: boolean; error?: string }>;
} = $props();

let alias = $state('');
let initializedSessionId: string | undefined;
let saving = $state(false);
let errorMessage = $state('');
const directoryName = $derived(projectName(session.cwd));
const currentName = $derived(workspaceName(session));
const normalizedAlias = $derived(alias.trim());
const unchanged = $derived(normalizedAlias === (session.workspaceLabel?.trim() ?? ''));

$effect(() => {
  if (initializedSessionId === session.id) return;
  initializedSessionId = session.id;
  alias = session.workspaceLabel?.trim() ?? '';
  errorMessage = '';
});

async function submit(event: SubmitEvent) {
  event.preventDefault();
  if (saving || unchanged) return;
  if (/[\0\r\n\t]/.test(alias) || normalizedAlias.length > 80) {
    errorMessage = 'Aliases must stay on one line and be 80 characters or fewer.';
    return;
  }

  saving = true;
  errorMessage = '';
  try {
    const result = await onSave(normalizedAlias);
    if (result.ok) close();
    else errorMessage = result.error ?? 'Unable to save the workspace alias.';
  } finally {
    saving = false;
  }
}
</script>

<DialogShell eyebrow={currentName} title="Workspace alias" {close} closeDisabled={saving}>
  {#snippet children()}
    <form id="workspace-alias-form" class="alias-form" onsubmit={submit}>
      <div class="alias-intro">
        <span class="alias-intro__icon" aria-hidden="true"><Tags size={20} strokeWidth={1.8} /></span>
        <div>
          <strong>Give this workspace a recognizable name</strong>
          <p>
            The alias is shared across devices. It only changes the display name; the directory and Git branch stay
            unchanged.
          </p>
        </div>
      </div>

      <label class="alias-field" for="workspace-alias">
        <span>Alias</span>
        <input id="workspace-alias" type="text" bind:value={alias} maxlength="80" autocomplete="off" disabled={saving}>
      </label>
      <p class="alias-note">Leave this empty to use the folder name: <strong>{directoryName}</strong></p>
      {#if errorMessage}
        <p class="alias-error" role="alert">{errorMessage}</p>
      {/if}
    </form>
  {/snippet}

  {#snippet footer()}
    <div class="vampire-dialog-actions">
      <button class="vampire-dialog-secondary-button" type="button" onclick={close} disabled={saving}>Cancel</button>
      <button
        class="vampire-dialog-primary-button"
        type="submit"
        form="workspace-alias-form"
        disabled={saving || unchanged}
      >
        {#if saving}
          <LoaderCircle class="alias-spinner" size={15} strokeWidth={1.9} aria-hidden="true" />
        {/if}
        <span>{saving ? 'Saving…' : normalizedAlias ? 'Save alias' : 'Use folder name'}</span>
      </button>
    </div>
  {/snippet}
</DialogShell>

<style>
.alias-form {
  display: grid;
  min-width: 0;
  gap: 1rem;
}
.alias-intro {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: 0.75rem;
}
.alias-intro__icon {
  display: grid;
  place-items: center;
  width: 2.35rem;
  height: 2.35rem;
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  color: var(--color-accent);
}
.alias-intro strong {
  display: block;
  color: var(--color-text);
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
  line-height: var(--leading-ui);
}
.alias-intro p,
.alias-note {
  margin: 0.3rem 0 0;
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
  line-height: var(--leading-body);
}
.alias-field {
  display: grid;
  gap: 0.4rem;
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
  font-weight: var(--weight-medium);
}
.alias-field input {
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
.alias-field input:focus-visible {
  border-color: var(--color-accent);
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}
.alias-field input:disabled {
  cursor: wait;
  opacity: 0.62;
}
.alias-note {
  margin: 0;
  color: var(--color-text-tertiary);
}
.alias-note strong {
  color: var(--color-text-secondary);
  font-weight: var(--weight-medium);
}
.alias-error {
  margin: 0;
  padding: 0.65rem 0.75rem;
  border-radius: var(--radius-sm);
  background: var(--color-danger-surface-hover);
  color: var(--color-danger-text);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
:global(.alias-spinner) {
  animation: alias-spin 0.8s linear infinite;
}

@keyframes alias-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  :global(.alias-spinner) {
    animation: none;
  }
}
</style>
