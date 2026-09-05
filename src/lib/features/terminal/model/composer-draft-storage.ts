const COMPOSER_DRAFT_STORAGE_PREFIX = 'vampire:terminal-composer-draft:v1';

type ComposerDraftStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>;

function composerDraftStorageKey(workspaceId: string, terminalId?: string): string {
  return `${COMPOSER_DRAFT_STORAGE_PREFIX}:${encodeURIComponent(workspaceId)}:${encodeURIComponent(terminalId ?? 'main')}`;
}

export function loadComposerDraft(
  workspaceId: string,
  terminalId?: string,
  storage?: ComposerDraftStorage
): { value: string; available: boolean } {
  try {
    return {
      value: (storage ?? window.localStorage).getItem(composerDraftStorageKey(workspaceId, terminalId)) ?? '',
      available: true,
    };
  } catch {
    return { value: '', available: false };
  }
}

export function saveComposerDraft(
  workspaceId: string,
  terminalId: string | undefined,
  value: string,
  storage?: ComposerDraftStorage
): boolean {
  try {
    const target = storage ?? window.localStorage;
    const key = composerDraftStorageKey(workspaceId, terminalId);
    if (value) target.setItem(key, value);
    else target.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
