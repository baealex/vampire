import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionNotePreview, SESSION_NOTE_PREVIEW_MAX_LENGTH } from '../src/lib/server/session-note.mjs';

test('uses the first non-empty line as the session note preview', () => {
	assert.equal(createSessionNotePreview('\n  Fix the adapter origin  \nSecond line'), 'Fix the adapter origin');
	assert.equal(createSessionNotePreview('One\t two   three'), 'One two three');
});

test('truncates long previews without splitting a unicode character', () => {
	const preview = createSessionNotePreview('가'.repeat(SESSION_NOTE_PREVIEW_MAX_LENGTH + 20));
	assert.equal(Array.from(preview).length, SESSION_NOTE_PREVIEW_MAX_LENGTH);
	assert.equal(preview.endsWith('…'), true);
});
