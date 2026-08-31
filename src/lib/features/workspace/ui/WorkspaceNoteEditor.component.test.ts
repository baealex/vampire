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
  queueAgentAction: (request: string) => Promise<WorkspaceAgentActionSubmission>;
};

const agentAction: WorkspaceAgentActionDescriptor = {
  id: 'note',
  title: 'Ask agent about this note',
  description: 'The note path is supplied as context.',
  target: { workspaceId: 'workspace-1', workspaceLabel: 'Project', agentLabel: 'codex' },
  context: [{ label: 'Workspace note', value: '/state/workspace-1.note.md' }],
  requestLabel: 'What should the agent do?',
  requestPlaceholder: 'Organize the note.',
  defaultRequest: 'Organize the important context and next steps.',
};

const submission: WorkspaceAgentActionSubmission = {
  actionId: 'note',
  status: 'queued',
  queuedAt: 1,
  prompt: 'Prompt',
};

function renderEditor({
  getNote = vi.fn(async () => 'Initial note'),
  close = vi.fn(),
  save = vi.fn(async () => undefined),
  loadAgentAction = vi.fn(async () => agentAction),
  queueAgentAction = vi.fn(async () => submission),
}: Partial<EditorCallbacks> = {}) {
  render(WorkspaceNoteEditor, {
    workspaceId: 'workspace-1',
    getNote,
    close,
    save,
    loadAgentAction,
    queueAgentAction,
  });
  return { getNote, close, save, loadAgentAction, queueAgentAction };
}

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

test('saves the latest draft when a workspace switch unmounts the editor before autosave', async () => {
  const user = userEvent.setup();
  const save = vi.fn(async () => undefined);
  const view = render(WorkspaceNoteEditor, {
    workspaceId: 'workspace-1',
    getNote: vi.fn(async () => 'Initial note'),
    close: vi.fn(),
    save,
    loadAgentAction: vi.fn(async () => agentAction),
    queueAgentAction: vi.fn(async () => submission),
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
    queueAgentAction: vi.fn(async () => submission),
    panel: true,
  });

  await screen.findByRole('textbox', { name: 'Workspace note' });
  await user.click(screen.getByRole('button', { name: 'Close workspace note' }));

  expect(close).toHaveBeenCalledTimes(1);
});

test('shows the note path in a modal and saves the latest draft before queuing the visible request', async () => {
  const user = userEvent.setup();
  const pendingSave = deferred();
  const save = vi.fn(() => pendingSave.promise);
  const queueAgentAction = vi.fn(async () => submission);
  renderEditor({ save, queueAgentAction });
  const textarea = await screen.findByRole('textbox', { name: 'Workspace note' });

  await user.clear(textarea);
  await user.type(textarea, 'Keep this latest draft');
  await user.click(screen.getByRole('button', { name: 'Ask agent…' }));
  expect(await screen.findByText('/state/workspace-1.note.md')).toBeInTheDocument();
  const instructions = screen.getByRole('textbox', { name: 'What should the agent do?' });
  const queueButton = screen.getByRole('button', { name: 'Send to agent' });
  await user.clear(instructions);
  await user.type(instructions, 'Preserve everything and add only the current blocker.');
  await user.click(queueButton);
  await user.click(queueButton);

  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith('Keep this latest draft');
  expect(queueAgentAction).not.toHaveBeenCalled();

  pendingSave.resolve();

  await waitFor(() => expect(queueAgentAction).toHaveBeenCalledTimes(1));
  expect(queueAgentAction).toHaveBeenCalledWith('Preserve everything and add only the current blocker.');
  expect(
    await screen.findByText('Queued — the request will appear in the main agent session when it is ready.')
  ).toBeInTheDocument();
});
