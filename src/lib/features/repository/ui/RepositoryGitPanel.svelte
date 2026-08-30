<script lang="ts">
import Check from '@lucide/svelte/icons/check';
import ChevronDown from '@lucide/svelte/icons/chevron-down';
import GitBranch from '@lucide/svelte/icons/git-branch';
import Trash2 from '@lucide/svelte/icons/trash-2';
import Button from '~/lib/shared/ui/Button.svelte';
import RepositoryChanges from './RepositoryChanges.svelte';
import type {
  RepositoryBranch,
  RepositoryChange,
  RepositoryGitSnapshot,
  RepositorySelection,
  RepositorySnapshot,
  RepositoryUpstream,
} from '~/lib/shared/contracts/repository.ts';

let {
  snapshot,
  git,
  selected,
  onSelect,
  onRequestDiscardChange,
  onRequestDeleteBranch,
  onLoadMoreCommits,
  loadingMoreCommits = false,
  onOpenFiles,
}: {
  snapshot: RepositorySnapshot;
  git: RepositoryGitSnapshot;
  selected?: RepositorySelection;
  onSelect: (selection: RepositorySelection) => void;
  onRequestDiscardChange: (change: RepositoryChange) => void;
  onRequestDeleteBranch: (branch: RepositoryBranch) => void;
  onLoadMoreCommits: () => Promise<void>;
  loadingMoreCommits?: boolean;
  onOpenFiles: () => void;
} = $props();

type GitView = 'changes' | 'history' | 'branches';

let activeView = $state<GitView>('changes');
const branchLabel = $derived(git.branch ?? (git.commits[0] ? `Detached at ${git.commits[0].shortHash}` : 'No branch'));

function upstreamStatus(upstream: RepositoryUpstream): string {
  if (upstream.ahead === 0 && upstream.behind === 0) return `Up to date with ${upstream.name}`;
  if (upstream.ahead > 0 && upstream.behind > 0) {
    return `${upstream.ahead} ahead, ${upstream.behind} behind ${upstream.name}`;
  }
  if (upstream.ahead > 0) return `${upstream.ahead} ahead of ${upstream.name}`;
  return `${upstream.behind} behind ${upstream.name}`;
}

function commitTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function branchCommitDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, { dateStyle: 'medium' });
}
</script>

<div class="repository-git-panel">
  <div class="repository-git-context">
    <div class="repository-git-context__branch">
      <GitBranch size={15} strokeWidth={1.9} aria-hidden="true" />
      <strong title={branchLabel}>{branchLabel}</strong>
    </div>
    <span>
      {#if git.upstream}
        {upstreamStatus(git.upstream)}
      {:else if git.branch}
        No upstream configured
      {:else if git.detached}
        Detached HEAD
      {:else}
        Repository has no commits yet
      {/if}
    </span>
  </div>

  <div class="repository-git-tabs" role="tablist" aria-label="Git view">
    <button
      type="button"
      role="tab"
      class:active={activeView === 'changes'}
      aria-selected={activeView === 'changes'}
      onclick={() => (activeView = 'changes')}
    >
      Changes
      {#if snapshot.changes.length > 0}
        <span>{snapshot.changes.length}</span>
      {/if}
    </button>
    <button
      type="button"
      role="tab"
      class:active={activeView === 'history'}
      aria-selected={activeView === 'history'}
      onclick={() => (activeView = 'history')}
    >
      Commits
    </button>
    <button
      type="button"
      role="tab"
      class:active={activeView === 'branches'}
      aria-selected={activeView === 'branches'}
      onclick={() => (activeView = 'branches')}
    >
      Branches
      <span>{git.branches.length}</span>
    </button>
  </div>

  <div class="repository-git-body">
    {#if activeView === 'changes'}
      <RepositoryChanges {snapshot} {selected} {onSelect} {onRequestDiscardChange} {onOpenFiles} />
    {:else if activeView === 'history'}
      <div class="repository-git-view" role="tabpanel" aria-label="Commit history">
        {#if git.commits.length > 0}
          <div class="repository-commit-list">
            {#each git.commits as commit (commit.hash)}
              <button
                type="button"
                class="repository-commit"
                class:selected={selected?.kind === 'commit' && selected.path === commit.hash}
                title={commit.hash}
                onclick={() => onSelect({ kind: 'commit', path: commit.hash })}
                aria-label={`Open changes for commit ${commit.shortHash}: ${commit.subject}`}
              >
                <strong>{commit.subject}</strong>
                <span class="repository-commit__stats" aria-label={`${commit.stats.filesChanged} files changed, ${commit.stats.additions} lines added, ${commit.stats.deletions} lines deleted`}>
                  <span>{commit.stats.filesChanged} {commit.stats.filesChanged === 1 ? 'file' : 'files'}</span>
                  <span class="added">+{commit.stats.additions}</span>
                  <span class="deleted">−{commit.stats.deletions}</span>
                </span>
                <span class="repository-commit__meta">
                  <code>{commit.shortHash}</code>
                  <span>{commit.authorName}</span>
                  <time datetime={new Date(commit.authoredAt).toISOString()}>{commitTime(commit.authoredAt)}</time>
                </span>
              </button>
            {/each}
            {#if git.hasMoreCommits}
              <div class="repository-commit-more">
                <Button
                  class="repository-commit-more__button"
                  block
                  size="sm"
                  variant="ghost"
                  disabled={loadingMoreCommits}
                  onclick={() => void onLoadMoreCommits()}
                >
                  <ChevronDown size={13} strokeWidth={1.9} aria-hidden="true" />
                  {loadingMoreCommits ? 'Loading older commits…' : 'Load older commits'}
                </Button>
              </div>
            {/if}
          </div>
        {:else}
          <div class="repository-git-empty">
            <strong>No commits yet</strong>
            <p>Commit history will appear here after the first commit.</p>
          </div>
        {/if}
      </div>
    {:else}
      <div class="repository-git-view" role="tabpanel" aria-label="Git branches">
        <div class="repository-branch-list">
          {#each git.branches as branch (branch.name)}
            <div class="repository-branch" title={branch.worktreePath ?? branch.name}>
              <span class="repository-branch__state" aria-label={branch.current ? 'Current branch' : undefined}>
                {#if branch.current}
                  <Check size={13} strokeWidth={2} aria-hidden="true" />
                {:else if branch.worktreePath}
                  <GitBranch size={13} strokeWidth={1.8} aria-label="Checked out in another worktree" />
                {/if}
              </span>
              <span class="repository-branch__details">
                <strong>{branch.name}</strong>
                {#if branch.committedAt}
                  <time datetime={new Date(branch.committedAt).toISOString()} title={commitTime(branch.committedAt)}>
                    Last commit {branchCommitDate(branch.committedAt)}
                  </time>
                {/if}
              </span>
              <code>{branch.head ?? 'No commits'}</code>
              {#if !branch.worktreePath}
                <Button
                  class="repository-branch__delete"
                  variant="icon"
                  onclick={() => onRequestDeleteBranch(branch)}
                  ariaLabel={`Delete branch ${branch.name}`}
                  title={`Delete ${branch.name}`}
                >
                  <Trash2 size={15} strokeWidth={1.8} aria-hidden="true" />
                </Button>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
.repository-git-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.repository-git-context {
  display: grid;
  gap: 0.25rem;
  padding: 0.75rem 0.85rem 0.65rem;
  border-bottom: 1px solid var(--color-divider-subtle);
}
.repository-git-context__branch {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
  color: var(--color-text);
}
.repository-git-context__branch strong {
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.repository-git-context > span {
  overflow: hidden;
  color: var(--color-text-tertiary);
  font-size: var(--text-micro);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.repository-git-tabs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.2rem;
  padding: 0.5rem 0.65rem;
  border-bottom: 1px solid var(--color-divider-subtle);
}
.repository-git-tabs button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
  min-width: 0;
  min-height: 2rem;
  padding: 0.28rem 0.35rem;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  cursor: pointer;
}
.repository-git-tabs button.active {
  background: var(--color-surface-selected);
  color: var(--color-text);
  font-weight: var(--weight-medium);
}
.repository-git-tabs button:focus-visible {
  color: var(--color-text);
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
@media (hover: hover) {
  .repository-git-tabs button:hover {
    background: var(--color-surface-raised);
    color: var(--color-text);
  }
}
.repository-git-tabs button span {
  display: grid;
  place-items: center;
  min-width: 1.1rem;
  height: 1.1rem;
  padding-inline: 0.2rem;
  border-radius: var(--radius-pill);
  background: var(--color-surface-raised);
  color: var(--color-text-secondary);
  font-size: var(--text-nano);
  font-variant-numeric: tabular-nums;
}
.repository-git-view {
  min-width: 0;
}
.repository-git-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
}
.repository-branch-list,
.repository-commit-list {
  display: grid;
}
.repository-branch {
  display: grid;
  grid-template-columns: 1rem minmax(0, 1fr) auto 2rem;
  align-items: center;
  gap: 0.45rem;
  min-width: 0;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid var(--color-divider-subtle);
}
.repository-branch__state {
  display: grid;
  place-items: center;
  min-width: 1rem;
  color: var(--color-text-tertiary);
}
.repository-branch__state[aria-label="Current branch"] {
  color: var(--color-success);
}
.repository-branch__details {
  display: grid;
  min-width: 0;
  gap: 0.12rem;
}
.repository-branch__details strong {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: var(--text-caption);
  font-weight: var(--weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.repository-branch__details time {
  overflow: hidden;
  color: var(--color-text-tertiary);
  font-size: var(--text-micro);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.repository-branch code {
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
  font-size: var(--text-micro);
}
.repository-commit {
  display: grid;
  width: 100%;
  min-width: 0;
  gap: 0.24rem;
  padding: 0.65rem 0.85rem;
  border: 0;
  border-bottom: 1px solid var(--color-divider-subtle);
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.repository-commit.selected {
  background: var(--color-surface-active);
  box-shadow: inset 0.16rem 0 var(--color-accent);
}
.repository-commit-more {
  border-bottom: 1px solid var(--color-divider-subtle);
}
:global(.repository-commit-more__button) {
  min-height: 2.2rem;
  gap: 0.3rem;
  border-radius: 0;
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  font-weight: var(--weight-medium);
  line-height: 1;
}
:global(.repository-commit-more__button svg) {
  flex: 0 0 auto;
  transform: translateY(0.02rem);
}
.repository-commit:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
@media (hover: hover) {
  .repository-commit:hover {
    background: var(--color-surface-raised);
  }
}
.repository-commit strong {
  overflow: hidden;
  color: var(--color-text);
  font-size: var(--text-caption);
  font-weight: var(--weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.repository-commit__meta,
.repository-commit__stats {
  display: flex;
  min-width: 0;
  gap: 0.45rem;
  color: var(--color-text-tertiary);
  font-size: var(--text-micro);
}
.repository-commit__meta > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.repository-commit__stats .added {
  color: var(--color-change-add-text);
}
.repository-commit__stats .deleted {
  color: var(--color-change-delete-text);
}
.repository-commit code {
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
}
.repository-commit__meta time {
  margin-left: auto;
  white-space: nowrap;
}
.repository-git-empty {
  padding: 1.5rem 1rem;
}
.repository-git-empty strong {
  font-size: var(--text-body);
  font-weight: var(--weight-medium);
}
.repository-git-empty p {
  margin: 0.35rem 0 0;
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
  line-height: var(--leading-body);
}
</style>
