import { expect, test, vi } from 'vitest';
import {
  captureComposerEditorState,
  loadComposerEditorState,
  restoreComposerEditorState,
  saveComposerEditorState,
} from './composer-editor-state.ts';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

test('keeps Composer editor state separate by workspace and terminal', () => {
  const storage = memoryStorage();
  const mainState = { selectionStart: 2, selectionEnd: 5, selectionDirection: 'backward' as const, scrollTop: 18 };
  const otherState = { selectionStart: 7, selectionEnd: 7, selectionDirection: 'none' as const, scrollTop: 0 };

  expect(saveComposerEditorState('workspace/one', undefined, mainState, storage)).toBe(true);
  expect(saveComposerEditorState('workspace/one', 'terminal-2', otherState, storage)).toBe(true);

  expect(loadComposerEditorState('workspace/one', undefined, storage)).toEqual({ value: mainState, available: true });
  expect(loadComposerEditorState('workspace/one', 'terminal-2', storage)).toEqual({
    value: otherState,
    available: true,
  });
  expect(loadComposerEditorState('workspace/two', undefined, storage)).toEqual({
    value: undefined,
    available: true,
  });
});

test('captures and restores selection direction and scroll position with bounds clamping', () => {
  const source = document.createElement('textarea');
  source.value = 'one\ntwo\nthree';
  source.setSelectionRange(4, 7, 'backward');
  source.scrollTop = 24;

  const captured = captureComposerEditorState(source);
  expect(captured).toEqual({
    selectionStart: 4,
    selectionEnd: 7,
    selectionDirection: 'backward',
    scrollTop: 24,
  });

  const target = document.createElement('textarea');
  target.value = 'short';
  const restored = restoreComposerEditorState(target, captured);
  expect(restored).toEqual({ ...captured, selectionStart: 4, selectionEnd: 5 });
  expect(target.selectionStart).toBe(4);
  expect(target.selectionEnd).toBe(5);
  expect(target.selectionDirection).toBe('backward');
  expect(target.scrollTop).toBe(24);
});

test('ignores malformed state and degrades safely when browser storage is unavailable', () => {
  expect(
    loadComposerEditorState('workspace-1', undefined, {
      getItem: () => '{"selectionStart":4,"selectionEnd":2,"scrollTop":0}',
      setItem: () => undefined,
    })
  ).toEqual({ value: undefined, available: true });

  const unavailableStorage = {
    getItem: () => {
      throw new Error('Storage unavailable');
    },
    setItem: () => {
      throw new Error('Storage unavailable');
    },
  };
  const value = { selectionStart: 0, selectionEnd: 0, scrollTop: 0 };
  expect(loadComposerEditorState('workspace-1', undefined, unavailableStorage)).toEqual({
    value: undefined,
    available: false,
  });
  expect(saveComposerEditorState('workspace-1', undefined, value, unavailableStorage)).toBe(false);
});

test('catches an unavailable browser storage getter', () => {
  vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
    throw new Error('Storage getter unavailable');
  });

  const value = { selectionStart: 0, selectionEnd: 0, scrollTop: 0 };
  expect(loadComposerEditorState('workspace-1')).toEqual({ value: undefined, available: false });
  expect(saveComposerEditorState('workspace-1', undefined, value)).toBe(false);
});
