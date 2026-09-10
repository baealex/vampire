import type { ComponentPropsWithoutRef } from 'react';
import styles from './workspace-side-panel.module.css';

export function WorkspaceSidePanel({
  className,
  open,
  ...props
}: ComponentPropsWithoutRef<'aside'> & { open: boolean }) {
  return (
    <aside
      {...props}
      className={[styles.panel, open ? styles.open : '', className].filter(Boolean).join(' ')}
      aria-hidden={!open}
      inert={!open ? true : undefined}
    />
  );
}
