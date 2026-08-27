export const WORKSPACE_NOTE_MAX_BYTES = 128 * 1024;
export const WORKSPACE_NOTE_PREVIEW_MAX_LENGTH = 160;

export function normalizeWorkspaceNote(note: string): string {
  return note.trim();
}

export function workspaceNoteByteLength(note: string): number {
  return Buffer.byteLength(note, 'utf8');
}

export function createWorkspaceNotePreview(note: string): string {
  const lines = note.split(/\r?\n/).map((line) => line.trim());
  const firstLine = lines.find((line) => line && !/^#{1,6}\s/.test(line)) ?? '';
  const preview = firstLine.replace(/^[-*+]\s+/, '').replace(/\s+/g, ' ');
  if (Array.from(preview).length <= WORKSPACE_NOTE_PREVIEW_MAX_LENGTH) return preview;
  return `${Array.from(preview)
    .slice(0, WORKSPACE_NOTE_PREVIEW_MAX_LENGTH - 1)
    .join('')}…`;
}
