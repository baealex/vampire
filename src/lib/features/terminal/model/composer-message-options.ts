const COMPOSER_MESSAGE_OPTIONS_STORAGE_PREFIX = 'vampire:terminal-composer-message-options:v1';

type ComposerMessageOptionsStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>;

function composerMessageOptionsStorageKey(workspaceId: string, terminalId?: string): string {
  return `${COMPOSER_MESSAGE_OPTIONS_STORAGE_PREFIX}:${encodeURIComponent(workspaceId)}:${encodeURIComponent(terminalId ?? 'main')}`;
}

export function loadComposerTemplateBypass(
  workspaceId: string,
  terminalId?: string,
  storage?: ComposerMessageOptionsStorage
): { value: boolean; available: boolean } {
  try {
    const targetStorage = storage ?? window.localStorage;
    return {
      value: targetStorage.getItem(composerMessageOptionsStorageKey(workspaceId, terminalId)) === 'bypass-template',
      available: true,
    };
  } catch {
    return { value: false, available: false };
  }
}

export function saveComposerTemplateBypass(
  workspaceId: string,
  terminalId: string | undefined,
  bypassed: boolean,
  storage?: ComposerMessageOptionsStorage
): boolean {
  try {
    const targetStorage = storage ?? window.localStorage;
    const key = composerMessageOptionsStorageKey(workspaceId, terminalId);
    if (bypassed) targetStorage.setItem(key, 'bypass-template');
    else targetStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
