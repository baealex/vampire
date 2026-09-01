import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';
import BackgroundProcesses from './BackgroundProcesses.svelte';

function renderBackgroundProcesses(onOpenChange = vi.fn(), favoriteCommands: string[] = []) {
  return render(BackgroundProcesses, {
    open: true,
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
  });
}

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

test('keeps saved commands in the runner instead of repeating them in the process list', async () => {
  const savedCommand = 'VAMPIRE_HOST=192.168.219.106 pnpm dev --host 192.168.219.106';
  renderBackgroundProcesses(vi.fn(), [savedCommand]);

  expect(screen.queryByRole('region', { name: 'Saved background commands' })).not.toBeInTheDocument();

  await fireEvent.click(screen.getByRole('button', { name: 'Run background command' }));
  expect(screen.getByRole('region', { name: 'Saved background commands' })).toBeVisible();
  expect(screen.getByRole('button', { name: `Run saved command ${savedCommand}` })).toBeVisible();
});
