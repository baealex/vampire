import { expect, test } from 'vitest';
import { loadLastFocusedInputSurface, saveLastFocusedInputSurface } from './input-surface-preference.ts';

test('shares the last focused input surface across workspace changes', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };

  expect(saveLastFocusedInputSurface('terminal', storage)).toBe(true);
  expect(loadLastFocusedInputSurface(storage)).toEqual({ value: 'terminal', available: true });

  expect(saveLastFocusedInputSurface('compose', storage)).toBe(true);
  expect(loadLastFocusedInputSurface(storage)).toEqual({ value: 'compose', available: true });
});

test('ignores invalid values and degrades safely when browser storage is unavailable', () => {
  expect(
    loadLastFocusedInputSurface({
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
  expect(loadLastFocusedInputSurface(unavailableStorage)).toEqual({
    value: undefined,
    available: false,
  });
  expect(saveLastFocusedInputSurface('compose', unavailableStorage)).toBe(false);
});
