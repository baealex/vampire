export function isUiOverlayOpen(root: ParentNode = document): boolean {
  return Boolean(root.querySelector('[data-vampire-overlay]'));
}

const textEntrySelector = [
  'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="file"]):not(:disabled)',
  'textarea:not(:disabled)',
  'select:not(:disabled)',
].join(',');
const inputSelector = 'input:not([type="hidden"]):not(:disabled)';

export function focusFirstOverlayInput(content: HTMLElement | null, event: Event): void {
  if (!content) return;

  const target =
    content.querySelector<HTMLElement>(textEntrySelector) ?? content.querySelector<HTMLElement>(inputSelector);
  if (!target) return;

  event.preventDefault();
  target.focus();
}
