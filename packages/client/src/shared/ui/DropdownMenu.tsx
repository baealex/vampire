import * as Dropdown from '@baejino/react-ui/dropdown-menu';
import type { ComponentProps, PropsWithChildren, ReactNode } from 'react';
import './dropdown-menu.css';

export function DropdownMenu({
  align = 'start',
  children,
  label,
  onOpenChange,
  open,
  title,
  trigger,
}: PropsWithChildren<{
  align?: 'start' | 'center' | 'end';
  label: string;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  title?: string;
  trigger: ReactNode;
}>) {
  return (
    <Dropdown.Root open={open} onOpenChange={onOpenChange}>
      <Dropdown.Trigger className="vampire-menu-trigger" aria-label={label} title={title}>
        {trigger}
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content data-vampire-overlay className="vampire-menu-content" sideOffset={6} align={align}>
          {children}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

export function DropdownMenuItem({
  className,
  danger = false,
  ...props
}: ComponentProps<typeof Dropdown.Item> & { danger?: boolean }) {
  return (
    <Dropdown.Item
      className={['vampire-menu-item', danger ? 'vampire-menu-item--danger' : '', className].filter(Boolean).join(' ')}
      {...props}
    />
  );
}

export function DropdownMenuSeparator() {
  return <Dropdown.Separator className="vampire-menu-separator" />;
}
