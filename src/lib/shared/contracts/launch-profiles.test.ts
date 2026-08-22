import assert from 'node:assert/strict';
import test from 'node:test';
import { isLaunchProfileList, normalizeLaunchProfiles } from '~/lib/shared/contracts/launch-profiles.ts';

test('accepts bounded single-line launch profiles', () => {
  assert.equal(isLaunchProfileList([{ id: 'codex', name: 'Codex', command: 'codex' }]), true);
  assert.equal(isLaunchProfileList([{ id: 'codex', name: 'Codex', command: 'codex\n--danger' }]), false);
  assert.equal(
    isLaunchProfileList([
      { id: 'same', name: 'One', command: 'one' },
      { id: 'same', name: 'Two', command: 'two' },
    ]),
    false
  );
});

test('normalizes stored profiles without inventing invalid entries', () => {
  assert.deepEqual(
    normalizeLaunchProfiles([
      { id: 'codex', name: ' Codex ', command: ' codex ' },
      { id: 'codex', name: 'Duplicate', command: 'duplicate' },
      { id: 'broken', name: 'Broken\nProfile', command: 'ignored' },
    ]),
    [{ id: 'codex', name: 'Codex', command: 'codex' }]
  );
});
