export type TerminalControlKey =
  | 'escape'
  | 'interrupt'
  | 'tab'
  | 'backspace'
  | 'enter'
  | 'arrow-up'
  | 'arrow-down'
  | 'arrow-left'
  | 'arrow-right';

type TerminalShortcutEvent = Pick<
  KeyboardEvent,
  'altKey' | 'code' | 'ctrlKey' | 'isComposing' | 'metaKey' | 'repeat' | 'shiftKey'
>;

const FIXED_CONTROL_DATA: Partial<Record<TerminalControlKey, string>> = {
  escape: '\u001b',
  interrupt: '\u0003',
  tab: '\t',
  backspace: '\u007f',
  enter: '\r',
};

const CURSOR_SUFFIX: Partial<Record<TerminalControlKey, string>> = {
  'arrow-up': 'A',
  'arrow-down': 'B',
  'arrow-right': 'C',
  'arrow-left': 'D',
};

export function terminalControlData(control: TerminalControlKey, applicationCursorKeysMode: boolean): string {
  const fixed = FIXED_CONTROL_DATA[control];
  if (fixed !== undefined) return fixed;

  const suffix = CURSOR_SUFFIX[control];
  if (!suffix) throw new Error(`Unsupported terminal control: ${control}`);
  return `\u001b${applicationCursorKeysMode ? 'O' : '['}${suffix}`;
}

export function isInputSurfaceToggleShortcut(event: TerminalShortcutEvent): boolean {
  if (event.repeat || event.isComposing || event.altKey || event.shiftKey) return false;
  return (
    (event.code === 'Slash' && event.metaKey && !event.ctrlKey) ||
    (event.code === 'Backquote' && event.ctrlKey && !event.metaKey)
  );
}

/** @deprecated Use isInputSurfaceToggleShortcut for the bidirectional input switch. */
export function isComposeFocusShortcut(event: TerminalShortcutEvent): boolean {
  return isInputSurfaceToggleShortcut(event);
}
