import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { navigationGuard } from '../lib/navigation-guard.ts';
import { ManagementSurface } from './ManagementSurface.tsx';

afterEach(cleanup);

describe('unsaved management settings', () => {
  it('keeps edits when navigation is cancelled and allows an explicit discard', async () => {
    render(
      <ManagementSurface title="Settings" titleId="settings-title" close={vi.fn()} dirty>
        Settings form
      </ManagementSurface>,
    );
    let navigation: Promise<boolean> | undefined;
    act(() => {
      navigation = navigationGuard()?.();
    });
    expect(screen.getByRole('alertdialog', { name: 'Discard unsaved changes?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    await expect(navigation).resolves.toBe(false);
    act(() => {
      navigation = navigationGuard()?.();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    await expect(navigation).resolves.toBe(true);
  });

  it('protects page reload only until changes are saved', () => {
    const { rerender } = render(<ManagementSurface title="Settings" titleId="settings-title" close={vi.fn()} dirty />);
    const dirtyUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyUnload);
    expect(dirtyUnload.defaultPrevented).toBe(true);
    rerender(<ManagementSurface title="Settings" titleId="settings-title" close={vi.fn()} />);
    expect(navigationGuard()).toBeUndefined();
    const cleanUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);
  });

  it('blocks navigation while saving and resolves pending navigation on unmount', async () => {
    const { rerender, unmount } = render(
      <ManagementSurface title="Settings" titleId="settings-title" close={vi.fn()} dirty busy />,
    );
    await expect(navigationGuard()?.()).resolves.toBe(false);
    rerender(<ManagementSurface title="Settings" titleId="settings-title" close={vi.fn()} dirty />);
    let navigation: Promise<boolean> | undefined;
    act(() => {
      navigation = navigationGuard()?.();
    });
    unmount();
    await expect(navigation).resolves.toBe(false);
    expect(navigationGuard()).toBeUndefined();
  });
});
