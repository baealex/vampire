<script lang="ts">
import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
import Button from '~/lib/shared/ui/Button.svelte';
import { changeBadge, describeChange } from '../model/view';
import type { RepositoryChange, RepositorySelection, RepositorySnapshot } from '~/lib/shared/contracts/repository';

let {
  snapshot,
  selected,
  onSelect,
  onRequestDiscardChange,
  onOpenFiles,
}: {
  snapshot: RepositorySnapshot;
  selected?: RepositorySelection;
  onSelect: (selection: RepositorySelection) => void;
  onRequestDiscardChange: (change: RepositoryChange) => void;
  onOpenFiles: () => void;
} = $props();
</script>

<div role="tabpanel" aria-label="Changed files">
  {#if !snapshot.isGitRepository}
    <div class="repository-empty">
      <strong>Not a Git repository</strong>
      <p>Files are still available from the Files tab.</p>
      <Button size="sm" variant="secondary" onclick={onOpenFiles}>Open files</Button>
    </div>
  {:else if snapshot.changes.length === 0}
    <div class="repository-empty">
      <strong>No changes</strong>
      <p>The working tree is clean.</p>
    </div>
  {:else}
    <div
      class="change-stats"
      aria-label={`${snapshot.changeStats.additions} lines added, ${snapshot.changeStats.deletions} lines deleted`}
    >
      <span class="change-stats-label">Line changes</span>
      <span class="change-stat added" title="Added lines">+{snapshot.changeStats.additions}</span>
      <span class="change-stat deleted" title="Deleted lines">−{snapshot.changeStats.deletions}</span>
    </div>
    <div class="change-list">
      {#each snapshot.changes as change (change.path)}
        {@const badge = changeBadge(change)}
        <div class="change-row" class:selected={selected?.kind === 'diff' && selected.path === change.path}>
          <button
            type="button"
            class="change-open"
            onclick={() => onSelect({ kind: 'diff', path: change.path })}
            aria-label={`Open diff for ${change.path}. ${describeChange(change)}`}
          >
            <span
              class="change-badge"
              class:added={badge === 'A' || badge === 'U'}
              class:deleted={badge === 'D'}
              class:renamed={badge === 'R' || badge === 'C'}
              class:conflicted={badge === 'U' && change.status !== '??'}
              aria-hidden="true"
              >{badge}</span
            >
            <span class="change-summary">
              <strong title={change.path}>{change.path.split('/').pop()}</strong>
              <span title={change.path}>{change.path}</span>
              <small>{describeChange(change)}</small>
            </span>
          </button>
          <button
            type="button"
            class="discard-change"
            onclick={() => onRequestDiscardChange(change)}
            aria-label={`Discard changes for ${change.path}`}
            title={change.status === '??' ? 'Delete untracked file' : 'Discard changes'}
          >
            <RotateCcw size={16} strokeWidth={1.9} aria-hidden="true" />
          </button>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
.repository-empty {
  padding: 1.5rem 1rem;
}
.repository-empty strong {
  font-size: var(--text-body);
  font-weight: var(--weight-medium);
}
.repository-empty p {
  margin: 0.35rem 0 0;
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
  line-height: var(--leading-body);
}
:global(.repository-empty .vampire-button) {
  margin-top: 0.9rem;
}
.change-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: stretch;
  width: 100%;
  min-width: 0;
  border-bottom: 1px solid var(--color-divider-subtle);
  background: transparent;
  color: inherit;
}
.change-stats {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  min-height: 2.35rem;
  padding: 0 0.85rem;
  border-bottom: 1px solid var(--color-divider-subtle);
  color: var(--color-text-secondary);
  font-size: var(--text-micro);
}
.change-stats-label {
  margin-right: auto;
}
.change-stat {
  font-family: var(--font-mono);
  font-size: var(--text-caption);
  font-weight: var(--weight-medium);
}
.change-stat.added {
  color: var(--color-change-add-text);
}
.change-stat.deleted {
  color: var(--color-change-delete-text);
}
@media (hover: hover) {
  .change-row:hover {
    background: var(--color-surface-raised);
  }
}
.change-row.selected {
  background: var(--color-surface-active);
  box-shadow: inset 0.16rem 0 var(--color-accent);
}
.change-open {
  display: grid;
  grid-template-columns: 1.6rem minmax(0, 1fr);
  align-items: start;
  gap: 0.65rem;
  min-width: 0;
  padding: 0.72rem 0.35rem 0.72rem 0.85rem;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.discard-change {
  align-self: center;
  display: grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  margin-right: 0.45rem;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
  opacity: 0;
}
.change-row:focus-within .discard-change {
  opacity: 1;
}
.discard-change:focus-visible {
  background: var(--color-danger-surface-hover);
  color: var(--color-danger-text);
}
@media (hover: hover) {
  .change-row:hover .discard-change {
    opacity: 1;
  }
  .discard-change:hover {
    background: var(--color-danger-surface-hover);
    color: var(--color-danger-text);
  }
}
.change-badge {
  display: grid;
  place-items: center;
  width: 1.4rem;
  height: 1.4rem;
  margin-top: 0.08rem;
  border-radius: 0.3rem;
  background: var(--color-change-background);
  color: var(--color-change-text);
  font-family: var(--font-mono);
  font-size: var(--text-micro);
  font-weight: var(--weight-strong);
}
.change-badge.added {
  background: var(--color-change-add-background);
  color: var(--color-change-add-text);
}
.change-badge.deleted,
.change-badge.conflicted {
  background: var(--color-change-delete-background);
  color: var(--color-change-delete-text);
}
.change-badge.renamed {
  background: var(--color-change-rename-background);
  color: var(--color-renamed);
}
.change-summary {
  display: grid;
  min-width: 0;
  gap: 0.18rem;
}
.change-summary strong,
.change-summary span,
.change-summary small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.change-summary strong {
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
}
.change-summary span {
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
  font-size: var(--text-micro);
}
.change-summary small {
  color: var(--color-text-secondary);
  font-size: var(--text-micro);
}

@media (hover: none) {
  .discard-change {
    opacity: 1;
  }
}
</style>
