import assert from 'node:assert/strict';
import test from 'node:test';
import { automaticCommandsAllowed, statusWidgetCommandsAllowed } from './runtime-safety.ts';

test('safe development mode disables automatic commands without changing production defaults', () => {
  assert.equal(automaticCommandsAllowed({}), true);
  assert.equal(automaticCommandsAllowed({ VAMPIRE_SAFE_DEVELOPMENT: '1' }), false);
});

test('safe development can explicitly allow status widget commands only', () => {
  assert.equal(statusWidgetCommandsAllowed({ VAMPIRE_SAFE_DEVELOPMENT: '1' }), false);
  assert.equal(
    statusWidgetCommandsAllowed({
      VAMPIRE_SAFE_DEVELOPMENT: '1',
      VAMPIRE_ALLOW_STATUS_WIDGET_COMMANDS: '1',
    }),
    true,
  );
  assert.equal(
    automaticCommandsAllowed({
      VAMPIRE_SAFE_DEVELOPMENT: '1',
      VAMPIRE_ALLOW_STATUS_WIDGET_COMMANDS: '1',
    }),
    false,
  );
});
