import assert from 'node:assert/strict';
import test from 'node:test';
import { isInputSurfaceToggleShortcut, type TerminalControlKey, terminalControlData } from './terminal-control.ts';

test('encodes fixed terminal controls independently of cursor mode', () => {
  const controls = [
    ['escape', '\u001b'],
    ['interrupt', '\u0003'],
    ['tab', '\t'],
    ['backspace', '\u007f'],
    ['enter', '\r'],
  ] satisfies Array<[TerminalControlKey, string]>;
  for (const [control, expected] of controls) {
    assert.equal(terminalControlData(control, false), expected);
    assert.equal(terminalControlData(control, true), expected);
  }
});

test('encodes cursor controls for the active terminal mode', () => {
  const controls = [
    ['arrow-up', 'A'],
    ['arrow-down', 'B'],
    ['arrow-right', 'C'],
    ['arrow-left', 'D'],
  ] satisfies Array<[TerminalControlKey, string]>;
  for (const [control, suffix] of controls) {
    assert.equal(terminalControlData(control, false), `\u001b[${suffix}`);
    assert.equal(terminalControlData(control, true), `\u001bO${suffix}`);
  }
});

test('recognizes the platform input surface toggle', () => {
  const shortcut = (commandKey: boolean, changes: Partial<Parameters<typeof isInputSurfaceToggleShortcut>[0]>) =>
    isInputSurfaceToggleShortcut(
      {
        altKey: false,
        code: '',
        ctrlKey: false,
        isComposing: false,
        metaKey: false,
        repeat: false,
        shiftKey: false,
        ...changes,
      },
      commandKey,
    );

  assert.equal(shortcut(true, { code: 'Slash', metaKey: true }), true);
  assert.equal(shortcut(true, { code: 'Backquote', ctrlKey: true }), false);
  assert.equal(shortcut(false, { code: 'Backquote', ctrlKey: true }), true);
  assert.equal(shortcut(false, { code: 'Slash', metaKey: true }), false);
  assert.equal(shortcut(false, { code: 'Backquote', ctrlKey: true, shiftKey: true }), false);
  assert.equal(shortcut(false, { code: 'Backquote', ctrlKey: true, isComposing: true }), false);
  assert.equal(shortcut(false, { code: 'Backquote', ctrlKey: true, repeat: true }), false);
  assert.equal(shortcut(false, { altKey: true, code: 'Backquote', ctrlKey: true }), false);
  assert.equal(shortcut(true, { code: 'Slash', ctrlKey: true, metaKey: true }), false);
});
