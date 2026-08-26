<script lang="ts">
import Crown from '@lucide/svelte/icons/crown';
import LoaderCircle from '@lucide/svelte/icons/loader-circle';
import { untrack } from 'svelte';
import type { LaunchProfile } from '~/lib/shared/contracts/workspace.ts';
import Button from '~/lib/shared/ui/Button.svelte';
import DialogActions from '~/lib/shared/ui/DialogActions.svelte';
import DialogShell from '~/lib/shared/ui/DialogShell.svelte';
import Field from '~/lib/shared/ui/Field.svelte';
import Select from '~/lib/shared/ui/Select.svelte';

let {
  launchProfiles,
  creating,
  errorMessage,
  close,
  onCreate,
}: {
  launchProfiles: LaunchProfile[];
  creating: boolean;
  errorMessage: string;
  close: () => void;
  onCreate: (launchProfileId: string | null) => Promise<boolean>;
} = $props();

let selectedProfileId = $state(untrack(() => launchProfiles[0]?.id ?? ''));

async function submit(event: SubmitEvent) {
  event.preventDefault();
  if (creating) return;
  if (await onCreate(selectedProfileId || null)) close();
}
</script>

<DialogShell eyebrow="King workspace" title="Create King" {close} closeDisabled={creating} variant="form">
  {#snippet children()}
    <form id="create-king-workspace-form" class="king-workspace-form" onsubmit={submit}>
      <div class="king-workspace-intro">
        <span class="king-workspace-intro__icon" aria-hidden="true">
          <Crown size={22} strokeWidth={1.8} />
        </span>
        <div>
          <strong>Put one manager above your workspaces</strong>
          <p>
            Vampire creates King in its managed storage, launches the selected agent, and delivers a versioned manager
            contract when that agent is ready for input.
          </p>
        </div>
      </div>

      <Field
        label="Launch profile"
        id="king-launch-profile"
        description="Choose an existing agent profile, or start with a shell and launch an agent manually."
      >
        <Select id="king-launch-profile" bind:value={selectedProfileId} disabled={creating} ariaLabel="Launch profile">
          <option value="">Shell only</option>
          {#each launchProfiles as profile (profile.id)}
            <option value={profile.id}>{profile.name}</option>
          {/each}
        </Select>
      </Field>

      <p class="king-workspace-note">
        King is the manager, not a default repository worker. A waiting terminal or a worker’s completion claim is never
        accepted without the workflow result and verification gates.
      </p>
      {#if errorMessage}
        <p class="king-workspace-error" role="alert">{errorMessage}</p>
      {/if}
    </form>
  {/snippet}

  {#snippet footer()}
    <DialogActions>
      <Button variant="secondary" onclick={close} disabled={creating}>Cancel</Button>
      <Button variant="primary" type="submit" form="create-king-workspace-form" disabled={creating}>
        {#if creating}
          <LoaderCircle class="king-workspace-spinner" size={15} strokeWidth={1.9} aria-hidden="true" />
        {/if}
        <span>{creating ? 'Creating King…' : 'Create King workspace'}</span>
      </Button>
    </DialogActions>
  {/snippet}
</DialogShell>

<style>
.king-workspace-form {
  display: grid;
  min-width: 0;
  gap: 1rem;
}
.king-workspace-intro {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: 0.75rem;
}
.king-workspace-intro__icon {
  display: grid;
  place-items: center;
  width: 2.5rem;
  height: 2.5rem;
  border: 1px solid var(--color-warning-border-soft);
  border-radius: var(--radius-md);
  background: var(--color-warning-surface);
  color: var(--color-warning-accent);
}
.king-workspace-intro strong {
  display: block;
  color: var(--color-text);
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
  line-height: var(--leading-ui);
}
.king-workspace-intro p,
.king-workspace-note {
  margin: 0.3rem 0 0;
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
  line-height: var(--leading-body);
}
.king-workspace-note {
  margin: 0;
  padding: 0.7rem 0.75rem;
  border: 1px solid var(--color-warning-border-soft);
  border-radius: var(--radius-sm);
  background: var(--color-warning-surface-strong);
  color: var(--color-warning-text-secondary);
}
.king-workspace-error {
  margin: 0;
  padding: 0.65rem 0.75rem;
  border-radius: var(--radius-sm);
  background: var(--color-danger-surface-hover);
  color: var(--color-danger-text);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
:global(.king-workspace-spinner) {
  animation: king-workspace-spin 0.8s linear infinite;
}

@keyframes king-workspace-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  :global(.king-workspace-spinner) {
    animation: none;
  }
}
</style>
