import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, expect, test, vi } from 'vitest';
import TerminalInputDock from './TerminalInputDock.svelte';

function renderDock(submit = vi.fn(() => true), workspaceId = 'workspace-1') {
  const handoffToTerminal = vi.fn();
  const send = vi.fn();
  const scrollPageUp = vi.fn();
  const scrollPageDown = vi.fn();
  return {
    submit,
    send,
    handoffToTerminal,
    scrollPageUp,
    scrollPageDown,
    result: render(TerminalInputDock, {
      workspaceId,
      connected: true,
      send,
      submit,
      handoffToTerminal,
      onImageSelected: vi.fn(),
      scrollPageUp,
      scrollPageDown,
      scrollToTop: vi.fn(),
      scrollToBottom: vi.fn(),
      fontSize: 14,
      minimumFontSize: 10,
      maximumFontSize: 22,
      decreaseFontSize: vi.fn(),
      increaseFontSize: vi.fn(),
    }),
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

test('keeps Shift+Enter as a composer line break without submitting', async () => {
  const { submit } = renderDock();
  const composer = screen.getByPlaceholderText('Send to shell…');
  await fireEvent.input(composer, { target: { value: 'First line' } });
  await fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true });

  expect(composer).toHaveValue('First line\n');
  expect(submit).not.toHaveBeenCalled();
});

test('hands an initial slash to the interactive terminal without changing the draft', async () => {
  const { handoffToTerminal, submit } = renderDock();
  const composer = screen.getByPlaceholderText('Send to shell…');
  await fireEvent.keyDown(composer, { key: '/' });

  expect(handoffToTerminal).toHaveBeenCalledWith('/');
  expect(composer).toHaveValue('');
  expect(submit).not.toHaveBeenCalled();
});

test('moves through terminal history one page at a time', async () => {
  const { scrollPageUp, scrollPageDown } = renderDock();

  await fireEvent.click(screen.getByRole('button', { name: 'Scroll terminal up one page' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Scroll terminal down one page' }));

  expect(scrollPageUp).toHaveBeenCalledOnce();
  expect(scrollPageDown).toHaveBeenCalledOnce();
});

test('restores an unsent composer draft after remounting the terminal', async () => {
  const first = renderDock();
  const composer = screen.getByPlaceholderText('Send to shell…');
  await fireEvent.input(composer, { target: { value: 'Unsent 한글 draft' } });
  first.result.unmount();

  renderDock();
  await waitFor(() => expect(screen.getByPlaceholderText('Send to shell…')).toHaveValue('Unsent 한글 draft'));
});

test('isolates drafts by workspace and clears one only after a successful submit', async () => {
  const rejectedSubmit = vi.fn(() => false);
  const first = renderDock(rejectedSubmit);
  const composer = screen.getByPlaceholderText('Send to shell…');
  await fireEvent.input(composer, { target: { value: 'Keep this draft' } });
  await fireEvent.keyDown(composer, { key: 'Enter' });
  expect(rejectedSubmit).toHaveBeenCalledWith('Keep this draft');
  expect(composer).toHaveValue('Keep this draft');
  first.result.unmount();

  const other = renderDock(
    vi.fn(() => true),
    'workspace-2'
  );
  await waitFor(() => expect(screen.getByPlaceholderText('Send to shell…')).toHaveValue(''));
  other.result.unmount();

  const acceptedSubmit = vi.fn(() => true);
  const restored = renderDock(acceptedSubmit);
  const restoredComposer = await screen.findByPlaceholderText('Send to shell…');
  await waitFor(() => expect(restoredComposer).toHaveValue('Keep this draft'));
  await fireEvent.keyDown(restoredComposer, { key: 'Enter' });
  expect(acceptedSubmit).toHaveBeenCalledWith('Keep this draft');
  expect(restoredComposer).toHaveValue('');
  restored.result.unmount();

  renderDock();
  await waitFor(() => expect(screen.getByPlaceholderText('Send to shell…')).toHaveValue(''));
});
