interface TouchScrollableTerminal {
  rows: number;
  element?: HTMLElement;
  clearSelection(): void;
  scrollLines(amount: number): void;
}

type TerminalTouchScrollOptions = {
  onScrollAttempt?: (lines: number) => void;
  onScrollStart?: () => void;
  onTap?: () => void;
  useNativeInteraction?: () => boolean;
};

const SCROLL_INTENT_THRESHOLD_PX = 8;
const COMPATIBILITY_MOUSE_SUPPRESSION_MS = 500;

export function installTerminalTouchScroll(
  element: HTMLElement,
  getTerminal: () => TouchScrollableTerminal | undefined,
  options: TerminalTouchScrollOptions = {}
): () => void {
  let pointerId: number | undefined;
  let startY = 0;
  let lastY = 0;
  let rowHeight = 0;
  let remainder = 0;
  let scrolling = false;
  let suppressCompatibilityMouseUntil = 0;

  const isScrollbar = (target: EventTarget | null) =>
    target instanceof Element && Boolean(target.closest('.xterm-scrollable-element .scrollbar'));

  const reset = () => {
    pointerId = undefined;
    startY = 0;
    lastY = 0;
    rowHeight = 0;
    remainder = 0;
    scrolling = false;
  };

  const measureRowHeight = () => {
    const terminal = getTerminal();
    if (!terminal || terminal.rows <= 0) return 0;
    const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
    const height = screen?.getBoundingClientRect().height || element.clientHeight;
    return height / terminal.rows;
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' || !event.isPrimary || isScrollbar(event.target)) return;
    if (options.useNativeInteraction?.()) return;
    // xterm focuses its hidden textarea from the compatibility mousedown that
    // follows a touch pointerdown. Suppress that synthetic mouse event so the
    // visible mobile composer remains the sole IME owner. Pointer events keep
    // flowing, so the custom terminal scroll gesture still works normally.
    event.preventDefault();
    pointerId = event.pointerId;
    startY = event.clientY;
    lastY = event.clientY;
    rowHeight = measureRowHeight();
    remainder = 0;
  };

  const handlePointerMove = (event: PointerEvent) => {
    const terminal = getTerminal();
    if (event.pointerType !== 'touch' || !event.isPrimary || event.pointerId !== pointerId || !terminal) return;
    if (rowHeight <= 0) rowHeight = measureRowHeight();
    if (rowHeight <= 0) return;
    remainder += lastY - event.clientY;
    lastY = event.clientY;
    if (!scrolling) {
      if (Math.abs(startY - event.clientY) < SCROLL_INTENT_THRESHOLD_PX) return;
      scrolling = true;
      element.setPointerCapture(event.pointerId);
      terminal.clearSelection();
      options.onScrollStart?.();
    }
    const lines = Math.trunc(remainder / rowHeight);
    if (lines !== 0) {
      remainder -= lines * rowHeight;
      options.onScrollAttempt?.(lines);
      terminal.scrollLines(lines);
    }
    event.preventDefault();
  };

  const finishPointer = (event: PointerEvent, allowTap: boolean) => {
    if (event.pointerId !== pointerId) return;
    const wasScrolling = scrolling;
    if (wasScrolling) suppressCompatibilityMouseUntil = Date.now() + COMPATIBILITY_MOUSE_SUPPRESSION_MS;
    reset();
    if (allowTap && !wasScrolling) options.onTap?.();
  };
  const handlePointerUp = (event: PointerEvent) => finishPointer(event, true);
  const handlePointerCancel = (event: PointerEvent) => finishPointer(event, false);
  const handleLostPointerCapture = (event: PointerEvent) => {
    if (event.target === element) finishPointer(event, false);
  };

  const suppressCompatibilityMouse = (event: MouseEvent) => {
    if (Date.now() > suppressCompatibilityMouseUntil) return;
    event.preventDefault();
    event.stopPropagation();
  };

  element.addEventListener('pointerdown', handlePointerDown);
  element.addEventListener('pointermove', handlePointerMove);
  element.addEventListener('pointerup', handlePointerUp);
  element.addEventListener('pointercancel', handlePointerCancel);
  element.addEventListener('lostpointercapture', handleLostPointerCapture);
  element.addEventListener('mousedown', suppressCompatibilityMouse, true);
  element.addEventListener('click', suppressCompatibilityMouse, true);

  return () => {
    element.removeEventListener('pointerdown', handlePointerDown);
    element.removeEventListener('pointermove', handlePointerMove);
    element.removeEventListener('pointerup', handlePointerUp);
    element.removeEventListener('pointercancel', handlePointerCancel);
    element.removeEventListener('lostpointercapture', handleLostPointerCapture);
    element.removeEventListener('mousedown', suppressCompatibilityMouse, true);
    element.removeEventListener('click', suppressCompatibilityMouse, true);
    reset();
  };
}
