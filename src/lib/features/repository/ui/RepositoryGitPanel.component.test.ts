import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import RepositoryGitPanel from './RepositoryGitPanel.svelte';
import type { RepositoryGitSnapshot, RepositorySnapshot } from '~/lib/shared/contracts/repository.ts';

const cleanupCommittedAt = Date.UTC(2026, 6, 1, 1, 0);

const git: RepositoryGitSnapshot = {
  branch: 'fix-login',
  detached: false,
  hasMoreCommits: true,
  upstream: { name: 'origin/fix-login', ahead: 2, behind: 1 },
  branches: [
    {
      name: 'fix-login',
      head: 'def456',
      committedAt: Date.UTC(2026, 7, 28, 1, 0),
      current: true,
      worktreePath: '/worktrees/fix-login',
    },
    {
      name: 'main',
      head: 'abc123',
      committedAt: Date.UTC(2026, 7, 20, 1, 0),
      current: false,
      worktreePath: '/projects/vampire',
    },
    { name: 'merged-cleanup', head: 'abc123', committedAt: cleanupCommittedAt, current: false },
  ],
  worktrees: [
    { path: '/projects/vampire', name: 'vampire', branch: 'main', head: 'abc123', current: false },
    { path: '/worktrees/fix-login', name: 'fix-login', branch: 'fix-login', head: 'def456', current: true },
  ],
  commits: [
    {
      hash: 'def4567890',
      shortHash: 'def4567',
      subject: 'Fix login redirect',
      authorName: 'Vampire Test',
      authoredAt: Date.UTC(2026, 7, 28, 1, 0),
      stats: { filesChanged: 3, additions: 42, deletions: 11 },
    },
  ],
};

const snapshot: RepositorySnapshot = {
  isGitRepository: true,
  files: [],
  directories: [],
  ignored: [],
  changes: [{ path: 'src/login.ts', status: ' M' }],
  changeStats: { additions: 2, deletions: 1 },
  truncated: false,
  git,
};

test('exposes changes, history, and branches as explicit Git views', async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  const onRequestDeleteBranch = vi.fn();
  const onLoadMoreCommits = vi.fn(async () => undefined);
  render(RepositoryGitPanel, {
    snapshot,
    git,
    onSelect,
    onRequestDiscardChange: vi.fn(),
    onRequestDeleteBranch,
    onLoadMoreCommits,
    onOpenFiles: vi.fn(),
  });

  expect(screen.getByRole('tab', { name: 'Changes 1' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText('src/login.ts')).toBeInTheDocument();

  await user.click(screen.getByRole('tab', { name: 'Commits' }));
  expect(screen.getByRole('tabpanel', { name: 'Commit history' })).toBeInTheDocument();
  expect(screen.getByText('Fix login redirect')).toBeInTheDocument();
  expect(screen.getByLabelText('3 files changed, 42 lines added, 11 lines deleted')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Load older commits' }));
  expect(onLoadMoreCommits).toHaveBeenCalledOnce();
  await user.click(screen.getByRole('button', { name: /Open changes for commit def4567/ }));
  expect(onSelect).toHaveBeenCalledWith({ kind: 'commit', path: 'def4567890' });

  await user.click(screen.getByRole('tab', { name: 'Branches 3' }));
  expect(screen.getByRole('tabpanel', { name: 'Git branches' })).toBeInTheDocument();
  expect(screen.getByLabelText('Current branch')).toBeInTheDocument();
  expect(screen.getByLabelText('Checked out in another worktree')).toBeInTheDocument();
  const cleanupCommitDate = new Date(cleanupCommittedAt).toLocaleDateString(undefined, { dateStyle: 'medium' });
  expect(screen.getByText(`Last commit ${cleanupCommitDate}`)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Delete branch fix-login' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Delete branch main' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Delete branch merged-cleanup' }));
  expect(onRequestDeleteBranch).toHaveBeenCalledWith(git.branches[2]);
});
