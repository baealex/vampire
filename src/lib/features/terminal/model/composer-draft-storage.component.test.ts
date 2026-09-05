import { expect, test, vi } from 'vitest';
import { loadComposerDraft, saveComposerDraft } from './composer-draft-storage.ts';

test('keeps Composer drafts separate by workspace and terminal', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };

  expect(saveComposerDraft('workspace/one', undefined, 'Main draft', storage)).toBe(true);
  expect(saveComposerDraft('workspace/one', 'terminal-2', 'Other draft', storage)).toBe(true);
  expect(saveComposerDraft('workspace/two', undefined, 'Different workspace draft', storage)).toBe(true);
  expect(loadComposerDraft('workspace/one', undefined, storage)).toEqual({ value: 'Main draft', available: true });
  expect(loadComposerDraft('workspace/one', 'terminal-2', storage)).toEqual({
    value: 'Other draft',
    available: true,
  });
  expect(loadComposerDraft('workspace/two', undefined, storage)).toEqual({
    value: 'Different workspace draft',
    available: true,
  });

  expect(saveComposerDraft('workspace/one', undefined, '', storage)).toBe(true);
  expect(loadComposerDraft('workspace/one', undefined, storage).value).toBe('');
});

test('degrades safely when browser storage is unavailable', () => {
  const storage = {
    getItem: () => {
      throw new Error('Storage unavailable');
    },
    setItem: () => {
      throw new Error('Storage unavailable');
    },
    removeItem: () => {
      throw new Error('Storage unavailable');
    },
  };

  expect(loadComposerDraft('workspace-1', undefined, storage)).toEqual({ value: '', available: false });
  expect(saveComposerDraft('workspace-1', undefined, 'Draft', storage)).toBe(false);
});

test('catches an unavailable browser storage getter', () => {
  vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
    throw new Error('Storage getter unavailable');
  });

  expect(loadComposerDraft('workspace-1')).toEqual({ value: '', available: false });
  expect(saveComposerDraft('workspace-1', undefined, 'Draft')).toBe(false);
});
