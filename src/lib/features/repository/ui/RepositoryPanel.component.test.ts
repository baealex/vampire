import { fireEvent, render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import type { RepositorySnapshot } from '~/lib/shared/contracts/repository.ts';
import RepositoryPanel from './RepositoryPanel.svelte';

const snapshot: RepositorySnapshot = {
  isGitRepository: true,
  files: [],
  directories: ['src'],
  ignored: [],
  changes: [],
  changeStats: { additions: 0, deletions: 0 },
  truncated: false,
};

function props(overrides: Record<string, unknown> = {}) {
  return {
    projectName: 'vampire',
    projectPath: '/projects/vampire',
    snapshot,
    loading: false,
    errorMessage: '',
    open: true,
    onRefresh: vi.fn(),
    onLoadDirectory: vi.fn(async () => undefined),
    onCreateFile: vi.fn(async () => undefined),
    onCreateDirectory: vi.fn(async () => undefined),
    onRequestDelete: vi.fn(),
    onRequestDiscardChange: vi.fn(),
    onRequestDeleteBranch: vi.fn(),
    onLoadMoreCommits: vi.fn(async () => undefined),
    onMoveEntry: vi.fn(async () => undefined),
    onInsertPath: vi.fn(),
    onRenameEntry: vi.fn(async () => ({ fromPath: '', path: '', kind: 'file' as const, renamed: false })),
    onCopyEntries: vi.fn(),
    onCutEntries: vi.fn(),
    onPasteEntries: vi.fn(async () => []),
    onUploadSelection: vi.fn(async () => undefined),
    onUploadError: vi.fn(),
    onClose: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
}

test('keeps the Explorer add action scoped to workspace root after selecting a folder', async () => {
  const user = userEvent.setup();
  const onLoadDirectory = vi.fn(async () => undefined);
  const { container } = render(RepositoryPanel, props({ onLoadDirectory }));

  await user.click(screen.getByRole('button', { name: 'Expand src' }));

  const headerAdd = container.querySelector<HTMLButtonElement>('.repository-add-trigger');
  expect(screen.queryByText('Workspace files')).not.toBeInTheDocument();
  expect(headerAdd).toHaveAccessibleName('Add inside workspace root');
  expect(headerAdd?.closest('.repository-content')).not.toBeNull();
  expect(headerAdd?.closest('.tree-row-shell.root')).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Collapse vampire workspace root' })).toBeInTheDocument();
  expect(screen.getAllByTitle('/projects/vampire')).toHaveLength(2);
  await fireEvent.click(headerAdd!);
  await user.click(await screen.findByRole('menuitem', { name: 'New file' }));

  expect(screen.getByRole('textbox', { name: 'New file name' })).toBeInTheDocument();
  expect(onLoadDirectory).toHaveBeenCalledWith('src');
  expect(screen.getByRole('button', { name: 'Refresh workspace and Git' })).toBeInTheDocument();
});

test('keeps the panel close action available', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(RepositoryPanel, props({ onClose }));

  await user.click(screen.getByRole('button', { name: 'Close workspace panel' }));

  expect(onClose).toHaveBeenCalledTimes(1);
});
