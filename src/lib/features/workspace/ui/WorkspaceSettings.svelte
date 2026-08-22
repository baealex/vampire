<script lang="ts">
import Plus from '@lucide/svelte/icons/plus';
import Save from '@lucide/svelte/icons/save';
import Trash2 from '@lucide/svelte/icons/trash-2';
import { untrack } from 'svelte';
import Button from '~/lib/shared/ui/Button.svelte';
import DialogActions from '~/lib/shared/ui/DialogActions.svelte';
import DialogShell from '~/lib/shared/ui/DialogShell.svelte';
import Input from '~/lib/shared/ui/Input.svelte';
import { MAX_LAUNCH_PROFILES } from '~/lib/shared/contracts/launch-profiles.ts';
import type { LaunchProfile, ManagedWorkspace } from '~/lib/shared/contracts/workspace.ts';
import { workspaceName as getWorkspaceName } from '../model/workspace-view.ts';

type WorkspaceStartupSettings = {
  launchProfiles: LaunchProfile[];
  startupProfileId: string | null;
};

let {
  workspace,
  profiles,
  onClose,
  onSave,
}: {
  workspace: ManagedWorkspace;
  profiles: LaunchProfile[];
  onClose: () => void;
  onSave: (settings: WorkspaceStartupSettings) => Promise<{ ok: boolean; error?: string }>;
} = $props();

let editableProfiles = $state<LaunchProfile[]>(untrack(() => profiles.map((profile) => ({ ...profile }))));
let selectedProfileId = $state<string | null>(untrack(() => workspace.startupProfileId));
let syncedProfiles = JSON.stringify(untrack(() => profiles));
let syncedSelection = untrack(() => workspace.startupProfileId);
let saving = $state(false);
let savingError = $state('');
const workspaceName = $derived(getWorkspaceName(workspace));
const hasUnsavedChanges = $derived(
  JSON.stringify(editableProfiles) !== JSON.stringify(profiles) || selectedProfileId !== workspace.startupProfileId
);

$effect(() => {
  const incoming = JSON.stringify(profiles);
  if (incoming === syncedProfiles) return;
  const local = untrack(() => JSON.stringify(editableProfiles));
  if (local !== syncedProfiles) return;
  editableProfiles = profiles.map((profile) => ({ ...profile }));
  syncedProfiles = incoming;
});

$effect(() => {
  const incoming = workspace.startupProfileId;
  if (incoming === syncedSelection) return;
  if (untrack(() => selectedProfileId) !== syncedSelection) return;
  selectedProfileId = incoming;
  syncedSelection = incoming;
});

function addProfile() {
  if (editableProfiles.length >= MAX_LAUNCH_PROFILES) return;
  const profile: LaunchProfile = {
    id: globalThis.crypto?.randomUUID?.() ?? `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: `Profile ${editableProfiles.length + 1}`,
    command: '',
  };
  editableProfiles = [...editableProfiles, profile];
  selectedProfileId = profile.id;
  savingError = '';
}

function removeProfile(profileId: string) {
  editableProfiles = editableProfiles.filter((profile) => profile.id !== profileId);
  if (selectedProfileId === profileId) selectedProfileId = null;
}

function validate(): string | undefined {
  const names = new Set<string>();
  for (const profile of editableProfiles) {
    profile.name = profile.name.trim();
    profile.command = profile.command.trim();
    if (!profile.name) return 'Give every launch profile a name.';
    if (!profile.command) return 'Give every launch profile a command.';
    const normalizedName = profile.name.toLocaleLowerCase();
    if (names.has(normalizedName)) return 'Launch profile names must be unique.';
    names.add(normalizedName);
    if (/[\0\r\n\t]/.test(profile.name) || /[\0\r\n\t]/.test(profile.command)) {
      return 'Names and commands must stay on one line.';
    }
  }
  if (selectedProfileId && !editableProfiles.some((profile) => profile.id === selectedProfileId)) {
    selectedProfileId = null;
  }
  return undefined;
}

async function save() {
  savingError = validate() ?? '';
  if (savingError) return;
  saving = true;
  try {
    const result = await onSave({
      launchProfiles: editableProfiles.map((profile) => ({ ...profile })),
      startupProfileId: selectedProfileId,
    });
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
          <strong>Start this workspace your way</strong>
          <p>
            Create a command here or reuse one saved from another workspace. Profiles are shared on this Vampire server;
            only the startup selection belongs to this workspace.
          </p>
        </div>
        <Button
          class="add-button"
          variant="secondary"
          onclick={addProfile}
          disabled={editableProfiles.length >= MAX_LAUNCH_PROFILES}
        >
          <Plus size={15} strokeWidth={2} aria-hidden="true" />
          <span>Add profile</span>
        </Button>
      </div>

      <label class:selected={selectedProfileId === null} class="no-startup-option">
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

      {#if editableProfiles.length > 0}
        <div class="profile-list">
          {#each editableProfiles as profile, index (profile.id)}
            <article class:selected={selectedProfileId === profile.id} class="profile-card">
              <div class="profile-card__top">
                <label class="profile-field">
                  <span>Name</span>
                  <Input bind:value={profile.name} size="sm" maxlength={80} />
                </label>
                <Button
                  variant="danger-outline"
                  class="icon-danger"
                  size="sm"
                  onclick={() => removeProfile(profile.id)}
                  ariaLabel={`Remove ${profile.name || `profile ${index + 1}`}`}
                >
                  <Trash2 size={15} strokeWidth={1.8} aria-hidden="true" />
                </Button>
              </div>
              <label class="profile-field">
                <span>Command</span>
                <Input bind:value={profile.command} size="sm" mono maxlength={1000} spellcheck={false} />
              </label>
              <div class="profile-card__footer">
                <span
                  >{selectedProfileId === profile.id ? 'Selected for this workspace' : 'Reusable in any workspace'}</span
                >
                <label class="profile-selection">
                  <input
                    type="radio"
                    name="startup-profile"
                    checked={selectedProfileId === profile.id}
                    onchange={() => selectedProfileId = profile.id}
                  >
                  <span>Use here</span>
                </label>
              </div>
            </article>
          {/each}
        </div>
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
        <span>{saving ? 'Saving…' : 'Save changes'}</span>
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
:global(.add-button) {
  flex: 0 0 auto;
}
.no-startup-option {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: 0.65rem;
  padding: 0.7rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  cursor: pointer;
}
.no-startup-option.selected {
  border-color: var(--color-accent);
  background: var(--color-surface-selected);
}
.no-startup-option input {
  margin-top: 0.18rem;
  accent-color: var(--color-accent);
}
.no-startup-option > span {
  display: grid;
  gap: 0.2rem;
}
.no-startup-option strong {
  color: var(--color-text);
  font-size: var(--text-caption);
  font-weight: var(--weight-medium);
}
.no-startup-option small {
  color: var(--color-text-tertiary);
  font-size: var(--text-nano);
}
.profile-list {
  display: grid;
  gap: 0.65rem;
}
.profile-card {
  display: grid;
  gap: 0.65rem;
  padding: 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
}
.profile-card.selected {
  border-color: var(--color-accent);
}
.profile-card__top {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 0.55rem;
}
.profile-field {
  display: grid;
  gap: 0.3rem;
  min-width: 0;
  color: var(--color-text-secondary);
  font-size: var(--text-nano);
  font-weight: var(--weight-medium);
}
.profile-selection input:focus-visible,
.no-startup-option input:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
:global(.icon-danger) {
  width: 2.3rem;
  min-width: 2.3rem;
  height: 2.3rem;
  padding: 0;
}
.profile-card__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  color: var(--color-text-tertiary);
  font-size: var(--text-nano);
}
.profile-selection {
  display: inline-flex !important;
  grid-template-columns: none !important;
  flex: 0 0 auto;
  align-items: center;
  gap: 0.4rem !important;
  color: var(--color-text-secondary) !important;
  cursor: pointer;
}
.profile-selection input {
  accent-color: var(--color-accent);
}
.feedback {
  margin: 0;
  padding: 0.65rem 0.75rem;
  border-radius: var(--radius-sm);
  background: var(--color-danger-surface-hover);
  color: var(--color-danger-text);
  font-size: var(--text-caption);
}
@media (max-width: 38rem) {
  .dialog-intro {
    align-items: flex-start;
    flex-direction: column;
  }
  :global(.add-button) {
    align-self: flex-start;
  }
}
</style>
