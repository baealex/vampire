<script lang="ts">
import LoaderCircle from '@lucide/svelte/icons/loader-circle';
import Tags from '@lucide/svelte/icons/tags';
import Button from '~/lib/shared/ui/Button.svelte';
import DialogShell from '~/lib/shared/ui/DialogShell.svelte';
import DialogActions from '~/lib/shared/ui/DialogActions.svelte';
import Field from '~/lib/shared/ui/Field.svelte';
import Input from '~/lib/shared/ui/Input.svelte';
import type { ManagedWorkspace } from '~/lib/shared/contracts/workspace.ts';
import { projectName, workspaceName } from '../model/workspace-view.ts';

let {
  workspace,
  close,
  onSave,
}: {
  workspace: ManagedWorkspace;
  close: () => void;
  onSave: (alias: string) => Promise<{ ok: boolean; error?: string }>;
} = $props();

let alias = $state('');
let initializedWorkspaceId: string | undefined;
let saving = $state(false);
let errorMessage = $state('');
const directoryName = $derived(projectName(workspace.cwd));
const currentName = $derived(workspaceName(workspace));
const normalizedAlias = $derived(alias.trim());
const unchanged = $derived(normalizedAlias === (workspace.workspaceLabel?.trim() ?? ''));

$effect(() => {
  if (initializedWorkspaceId === workspace.id) return;
  initializedWorkspaceId = workspace.id;
  alias = workspace.workspaceLabel?.trim() ?? '';
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

      <Field label="Alias" id="workspace-alias">
        <Input
          id="workspace-alias"
          type="text"
          bind:value={alias}
          maxlength={80}
          autocomplete="off"
          disabled={saving}
        />
      </Field>
      <p class="alias-note">Leave this empty to use the folder name: <strong>{directoryName}</strong></p>
      {#if errorMessage}
        <p class="alias-error" role="alert">{errorMessage}</p>
      {/if}
    </form>
  {/snippet}

  {#snippet footer()}
    <DialogActions>
      <Button variant="secondary" onclick={close} disabled={saving}>Cancel</Button>
      <Button variant="primary" type="submit" form="workspace-alias-form" disabled={saving || unchanged}>
        {#if saving}
          <LoaderCircle class="alias-spinner" size={15} strokeWidth={1.9} aria-hidden="true" />
        {/if}
        <span>{saving ? 'Saving…' : normalizedAlias ? 'Save alias' : 'Use folder name'}</span>
      </Button>
    </DialogActions>
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
