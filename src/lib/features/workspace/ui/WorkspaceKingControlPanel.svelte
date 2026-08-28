<script lang="ts">
import Crown from '@lucide/svelte/icons/crown';
import ShieldCheck from '@lucide/svelte/icons/shield-check';
import UserRound from '@lucide/svelte/icons/user-round';
import { requestJson } from '~/lib/shared/api/request.ts';
import type { ManagedWorkspace, WorkspaceKingControl } from '~/lib/shared/contracts/workspace.ts';
import { workspaceHasRecognizedMainAgent } from '~/lib/shared/contracts/workspace-agent.ts';
import Button from '~/lib/shared/ui/Button.svelte';
import PopoverShell from '~/lib/shared/ui/PopoverShell.svelte';

const WORKSPACE_CONTROL_TIMEOUT_MS = 60_000;

let {
  workspace,
  onControlChange = () => undefined,
}: {
  workspace: ManagedWorkspace;
  onControlChange?: (control: WorkspaceKingControl) => void;
} = $props();

let open = $state(false);
let pendingAction = $state<'handoff' | 'decline' | 'take-control'>();
let reason = $state('');
let errorMessage = $state('');
const controlState = $derived(workspace.kingControl?.state ?? 'manual');
const requested = $derived(workspace.kingControl?.state === 'requested');
const kingControlled = $derived(workspace.kingControl?.state === 'king');
const liveMainAgent = $derived(workspaceHasRecognizedMainAgent(workspace));

function controlTriggerLabel(state: typeof controlState): string {
  if (state === 'requested') return 'King requested workspace control';
  if (state === 'king') return 'King controls this workspace';
  return 'Hand this workspace to King';
}

function controlHeading(state: typeof controlState): string {
  if (state === 'requested') return 'King requests control';
  if (state === 'king') return 'King has control';
  return 'Manual control';
}

const triggerLabel = $derived(controlTriggerLabel(controlState));

async function applyAction(action: 'handoff' | 'decline' | 'take-control') {
  pendingAction = action;
  errorMessage = '';
  try {
    const result = await requestJson<{ control: WorkspaceKingControl; interruptedAttemptIds: string[] }>(
      `/api/workspaces/${encodeURIComponent(workspace.id)}/king-control`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...(reason.trim() ? { reason: reason.trim() } : {}) }),
      },
      'Changing workspace control',
      { timeoutMs: WORKSPACE_CONTROL_TIMEOUT_MS }
    );
    onControlChange(result.control);
    reason = '';
    if (action !== 'handoff' || result.control.state === 'king') open = false;
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Workspace control could not be changed.';
  } finally {
    pendingAction = undefined;
  }
}
</script>

<PopoverShell
  bind:open
  align="end"
  side="bottom"
  sideOffset={14}
  trapFocus={true}
  contentClass="workspace-king-control-popover"
  contentLabel="Workspace King control"
  contentRole="dialog"
  triggerClass={`king-workflow-button king-control-button ${controlState}${open ? ' active' : ''}`}
  triggerLabel={open ? 'Close workspace King control' : triggerLabel}
  triggerTitle={open ? 'Close workspace King control' : triggerLabel}
>
  {#snippet trigger()}
    <Crown size={16} strokeWidth={1.9} aria-hidden="true" />
    {#if requested}
      <span class="king-control-button__notice" aria-hidden="true"></span>
    {/if}
  {/snippet}

  {#snippet children()}
    <div class="workspace-king-control" data-vampire-overlay>
      <header>
        <span class="workspace-king-control__icon" class:active={kingControlled || requested}>
          <Crown size={17} strokeWidth={1.9} aria-hidden="true" />
        </span>
        <span>
          <strong>{controlHeading(controlState)}</strong>
          <small>{workspace.workspaceLabel || workspace.cwd}</small>
        </span>
      </header>

      {#if requested}
        <p>{workspace.kingControl?.reason}</p>
        <p class="workspace-king-control__hint">
          Handing over preserves this checkout and lets King assign work to its existing main agent.
        </p>
        {#if !liveMainAgent}
          <p class="workspace-king-control__warning">
            Start Codex or Claude in this workspace first. King will not launch an agent or write into a shell.
          </p>
        {/if}
        <div class="workspace-king-control__actions">
          <Button
            size="sm"
            variant="primary"
            disabled={Boolean(pendingAction) || !liveMainAgent}
            onclick={() => void applyAction('handoff')}
          >
            <ShieldCheck size={15} strokeWidth={1.8} aria-hidden="true" />
            Hand over
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={Boolean(pendingAction)}
            onclick={() => void applyAction('decline')}
            >Keep manual</Button
          >
        </div>
      {:else if kingControlled}
        <p>
          King owns the writer lease and assigns Tasks to this workspace’s existing main agent. Progress remains visible
          in the same terminal.
        </p>
        {#if !liveMainAgent}
          <p class="workspace-king-control__warning">
            The main agent is no longer running. Start it manually before asking King to assign more work.
          </p>
        {/if}
        {#if workspace.kingControl?.handoffSnapshot}
          <dl>
            <div>
              <dt>Handoff baseline</dt>
              <dd>{workspace.kingControl.handoffSnapshot.changes.length} changed</dd>
            </div>
            <div>
              <dt>HEAD</dt>
              <dd>{workspace.kingControl.handoffSnapshot.headRevision?.slice(0, 8) ?? 'none'}</dd>
            </div>
          </dl>
        {/if}
        <p class="workspace-king-control__warning">
          Taking control stops unfinished King Tasks for this checkout. Their partial diff remains for review.
        </p>
        <div class="workspace-king-control__actions">
          <Button
            size="sm"
            variant="danger-outline"
            disabled={Boolean(pendingAction)}
            onclick={() => void applyAction('take-control')}
          >
            <UserRound size={15} strokeWidth={1.8} aria-hidden="true" />
            Take control
          </Button>
        </div>
      {:else}
        <p>
          Hand this checkout to King when you want it to coordinate the existing main agent. King will not create a
          workspace, terminal, worktree, or agent for you.
        </p>
        <label>
          <span>Context for King (optional)</span>
          <textarea bind:value={reason} rows="2" placeholder="Why King should control this workspace"></textarea>
        </label>
        {#if !liveMainAgent}
          <p class="workspace-king-control__warning">
            Start Codex or Claude in this workspace first. King will not launch an agent or write into a shell.
          </p>
        {/if}
        <div class="workspace-king-control__actions">
          <Button
            size="sm"
            variant="primary"
            disabled={Boolean(pendingAction) || !liveMainAgent}
            onclick={() => void applyAction('handoff')}
          >
            <Crown size={15} strokeWidth={1.8} aria-hidden="true" />
            Hand over to King
          </Button>
        </div>
      {/if}

      {#if errorMessage}
        <p class="workspace-king-control__error" role="alert">{errorMessage}</p>
      {/if}
    </div>
  {/snippet}
</PopoverShell>

<style>
:global(.workspace-king-control-popover) {
  z-index: 45;
  width: min(24rem, calc(100vw - 1rem));
  max-height: min(32rem, calc(100dvh - 5rem));
  overflow: auto;
}
:global(.king-control-button.requested),
:global(.king-control-button.king) {
  color: var(--color-warning-accent);
}
:global(.king-control-button__notice) {
  position: absolute;
  top: 0.35rem;
  right: 0.35rem;
  width: 0.38rem;
  height: 0.38rem;
  border-radius: 50%;
  background: var(--color-warning-accent);
  box-shadow: 0 0 0 2px var(--color-panel);
}
.workspace-king-control {
  display: grid;
  gap: 0.9rem;
  padding: 1rem;
}
.workspace-king-control header {
  display: flex;
  align-items: center;
  gap: 0.65rem;
}
.workspace-king-control header > span:last-child {
  display: grid;
  gap: 0.15rem;
  min-width: 0;
}
.workspace-king-control header strong {
  font-size: var(--text-body);
}
.workspace-king-control header small {
  overflow: hidden;
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.workspace-king-control__icon {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 2rem;
  height: 2rem;
  border-radius: 50%;
  background: var(--color-surface-raised);
  color: var(--color-text-tertiary);
}
.workspace-king-control__icon.active {
  background: var(--color-warning-surface);
  color: var(--color-warning-accent);
}
.workspace-king-control p {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
.workspace-king-control__hint {
  color: var(--color-text-tertiary) !important;
}
.workspace-king-control__warning {
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--color-warning-border);
  border-radius: var(--radius-sm);
  background: var(--color-warning-surface);
  color: var(--color-warning-accent) !important;
}
.workspace-king-control label {
  display: grid;
  gap: 0.35rem;
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
}
.workspace-king-control textarea {
  width: 100%;
  min-height: 4.25rem;
  padding: 0.55rem 0.6rem;
  resize: vertical;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  outline: none;
  background: var(--color-control-background);
  color: var(--color-text);
  font: inherit;
}
.workspace-king-control textarea:focus {
  border-color: var(--color-accent);
  box-shadow: var(--shadow-accent-focus);
}
.workspace-king-control dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.5rem;
  margin: 0;
}
.workspace-king-control dl div {
  display: grid;
  gap: 0.15rem;
  padding: 0.55rem;
  border-radius: var(--radius-sm);
  background: var(--color-surface-raised);
}
.workspace-king-control dt {
  color: var(--color-text-tertiary);
  font-size: var(--text-nano);
}
.workspace-king-control dd {
  margin: 0;
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: var(--text-caption);
}
.workspace-king-control__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.5rem;
}
.workspace-king-control__error {
  color: var(--color-danger) !important;
}
</style>
