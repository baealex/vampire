import assert from 'node:assert/strict';
import test from 'node:test';
import {
	createSessionNotePreview,
	normalizeSessionNote,
	sessionNoteByteLength,
	SESSION_NOTE_PREVIEW_MAX_LENGTH
} from '../src/lib/server/session-note.ts';

test('uses the first non-empty line as the session note preview', () => {
	assert.equal(createSessionNotePreview('\n  Fix the adapter origin  \nSecond line'), 'Fix the adapter origin');
	assert.equal(createSessionNotePreview('One\t two   three'), 'One two three');
});

test('truncates long previews without splitting a unicode character', () => {
	const preview = createSessionNotePreview('가'.repeat(SESSION_NOTE_PREVIEW_MAX_LENGTH + 20));
	assert.equal(Array.from(preview).length, SESSION_NOTE_PREVIEW_MAX_LENGTH);
	assert.equal(preview.endsWith('…'), true);
});

test('uses the first plain line for the workspace preview', () => {
	assert.equal(
		createSessionNotePreview('## 완료\n\n- Verify the updated prompt\n\n## 다음\n\n- Run the tests'),
		'Verify the updated prompt'
	);
	assert.equal(createSessionNotePreview('Current state and the immediate next action'), 'Current state and the immediate next action');
});

test('does not truncate note content and measures its UTF-8 size', () => {
	const note = '가'.repeat(5_000);
	assert.equal(normalizeSessionNote(`  ${note}  `), note);
	assert.equal(sessionNoteByteLength('가'), 3);
});
