import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseWorkspaceEntryDrag,
  parseWorkspaceEntryDragEntries,
  workspaceEntryCanMoveToDirectory,
  workspaceEntryDragText,
} from '~/lib/shared/lib/workspace-entry-drag.ts';

test('formats workspace file and folder paths for shell input', () => {
  assert.equal(workspaceEntryDragText({ path: 'src/app.ts', kind: 'file' }), 'src/app.ts');
  assert.equal(workspaceEntryDragText({ path: 'src/lib', kind: 'directory' }), 'src/lib/');
  assert.equal(workspaceEntryDragText({ path: 'docs/my file.md', kind: 'file' }), "'docs/my file.md'");
  assert.equal(workspaceEntryDragText({ path: "docs/owner's.md", kind: 'file' }), "'docs/owner'\\''s.md'");
});

test('accepts only safe workspace drag payloads', () => {
  assert.deepEqual(parseWorkspaceEntryDrag('{"path":"src/app.ts","kind":"file"}'), {
    path: 'src/app.ts',
    kind: 'file',
  });
  assert.deepEqual(parseWorkspaceEntryDrag('{"path":"src/lib","kind":"directory"}'), {
    path: 'src/lib',
    kind: 'directory',
  });
  assert.equal(parseWorkspaceEntryDrag('{"path":"../secret","kind":"file"}'), undefined);
  assert.equal(parseWorkspaceEntryDrag('{"path":"/tmp/secret","kind":"file"}'), undefined);
  assert.equal(parseWorkspaceEntryDrag('{"path":"src/app.ts","kind":"unknown"}'), undefined);
});

test('parses multi-entry drags while keeping legacy single-entry payloads compatible', () => {
  assert.deepEqual(
    parseWorkspaceEntryDragEntries(
      '{"entries":[{"path":"src/app.ts","kind":"file"},{"path":"docs","kind":"directory"}]}'
    ),
    [
      { path: 'src/app.ts', kind: 'file' },
      { path: 'docs', kind: 'directory' },
    ]
  );
  assert.deepEqual(parseWorkspaceEntryDragEntries('{"path":"src/app.ts","kind":"file"}'), [
    { path: 'src/app.ts', kind: 'file' },
  ]);
  assert.equal(parseWorkspaceEntryDragEntries('{"entries":[{"path":"../secret","kind":"file"}]}'), undefined);
});

test('moves entries only to a different directory outside their own descendants', () => {
  assert.equal(workspaceEntryCanMoveToDirectory({ path: 'src/app.ts', kind: 'file' }, ''), true);
  assert.equal(workspaceEntryCanMoveToDirectory({ path: 'src/app.ts', kind: 'file' }, 'src'), false);
  assert.equal(workspaceEntryCanMoveToDirectory({ path: 'src/lib', kind: 'directory' }, 'src/lib'), false);
  assert.equal(workspaceEntryCanMoveToDirectory({ path: 'src/lib', kind: 'directory' }, 'src/lib/nested'), false);
  assert.equal(workspaceEntryCanMoveToDirectory({ path: 'src/lib', kind: 'directory' }, 'packages'), true);
});
