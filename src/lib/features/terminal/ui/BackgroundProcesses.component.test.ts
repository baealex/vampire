import { fireEvent, render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import type {
  WorkspaceAgentActionDescriptor,
  WorkspaceAgentActionSubmission,
} from '~/lib/shared/contracts/workspace-agent-actions.ts';
import BackgroundProcesses from './BackgroundProcesses.svelte';

function renderBackgroundProcesses(
  onOpenChange = vi.fn(),
  favoriteCommands: string[] = [],
  agent: {
    load?: () => Promise<WorkspaceAgentActionDescriptor>;
    queue?: (request: string) => Promise<WorkspaceAgentActionSubmission>;
    available?: boolean;
  } = {}
) {
  return render(BackgroundProcesses, {
    open: true,
    workspaceId: 'workspace-1',
    onOpenChange,
    panelId: 'background-panel',
    triggerId: 'background-trigger',
    processes: [],
    favoriteCommands,
    onStart: vi.fn(),
    onStop: vi.fn(),
    onLoadOutput: vi.fn(),
    onFavorite: vi.fn(),
    onRemoveFavorite: vi.fn(),
    ...(agent.load ? { loadAgentAction: agent.load } : {}),
    ...(agent.queue ? { submitAgentAction: agent.queue } : {}),
    ...(agent.available === undefined ? {} : { askAgentAvailable: agent.available }),
  });
}

test('disables Ask agent before opening when the main terminal has no foreground process', () => {
  renderBackgroundProcesses(vi.fn(), [], { available: false });

  expect(screen.getByRole('button', { name: 'Ask agent to manage saved commands' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Ask agent to manage saved commands' })).toHaveAttribute(
    'title',
    'Start a foreground process in the main terminal first.'
  );
});

test('renders background management as a workspace panel instead of a dialog', () => {
  renderBackgroundProcesses();

  expect(screen.getByRole('complementary', { name: 'Background' })).toBeVisible();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('uses panel navigation for the command runner and close action', async () => {
  const onOpenChange = vi.fn();
  renderBackgroundProcesses(onOpenChange);

  await fireEvent.click(screen.getByRole('button', { name: 'Run background command' }));
  expect(screen.getByText('Run command')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Back to background processes' })).toBeVisible();

  await fireEvent.click(screen.getByRole('button', { name: 'Close background manager' }));
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test('shows saved commands immediately and keeps them available in the runner', async () => {
  const savedCommand = 'VAMPIRE_HOST=192.168.219.106 pnpm dev --host 192.168.219.106';
  renderBackgroundProcesses(vi.fn(), [savedCommand]);

  expect(screen.getByRole('region', { name: 'Saved background commands' })).toBeVisible();
  expect(screen.getByRole('button', { name: `Run saved command ${savedCommand}` })).toBeVisible();

  await fireEvent.click(screen.getByRole('button', { name: 'Run background command' }));
  expect(screen.getByRole('region', { name: 'Saved background commands' })).toBeVisible();
  expect(screen.getByRole('button', { name: `Run saved command ${savedCommand}` })).toBeVisible();
});

test('uses an embedded Ask agent flow and returns to the Background list after sending', async () => {
  const user = userEvent.setup();
  const queue = vi.fn(
    async (request: string): Promise<WorkspaceAgentActionSubmission> => ({
      actionId: 'background',
      status: 'submitted',
      submittedAt: 1,
      prompt: request,
    })
  );
  renderBackgroundProcesses(vi.fn(), ['pnpm dev'], {
    load: async () => ({
      id: 'background',
      title: 'Manage Background commands with an agent',
      description: 'Vampire supplies an isolated request.',
      target: { workspaceId: 'workspace-1', workspaceLabel: 'Vampire', processLabel: 'node' },
      context: [{ label: 'Agent support', value: 'Prepared when sent' }],
      requestLabel: 'Which commands should the agent manage?',
      requestPlaceholder: 'Find development commands.',
      defaultRequest: '',
    }),
    queue,
  });

  await user.click(screen.getByRole('button', { name: 'Ask agent to manage saved commands' }));
  expect(await screen.findByRole('heading', { name: 'Manage Background commands with an agent' })).toBeVisible();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  const request = screen.getByRole('textbox', { name: 'Which commands should the agent manage?' });
  await user.type(request, 'Save the dev server and test watcher.');
  await user.click(screen.getByRole('button', { name: 'Send to agent' }));

  expect(queue).toHaveBeenCalledWith('Save the dev server and test watcher.');
  expect(screen.queryByText(/Background request sent/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Ask agent to manage saved commands' })).toHaveFocus();
});
