import { afterEach, expect, test, vi } from 'vitest';
import type { WorkspaceFile } from '~/lib/shared/contracts/repository.ts';
import { RepositoryWorkspaceState } from './workspace-state.svelte.ts';

function openedFile(path: string): WorkspaceFile {
  return {
    path,
    content: 'unsaved content',
    size: 15,
    modifiedAt: 1,
    version: 'version-1',
  };
}

function dirtyState() {
  const state = new RepositoryWorkspaceState('workspace-1', { isOpen: () => true });
  state.selection = { kind: 'file', path: 'current.txt' };
  state.openedFile = openedFile('current.txt');
  state.fileDirty = true;
  return state;
}

test('keeps the dirty file open when navigation is cancelled', async () => {
  const state = dirtyState();
  const navigation = state.selectItem({ kind: 'file', path: 'next.txt' });

  expect(state.discardChangesPrompt).toBe(true);
  state.resolveDiscardChanges(false);

  await expect(navigation).resolves.toBe(false);
  expect(state.selection).toEqual({ kind: 'file', path: 'current.txt' });
  expect(state.openedFile).toEqual(openedFile('current.txt'));
  expect(state.fileDirty).toBe(true);
  expect(state.discardChangesPrompt).toBe(false);
});

test('discards the dirty file only after navigation is confirmed', async () => {
  const state = dirtyState();
  const navigation = state.selectItem({ kind: 'file', path: 'next.txt' });

  state.resolveDiscardChanges(true);

  await expect(navigation).resolves.toBe(true);
  expect(state.selection).toEqual({ kind: 'file', path: 'next.txt' });
  expect(state.openedFile).toBeUndefined();
  expect(state.fileDirty).toBe(false);
});

test('does not let a second action steal an active discard confirmation', async () => {
  const state = dirtyState();
  const firstNavigation = state.selectItem({ kind: 'file', path: 'first.txt' });
  const secondNavigation = state.selectItem({ kind: 'file', path: 'second.txt' });

  state.resolveDiscardChanges(true);

  await expect(secondNavigation).resolves.toBe(false);
  await expect(firstNavigation).resolves.toBe(true);
  expect(state.selection).toEqual({ kind: 'file', path: 'first.txt' });
  expect(state.discardChangesPrompt).toBe(false);
});

test('keeps the viewer open until closing a dirty file is confirmed', async () => {
  const state = dirtyState();
  const cancelledClose = state.closeViewer();

  state.resolveDiscardChanges(false);

  await expect(cancelledClose).resolves.toBe(false);
  expect(state.selection).toEqual({ kind: 'file', path: 'current.txt' });
  expect(state.openedFile).toBeDefined();

  const confirmedClose = state.closeViewer();
  state.resolveDiscardChanges(true);

  await expect(confirmedClose).resolves.toBe(true);
  expect(state.selection).toBeUndefined();
  expect(state.openedFile).toBeUndefined();
  expect(state.fileDirty).toBe(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function repositorySnapshotResponse(): Response {
  return new Response(
    JSON.stringify({
      isGitRepository: true,
      files: [],
      directories: [],
      ignored: [],
      changes: [],
      changeStats: { additions: 0, deletions: 0 },
      truncated: false,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

test('permanently deletes an entry as soon as deletion is confirmed', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    if (init?.method === 'DELETE') {
      return new Response(JSON.stringify({ path: 'notes.txt' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return repositorySnapshotResponse();
  });
  const state = new RepositoryWorkspaceState('workspace-1', { isOpen: () => true });

  state.requestDelete('notes.txt', 'file');
  await state.confirmDelete();

  expect(state.deleteTargets).toHaveLength(0);
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/workspaces/workspace-1/repository/file?path=notes.txt',
    expect.objectContaining({ method: 'DELETE' })
  );
});

test('requests the final uploaded path to be revealed in the file tree', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (init?.method === 'POST' && String(input).includes('/upload?')) {
      return new Response(JSON.stringify({ path: 'docs/new.txt', size: 3, renamed: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return repositorySnapshotResponse();
  });
  const state = new RepositoryWorkspaceState('workspace-1', { isOpen: () => true });

  await state.uploadFiles(
    { candidates: [{ file: new File(['new'], 'new.txt'), relativePath: 'new.txt' }], skippedGitFiles: 0 },
    'docs'
  );

  expect(state.uploadRevealRequest).toEqual({ path: 'docs/new.txt', token: 1 });
});

test('collapses nested clipboard selections and pastes each top-level entry once', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (String(input).endsWith('/copy')) {
      return new Response(JSON.stringify({ fromPath: 'src', path: 'archive/src', kind: 'directory', renamed: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return repositorySnapshotResponse();
  });
  const state = new RepositoryWorkspaceState('workspace-1', { isOpen: () => true });
  state.setClipboard('copy', [
    { path: 'src', kind: 'directory' },
    { path: 'src/app.ts', kind: 'file' },
  ]);

  expect(state.clipboard?.entries).toEqual([{ path: 'src', kind: 'directory' }]);
  await expect(state.pasteEntries('archive')).resolves.toEqual([
    { fromPath: 'src', path: 'archive/src', kind: 'directory', renamed: false },
  ]);
  const copyCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/copy'));
  expect(JSON.parse(String(copyCall?.[1]?.body))).toEqual({
    path: 'src',
    kind: 'directory',
    targetDirectory: 'archive',
    conflict: 'rename',
  });
});
