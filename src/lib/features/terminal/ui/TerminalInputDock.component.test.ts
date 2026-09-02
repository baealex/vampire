import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, expect, test, vi } from 'vitest';
import { terminalInputPreferences } from '../model/input-preferences.svelte.ts';
import { DEFAULT_TERMINAL_INPUT_SETTINGS } from '~/lib/shared/contracts/terminal-input.ts';
import TerminalInputDock from './TerminalInputDock.svelte';

function renderDock(submit = vi.fn(() => true), workspaceId = 'workspace-1', composerTemplate = '{{ prompts }}') {
  const handoffToTerminal = vi.fn();
  const send = vi.fn();
  const scrollPageUp = vi.fn();
  const scrollPageDown = vi.fn();
  const onSubmitted = vi.fn(async () => undefined);
  const loadPrompts = vi.fn(async () => [
    { id: 'prompt-2', text: 'Review the automation queue', submittedAt: 2 },
    { id: 'prompt-1', text: 'Check the current tests', submittedAt: 1 },
  ]);
  return {
    submit,
    send,
    handoffToTerminal,
    scrollPageUp,
    scrollPageDown,
    onSubmitted,
    loadPrompts,
    result: render(TerminalInputDock, {
      workspaceId,
      connected: true,
      composerTemplate,
      composerTemplateContext: { workspace: { name: 'Vampire', cwd: '/work/vampire' } },
      send,
      submit,
      onSubmitted,
      loadPrompts,
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
  terminalInputPreferences.apply(DEFAULT_TERMINAL_INPUT_SETTINGS);
});

test('opens exact workspace Composer history and inserts a selected prompt without sending it', async () => {
  const { submit } = renderDock();

  expect(screen.queryByText('Review the automation queue')).not.toBeInTheDocument();
  await fireEvent.click(screen.getByRole('button', { name: 'Open Composer history' }));
  expect(await screen.findByText('Review the automation queue')).toBeInTheDocument();
  await fireEvent.click(await screen.findByRole('button', { name: /Check the current tests/ }));

  expect(screen.getByLabelText('Send text to the shell')).toHaveValue('Check the current tests');
  expect(submit).not.toHaveBeenCalled();
});

test('records exact Composer text only after terminal submission succeeds', async () => {
  const { submit, onSubmitted } = renderDock();
  const composer = screen.getByLabelText('Send text to the shell');
  await fireEvent.input(composer, { target: { value: 'Continue the current work' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Send to shell' }));

  expect(submit).toHaveBeenCalledWith('Continue the current work');
  await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith('Continue the current work'));
  expect(composer).toHaveValue('');
});

test('applies the workspace template only to the terminal submission', async () => {
  const { submit, onSubmitted } = renderDock(
    vi.fn(() => true),
    'workspace-1',
    'Workspace: {{ workspace.name }}\n\n{{ prompts }}\n\nVerify before replying.'
  );
  const composer = screen.getByLabelText('Send text to the shell');
  await fireEvent.input(composer, { target: { value: 'Implement the request' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Send to shell' }));

  expect(submit).toHaveBeenCalledWith('Workspace: Vampire\n\nImplement the request\n\nVerify before replying.');
  await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith('Implement the request'));
});

test('sends the original message when a stored workspace template is invalid', async () => {
  const { submit } = renderDock(
    vi.fn(() => true),
    'workspace-1',
    'Prompt was accidentally removed'
  );
  const composer = screen.getByLabelText('Send text to the shell');
  await fireEvent.input(composer, { target: { value: 'Do not lose this message' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Send to shell' }));

  expect(submit).toHaveBeenCalledWith('Do not lose this message');
  expect(await screen.findByText(/original message was sent/i)).toBeVisible();
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
