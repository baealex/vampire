import { expect, test } from 'vitest';
import { loadComposerTemplateBypass, saveComposerTemplateBypass } from './composer-message-options.ts';

test('keeps one-message template bypass scoped to a workspace terminal and clears it after use', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };

  expect(saveComposerTemplateBypass('workspace-a', 'terminal-1', true, storage)).toBe(true);
  expect(loadComposerTemplateBypass('workspace-a', 'terminal-1', storage)).toEqual({ value: true, available: true });
  expect(loadComposerTemplateBypass('workspace-a', 'terminal-2', storage).value).toBe(false);
  expect(saveComposerTemplateBypass('workspace-a', 'terminal-1', false, storage)).toBe(true);
  expect(loadComposerTemplateBypass('workspace-a', 'terminal-1', storage).value).toBe(false);
});

test('reports unavailable storage without changing the template behavior', () => {
  const storage = {
    getItem: () => {
      throw new Error('unavailable');
    },
    setItem: () => {
      throw new Error('unavailable');
    },
    removeItem: () => {
      throw new Error('unavailable');
    },
  };

  expect(loadComposerTemplateBypass('workspace-a', undefined, storage)).toEqual({ value: false, available: false });
  expect(saveComposerTemplateBypass('workspace-a', undefined, true, storage)).toBe(false);
});
