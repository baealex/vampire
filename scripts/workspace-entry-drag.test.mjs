import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWorkspaceEntryDrag, workspaceEntryDragText } from '../src/lib/workspace-entry-drag.mjs';

test('formats workspace file and folder paths for shell input', () => {
	assert.equal(workspaceEntryDragText({ path: 'src/app.ts', kind: 'file' }), 'src/app.ts');
	assert.equal(workspaceEntryDragText({ path: 'src/lib', kind: 'directory' }), 'src/lib/');
	assert.equal(workspaceEntryDragText({ path: 'docs/my file.md', kind: 'file' }), "'docs/my file.md'");
	assert.equal(workspaceEntryDragText({ path: "docs/owner's.md", kind: 'file' }), "'docs/owner'\\''s.md'");
});

test('accepts only safe workspace drag payloads', () => {
	assert.deepEqual(parseWorkspaceEntryDrag('{"path":"src/app.ts","kind":"file"}'), { path: 'src/app.ts', kind: 'file' });
	assert.deepEqual(parseWorkspaceEntryDrag('{"path":"src/lib","kind":"directory"}'), { path: 'src/lib', kind: 'directory' });
	assert.equal(parseWorkspaceEntryDrag('{"path":"../secret","kind":"file"}'), undefined);
	assert.equal(parseWorkspaceEntryDrag('{"path":"/tmp/secret","kind":"file"}'), undefined);
	assert.equal(parseWorkspaceEntryDrag('{"path":"src/app.ts","kind":"unknown"}'), undefined);
});
