import { ArrowLeft, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { ToolbarButton } from './ToolbarButton.tsx';
import styles from './workspace-panel-header.module.css';

export function WorkspacePanelHeader({
  actions,
  backLabel = 'Back',
  close,
  closeLabel = 'Close panel',
  onBack,
  subtitle,
  subtitleMonospace = false,
  subtitleTitle,
  title,
  titleId,
}: {
  actions?: ReactNode;
  backLabel?: string;
  close?: () => void;
  closeLabel?: string;
  onBack?: () => void;
  subtitle?: string;
  subtitleMonospace?: boolean;
  subtitleTitle?: string;
  title: string;
  titleId?: string;
}) {
  return (
    <header className={styles.header}>
      <div className={styles.heading}>
        {onBack ? (
          <ToolbarButton className={styles.back} label={backLabel} onClick={onBack}>
            <ArrowLeft size={17} strokeWidth={1.9} aria-hidden="true" />
          </ToolbarButton>
        ) : null}
        <div className={styles.title}>
          <strong id={titleId}>{title}</strong>
          {subtitle ? (
            <span className={subtitleMonospace ? styles.monospace : undefined} title={subtitleTitle ?? subtitle}>
              {subtitle}
            </span>
          ) : null}
        </div>
      </div>
      {actions || close ? (
        <div className={styles.actions}>
          {actions}
          {close ? (
            <ToolbarButton className={styles.close} label={closeLabel} onClick={close}>
              <X size={17} strokeWidth={1.9} aria-hidden="true" />
            </ToolbarButton>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
