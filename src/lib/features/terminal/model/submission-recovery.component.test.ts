import { expect, test, vi } from 'vitest';
import { SubmissionRecovery } from './submission-recovery.svelte.ts';

function storage() {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
}

test('records the raw draft before sending and removes it only after server confirmation', () => {
  const saved = storage();
  const recovery = new SubmissionRecovery('recovery-confirmation', undefined, saved);
  let requestId = '';
  expect(
    recovery.submit('wrapped prompt', 'raw prompt', (_data, id) => {
      requestId = id;
      expect(recovery.entries[0].draft).toBe('raw prompt');
      expect(recovery.entries[0].status).toBe('pending');
      return true;
    })
  ).toBe(true);
  recovery.applyResult({ type: 'submission-result', requestId, status: 'completed' });
  expect(recovery.entries).toEqual([]);
});

test('a failed transport leaves the editor responsible for its draft and creates no duplicate recovery', () => {
  const recovery = new SubmissionRecovery('recovery-not-sent', undefined, storage());
  expect(recovery.submit('prompt', 'prompt', () => false)).toBe(false);
  expect(recovery.entries).toEqual([]);
  expect(recovery.error).toContain('draft has been kept');
});

test('submits on HTTP origins without crypto.randomUUID', () => {
  const unavailable = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
    throw new Error('Not available on this origin');
  });
  const recovery = new SubmissionRecovery('recovery-http', undefined, storage());
  expect(recovery.submit('prompt', 'prompt', () => true)).toBe(true);
  expect(recovery.entries[0].requestId).toMatch(/^[a-f0-9]{32}$/);
  expect(unavailable).not.toHaveBeenCalled();
  unavailable.mockRestore();
});

test('unconfirmed drafts survive remount and a warm runtime restores their pending status', () => {
  const saved = storage();
  const recovery = new SubmissionRecovery('recovery-remount', 'terminal-2', saved);
  const send = vi.fn(() => true);
  recovery.submit('template text', 'draft', send);
  const requestId = recovery.entries[0].requestId;
  const restored = new SubmissionRecovery('recovery-remount', 'terminal-2', saved);
  expect(restored.entries[0]).toMatchObject({ status: 'uncertain', draft: 'draft' });
  restored.resumePending([requestId]);
  expect(restored.entries[0].status).toBe('pending');
  restored.markUncertain(requestId);
  expect(restored.entries[0].status).toBe('uncertain');
  expect(send).toHaveBeenCalledOnce();
});

test('storage failure keeps a recovery copy in memory and reports its limitation', () => {
  const broken = {
    getItem: () => null,
    setItem: () => {
      throw new Error('quota');
    },
    removeItem: () => {
      throw new Error('quota');
    },
  };
  const recovery = new SubmissionRecovery('recovery-quota', undefined, broken);
  recovery.submit('message', 'original', () => true);
  expect(recovery.persistenceFailed).toBe(true);
  const restored = new SubmissionRecovery('recovery-quota', undefined, broken);
  expect(restored.entries[0].draft).toBe('original');
  restored.dismiss(restored.entries[0].requestId);
  expect(new SubmissionRecovery('recovery-quota', undefined, broken).entries).toEqual([]);
});

test('visiting empty terminals does not evict a draft when storage is unavailable', () => {
  const broken = {
    getItem: () => null,
    setItem: () => {
      throw new Error('quota');
    },
    removeItem: () => {
      throw new Error('quota');
    },
  };
  const recovery = new SubmissionRecovery('recovery-retained', undefined, broken);
  recovery.submit('message', 'keep me', () => true);
  for (let index = 0; index < 40; index++) new SubmissionRecovery(`empty-recovery-${index}`, undefined, broken);
  expect(new SubmissionRecovery('recovery-retained', undefined, broken).entries[0].draft).toBe('keep me');
});
