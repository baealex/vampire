<script lang="ts">
import Settings2 from '@lucide/svelte/icons/settings-2';
import Save from '@lucide/svelte/icons/save';
import { untrack } from 'svelte';
import Button from '~/lib/shared/ui/Button.svelte';
import DialogActions from '~/lib/shared/ui/DialogActions.svelte';
import DialogShell from '~/lib/shared/ui/DialogShell.svelte';
import type { LaunchProfile, ManagedWorkspace } from '~/lib/shared/contracts/workspace.ts';
import { workspaceName as getWorkspaceName } from '../model/workspace-view.ts';

let {
  workspace,
  profiles,
  onClose,
  onSave,
  onManageProfiles,
}: {
  workspace: ManagedWorkspace;
  profiles: LaunchProfile[];
  onClose: () => void;
  onSave: (startupProfileId: string | null) => Promise<{ ok: boolean; error?: string }>;
  onManageProfiles: () => void;
} = $props();

let selectedProfileId = $state<string | null>(untrack(() => workspace.startupProfileId));
let syncedSelection = $state(untrack(() => workspace.startupProfileId));
let saving = $state(false);
let savingError = $state('');
const workspaceName = $derived(getWorkspaceName(workspace));
const hasUnsavedChanges = $derived(selectedProfileId !== workspace.startupProfileId);

$effect(() => {
  const incoming = workspace.startupProfileId;
  if (incoming === syncedSelection) return;
  if (untrack(() => selectedProfileId) !== syncedSelection) return;
  selectedProfileId = incoming;
  syncedSelection = incoming;
});

$effect(() => {
  if (selectedProfileId && !profiles.some((profile) => profile.id === selectedProfileId)) {
    selectedProfileId = null;
  }
});

async function save() {
  saving = true;
  savingError = '';
  try {
    const result = await onSave(selectedProfileId);
    if (!result.ok) {
      savingError = result.error ?? 'Unable to save the startup profile.';
      return;
    }
    onClose();
  } finally {
    saving = false;
  }
}
</script>

<DialogShell
  eyebrow={workspaceName}
  title="Startup profile"
  close={onClose}
  variant="inspect"
  closeDisabled={saving}
  footerVisible={saving || hasUnsavedChanges}
>
  {#snippet children()}
    <div class="startup-profile-dialog">
      <div class="dialog-intro">
        <div>
          <strong>Choose how this workspace starts</strong>
          <p>The selected command runs the next time this shell is opened. Running terminals are not changed.</p>
        </div>
        <Button variant="secondary" size="sm" onclick={onManageProfiles} disabled={saving}>
          <Settings2 size={15} strokeWidth={1.8} aria-hidden="true" />
          <span>Manage</span>
        </Button>
      </div>

      <div class="profile-options" role="radiogroup" aria-label="Startup profile">
        <label class:selected={selectedProfileId === null} class="profile-option">
          <input
            type="radio"
            name="startup-profile"
            checked={selectedProfileId === null}
            onchange={() => selectedProfileId = null}
          >
          <span>
            <strong>No startup profile</strong>
            <small>Open a regular shell without running a saved command.</small>
          </span>
        </label>

        {#each profiles as profile (profile.id)}
          <label class:selected={selectedProfileId === profile.id} class="profile-option">
            <input
              type="radio"
              name="startup-profile"
              checked={selectedProfileId === profile.id}
              onchange={() => selectedProfileId = profile.id}
            >
            <span>
              <strong>{profile.name}</strong>
              <code>{profile.command}</code>
            </span>
          </label>
        {/each}
      </div>

      {#if profiles.length === 0}
        <p class="empty-message">Create a shared launch profile in Settings to make it available here.</p>
      {/if}

      {#if savingError}
        <p class="feedback" role="alert">{savingError}</p>
      {/if}
    </div>
  {/snippet}

  {#snippet footer()}
    <DialogActions>
      <Button variant="primary" onclick={() => void save()} disabled={saving}>
        <Save size={15} strokeWidth={1.9} aria-hidden="true" />
        <span>{saving ? 'Saving…' : 'Save selection'}</span>
      </Button>
    </DialogActions>
  {/snippet}
</DialogShell>

<style>
.startup-profile-dialog {
  display: grid;
  gap: 0.9rem;
  min-width: 0;
}
.dialog-intro {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}
.dialog-intro strong {
  display: block;
  color: var(--color-text);
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
}
.dialog-intro p {
  max-width: 35rem;
  margin: 0.25rem 0 0;
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
  line-height: var(--leading-body);
}
.dialog-intro :global(.vampire-button) {
  flex: 0 0 auto;
  white-space: nowrap;
}
.profile-options {
  display: grid;
  gap: 0.55rem;
}
.profile-option {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: 0.65rem;
  padding: 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  cursor: pointer;
}
.profile-option.selected {
  border-color: var(--color-visual-accent-border);
  background: var(--color-surface-selected);
}
.profile-option input {
  margin-top: 0.18rem;
  accent-color: var(--color-accent);
}
.profile-option input:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
.profile-option > span {
  display: grid;
  min-width: 0;
  gap: 0.25rem;
}
.profile-option strong {
  color: var(--color-text);
  font-size: var(--text-caption);
  font-weight: var(--weight-medium);
}
.profile-option small,
.profile-option code {
  overflow: hidden;
  color: var(--color-text-tertiary);
  font-size: var(--text-nano);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.profile-option code {
  font-family: var(--font-mono);
}
.empty-message,
.feedback {
  margin: 0;
  padding: 0.65rem 0.75rem;
  border-radius: var(--radius-sm);
  font-size: var(--text-caption);
}
.empty-message {
  background: var(--color-control-background);
  color: var(--color-text-tertiary);
}
.feedback {
  background: var(--color-danger-surface-hover);
  color: var(--color-danger-text);
}
@media (max-width: 38rem) {
  .dialog-intro {
    align-items: stretch;
    flex-direction: column;
  }
  .dialog-intro :global(.vampire-button) {
    align-self: flex-start;
  }
}
</style>
