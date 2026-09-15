import assert from 'node:assert/strict';
import test from 'node:test';
import { hasPrimaryShortcutModifier, usesCommandKeyForShortcuts } from './keyboard.ts';

test('selects the platform primary shortcut modifier from the user agent', () => {
  assert.equal(usesCommandKeyForShortcuts('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), true);
  assert.equal(usesCommandKeyForShortcuts('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), true);
  assert.equal(usesCommandKeyForShortcuts('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), false);
  assert.equal(usesCommandKeyForShortcuts('Mozilla/5.0 (Linux; Android 15)'), false);
});

test('requires exactly the primary modifier for the active platform', () => {
  assert.equal(hasPrimaryShortcutModifier({ ctrlKey: false, metaKey: true }, true), true);
  assert.equal(hasPrimaryShortcutModifier({ ctrlKey: true, metaKey: false }, true), false);
  assert.equal(hasPrimaryShortcutModifier({ ctrlKey: true, metaKey: false }, false), true);
  assert.equal(hasPrimaryShortcutModifier({ ctrlKey: false, metaKey: true }, false), false);
  assert.equal(hasPrimaryShortcutModifier({ ctrlKey: true, metaKey: true }, true), false);
  assert.equal(hasPrimaryShortcutModifier({ ctrlKey: true, metaKey: true }, false), false);
});
