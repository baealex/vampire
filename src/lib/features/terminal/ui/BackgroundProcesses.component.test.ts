import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';
import BackgroundProcesses from './BackgroundProcesses.svelte';

function renderBackgroundProcesses(onOpenChange = vi.fn()) {
  return render(BackgroundProcesses, {
    open: true,
    onOpenChange,
    panelId: 'background-panel',
    triggerId: 'background-trigger',
    processes: [],
    favoriteCommands: [],
    onStart: vi.fn(),
    onStop: vi.fn(),
    onLoadOutput: vi.fn(),
    onFavorite: vi.fn(),
    onRemoveFavorite: vi.fn(),
  });
}

test('renders background management as a workspace panel instead of a dialog', () => {
  renderBackgroundProcesses();

  expect(screen.getByRole('complementary', { name: 'Background processes' })).toBeVisible();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('uses panel navigation for the command runner and close action', async () => {
  const onOpenChange = vi.fn();
  renderBackgroundProcesses(onOpenChange);

  await fireEvent.click(screen.getByRole('button', { name: 'Run background command' }));
  expect(screen.getByText('Run background command')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Back to background processes' })).toBeVisible();

  await fireEvent.click(screen.getByRole('button', { name: 'Close background manager' }));
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
