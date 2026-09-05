const COMPOSER_DRAFT_STORAGE_PREFIX = 'vampire:terminal-composer-draft:v1';

type ComposerDraftStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>;

function composerDraftStorageKey(workspaceId: string, terminalId?: string): string {
  return `${COMPOSER_DRAFT_STORAGE_PREFIX}:${encodeURIComponent(workspaceId)}:${encodeURIComponent(terminalId ?? 'main')}`;
}

export function loadComposerDraft(
  workspaceId: string,
  terminalId?: string,
  storage: ComposerDraftStorage = window.localStorage
): { value: string; available: boolean } {
  try {
    return { value: storage.getItem(composerDraftStorageKey(workspaceId, terminalId)) ?? '', available: true };
  } catch {
    return { value: '', available: false };
  }
}

export function saveComposerDraft(
  workspaceId: string,
  terminalId: string | undefined,
  value: string,
  storage: ComposerDraftStorage = window.localStorage
): boolean {
  try {
    const key = composerDraftStorageKey(workspaceId, terminalId);
    if (value) storage.setItem(key, value);
    else storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
