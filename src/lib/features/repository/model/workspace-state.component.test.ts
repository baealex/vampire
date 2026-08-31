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

test('keeps a Git discard confirmation busy until its refreshed change list is ready', async () => {
  let finishRefresh!: () => void;
  const refreshReady = new Promise<void>((resolve) => {
    finishRefresh = resolve;
  });
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).endsWith('/repository/discard') && init?.method === 'POST') {
      return new Response(JSON.stringify({ path: 'scratch.txt', status: '??' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    await refreshReady;
    return repositorySnapshotResponse();
  });
  const state = new RepositoryWorkspaceState('workspace-1', { isOpen: () => true });
  const change = { path: 'scratch.txt', status: '??' as const };
  state.requestDiscardChange(change);

  const discard = state.confirmDiscardChange();
  await vi.waitFor(() =>
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/repository/discard'))).toBe(true)
  );
  expect(state.discarding).toBe(true);
  expect(state.discardTarget).toEqual(change);

  finishRefresh();
  await discard;
  expect(state.discarding).toBe(false);
  expect(state.discardTarget).toBeUndefined();
});

test('waits for the queued snapshot when refresh is requested during an active refresh', async () => {
  let finishFirstRefresh!: () => void;
  let finishQueuedRefresh!: () => void;
  const firstRefreshReady = new Promise<void>((resolve) => {
    finishFirstRefresh = resolve;
  });
  const queuedRefreshReady = new Promise<void>((resolve) => {
    finishQueuedRefresh = resolve;
  });
  let snapshotRequestCount = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    snapshotRequestCount += 1;
    await (snapshotRequestCount === 1 ? firstRefreshReady : queuedRefreshReady);
    return repositorySnapshotResponse();
  });
  const state = new RepositoryWorkspaceState('workspace-1', { isOpen: () => true });

  const activeRefresh = state.refresh();
  await vi.waitFor(() => expect(snapshotRequestCount).toBe(1));
  let queuedSettled = false;
  const queuedRefresh = state.refresh().then(() => {
    queuedSettled = true;
  });

  finishFirstRefresh();
  await vi.waitFor(() => expect(snapshotRequestCount).toBe(2));
  expect(queuedSettled).toBe(false);

  finishQueuedRefresh();
  await Promise.all([activeRefresh, queuedRefresh]);
  expect(queuedSettled).toBe(true);
  expect(state.refreshToken).toBe(2);
});

test('deletes an unused local branch only after confirmation', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    if (init?.method === 'DELETE') {
      return new Response(JSON.stringify({ name: 'merged-cleanup' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return repositorySnapshotResponse();
  });
  const state = new RepositoryWorkspaceState('workspace-1', { isOpen: () => true });

  state.requestDeleteBranch({ name: 'merged-cleanup', current: false, head: 'abc123' });
  expect(state.branchDeleteTarget?.name).toBe('merged-cleanup');
  await state.confirmDeleteBranch();

  expect(state.branchDeleteTarget).toBeUndefined();
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/workspaces/workspace-1/repository/branch?path=merged-cleanup',
    expect.objectContaining({ method: 'DELETE' })
  );
});

test('does not offer deletion for a branch checked out in a worktree', () => {
  const state = new RepositoryWorkspaceState('workspace-1', { isOpen: () => true });
  state.requestDeleteBranch({ name: 'in-use', current: false, worktreePath: '/worktrees/in-use' });

  expect(state.branchDeleteTarget).toBeUndefined();
  expect(state.errorMessage).toMatch(/checked out in a worktree/i);
});

test('appends the next commit page without replacing the visible history', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        commits: [
          {
            hash: 'older-hash',
            shortHash: 'older',
            subject: 'Older commit',
            authorName: 'Vampire Test',
            authoredAt: 1,
            stats: { filesChanged: 1, additions: 2, deletions: 0 },
          },
        ],
        hasMore: false,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  );
  const state = new RepositoryWorkspaceState('workspace-1', { isOpen: () => true });
  state.snapshot = {
    isGitRepository: true,
    files: [],
    directories: [],
    ignored: [],
    changes: [],
    changeStats: { additions: 0, deletions: 0 },
    truncated: false,
    git: {
      detached: false,
      commits: [
        {
          hash: 'newer-hash',
          shortHash: 'newer',
          subject: 'Newer commit',
          authorName: 'Vampire Test',
          authoredAt: 2,
          stats: { filesChanged: 1, additions: 1, deletions: 0 },
        },
      ],
      hasMoreCommits: true,
      branches: [],
      worktrees: [],
    },
  };

  await state.loadMoreCommits();

  expect(state.snapshot.git?.commits.map((commit) => commit.hash)).toEqual(['newer-hash', 'older-hash']);
  expect(state.snapshot.git?.hasMoreCommits).toBe(false);
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
