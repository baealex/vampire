import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_TERMINAL_INPUT_SETTINGS, isTerminalInputSettings } from './terminal-input.ts';

test('validates terminal input settings at the shared boundary', () => {
  assert.equal(isTerminalInputSettings(DEFAULT_TERMINAL_INPUT_SETTINGS), true);
  assert.equal(isTerminalInputSettings({ mode: 'compose', slashHandoff: 'yes' }), false);
});
