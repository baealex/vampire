import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestError, requestJson } from './request.ts';

test('bounds a request that never responds with a typed timeout error', async (t) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  await assert.rejects(
    () => requestJson('/never-responds', undefined, 'King request', { timeoutMs: 5 }),
    (error) => error instanceof RequestError && error.status === 408 && error.message === 'King request timed out.'
  );
});
