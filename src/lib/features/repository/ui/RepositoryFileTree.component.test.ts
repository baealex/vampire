import { tick } from 'svelte';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type { RepositorySnapshot } from '~/lib/shared/contracts/repository.ts';
import RepositoryFileTree from './RepositoryFileTree.svelte';

afterEach(() => vi.useRealTimers());

const snapshot: RepositorySnapshot = {
  isGitRepository: true,
  files: ['docs/readme.md', 'src/app.ts'],
  directories: ['archive', 'docs', 'src'],
  ignored: [],
  changes: [],
  changeStats: { additions: 0, deletions: 0 },
  truncated: false,
};

function props(overrides: Record<string, unknown> = {}) {
  return {
    snapshot,
    projectName: 'vampire',
    projectPath: '/projects/vampire',
    onLoadDirectory: vi.fn(async () => undefined),
    onCreateFile: vi.fn(async () => undefined),
    onCreateDirectory: vi.fn(async () => undefined),
    onRequestDelete: vi.fn(),
    onDropFiles: vi.fn(async () => undefined),
    onMoveEntry: vi.fn(async () => undefined),
    onInsertPath: vi.fn(),
    onRenameEntry: vi.fn(async (entry: { path: string; kind: 'file' | 'directory' }, name: string) => ({
      fromPath: entry.path,
      path: `${entry.path.slice(0, Math.max(0, entry.path.lastIndexOf('/') + 1))}${name}`,
      kind: entry.kind,
      renamed: false,
    })),
    onCopyEntries: vi.fn(),
    onCutEntries: vi.fn(),
    onPasteEntries: vi.fn(async () => []),
    onSelect: vi.fn(),
    ...overrides,
  };
}

test('offers an explicit add action on folders and loads the target folder before creation', async () => {
  const user = userEvent.setup();
  const onLoadDirectory = vi.fn(async () => undefined);
  render(RepositoryFileTree, props({ onLoadDirectory }));

  await fireEvent.click(screen.getByRole('button', { name: 'Add inside src' }));
  await user.click(await screen.findByRole('menuitem', { name: 'New file' }));

  expect(screen.getByRole('textbox', { name: 'New file name' })).toBeInTheDocument();
  expect(onLoadDirectory).toHaveBeenCalledWith('src');
});

test('indents workspace contents beneath the root folder', async () => {
  const user = userEvent.setup();
  render(RepositoryFileTree, props());

  const docsShell = screen.getByRole('button', { name: 'Expand docs' }).closest('.tree-row-shell');
  expect(docsShell?.querySelectorAll('.tree-indent > span')).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: 'Expand docs' }));
  const readmeShell = screen.getByRole('button', { name: 'Open docs/readme.md' }).closest('.tree-row-shell');
  expect(readmeShell?.querySelectorAll('.tree-indent > span')).toHaveLength(2);
});

test('expands a collapsed folder after a sustained external-file drag hover', async () => {
  vi.useFakeTimers();
  const onLoadDirectory = vi.fn(async () => undefined);
  render(RepositoryFileTree, props({ onLoadDirectory }));
  const docs = screen.getByRole('button', { name: 'Expand docs' }).closest('.tree-row-shell');
  const dataTransfer = { types: ['Files'], files: [] };

  await fireEvent.dragOver(docs!, { dataTransfer });
  await vi.advanceTimersByTimeAsync(649);
  expect(onLoadDirectory).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await tick();

  expect(onLoadDirectory).toHaveBeenCalledWith('docs');
  expect(screen.getByRole('button', { name: 'Collapse docs' })).toBeInTheDocument();
});

test('collapses every expanded descendant while keeping the workspace root open', async () => {
  const user = userEvent.setup();
  render(RepositoryFileTree, props());
  await user.click(screen.getByRole('button', { name: 'Expand docs' }));
  await user.click(screen.getByRole('button', { name: 'Expand src' }));

  await fireEvent.click(screen.getByRole('button', { name: 'More workspace tree actions' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Collapse all folders' }));

  expect(screen.getByRole('button', { name: 'Collapse vampire workspace root' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Expand docs' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Expand src' })).toBeInTheDocument();
});

test('moves a dragged file into another folder', async () => {
  const user = userEvent.setup();
  const onMoveEntry = vi.fn(async () => ({
    fromPath: 'src/app.ts',
    path: 'docs/app.ts',
    kind: 'file' as const,
    renamed: false,
  }));
  render(RepositoryFileTree, props({ onMoveEntry }));

  await user.click(screen.getByRole('button', { name: 'Expand src' }));
  const file = await screen.findByRole('button', { name: 'Open src/app.ts' });
  const docs = screen.getByRole('button', { name: 'Expand docs' }).closest('.tree-row-shell');
  expect(docs).not.toBeNull();

  const values = new Map<string, string>();
  const dataTransfer = {
    effectAllowed: 'none',
    dropEffect: 'none',
    types: [] as string[],
    setData(type: string, value: string) {
      values.set(type, value);
      if (!this.types.includes(type)) this.types.push(type);
    },
    getData(type: string) {
      return values.get(type) ?? '';
    },
  };

  await fireEvent.dragStart(file, { dataTransfer });
  await fireEvent.dragOver(docs!, { dataTransfer });
  await fireEvent.drop(docs!, { dataTransfer });

  await waitFor(() => expect(onMoveEntry).toHaveBeenCalledWith({ path: 'src/app.ts', kind: 'file' }, 'docs'));
});

test('passes external file drops to the exact target folder', async () => {
  const onDropFiles = vi.fn(async () => undefined);
  const onLoadDirectory = vi.fn(async () => undefined);
  render(RepositoryFileTree, props({ onDropFiles, onLoadDirectory }));
  const docs = screen.getByRole('button', { name: 'Expand docs' }).closest('.tree-row-shell');
  expect(docs).not.toBeNull();
  const dataTransfer = { types: ['Files'], files: [] };

  await fireEvent.dragOver(docs!, { dataTransfer });
  await fireEvent.drop(docs!, { dataTransfer });

  await waitFor(() => expect(onDropFiles).toHaveBeenCalledWith('docs', dataTransfer));
  expect(onLoadDirectory).toHaveBeenCalledWith('docs');
  expect(screen.getByRole('button', { name: 'Collapse docs' })).toBeInTheDocument();
});

test('uploads a file dropped on a file row into that file’s parent folder', async () => {
  const user = userEvent.setup();
  const onDropFiles = vi.fn(async () => undefined);
  render(RepositoryFileTree, props({ onDropFiles }));
  await user.click(screen.getByRole('button', { name: 'Expand docs' }));
  const readme = screen.getByRole('button', { name: 'Open docs/readme.md' }).closest('.tree-row-shell');
  expect(readme).not.toBeNull();
  const dataTransfer = { types: ['Files'], files: [] };

  await fireEvent.dragOver(readme!, { dataTransfer });
  expect(readme).toHaveClass('drop-target');
  await fireEvent.drop(readme!, { dataTransfer });

  expect(onDropFiles).toHaveBeenCalledWith('docs', dataTransfer);
});

test('expands and scrolls to a newly uploaded path', async () => {
  const onLoadDirectory = vi.fn(async () => undefined);
  const scrollIntoView = vi.fn();
  const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
  try {
    const view = render(RepositoryFileTree, props({ onLoadDirectory }));
    await view.rerender(props({ onLoadDirectory, revealRequest: { path: 'docs/readme.md', token: 1 } }));

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' }));
    expect(onLoadDirectory).toHaveBeenCalledWith('docs');
    expect(screen.getByRole('button', { name: 'Collapse docs' })).toBeInTheDocument();
  } finally {
    if (previous) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previous);
    else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  }
});

test('moves every modifier-selected entry in one internal drag', async () => {
  const user = userEvent.setup();
  const onMoveEntry = vi.fn(async (entry: { path: string; kind: 'file' | 'directory' }) => ({
    fromPath: entry.path,
    path: `archive/${entry.path.split('/').pop()}`,
    kind: entry.kind,
    renamed: false,
  }));
  render(RepositoryFileTree, props({ onMoveEntry }));
  await user.click(screen.getByRole('button', { name: 'Expand docs' }));
  await user.click(screen.getByRole('button', { name: 'Expand src' }));
  const readme = screen.getByRole('button', { name: 'Open docs/readme.md' });
  const app = screen.getByRole('button', { name: 'Open src/app.ts' });
  await fireEvent.click(readme);
  await fireEvent.click(app, { ctrlKey: true });

  const values = new Map<string, string>();
  const dataTransfer = {
    effectAllowed: 'none',
    dropEffect: 'none',
    types: [] as string[],
    setData(type: string, value: string) {
      values.set(type, value);
      if (!this.types.includes(type)) this.types.push(type);
    },
    getData(type: string) {
      return values.get(type) ?? '';
    },
  };
  const archive = screen.getByRole('button', { name: 'Expand archive' }).closest('.tree-row-shell');
  await fireEvent.dragStart(app, { dataTransfer });
  await fireEvent.dragOver(archive!, { dataTransfer });
  await fireEvent.drop(archive!, { dataTransfer });

  await waitFor(() => expect(onMoveEntry).toHaveBeenCalledTimes(2));
  expect(onMoveEntry).toHaveBeenNthCalledWith(1, { path: 'docs/readme.md', kind: 'file' }, 'archive');
  expect(onMoveEntry).toHaveBeenNthCalledWith(2, { path: 'src/app.ts', kind: 'file' }, 'archive');
});

test('renames the focused entry with F2 and keeps editing errors inline', async () => {
  const user = userEvent.setup();
  const onRenameEntry = vi.fn(async () => ({
    fromPath: 'src/app.ts',
    path: 'src/main.ts',
    kind: 'file' as const,
    renamed: false,
  }));
  render(RepositoryFileTree, props({ onRenameEntry }));

  await user.click(screen.getByRole('button', { name: 'Expand src' }));
  await fireEvent.keyDown(screen.getByRole('button', { name: 'Open src/app.ts' }), { key: 'F2' });
  const input = screen.getByRole('textbox', { name: 'Rename file' });
  await user.clear(input);
  await user.type(input, 'main.ts{Enter}');

  await waitFor(() => expect(onRenameEntry).toHaveBeenCalledWith({ path: 'src/app.ts', kind: 'file' }, 'main.ts'));
});

test('copies a modifier-selected group and pastes into the focused folder from the keyboard', async () => {
  const user = userEvent.setup();
  const onCopyEntries = vi.fn();
  const onPasteEntries = vi.fn(async () => []);
  render(RepositoryFileTree, props({ onCopyEntries, onPasteEntries, canPaste: true }));

  await user.click(screen.getByRole('button', { name: 'Expand docs' }));
  await user.click(screen.getByRole('button', { name: 'Expand src' }));
  const readme = screen.getByRole('button', { name: 'Open docs/readme.md' });
  const app = screen.getByRole('button', { name: 'Open src/app.ts' });
  await fireEvent.click(readme);
  await fireEvent.click(app, { ctrlKey: true });
  await fireEvent.keyDown(app, { key: 'c', ctrlKey: true });

  expect(onCopyEntries).toHaveBeenCalledWith([
    { path: 'docs/readme.md', kind: 'file' },
    { path: 'src/app.ts', kind: 'file' },
  ]);

  const docs = screen.getByRole('button', { name: 'Collapse docs' });
  await fireEvent.keyDown(docs, { key: 'v', ctrlKey: true });
  await waitFor(() => expect(onPasteEntries).toHaveBeenCalledWith('docs'));
});
