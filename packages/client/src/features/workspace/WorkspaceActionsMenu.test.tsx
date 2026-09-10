import { cleanup, render, screen } from '@testing-library/react';
import type { ManagedWorkspace } from '@vampire/lib/shared/contracts/workspace.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceState } from './model/workspace-state.ts';
import { WorkspaceActionsMenu } from './WorkspaceActionsMenu.tsx';

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  });
});

afterEach(cleanup);

describe('Workspace actions menu', () => {
  it.each(['running', 'missing'] as const)('has no empty groups for a %s workspace', (state) => {
    render(
      <WorkspaceActionsMenu
        open
        onOpenChange={vi.fn()}
        onSettings={vi.fn()}
        onAutomations={vi.fn()}
        onNewWorktree={vi.fn()}
        state={{} as WorkspaceState}
        workspace={{ id: 'workspace', cwd: '/projects/example', state } as ManagedWorkspace}
      />,
    );
    const menu = screen.getByRole('menu');
    const children = Array.from(menu.children);
    for (const separator of menu.querySelectorAll('[role="separator"]')) {
      const index = children.indexOf(separator);
      expect(children[index - 1]?.getAttribute('role')).toBe('menuitem');
      expect(children[index + 1]?.getAttribute('role')).toBe('menuitem');
    }
    expect(screen.queryByRole('menuitem', { name: 'Close workspace' }) !== null).toBe(state === 'running');
    expect(screen.getByRole('menuitem', { name: 'Remove workspace' })).toBeVisible();
  });
});
