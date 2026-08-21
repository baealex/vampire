import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryCache } from '../src/lib/client/query-cache.ts';

test('caches successful results, coalesces requests, and reloads after invalidation', async () => {
  const cache = new QueryCache();
  let calls = 0;
  const load = async () => ({ value: ++calls });

  const [first, concurrent] = await Promise.all([cache.fetch('workspace', load), cache.fetch('workspace', load)]);
  assert.deepEqual(first, { value: 1 });
  assert.deepEqual(concurrent, { value: 1 });
  assert.equal(calls, 1);
  assert.deepEqual(await cache.fetch('workspace', load), { value: 1 });
  assert.equal(calls, 1);

  cache.invalidate('workspace');
  assert.deepEqual(await cache.fetch('workspace', load), { value: 2 });
  assert.equal(calls, 2);
});

test('shows cached data while revalidating and notifies subscribers', async () => {
  const cache = new QueryCache();
  cache.set('workspace', { value: 1 });
  const snapshots: Array<{ value: number | undefined; isFetching: boolean }> = [];
  const unsubscribe = cache.subscribe<{ value: number }>('workspace', (snapshot) => {
    snapshots.push({ value: snapshot.data?.value, isFetching: snapshot.isFetching });
  });

  let resolveRequest: ((value: { value: number }) => void) | undefined;
  const request = new Promise<{ value: number }>((resolve) => {
    resolveRequest = resolve;
  });
  const revalidation = cache.fetch('workspace', () => request, true);

  assert.deepEqual(snapshots.at(-1), { value: 1, isFetching: true });
  resolveRequest!({ value: 2 });
  await revalidation;
  assert.deepEqual(snapshots.at(-1), { value: 2, isFetching: false });
  unsubscribe();
});

test('does not let cleared or mutated queries commit an old pending response', async () => {
  const cache = new QueryCache();
  let resolveRequest: ((value: { value: number }) => void) | undefined;
  const request = new Promise<{ value: number }>((resolve) => {
    resolveRequest = resolve;
  });
  const oldRequest = cache.fetch('workspace', () => request, true);

  cache.set('workspace', { value: 3 });
  resolveRequest!({ value: 1 });
  await oldRequest;
  assert.deepEqual(cache.get('workspace'), { value: 3 });

  let resolveClearedRequest: ((value: { value: number }) => void) | undefined;
  const clearedRequest = new Promise<{ value: number }>((resolve) => {
    resolveClearedRequest = resolve;
  });
  const pendingBeforeClear = cache.fetch('workspace', () => clearedRequest, true);
  cache.clear();
  const freshRequest = cache.fetch('workspace', async () => ({ value: 4 }), true);
  resolveClearedRequest!({ value: 2 });

  await Promise.all([pendingBeforeClear, freshRequest]);
  assert.deepEqual(cache.get('workspace'), { value: 4 });
});

test('does not cache a failed request and allows retry', async () => {
  const cache = new QueryCache();
  let calls = 0;
  await assert.rejects(cache.fetch('workspace', async () => {
    calls += 1;
    throw new Error('offline');
  }, true), /offline/);

  assert.equal(cache.has('workspace'), false);
  assert.deepEqual(await cache.fetch('workspace', async () => {
    calls += 1;
    return { value: 1 };
  }), { value: 1 });
  assert.equal(calls, 2);
});
