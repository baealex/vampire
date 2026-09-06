import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { loadComposerDraft } from '../model/composer-draft-storage.ts';
import type { RecoverableComposerSubmission } from '../model/composer-submission.ts';
import TerminalInputDock from './TerminalInputDock.svelte';

function renderDock(
  submit = vi.fn(() => true),
  workspaceId = 'workspace-1',
  composerTemplate = '{{ prompts }}',
  options: {
    handoffSucceeds?: boolean;
    composerHistoryEnabled?: boolean;
    recoverableSubmissions?: RecoverableComposerSubmission[];
  } = {}
) {
  const handoffToTerminal = vi.fn(() => options.handoffSucceeds ?? true);
  const onToggleInputSurface = vi.fn();
  const onDismissSubmission = vi.fn();
  const sendControl = vi.fn();
  const scrollPageUp = vi.fn();
  const scrollPageDown = vi.fn();
  const onSubmitted = vi.fn(async () => undefined);
  const loadPrompts = vi.fn(async () => [
    { id: 'prompt-2', text: 'Review the automation queue', submittedAt: 2 },
    { id: 'prompt-1', text: 'Check the current tests', submittedAt: 1 },
  ]);
  return {
    submit,
    sendControl,
    handoffToTerminal,
    onToggleInputSurface,
    onDismissSubmission,
    scrollPageUp,
    scrollPageDown,
    onSubmitted,
    loadPrompts,
    result: render(TerminalInputDock, {
      workspaceId,
      connected: true,
      composerTemplate,
      composerTemplateContext: { workspace: { name: 'Vampire', cwd: '/work/vampire' } },
      sendControl,
      submit,
      onSubmitted,
      loadPrompts,
      handoffToTerminal,
      onToggleInputSurface,
      composerHistoryEnabled: options.composerHistoryEnabled,
      recoverableSubmissions: options.recoverableSubmissions,
      onDismissSubmission,
      onImageSelected: vi.fn(),
      scrollPageUp,
      scrollPageDown,
      scrollToTop: vi.fn(),
      scrollToBottom: vi.fn(),
    }),
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

test('opens exact workspace Composer history and inserts a selected prompt without sending it', async () => {
  const { submit } = renderDock();

  expect(screen.queryByText('Review the automation queue')).not.toBeInTheDocument();
  await fireEvent.click(screen.getByRole('button', { name: 'Open Composer history' }));
  expect(await screen.findByText('Review the automation queue')).toBeInTheDocument();
  await fireEvent.click(await screen.findByRole('option', { name: /Check the current tests/ }));

  expect(screen.getByLabelText('Send text to the shell')).toHaveValue('Check the current tests');
  expect(submit).not.toHaveBeenCalled();
});

test('records exact Composer text only after terminal submission succeeds', async () => {
  const { submit, onSubmitted } = renderDock();
  const composer = screen.getByLabelText('Send text to the shell');
  await fireEvent.input(composer, { target: { value: 'Continue the current work' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Send to shell' }));

  expect(submit).toHaveBeenCalledWith('Continue the current work', 'Continue the current work');
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

  expect(submit).toHaveBeenCalledWith(
    'Workspace: Vampire\n\nImplement the request\n\nVerify before replying.',
    'Implement the request'
  );
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

  expect(submit).toHaveBeenCalledWith('Do not lose this message', 'Do not lose this message');
  expect(await screen.findByText(/original message was sent/i)).toBeVisible();
});

test('keeps Shift+Enter as a composer line break without submitting', async () => {
  const { submit } = renderDock();
  const composer = screen.getByPlaceholderText('Compose a message…') as HTMLTextAreaElement;
  await fireEvent.input(composer, { target: { value: 'First line' } });
  const user = userEvent.setup();
  composer.focus();
  composer.setSelectionRange(composer.value.length, composer.value.length);
  await user.keyboard('{Shift>}{Enter}{/Shift}');

  expect(composer).toHaveValue('First line\n');
  expect(submit).not.toHaveBeenCalled();
});

test('retains a whitespace-only draft without submitting or forwarding Enter', async () => {
  const { sendControl, submit, onSubmitted } = renderDock();
  const composer = screen.getByPlaceholderText('Compose a message…');
  await fireEvent.input(composer, { target: { value: '  ' } });
  await fireEvent.keyDown(composer, { key: 'Enter' });

  expect(sendControl).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  expect(onSubmitted).not.toHaveBeenCalled();
  expect(composer).toHaveValue('  ');
});

test('sends Enter directly to the terminal only when Compose is exactly empty', async () => {
  const { sendControl, submit } = renderDock();
  const composer = screen.getByPlaceholderText('Compose a message…');
  await fireEvent.keyDown(composer, { key: 'Enter' });

  expect(sendControl).toHaveBeenCalledWith('enter');
  expect(submit).not.toHaveBeenCalled();
});

test('forwards terminal navigation keys only while Compose is empty', async () => {
  const { sendControl } = renderDock();
  const composer = screen.getByPlaceholderText('Compose a message…');

  await fireEvent.keyDown(composer, { key: 'ArrowDown' });
  await fireEvent.keyDown(composer, { key: 'Escape' });
  await fireEvent.keyDown(composer, { key: 'Backspace' });
  expect(sendControl).toHaveBeenNthCalledWith(1, 'arrow-down');
  expect(sendControl).toHaveBeenNthCalledWith(2, 'escape');
  expect(sendControl).toHaveBeenNthCalledWith(3, 'backspace');

  await fireEvent.input(composer, { target: { value: 'Draft in progress' } });
  await fireEvent.keyDown(composer, { key: 'ArrowDown' });
  await fireEvent.keyDown(composer, { key: 'Escape' });
  await fireEvent.keyDown(composer, { key: 'Backspace' });
  await fireEvent.keyDown(composer, { key: 'Backspace', isComposing: true });
  expect(sendControl).toHaveBeenCalledTimes(3);
  expect(composer).toHaveValue('Draft in progress');
});

test('hands an initial slash to the interactive terminal without changing the draft', async () => {
  const { handoffToTerminal, submit } = renderDock();
  const composer = screen.getByPlaceholderText('Compose a message…');
  await fireEvent.keyDown(composer, { key: '/' });

  expect(handoffToTerminal).toHaveBeenCalledWith('/');
  expect(composer).toHaveValue('');
  expect(submit).not.toHaveBeenCalled();
});

test('keeps an initial slash in Compose when the terminal cannot accept input', async () => {
  const user = userEvent.setup();
  const { handoffToTerminal } = renderDock(
    vi.fn(() => true),
    'workspace-1',
    '{{ prompts }}',
    { handoffSucceeds: false }
  );
  const composer = screen.getByPlaceholderText('Compose a message…');
  composer.focus();

  await user.keyboard('/');

  expect(handoffToTerminal).toHaveBeenCalledWith('/');
  expect(composer).toHaveValue('/');
  expect(composer).toHaveFocus();
});

test('inserts a literal initial slash with Ctrl+/ without handing off', async () => {
  const { handoffToTerminal } = renderDock();
  const composer = screen.getByPlaceholderText('Compose a message…');

  await fireEvent.keyDown(composer, { key: '/', code: 'Slash', ctrlKey: true });

  expect(composer).toHaveValue('/');
  expect(handoffToTerminal).not.toHaveBeenCalled();
});

test('toggles between Compose and terminal with either supported shortcut', async () => {
  const { onToggleInputSurface, submit } = renderDock();
  const composer = screen.getByPlaceholderText('Compose a message…') as HTMLTextAreaElement;
  await fireEvent.input(composer, { target: { value: 'Keep this draft' } });
  composer.setSelectionRange(4, 8);

  await fireEvent.keyDown(composer, { key: '/', code: 'Slash', metaKey: true });
  await fireEvent.keyDown(composer, { key: '`', code: 'Backquote', ctrlKey: true });
  await fireEvent.keyDown(composer, { key: '?', code: 'Slash', ctrlKey: true, shiftKey: true });
  await fireEvent.keyDown(composer, { key: '/', code: 'Slash', metaKey: true, repeat: true });

  expect(onToggleInputSurface).toHaveBeenCalledTimes(2);
  expect(submit).not.toHaveBeenCalled();
  expect(composer).toHaveValue('Keep this draft');
});

test('ignores repeated Enter while allowing repeated terminal arrow navigation', async () => {
  const { sendControl, submit } = renderDock();
  const composer = screen.getByPlaceholderText('Compose a message…');

  await fireEvent.input(composer, { target: { value: 'Do not double send' } });
  await fireEvent.keyDown(composer, { key: 'Enter', repeat: true });
  expect(submit).not.toHaveBeenCalled();
  expect(composer).toHaveValue('Do not double send');

  await fireEvent.input(composer, { target: { value: '' } });
  await fireEvent.keyDown(composer, { key: 'Enter', repeat: true });
  await fireEvent.keyDown(composer, { key: 'ArrowDown', repeat: true });
  expect(sendControl).toHaveBeenCalledTimes(1);
  expect(sendControl).toHaveBeenCalledWith('arrow-down');
});

test('opens, searches, and inserts Composer history with the keyboard', async () => {
  const { submit } = renderDock();
  const composer = screen.getByPlaceholderText('Compose a message…') as HTMLTextAreaElement;
  await fireEvent.input(composer, { target: { value: 'Before  after' } });
  composer.setSelectionRange(7, 7);
  await fireEvent.select(composer);

  await fireEvent.keyDown(composer, { key: 'h', code: 'KeyH', ctrlKey: true, altKey: true });
  const search = await screen.findByRole('combobox', { name: 'Search sent prompts' });
  expect(search).toHaveFocus();
  await fireEvent.input(search, { target: { value: 'current tests' } });
  expect(screen.queryByText('Review the automation queue')).not.toBeInTheDocument();
  await fireEvent.keyDown(search, { key: 'ArrowDown' });
  await fireEvent.keyDown(search, { key: 'Enter' });

  await waitFor(() => expect(composer).toHaveValue('Before Check the current tests after'));
  await waitFor(() => expect(composer).toHaveFocus());
  expect(composer.selectionStart).toBe('Before Check the current tests'.length);
  expect(submit).not.toHaveBeenCalled();
});

test('restores the Composer selection after closing history with Escape', async () => {
  renderDock();
  const composer = screen.getByPlaceholderText('Compose a message…') as HTMLTextAreaElement;
  await fireEvent.input(composer, { target: { value: 'Selection remains' } });
  composer.setSelectionRange(2, 9, 'forward');
  await fireEvent.select(composer);
  await fireEvent.keyDown(composer, { key: 'h', code: 'KeyH', ctrlKey: true, altKey: true });
  const search = await screen.findByRole('combobox', { name: 'Search sent prompts' });

  await fireEvent.keyDown(search, { key: 'Escape' });

  await waitFor(() => expect(composer).toHaveFocus());
  expect(composer.selectionStart).toBe(2);
  expect(composer.selectionEnd).toBe(9);
});

test('preserves focus chosen outside Composer popovers', async () => {
  const user = userEvent.setup();
  renderDock();
  const composer = screen.getByPlaceholderText('Compose a message…') as HTMLTextAreaElement;
  await fireEvent.input(composer, { target: { value: 'Keep the current draft' } });
  const outsideButton = document.createElement('button');
  outsideButton.textContent = 'Outside action';
  document.body.append(outsideButton);

  try {
    composer.focus();
    await fireEvent.keyDown(composer, { key: 'h', code: 'KeyH', ctrlKey: true, altKey: true });
    expect(await screen.findByRole('combobox', { name: 'Search sent prompts' })).toHaveFocus();
    await user.click(outsideButton);
    await waitFor(() =>
      expect(screen.queryByRole('combobox', { name: 'Search sent prompts' })).not.toBeInTheDocument()
    );
    expect(outsideButton).toHaveFocus();
  } finally {
    outsideButton.remove();
  }
});

test('applies the template even when an old bypass preference remains in browser storage', async () => {
  window.localStorage.setItem('vampire:terminal-composer-message-options:v1:workspace-1:main', 'bypass-template');
  const { submit } = renderDock(
    vi.fn(() => true),
    'workspace-1',
    'Wrapped: {{ prompts }}'
  );
  const composer = screen.getByPlaceholderText('Compose a message…');
  await fireEvent.input(composer, { target: { value: 'Inspect this' } });
  await fireEvent.keyDown(composer, { key: 'b', code: 'KeyB', ctrlKey: true, altKey: true });
  await fireEvent.keyDown(composer, { key: 'Enter' });
  expect(submit).toHaveBeenLastCalledWith('Wrapped: Inspect this', 'Inspect this');
});

test('restores an uncertain submission at the caret without overwriting or resending', async () => {
  const recoverableSubmissions: RecoverableComposerSubmission[] = [
    {
      requestId: 'request-0',
      draft: 'older draft',
      status: 'failed',
      message: 'The submit key was rejected.',
    },
    {
      requestId: 'request-1',
      draft: 'recovered ',
      status: 'uncertain',
      message: 'The acknowledgement timed out.',
    },
  ];
  const { onDismissSubmission, submit } = renderDock(
    vi.fn(() => true),
    'workspace-1',
    '{{ prompts }}',
    { recoverableSubmissions }
  );
  const composer = screen.getByPlaceholderText('Compose a message…') as HTMLTextAreaElement;
  await fireEvent.input(composer, { target: { value: 'ABCD' } });
  composer.setSelectionRange(1, 3);
  await fireEvent.select(composer);
  expect(screen.getAllByLabelText('Draft excerpt').map((excerpt) => excerpt.textContent)).toEqual([
    'older draft',
    'recovered ',
  ]);
  expect(screen.getAllByText(/Some input may have reached the terminal/)).toHaveLength(2);

  await fireEvent.keyDown(composer, { key: 'r', code: 'KeyR', ctrlKey: true, altKey: true });

  await waitFor(() => expect(composer).toHaveValue('Arecovered BCD'));
  expect(onDismissSubmission).toHaveBeenCalledWith('request-1');
  expect(submit).not.toHaveBeenCalled();
});

test('moves through terminal history one page at a time', async () => {
  const { scrollPageUp, scrollPageDown } = renderDock();

  await fireEvent.click(screen.getByRole('button', { name: 'Scroll terminal up one page' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Scroll terminal down one page' }));

  expect(scrollPageUp).toHaveBeenCalledOnce();
  expect(scrollPageDown).toHaveBeenCalledOnce();
});

test('sends Backspace to the terminal without submitting Compose', async () => {
  const { sendControl, submit } = renderDock();

  await fireEvent.click(screen.getByRole('button', { name: 'Backspace' }));

  expect(sendControl).toHaveBeenCalledWith('backspace');
  expect(submit).not.toHaveBeenCalled();
});

test('keeps Compose focused after a one-shot terminal control', async () => {
  const user = userEvent.setup();
  const { sendControl } = renderDock();
  const composer = screen.getByPlaceholderText('Compose a message…');
  composer.focus();

  await user.click(screen.getByRole('button', { name: 'Arrow up' }));

  expect(sendControl).toHaveBeenCalledWith('arrow-up');
  expect(composer).toHaveFocus();
});

test('restores an unsent composer draft after remounting the terminal', async () => {
  const first = renderDock();
  const composer = screen.getByPlaceholderText('Compose a message…');
  await fireEvent.input(composer, { target: { value: 'Unsent 한글 draft' } });
  first.result.unmount();

  renderDock();
  await waitFor(() => expect(screen.getByPlaceholderText('Compose a message…')).toHaveValue('Unsent 한글 draft'));
});

test('isolates drafts by workspace and clears one only after a successful submit', async () => {
  const rejectedSubmit = vi.fn(() => false);
  const first = renderDock(rejectedSubmit);
  const composer = screen.getByPlaceholderText('Compose a message…');
  await fireEvent.input(composer, { target: { value: 'Keep this draft' } });
  await fireEvent.keyDown(composer, { key: 'Enter' });
  expect(rejectedSubmit).toHaveBeenCalledWith('Keep this draft', 'Keep this draft');
  expect(composer).toHaveValue('Keep this draft');
  first.result.unmount();

  const other = renderDock(
    vi.fn(() => true),
    'workspace-2'
  );
  await waitFor(() => expect(screen.getByPlaceholderText('Compose a message…')).toHaveValue(''));
  other.result.unmount();

  const acceptedSubmit = vi.fn(() => true);
  const restored = renderDock(acceptedSubmit);
  const restoredComposer = await screen.findByPlaceholderText('Compose a message…');
  await waitFor(() => expect(restoredComposer).toHaveValue('Keep this draft'));
  await fireEvent.keyDown(restoredComposer, { key: 'Enter' });
  expect(acceptedSubmit).toHaveBeenCalledWith('Keep this draft', 'Keep this draft');
  expect(restoredComposer).toHaveValue('');
  restored.result.unmount();

  renderDock();
  await waitFor(() => expect(screen.getByPlaceholderText('Compose a message…')).toHaveValue(''));
});

test('flushes the latest draft before attempting a submission that is refused', async () => {
  const rejectedSubmit = vi.fn(() => false);
  renderDock(rejectedSubmit);
  const composer = screen.getByPlaceholderText('Compose a message…');
  await fireEvent.input(composer, { target: { value: 'Latest edit before transport failure' } });

  await fireEvent.keyDown(composer, { key: 'Enter' });

  expect(rejectedSubmit).toHaveBeenCalled();
  expect(loadComposerDraft('workspace-1').value).toBe('Latest edit before transport failure');
  expect(composer).toHaveValue('Latest edit before transport failure');
});
