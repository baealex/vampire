import { changeBadge, describeChange } from '@vampire/lib/features/repository/model/view.ts';
import type {
  RepositoryBranch,
  RepositoryChange,
  RepositoryCommit,
  RepositoryUpstream,
} from '@vampire/lib/shared/contracts/repository.ts';
import { Check, GitBranch, RotateCcw, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { Button, ToolbarButton } from '~/shared/ui/index.ts';
import type { RepositoryWorkspaceState } from './model/repository-workspace-state.ts';
import { RepositoryVirtualList } from './RepositoryVirtualList.tsx';
import styles from './repository-git-panel.module.css';

const changeKey = (change: RepositoryChange) => change.path;
const commitKey = (commit: RepositoryCommit) => commit.hash;
const branchKey = (branch: RepositoryBranch) => branch.name;

export type RepositoryGitView = 'changes' | 'commits' | 'branches';

function upstreamStatus(upstream: RepositoryUpstream) {
  if (upstream.ahead === 0 && upstream.behind === 0) return `Up to date with ${upstream.name}`;
  if (upstream.ahead > 0 && upstream.behind > 0)
    return `${upstream.ahead} ahead, ${upstream.behind} behind ${upstream.name}`;
  if (upstream.ahead > 0) return `${upstream.ahead} ahead of ${upstream.name}`;
  return `${upstream.behind} behind ${upstream.name}`;
}

const RepositoryChanges = observer(function RepositoryChanges({ state }: { state: RepositoryWorkspaceState }) {
  const snapshot = state.snapshot;
  const changes = snapshot?.changes ?? [];
  return (
    <div className={`${styles.list} ${styles.virtualList}`}>
      {changes.length === 0 ? (
        <div className={styles.empty}>
          <strong>No changes</strong>
          <p>The working tree is clean.</p>
        </div>
      ) : (
        <>
          <div
            className={styles.changeStats}
            aria-label={`${snapshot?.changeStats.additions ?? 0} lines added, ${snapshot?.changeStats.deletions ?? 0} lines deleted`}
          >
            <span>
              {changes.length} {changes.length === 1 ? 'changed file' : 'changed files'}
            </span>
            <span className={styles.addedStat}>+{snapshot?.changeStats.additions ?? 0}</span>
            <span className={styles.deletedStat}>−{snapshot?.changeStats.deletions ?? 0}</span>
          </div>
          <RepositoryVirtualList
            items={changes}
            itemKey={changeKey}
            label="Changed files"
            estimateSize={72}
            renderItem={(change) => {
              const badge = changeBadge(change);
              const badgeClass = [
                styles.changeBadge,
                badge === 'A' || badge === 'U' ? styles.addedBadge : '',
                badge === 'D' || (badge === 'U' && change.status !== '??') ? styles.deletedBadge : '',
                badge === 'R' || badge === 'C' ? styles.renamedBadge : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <div
                  className={`${styles.change}${state.selection?.kind === 'diff' && state.selection.path === change.path ? ` ${styles.selected}` : ''}`}
                  key={`${change.status}:${change.path}`}
                >
                  <button
                    type="button"
                    aria-label={`Open diff for ${change.path}. ${describeChange(change)}`}
                    onClick={() => void state.selectItem({ kind: 'diff', path: change.path })}
                  >
                    <span className={badgeClass} aria-hidden="true">
                      {badge}
                    </span>
                    <span className={styles.changeSummary}>
                      <strong title={change.path}>{change.path.split('/').pop()}</strong>
                      {change.path.includes('/') ? (
                        <span title={change.path}>{change.path.slice(0, change.path.lastIndexOf('/'))}</span>
                      ) : null}
                      <small>{describeChange(change)}</small>
                    </span>
                  </button>
                  <ToolbarButton
                    className={styles.discardChange}
                    label={`Discard changes for ${change.path}`}
                    title={change.status === '??' ? 'Delete untracked file' : 'Discard changes'}
                    onClick={() => state.requestDiscardChange(change)}
                  >
                    <RotateCcw size={16} strokeWidth={1.9} />
                  </ToolbarButton>
                </div>
              );
            }}
          />
        </>
      )}
    </div>
  );
});

const RepositoryCommits = observer(function RepositoryCommits({ state }: { state: RepositoryWorkspaceState }) {
  const git = state.snapshot?.git;
  if (!git) return <p className={styles.empty}>This is not a Git repository.</p>;
  return (
    <div className={`${styles.list} ${styles.virtualList}`}>
      <RepositoryVirtualList
        items={git.commits}
        itemKey={commitKey}
        label="Commit history"
        estimateSize={100}
        renderItem={(commit) => (
          <button
            key={commit.hash}
            className={styles.commit}
            type="button"
            onClick={() => void state.selectItem({ kind: 'commit', path: commit.hash })}
          >
            <strong className={styles.commitSubject} title={commit.subject}>
              {commit.subject}
            </strong>
            <span className={styles.commitMeta}>
              <span title={commit.authorName}>{commit.authorName}</span>
              <time
                dateTime={new Date(commit.authoredAt).toISOString()}
                title={new Date(commit.authoredAt).toLocaleString()}
              >
                {new Date(commit.authoredAt).toLocaleDateString()}
              </time>
            </span>
            <span className={styles.commitStats}>
              <code title={commit.hash}>{commit.shortHash}</code>
              <span className={styles.addedStat} aria-label={`${commit.stats.additions} lines added`}>
                +{commit.stats.additions.toLocaleString()}
              </span>
              <span className={styles.deletedStat} aria-label={`${commit.stats.deletions} lines deleted`}>
                −{commit.stats.deletions.toLocaleString()}
              </span>
            </span>
          </button>
        )}
      />
      {git.hasMoreCommits ? (
        <Button block variant="ghost" disabled={state.loadingMoreCommits} onClick={() => void state.loadMoreCommits()}>
          {state.loadingMoreCommits ? 'Loading…' : 'Load older commits'}
        </Button>
      ) : null}
    </div>
  );
});

const RepositoryBranches = observer(function RepositoryBranches({ state }: { state: RepositoryWorkspaceState }) {
  const git = state.snapshot?.git;
  if (!git) return <p className={styles.empty}>This is not a Git repository.</p>;
  return (
    <div className={`${styles.list} ${styles.virtualList}`}>
      <RepositoryVirtualList
        items={git.branches}
        itemKey={branchKey}
        label="Branches"
        estimateSize={52}
        renderItem={(branch) => (
          <div className={styles.branch} key={branch.name}>
            {branch.current ? <Check size={14} /> : <GitBranch size={14} />}
            <span>
              <strong>{branch.name}</strong>
              <small>{branch.worktreePath ?? branch.head ?? 'No commits'}</small>
            </span>
            {!branch.current && !branch.worktreePath ? (
              <ToolbarButton label={`Delete branch ${branch.name}`} onClick={() => state.requestDeleteBranch(branch)}>
                <Trash2 size={14} />
              </ToolbarButton>
            ) : null}
          </div>
        )}
      />
    </div>
  );
});

export const RepositoryGitPanel = observer(function RepositoryGitPanel({
  onViewChange,
  state,
  view,
}: {
  onViewChange: (view: RepositoryGitView) => void;
  state: RepositoryWorkspaceState;
  view: RepositoryGitView;
}) {
  const snapshot = state.snapshot;
  const git = snapshot?.git;
  if (!snapshot || !git) return <p className={styles.empty}>This is not a Git repository.</p>;

  const branchLabel = git.branch ?? (git.commits[0] ? `Detached at ${git.commits[0].shortHash}` : 'No branch');
  const context = git.upstream
    ? upstreamStatus(git.upstream)
    : git.branch
      ? 'No upstream configured'
      : git.detached
        ? 'Detached HEAD'
        : 'Repository has no commits yet';

  return (
    <div className={styles.panel}>
      <div className={styles.context}>
        <div className={styles.contextBranch}>
          <GitBranch size={15} strokeWidth={1.9} aria-hidden="true" />
          <strong title={branchLabel}>{branchLabel}</strong>
        </div>
        <span>{context}</span>
      </div>
      <div className={styles.tabs} role="tablist" aria-label="Git view">
        <button type="button" role="tab" aria-selected={view === 'changes'} onClick={() => onViewChange('changes')}>
          Changes
          {snapshot.changes.length > 0 ? <span>{snapshot.changes.length}</span> : null}
        </button>
        <button type="button" role="tab" aria-selected={view === 'commits'} onClick={() => onViewChange('commits')}>
          Commits
        </button>
        <button type="button" role="tab" aria-selected={view === 'branches'} onClick={() => onViewChange('branches')}>
          Branches <span>{git.branches.length}</span>
        </button>
      </div>
      <div className={styles.body}>
        {view === 'changes' ? (
          <RepositoryChanges state={state} />
        ) : view === 'commits' ? (
          <RepositoryCommits state={state} />
        ) : (
          <RepositoryBranches state={state} />
        )}
      </div>
    </div>
  );
});
