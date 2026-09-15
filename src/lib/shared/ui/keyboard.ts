const APPLE_USER_AGENT = /\b(?:Macintosh|iPhone|iPad|iPod)\b/u;

type ShortcutModifierEvent = {
  ctrlKey: boolean;
  metaKey: boolean;
};

export function usesCommandKeyForShortcuts(userAgent = navigator.userAgent): boolean {
  return APPLE_USER_AGENT.test(userAgent);
}

export function hasPrimaryShortcutModifier(
  event: ShortcutModifierEvent,
  commandKey = usesCommandKeyForShortcuts(),
): boolean {
  return commandKey ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}
