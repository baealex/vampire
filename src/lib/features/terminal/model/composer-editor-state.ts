export type ComposerSelectionDirection = 'forward' | 'backward' | 'none';

export interface ComposerEditorState {
  selectionStart: number;
  selectionEnd: number;
  selectionDirection?: ComposerSelectionDirection;
  scrollTop: number;
}

const COMPOSER_EDITOR_STATE_STORAGE_PREFIX = 'vampire:terminal-composer-editor-state:v1';

type ComposerEditorStateStorage = Pick<Storage, 'getItem' | 'setItem'>;

function composerEditorStateStorageKey(workspaceId: string, terminalId?: string): string {
  return `${COMPOSER_EDITOR_STATE_STORAGE_PREFIX}:${encodeURIComponent(workspaceId)}:${encodeURIComponent(terminalId ?? 'main')}`;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isSelectionDirection(value: unknown): value is ComposerSelectionDirection {
  return value === 'forward' || value === 'backward' || value === 'none';
}

function parseComposerEditorState(value: string | null): ComposerEditorState | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (
    !isNonNegativeInteger(candidate.selectionStart) ||
    !isNonNegativeInteger(candidate.selectionEnd) ||
    candidate.selectionStart > candidate.selectionEnd ||
    typeof candidate.scrollTop !== 'number' ||
    !Number.isFinite(candidate.scrollTop) ||
    candidate.scrollTop < 0 ||
    (candidate.selectionDirection !== undefined && !isSelectionDirection(candidate.selectionDirection))
  )
    return undefined;

  return {
    selectionStart: candidate.selectionStart,
    selectionEnd: candidate.selectionEnd,
    selectionDirection: candidate.selectionDirection,
    scrollTop: candidate.scrollTop,
  };
}

export function loadComposerEditorState(
  workspaceId: string,
  terminalId?: string,
  storage?: ComposerEditorStateStorage
): { value: ComposerEditorState | undefined; available: boolean } {
  try {
    return {
      value: parseComposerEditorState(
        (storage ?? window.localStorage).getItem(composerEditorStateStorageKey(workspaceId, terminalId))
      ),
      available: true,
    };
  } catch {
    return { value: undefined, available: false };
  }
}

export function saveComposerEditorState(
  workspaceId: string,
  terminalId: string | undefined,
  value: ComposerEditorState,
  storage?: ComposerEditorStateStorage
): boolean {
  try {
    (storage ?? window.localStorage).setItem(
      composerEditorStateStorageKey(workspaceId, terminalId),
      JSON.stringify(value)
    );
    return true;
  } catch {
    return false;
  }
}

export function captureComposerEditorState(element: HTMLTextAreaElement): ComposerEditorState {
  const direction = element.selectionDirection;
  return {
    selectionStart: element.selectionStart,
    selectionEnd: element.selectionEnd,
    selectionDirection: isSelectionDirection(direction) ? direction : undefined,
    scrollTop: Math.max(0, element.scrollTop),
  };
}

export function normalizeComposerEditorState(value: ComposerEditorState, textLength: number): ComposerEditorState {
  const maximum = Math.max(0, Math.trunc(textLength));
  const selectionStart = Math.min(value.selectionStart, maximum);
  const selectionEnd = Math.max(selectionStart, Math.min(value.selectionEnd, maximum));
  return { ...value, selectionStart, selectionEnd, scrollTop: Math.max(0, value.scrollTop) };
}

export function restoreComposerEditorState(
  element: HTMLTextAreaElement,
  value: ComposerEditorState
): ComposerEditorState {
  const restored = normalizeComposerEditorState(value, element.value.length);
  element.setSelectionRange(restored.selectionStart, restored.selectionEnd, restored.selectionDirection);
  element.scrollTop = restored.scrollTop;
  return restored;
}
