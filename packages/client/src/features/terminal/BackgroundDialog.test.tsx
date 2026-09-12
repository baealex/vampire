import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { BackgroundDialog } from './BackgroundDialog.tsx';

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('stops output polling and resets to the process list after the panel closes', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  const load = vi.fn().mockResolvedValue('output');
  const state = {
    workspaces: [
      {
        id: 'workspace',
        favoriteCommands: [],
        terminals: [
          { id: 'main', index: 0 },
          { id: 'background', index: 1, command: 'test command', state: 'running' },
        ],
      },
    ],
    loadBackgroundOutput: load,
  } as unknown as ComponentProps<typeof BackgroundDialog>['state'];
  const props = { open: true, workspaceId: 'workspace', workspaceLabel: 'Workspace', state, onClose: vi.fn() };
  const view = render(<BackgroundDialog {...props} />);
  await act(async () => {
    fireEvent.click(view.container.querySelector('.process-summary')!);
  });
  expect(load).toHaveBeenCalledTimes(1);
  view.rerender(<BackgroundDialog {...props} open={false} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => {
    view.rerender(<BackgroundDialog {...props} />);
  });
  expect(load).toHaveBeenCalledTimes(1);
  expect(view.container.querySelector('.process-list')).not.toBeNull();
  expect(view.container.querySelector('.process-output')).toBeNull();
});

it('pauses output polling while the browser tab is hidden and resumes on return', async () => {
  vi.useFakeTimers();
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  const load = vi.fn().mockResolvedValue('output');
  const state = {
    workspaces: [
      {
        id: 'workspace',
        favoriteCommands: [],
        terminals: [
          { id: 'main', index: 0 },
          { id: 'background', index: 1, command: 'test command', state: 'running' },
        ],
      },
    ],
    loadBackgroundOutput: load,
  } as unknown as ComponentProps<typeof BackgroundDialog>['state'];
  const props = { open: true, workspaceId: 'workspace', workspaceLabel: 'Workspace', state, onClose: vi.fn() };
  const view = render(<BackgroundDialog {...props} />);
  await act(async () => {
    fireEvent.click(view.container.querySelector('.process-summary')!);
  });
  expect(load).toHaveBeenCalledTimes(1);
  hidden.mockReturnValue(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(load).toHaveBeenCalledTimes(1);
  hidden.mockReturnValue(false);
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(load).toHaveBeenCalledTimes(2);
});
