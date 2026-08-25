import { expect, test } from 'vitest';
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
