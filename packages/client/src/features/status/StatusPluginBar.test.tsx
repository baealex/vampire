import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StatusPluginSnapshot } from '@vampire/lib/shared/contracts/status-plugin.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusPluginBar } from './StatusPluginBar.tsx';

const plugins: StatusPluginSnapshot[] = [
  {
    id: 'cpu',
    name: 'CPU',
    state: 'ready',
    text: '10%',
    menu: [{ type: 'item', text: 'CPU detail', value: '10 cores' }],
    updatedAt: Date.now(),
  },
  {
    id: 'ram',
    name: 'RAM',
    state: 'ready',
    text: '20%',
    menu: [{ type: 'item', text: 'RAM detail', value: '2 GB' }],
    updatedAt: Date.now(),
  },
];

describe('StatusPluginBar', () => {
  afterEach(cleanup);
  it('labels widget details, separates progress values and supports closing', async () => {
    const user = userEvent.setup();
    render(
      <StatusPluginBar
        onManage={() => undefined}
        plugins={[
          {
            ...plugins[0]!,
            progress: 10,
            menu: [
              { type: 'item', text: 'Session', value: '42%', progress: 42, badge: 'Active', detail: 'Resets soon' },
            ],
          },
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'CPU: 10%' }));
    const dialog = screen.getByRole('dialog', { name: 'CPU details' });
    expect(within(dialog).getByRole('progressbar', { name: 'CPU' })).toHaveAttribute('aria-valuenow', '10');
    expect(within(dialog).getByRole('progressbar', { name: 'Session' })).toHaveAttribute('aria-valuenow', '42');
    expect(within(dialog).getByText('Active')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Close CPU details' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'CPU: 10%' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('switches directly between widget popovers', async () => {
    const user = userEvent.setup();
    render(<StatusPluginBar plugins={plugins} onManage={() => undefined} />);

    await user.click(screen.getByRole('button', { name: 'CPU: 10%' }));
    expect(screen.getByText('CPU detail')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'RAM: 20%' }));
    expect(screen.queryByText('CPU detail')).not.toBeInTheDocument();
    expect(screen.getByText('RAM detail')).toBeInTheDocument();
  });
});
