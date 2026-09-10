import { expect, test, vi } from 'vitest';
import { SubmissionRecovery } from './submission-recovery.ts';

function storage() {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
  };
}

test('retains the raw draft until the server confirms the submission', () => {
  const recovery = new SubmissionRecovery('confirmation', undefined, storage());
  let requestId = '';
  expect(
    recovery.submit('rendered prompt', 'raw prompt', (_data, id) => {
      requestId = id;
      expect(recovery.entries[0]).toMatchObject({ draft: 'raw prompt', status: 'pending' });
      return true;
    }),
  ).toBe(true);
  recovery.applyResult({ type: 'submission-result', requestId, status: 'completed' });
  expect(recovery.entries).toEqual([]);
});

test('keeps an unsent draft out of recovery and reports the transport failure', () => {
  const recovery = new SubmissionRecovery('not-sent', undefined, storage());
  expect(recovery.submit('prompt', 'prompt', () => false)).toBe(false);
  expect(recovery.entries).toEqual([]);
  expect(recovery.error).toContain('draft has been kept');
});

test('restores an unconfirmed draft without sending it again', () => {
  const saved = storage();
  const recovery = new SubmissionRecovery('remount', 'terminal-2', saved);
  const send = vi.fn(() => true);
  recovery.submit('template text', 'draft', send);
  const restored = new SubmissionRecovery('remount', 'terminal-2', saved);
  expect(restored.entries[0]).toMatchObject({ status: 'uncertain', draft: 'draft' });
  expect(send).toHaveBeenCalledOnce();
});

test('rejects oversized UTF-8 messages before transport', () => {
  const recovery = new SubmissionRecovery('size-limit', undefined, storage());
  const send = vi.fn(() => true);
  expect(recovery.submit('한'.repeat(22_000), 'original draft', send)).toBe(false);
  expect(recovery.error).toContain('too large');
  expect(send).not.toHaveBeenCalled();
});
