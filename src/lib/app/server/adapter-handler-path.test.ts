import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAdapterHandlerPath } from './adapter-handler-path.ts';

test('resolves the adapter handler from a source entrypoint', () => {
  const existing = new Set(['/repo/build-e2e/handler.js']);
  const path = resolveAdapterHandlerPath('/repo/src/lib/app/server', 'build-e2e', existing.has.bind(existing));

  assert.equal(path, '/repo/build-e2e/handler.js');
});

test('resolves the adapter handler from a bundled entrypoint', () => {
  const existing = new Set(['/repo/build/handler.js']);
  const path = resolveAdapterHandlerPath('/repo/build', 'build', existing.has.bind(existing));

  assert.equal(path, '/repo/build/handler.js');
});
