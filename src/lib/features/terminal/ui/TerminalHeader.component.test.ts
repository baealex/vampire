import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';
import TerminalHeader from './TerminalHeader.svelte';

test('shows one quiet branch label instead of separate worktree badges', () => {
  render(TerminalHeader, {
    projectName: 'Vampire',
    cwd: '/worktrees/fix-login',
    isWorktree: true,
    branch: 'fix-login',
    hasNote: false,
    noteOpen: false,
    close: vi.fn(),
    repositoryOpen: false,
    isGitRepository: true,
    workspaceAvailable: true,
    changeCount: 0,
    worktreeCount: 3,
    backgroundOpen: false,
    backgroundCount: 0,
    backgroundPanelId: 'background-panel',
    backgroundTriggerId: 'background-trigger',
    toggleRepository: vi.fn(),
    toggleNote: vi.fn(),
    toggleBackground: vi.fn(),
  });

  expect(screen.getByText('fix-login').parentElement).toHaveAttribute('title', 'fix-login · 3 worktrees');
  expect(screen.queryByText('Worktree')).not.toBeInTheDocument();
  expect(screen.queryByText('3 worktrees')).not.toBeInTheDocument();
});

test('keeps note and repository controls visible as panel toggles', async () => {
  const toggleRepository = vi.fn();
  const toggleNote = vi.fn();
  render(TerminalHeader, {
    projectName: 'Vampire',
    cwd: '/workspaces/vampire',
    isWorktree: false,
    hasNote: true,
    noteOpen: false,
    close: vi.fn(),
    repositoryOpen: true,
    isGitRepository: true,
    workspaceAvailable: true,
    changeCount: 2,
    worktreeCount: 1,
    backgroundOpen: false,
    backgroundCount: 0,
    backgroundPanelId: 'background-panel',
    backgroundTriggerId: 'background-trigger',
    toggleRepository,
    toggleNote,
    toggleBackground: vi.fn(),
  });

  await fireEvent.click(screen.getByRole('button', { name: 'Close repository' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Open workspace note' }));
  expect(toggleRepository).toHaveBeenCalledOnce();
  expect(toggleNote).toHaveBeenCalledOnce();
});
