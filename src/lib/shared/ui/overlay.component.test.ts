import { expect, test } from 'vitest';
import { focusFirstOverlayInput } from './overlay.ts';

test('focuses the first text entry control before other inputs', () => {
  const content = document.createElement('div');
  content.innerHTML = `
    <button type="button">Close</button>
    <input type="radio" name="choice">
    <input aria-label="Name" type="text">
  `;
  document.body.append(content);

  const event = new Event('focusScope.onOpenAutoFocus', { cancelable: true });
  focusFirstOverlayInput(content, event);

  expect(document.activeElement).toBe(content.querySelector('input[type="text"]'));
  expect(event.defaultPrevented).toBe(true);

  content.remove();
});

test('keeps the default focus behavior when an overlay has no input', () => {
  const content = document.createElement('div');
  content.innerHTML = '<button type="button">Close</button>';

  const event = new Event('focusScope.onOpenAutoFocus', { cancelable: true });
  focusFirstOverlayInput(content, event);

  expect(event.defaultPrevented).toBe(false);
});
