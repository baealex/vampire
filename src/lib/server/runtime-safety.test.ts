import assert from 'node:assert/strict';
import test from 'node:test';
import { automaticCommandsAllowed } from './runtime-safety.ts';

test('safe development mode disables automatic commands without changing production defaults', () => {
  assert.equal(automaticCommandsAllowed({}), true);
  assert.equal(automaticCommandsAllowed({ VAMPIRE_SAFE_DEVELOPMENT: '1' }), false);
});
