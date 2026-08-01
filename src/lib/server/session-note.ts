export const SESSION_NOTE_PREVIEW_MAX_LENGTH = 160;

export function createSessionNotePreview(note: string): string {
	const firstLine = note
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean) ?? '';
	const preview = firstLine.replace(/\s+/g, ' ');
	if (Array.from(preview).length <= SESSION_NOTE_PREVIEW_MAX_LENGTH) return preview;
	return `${Array.from(preview).slice(0, SESSION_NOTE_PREVIEW_MAX_LENGTH - 1).join('')}…`;
}
