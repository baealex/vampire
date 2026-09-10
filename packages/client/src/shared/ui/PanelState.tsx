import type { ReactNode } from 'react';
import styles from './panel-state.module.css';
import { Spinner } from './Spinner.tsx';

export function PanelState({
  children,
  loading = false,
  error = false,
}: {
  children: ReactNode;
  loading?: boolean;
  error?: boolean;
}) {
  return (
    <div className={`${styles.state}${error ? ` ${styles.error}` : ''}`} role={error ? 'alert' : 'status'}>
      {loading ? <Spinner /> : null}
      <span>{children}</span>
    </div>
  );
}
