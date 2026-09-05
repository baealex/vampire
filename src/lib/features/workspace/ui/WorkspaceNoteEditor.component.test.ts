import { render, screen, waitFor } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import type {
  WorkspaceAgentActionDescriptor,
  WorkspaceAgentActionSubmission,
} from '~/lib/shared/contracts/workspace-agent-actions.ts';
import WorkspaceNoteEditor from './WorkspaceNoteEditor.svelte';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type EditorCallbacks = {
  getNote: (refresh?: boolean) => Promise<string>;
  close: () => void;
  save: (note: string) => Promise<void>;
  loadAgentAction: () => Promise<WorkspaceAgentActionDescriptor>;
  submitAgentAction: (request: string) => Promise<WorkspaceAgentActionSubmission>;
  askAgentAvailable: boolean;
  onBusyChange: (busy: boolean) => void;
  onFlushAvailable: (flush: (() => Promise<boolean>) | undefined) => void;
  onPanelLockChange: (locked: boolean) => void;
};

const agentAction: WorkspaceAgentActionDescriptor = {
  id: 'note',
  title: 'Ask agent about this note',
  description: 'The note path is supplied as context.',
  target: { workspaceId: 'workspace-1', workspaceLabel: 'Project', processLabel: 'node' },
  context: [{ label: 'Workspace note', value: '/state/workspace-1.note.md' }],
  requestLabel: 'What should the agent do?',
  requestPlaceholder: 'Organize the note.',
  defaultRequest: 'Organize the important context and next steps.',
};

const submission: WorkspaceAgentActionSubmission = {
  actionId: 'note',
  status: 'submitted',
  submittedAt: 1,
  prompt: 'Prompt',
};

function renderEditor({
  getNote = vi.fn(async () => 'Initial note'),
  close = vi.fn(),
  save = vi.fn(async () => undefined),
  loadAgentAction = vi.fn(async () => agentAction),
  submitAgentAction = vi.fn(async () => submission),
  askAgentAvailable = true,
  onBusyChange = vi.fn(),
  onFlushAvailable = vi.fn(),
  onPanelLockChange = vi.fn(),
}: Partial<EditorCallbacks> = {}) {
  render(WorkspaceNoteEditor, {
    workspaceId: 'workspace-1',
    getNote,
    close,
    save,
    loadAgentAction,
    submitAgentAction,
    askAgentAvailable,
    onBusyChange,
    onFlushAvailable,
    onPanelLockChange,
  });
  return {
    getNote,
    close,
    save,
    loadAgentAction,
    submitAgentAction,
    askAgentAvailable,
    onBusyChange,
    onFlushAvailable,
    onPanelLockChange,
  };
}

test('disables Ask agent before opening when the main terminal has no foreground process', async () => {
  renderEditor({ askAgentAvailable: false });
  await screen.findByRole('textbox', { name: 'Workspace note' });

  expect(screen.getByRole('button', { name: 'Ask agent…' })).toBeDisabled();
  expect(screen.getByText('Start a foreground process in the main terminal to use Ask agent.')).toBeVisible();
});

test('autosaves the latest draft after the user pauses typing', async () => {
  const user = userEvent.setup();
  const { save } = renderEditor();
  const textarea = await screen.findByRole('textbox', { name: 'Workspace note' });

  await user.clear(textarea);
  await user.type(textarea, 'Latest plan');

  expect(save).not.toHaveBeenCalled();
  await waitFor(() => expect(save).toHaveBeenCalledWith('Latest plan'), { timeout: 2_000 });
  expect(save).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved'));
});

test('reports an edited draft as busy until automatic saving finishes', async () => {
  const user = userEvent.setup();
  const pendingSave = deferred();
  const onBusyChange = vi.fn();
  renderEditor({ save: vi.fn(() => pendingSave.promise), onBusyChange });
  const textarea = await screen.findByRole('textbox', { name: 'Workspace note' });

  await user.clear(textarea);
  await user.type(textarea, 'Protected draft');
  await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));

  pendingSave.resolve();
  await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false), { timeout: 2_000 });
});

test('provides a navigation guard that flushes the current draft before leaving', async () => {
  const user = userEvent.setup();
  const pendingSave = deferred();
  let flushDraft: (() => Promise<boolean>) | undefined;
  renderEditor({
    save: vi.fn(() => pendingSave.promise),
    onFlushAvailable: (flush) => (flushDraft = flush),
  });
  const textarea = await screen.findByRole('textbox', { name: 'Workspace note' });

  await user.clear(textarea);
  await user.type(textarea, 'Save before leaving');
  expect(flushDraft).toBeDefined();
  let navigationReady = false;
  const flush = flushDraft!().then((ready) => {
    navigationReady = ready;
  });
  expect(navigationReady).toBe(false);

  pendingSave.resolve();
  await flush;
  expect(navigationReady).toBe(true);
});

test('saves the latest draft when a workspace switch unmounts the editor before autosave', async () => {
  const user = userEvent.setup();
  const save = vi.fn(async () => undefined);
  const view = render(WorkspaceNoteEditor, {
    workspaceId: 'workspace-1',
    getNote: vi.fn(async () => 'Initial note'),
    close: vi.fn(),
    save,
    loadAgentAction: vi.fn(async () => agentAction),
    submitAgentAction: vi.fn(async () => submission),
  });
  const textarea = await screen.findByRole('textbox', { name: 'Workspace note' });

  await user.clear(textarea);
  await user.type(textarea, 'Draft before switching workspaces');
  view.unmount();

  await waitFor(() => expect(save).toHaveBeenCalledWith('Draft before switching workspaces'));
  expect(save).toHaveBeenCalledTimes(1);
});

test('saves edits made during an in-flight save before closing', async () => {
  const user = userEvent.setup();
  const firstSave = deferred();
  const secondSave = deferred();
  const save = vi
    .fn()
    .mockImplementationOnce(() => firstSave.promise)
    .mockImplementationOnce(() => secondSave.promise);
  const close = vi.fn();
  renderEditor({ save, close });
  const textarea = await screen.findByRole('textbox', { name: 'Workspace note' });

  await user.clear(textarea);
  await user.type(textarea, 'First draft');
  await user.keyboard('{Control>}Enter{/Control}');
  await waitFor(() => expect(save).toHaveBeenCalledWith('First draft'));

  await user.clear(textarea);
  await user.type(textarea, 'Final draft');
  await user.keyboard('{Escape}');
  expect(close).not.toHaveBeenCalled();

  firstSave.resolve();
  await waitFor(() => expect(save).toHaveBeenCalledWith('Final draft'));
  expect(close).not.toHaveBeenCalled();

  secondSave.resolve();
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(save.mock.calls.map(([note]) => note)).toEqual(['First draft', 'Final draft']);
});

test('keeps a failed draft open and closes only after a successful retry', async () => {
  const user = userEvent.setup();
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error('Note storage is unavailable.'))
    .mockResolvedValueOnce(undefined);
  const close = vi.fn();
  renderEditor({ save, close });
  const textarea = await screen.findByRole('textbox', { name: 'Workspace note' });

  await user.clear(textarea);
  await user.type(textarea, 'Do not lose this');
  await user.click(screen.getByRole('button', { name: 'Close workspace note' }));

  expect(await screen.findByText('Note storage is unavailable.')).toBeInTheDocument();
  expect(textarea).toHaveValue('Do not lose this');
  expect(close).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Close workspace note' }));

  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(save).toHaveBeenCalledTimes(2);
});

test('keeps the close action available in panel mode', async () => {
  const user = userEvent.setup();
  const close = vi.fn();
  render(WorkspaceNoteEditor, {
    workspaceId: 'workspace-1',
    getNote: vi.fn(async () => 'Initial note'),
    close,
    save: vi.fn(async () => undefined),
    loadAgentAction: vi.fn(async () => agentAction),
    submitAgentAction: vi.fn(async () => submission),
    panel: true,
  });

  await screen.findByRole('textbox', { name: 'Workspace note' });
  await user.click(screen.getByRole('button', { name: 'Close workspace note' }));

  expect(close).toHaveBeenCalledTimes(1);
});

test('shows the note path inside the panel and saves the latest draft before queuing the visible request', async () => {
  const user = userEvent.setup();
  const pendingSave = deferred();
  const save = vi.fn(() => pendingSave.promise);
  const submitAgentAction = vi.fn(async () => submission);
  renderEditor({ save, submitAgentAction });
  const textarea = await screen.findByRole('textbox', { name: 'Workspace note' });

  await user.clear(textarea);
  await user.type(textarea, 'Keep this latest draft');
  await user.click(screen.getByRole('button', { name: 'Ask agent…' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(await screen.findByText('/state/workspace-1.note.md')).toBeInTheDocument();
  const instructions = screen.getByRole('textbox', { name: 'What should the agent do?' });
  const queueButton = screen.getByRole('button', { name: 'Send to agent' });
  await user.clear(instructions);
  await user.type(instructions, 'Preserve everything and add only the current blocker.');
  await user.click(queueButton);
  await user.click(queueButton);

  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith('Keep this latest draft');
  expect(submitAgentAction).not.toHaveBeenCalled();

  pendingSave.resolve();

  await waitFor(() => expect(submitAgentAction).toHaveBeenCalledTimes(1));
  expect(submitAgentAction).toHaveBeenCalledWith('Preserve everything and add only the current blocker.');
  expect(screen.queryByText('Sent to the main terminal process.')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Ask agent…' })).toHaveFocus();
});

test('locks panel transitions while an agent request is being submitted', async () => {
  const user = userEvent.setup();
  let finishQueue!: (value: WorkspaceAgentActionSubmission) => void;
  const submitAgentAction = vi.fn(
    () =>
      new Promise<WorkspaceAgentActionSubmission>((resolve) => {
        finishQueue = resolve;
      })
  );
  const onPanelLockChange = vi.fn();
  renderEditor({ submitAgentAction, onPanelLockChange });

  await screen.findByRole('textbox', { name: 'Workspace note' });
  await user.click(screen.getByRole('button', { name: 'Ask agent…' }));
  await user.click(screen.getByRole('button', { name: 'Send to agent' }));
  await waitFor(() => expect(onPanelLockChange).toHaveBeenLastCalledWith(true));

  finishQueue(submission);
  await waitFor(() => expect(onPanelLockChange).toHaveBeenLastCalledWith(false));
});
