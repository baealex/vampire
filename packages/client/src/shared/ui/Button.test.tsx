import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { Button } from './Button.tsx';

test('uses safe button defaults and design-system classes', async () => {
  const onClick = vi.fn();
  render(
    <Button block size="sm" variant="primary" onClick={onClick}>
      Save
    </Button>
  );
  const button = screen.getByRole('button', { name: 'Save' });
  expect(button).toHaveAttribute('type', 'button');
  expect(button).toHaveClass('vampire-button--primary', 'vampire-button--sm', 'vampire-button--block');
  await userEvent.click(button);
  expect(onClick).toHaveBeenCalledOnce();
});

test('forwards native disabled behavior', async () => {
  const onClick = vi.fn();
  render(
    <Button disabled onClick={onClick}>
      Delete
    </Button>
  );
  const button = screen.getByRole('button', { name: 'Delete' });
  expect(button).toBeDisabled();
  await userEvent.click(button);
  expect(onClick).not.toHaveBeenCalled();
});
