import assert from 'node:assert/strict';
import test from 'node:test';
import { RepositoryClient } from './client.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('encodes workspace and repository paths and forwards an abort signal', async (t) => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    calls.push({ input: String(input), init });
    return jsonResponse({ path: 'src/main.ts' });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const signal = new AbortController().signal;
  await new RepositoryClient('workspace/one').readFile('src/main file.ts', signal);

  assert.equal(calls[0]?.input, '/api/workspaces/workspace%2Fone/repository/file?path=src%2Fmain+file.ts');
  assert.equal(calls[0]?.init?.signal, signal);
});

test('sends versioned file saves and explicit move conflict policies', async (t) => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    calls.push({ input: String(input), init });
    return jsonResponse({});
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const client = new RepositoryClient('workspace-1');
  await client.updateFile('src/main.ts', 'updated', 'version-7');
  await client.moveEntry('src/main.ts', 'file', 'archive', 'rename');

  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    content: 'updated',
    version: 'version-7',
  });
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    path: 'src/main.ts',
    kind: 'file',
    targetDirectory: 'archive',
    conflict: 'rename',
  });
});

test('preserves an API conflict as a typed request error', async (t) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse({ message: 'This file changed elsewhere.' }, 409)) as typeof fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  await assert.rejects(
    () => new RepositoryClient('workspace-1').updateFile('conflict.txt', 'updated', 'old-version'),
    (error: unknown) =>
      error instanceof Error &&
      'status' in error &&
      error.status === 409 &&
      error.message === 'This file changed elsewhere.'
  );
});
