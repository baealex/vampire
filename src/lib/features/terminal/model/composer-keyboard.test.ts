import assert from 'node:assert/strict';
import test from 'node:test';
import { composerKeyboardCommand } from './composer-keyboard.ts';

function command(changes: Partial<Parameters<typeof composerKeyboardCommand>[0]>) {
  return composerKeyboardCommand({
    altKey: false,
    code: '',
    ctrlKey: false,
    isComposing: false,
    keyCode: 0,
    metaKey: false,
    repeat: false,
    shiftKey: false,
    ...changes,
  });
}

test('maps Composer-only keyboard commands without consuming repeats or IME input', () => {
  assert.equal(command({ altKey: true, code: 'KeyH', ctrlKey: true }), 'history');
  assert.equal(command({ altKey: true, code: 'KeyP', ctrlKey: true }), 'preview-template');
  assert.equal(command({ altKey: true, code: 'KeyB', ctrlKey: true }), 'toggle-template');
  assert.equal(command({ altKey: true, code: 'KeyR', ctrlKey: true }), 'restore-submission');
  assert.equal(command({ code: 'Slash', ctrlKey: true }), 'insert-slash');
  assert.equal(command({ altKey: true, code: 'KeyH', ctrlKey: true, repeat: true }), undefined);
  assert.equal(command({ altKey: true, code: 'KeyH', ctrlKey: true, isComposing: true }), undefined);
  assert.equal(command({ code: 'KeyP', metaKey: true, shiftKey: true }), undefined);
  assert.equal(
    command({ altKey: true, code: 'KeyH', ctrlKey: true, getModifierState: (key) => key === 'AltGraph' }),
    undefined
  );
});
