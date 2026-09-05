import { expect, test, vi } from 'vitest';
import { loadLastFocusedInputSurface, saveLastFocusedInputSurface } from './input-surface-preference.ts';

test('keeps the last focused input surface separate by workspace and terminal', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };

  expect(saveLastFocusedInputSurface('workspace/one', undefined, 'terminal', storage)).toBe(true);
  expect(saveLastFocusedInputSurface('workspace/one', 'terminal-2', 'compose', storage)).toBe(true);
  expect(saveLastFocusedInputSurface('workspace/two', undefined, 'compose', storage)).toBe(true);

  expect(loadLastFocusedInputSurface('workspace/one', undefined, storage)).toEqual({
    value: 'terminal',
    available: true,
  });
  expect(loadLastFocusedInputSurface('workspace/one', 'terminal-2', storage)).toEqual({
    value: 'compose',
    available: true,
  });
  expect(loadLastFocusedInputSurface('workspace/two', undefined, storage)).toEqual({
    value: 'compose',
    available: true,
  });
  expect(loadLastFocusedInputSurface('workspace/three', undefined, storage)).toEqual({
    value: undefined,
    available: true,
  });
});

test('ignores invalid values and degrades safely when browser storage is unavailable', () => {
  expect(
    loadLastFocusedInputSurface('workspace-1', undefined, {
      getItem: () => 'other',
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
  expect(loadLastFocusedInputSurface('workspace-1', undefined, unavailableStorage)).toEqual({
    value: undefined,
    available: false,
  });
  expect(saveLastFocusedInputSurface('workspace-1', undefined, 'compose', unavailableStorage)).toBe(false);
});

test('catches an unavailable browser storage getter', () => {
  vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
    throw new Error('Storage getter unavailable');
  });

  expect(loadLastFocusedInputSurface('workspace-1')).toEqual({ value: undefined, available: false });
  expect(saveLastFocusedInputSurface('workspace-1', undefined, 'compose')).toBe(false);
});
