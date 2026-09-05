import assert from 'node:assert/strict';
import test from 'node:test';
import { isComposeFocusShortcut, terminalControlData, type TerminalControlKey } from './terminal-control.ts';

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

test('recognizes Compose focus shortcuts without taking terminal control sequences', () => {
  const shortcut = (changes: Partial<Parameters<typeof isComposeFocusShortcut>[0]>) =>
    isComposeFocusShortcut({
      altKey: false,
      code: '',
      ctrlKey: false,
      isComposing: false,
      metaKey: false,
      repeat: false,
      shiftKey: false,
      ...changes,
    });

  assert.equal(shortcut({ code: 'Slash', metaKey: true }), true);
  assert.equal(shortcut({ code: 'Enter', ctrlKey: true, shiftKey: true }), false);
  assert.equal(shortcut({ code: 'Backslash', metaKey: true }), false);
  assert.equal(shortcut({ code: 'Backquote', metaKey: true }), false);
  assert.equal(shortcut({ code: 'Slash', ctrlKey: true }), false);
  assert.equal(shortcut({ code: 'Slash', metaKey: true, repeat: true }), false);
  assert.equal(shortcut({ code: 'Slash', isComposing: true, metaKey: true }), false);
});
