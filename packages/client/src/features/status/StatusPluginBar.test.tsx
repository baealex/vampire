import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { StatusPluginSnapshot } from '@vampire/lib/shared/contracts/status-plugin.ts';
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
