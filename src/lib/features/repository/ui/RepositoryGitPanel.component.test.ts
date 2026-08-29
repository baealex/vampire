import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import RepositoryGitPanel from './RepositoryGitPanel.svelte';
import type { RepositoryGitSnapshot, RepositorySnapshot } from '~/lib/shared/contracts/repository.ts';

const git: RepositoryGitSnapshot = {
  branch: 'fix-login',
  detached: false,
  upstream: { name: 'origin/fix-login', ahead: 2, behind: 1 },
  branches: [
    { name: 'fix-login', head: 'def456', current: true, worktreePath: '/worktrees/fix-login' },
    { name: 'main', head: 'abc123', current: false, worktreePath: '/projects/vampire' },
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
  render(RepositoryGitPanel, {
    snapshot,
    git,
    onSelect: vi.fn(),
    onRequestDiscardChange: vi.fn(),
    onOpenFiles: vi.fn(),
  });

  expect(screen.getByRole('tab', { name: 'Changes 1' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText('src/login.ts')).toBeInTheDocument();

  await user.click(screen.getByRole('tab', { name: 'Commits' }));
  expect(screen.getByRole('tabpanel', { name: 'Commit history' })).toBeInTheDocument();
  expect(screen.getByText('Fix login redirect')).toBeInTheDocument();

  await user.click(screen.getByRole('tab', { name: 'Branches 2' }));
  expect(screen.getByRole('tabpanel', { name: 'Git branches' })).toBeInTheDocument();
  expect(screen.getByLabelText('Current branch')).toBeInTheDocument();
  expect(screen.getByLabelText('Checked out in another worktree')).toBeInTheDocument();
});
