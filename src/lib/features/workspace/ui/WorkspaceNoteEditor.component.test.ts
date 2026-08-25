import { render, screen, waitFor } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
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
  updateWithAgent: (instructions: string) => Promise<{ notePath: string }>;
};

function renderEditor({
  getNote = vi.fn(async () => 'Initial note'),
  close = vi.fn(),
  save = vi.fn(async () => undefined),
  updateWithAgent = vi.fn(async () => ({ notePath: '.vampire/note.md' })),
}: Partial<EditorCallbacks> = {}) {
  render(WorkspaceNoteEditor, { getNote, close, save, updateWithAgent });
  return { getNote, close, save, updateWithAgent };
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
    getNote: vi.fn(async () => 'Initial note'),
    close: vi.fn(),
    save,
    updateWithAgent: vi.fn(async () => ({ notePath: '.vampire/note.md' })),
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

test('requires custom instructions and saves the latest draft before queuing one agent update', async () => {
  const user = userEvent.setup();
  const pendingSave = deferred();
  const save = vi.fn(() => pendingSave.promise);
  const updateWithAgent = vi.fn(async () => ({ notePath: '.vampire/note.md' }));
  renderEditor({ save, updateWithAgent });
  const textarea = await screen.findByRole('textbox', { name: 'Workspace note' });

  await user.clear(textarea);
  await user.type(textarea, 'Keep this latest draft');
  await user.click(screen.getByRole('button', { name: 'Ask agent…' }));
  const instructions = screen.getByRole('textbox', { name: 'Agent instructions' });
  const queueButton = screen.getByRole('button', { name: 'Queue update' });
  expect(queueButton).toBeDisabled();
  await user.type(instructions, 'Preserve everything and add only the current blocker.');
  await user.click(queueButton);
  await user.click(queueButton);

  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith('Keep this latest draft');
  expect(updateWithAgent).not.toHaveBeenCalled();

  pendingSave.resolve();

  await waitFor(() => expect(updateWithAgent).toHaveBeenCalledTimes(1));
  expect(updateWithAgent).toHaveBeenCalledWith('Preserve everything and add only the current blocker.');
  expect(await screen.findByText('Queued — waiting for the agent to update the note.')).toBeInTheDocument();
});
