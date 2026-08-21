<script lang="ts">
import { AlertDialog } from 'bits-ui';
import AlertDialogShell from '~/lib/shared/ui/AlertDialogShell.svelte';
import type { WorkspaceEntryKind } from '~/lib/shared/contracts/repository';

let {
  path,
  kind,
  targetDirectory,
  onResolve,
}: {
  path: string;
  kind: WorkspaceEntryKind;
  targetDirectory: string;
  onResolve: (resolution: 'cancel' | 'rename') => Promise<void>;
} = $props();

let action = $state<'cancel' | 'rename'>();
let errorMessage = $state('');
const name = $derived(path.split('/').pop() || path);
const destination = $derived(targetDirectory || 'workspace root');

async function resolve(resolution: 'cancel' | 'rename') {
  if (action) return;
  action = resolution;
  errorMessage = '';
  try {
    await onResolve(resolution);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'The item could not be moved.';
    action = undefined;
  }
}
</script>

<AlertDialogShell
  eyebrow="Move conflict"
  title="An item already exists"
  close={() => void resolve('cancel')}
  closeDisabled={Boolean(action)}
>
  {#snippet children()}
    <AlertDialog.Description class="move-conflict-description">
      “{name}” already exists in {destination}.
    </AlertDialog.Description>
    <p class="move-conflict-help">
      Keep both moves the {kind === 'directory' ? 'folder' : 'file'} with a numbered name. Existing content will not be
      replaced.
    </p>
    {#if errorMessage}
      <p class="move-conflict-error" role="alert">{errorMessage}</p>
    {/if}
  {/snippet}
  {#snippet footer()}
    <div class="vampire-dialog-actions move-conflict-actions">
      <AlertDialog.Cancel
        class="vampire-dialog-secondary-button"
        disabled={Boolean(action)}
        onclick={(event) => { event.preventDefault(); void resolve('cancel'); }}
      >
        {action === 'cancel' ? 'Canceling…' : 'Cancel'}
      </AlertDialog.Cancel>
      <AlertDialog.Action
        class="vampire-dialog-primary-button"
        disabled={Boolean(action)}
        onclick={(event) => { event.preventDefault(); void resolve('rename'); }}
      >
        {action === 'rename' ? 'Moving…' : 'Keep both'}
      </AlertDialog.Action>
    </div>
  {/snippet}
</AlertDialogShell>

<style>
:global(.move-conflict-description) {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--color-text);
  font-size: var(--text-body);
  line-height: var(--leading-body);
}
.move-conflict-help {
  margin: -0.55rem 0 0;
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
.move-conflict-error {
  margin: 0;
  color: var(--color-danger-text);
  font-size: var(--text-label);
  line-height: var(--leading-ui);
}
@media (max-width: 39.999rem) {
  .move-conflict-actions {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
