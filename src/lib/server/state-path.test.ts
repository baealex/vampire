import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import {
  vampireAgentSupportPath,
  vampireGlobalStatePath,
  vampireRegistryPath,
  vampireStatePath,
  vampireWorkspaceStateDirectory,
  vampireWorkspaceStateKey,
} from './state-path.ts';

test('maps persistent ownership areas below an explicit state directory', () => {
  const env = { VAMPIRE_STATE_DIR: '/state' };
  assert.equal(vampireStatePath(env), join('/state', 'sessions.json'));
  assert.equal(vampireRegistryPath(env), join('/state', 'registry.json'));
  assert.equal(vampireGlobalStatePath('settings.json', env), join('/state', 'global', 'settings.json'));
  assert.equal(vampireWorkspaceStateDirectory('workspace-1', env), join('/state', 'workspaces', 'workspace-1'));
  assert.equal(vampireAgentSupportPath('guides', env), join('/state', 'agent-support', 'guides'));
});

test('hashes workspace identifiers that cannot safely own a directory', () => {
  const key = vampireWorkspaceStateKey('../../outside');
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(key.includes('..'), false);
});
