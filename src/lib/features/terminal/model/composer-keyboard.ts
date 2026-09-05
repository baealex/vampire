type ComposerKeyboardEvent = Pick<
  KeyboardEvent,
  'altKey' | 'code' | 'ctrlKey' | 'isComposing' | 'keyCode' | 'metaKey' | 'repeat' | 'shiftKey'
> & { getModifierState?: (key: string) => boolean };

export type ComposerKeyboardCommand =
  | 'history'
  | 'preview-template'
  | 'toggle-template'
  | 'restore-submission'
  | 'insert-slash';

export function composerKeyboardCommand(event: ComposerKeyboardEvent): ComposerKeyboardCommand | undefined {
  if (
    event.repeat ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.metaKey ||
    event.getModifierState?.('AltGraph')
  )
    return undefined;

  if (event.ctrlKey && event.altKey && !event.shiftKey) {
    if (event.code === 'KeyH') return 'history';
    if (event.code === 'KeyP') return 'preview-template';
    if (event.code === 'KeyB') return 'toggle-template';
    if (event.code === 'KeyR') return 'restore-submission';
  }

  if (event.ctrlKey && !event.shiftKey && !event.altKey && event.code === 'Slash') {
    return 'insert-slash';
  }

  return undefined;
}
