import { fireEvent, render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import RepositoryViewer from './RepositoryViewer.svelte';

afterEach(() => vi.restoreAllMocks());

test('previews an image selected from Git changes and navigates to the next change', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(null, { status: 200, headers: { etag: 'image-version-1', 'content-length': '42' } })
  );
  const onNavigate = vi.fn();
  render(RepositoryViewer, {
    workspaceId: 'workspace-1',
    selection: { kind: 'diff', path: 'assets/first.png' },
    refreshToken: 1,
    navigationPaths: ['assets/first.png', 'assets/second.png'],
    onNavigate,
    onClose: vi.fn(),
  });

  const image = await screen.findByRole('img', { name: 'first.png' });
  expect(image).toHaveAttribute(
    'src',
    expect.stringContaining('/api/workspaces/workspace-1/repository/media?path=assets%2Ffirst.png')
  );
  await fireEvent.load(image);
  expect(screen.getByRole('button', { name: 'Open previous diff' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Open next diff' }));
  expect(onNavigate).toHaveBeenCalledWith({ kind: 'diff', path: 'assets/second.png' });
});

test('renders a selected commit patch', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({ hash: 'abc1234', patch: '@@ -1 +1 @@\n-old value\n+new value\n' }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  );
  render(RepositoryViewer, {
    workspaceId: 'workspace-1',
    selection: { kind: 'commit', path: 'abc1234' },
    refreshToken: 1,
    onClose: vi.fn(),
  });

  expect(await screen.findByText('Commit changes')).toBeInTheDocument();
  expect(screen.getByText('+new value')).toBeInTheDocument();
  expect(screen.getByText('-old value')).toBeInTheDocument();
});
