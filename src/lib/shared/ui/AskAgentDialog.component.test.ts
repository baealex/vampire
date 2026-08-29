import { render, screen, waitFor } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import type {
  WorkspaceAgentActionDescriptor,
  WorkspaceAgentActionSubmission,
} from '../contracts/workspace-agent-actions.ts';
import AskAgentDialog from './AskAgentDialog.svelte';

const descriptor: WorkspaceAgentActionDescriptor = {
  id: 'status-widget',
  title: 'Create a status widget with an agent',
  description: 'Vampire supplies the live widget contract.',
  target: { workspaceId: 'workspace-1', workspaceLabel: 'Vampire', agentLabel: 'codex' },
  context: [
    { label: 'Widget configuration', value: '/state/status-plugins.json' },
    { label: 'Widget guide', value: '/state/agent-guides/status-widget.md' },
  ],
  requestLabel: 'What widget should the agent create?',
  requestPlaceholder: 'Show unread notifications.',
  defaultRequest: '',
};

const submission: WorkspaceAgentActionSubmission = {
  actionId: 'status-widget',
  status: 'queued',
  queuedAt: 1,
  prompt: 'Create the widget.',
};

test('shows supplied context and submits only the user request', async () => {
  const user = userEvent.setup();
  const close = vi.fn();
  const submit = vi.fn(async () => submission);
  const onQueued = vi.fn();
  render(AskAgentDialog, {
    close,
    load: vi.fn(async () => descriptor),
    submit,
    onQueued,
  });

  expect(await screen.findByText('/state/status-plugins.json')).toBeInTheDocument();
  expect(screen.getByText('/state/agent-guides/status-widget.md')).toBeInTheDocument();
  expect(screen.getByText('codex')).toBeInTheDocument();
  expect(screen.getByText('Vampire')).toBeInTheDocument();

  const request = screen.getByRole('textbox', { name: 'What widget should the agent create?' });
  const send = screen.getByRole('button', { name: 'Send to agent' });
  expect(send).toBeDisabled();
  await user.type(request, 'Show unread GitHub notifications.');
  await user.click(send);

  await waitFor(() => expect(submit).toHaveBeenCalledWith('Show unread GitHub notifications.'));
  expect(onQueued).toHaveBeenCalledWith(submission);
  expect(close).toHaveBeenCalledTimes(1);
});

test('keeps the dialog open and offers retry when context loading fails', async () => {
  const user = userEvent.setup();
  const load = vi
    .fn<() => Promise<WorkspaceAgentActionDescriptor>>()
    .mockRejectedValueOnce(new Error('Start a supported agent.'))
    .mockResolvedValueOnce(descriptor);
  render(AskAgentDialog, { close: vi.fn(), load, submit: vi.fn(async () => submission) });

  expect(await screen.findByRole('alert')).toHaveTextContent('Start a supported agent.');
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('/state/status-plugins.json')).toBeInTheDocument();
  expect(load).toHaveBeenCalledTimes(2);
});
