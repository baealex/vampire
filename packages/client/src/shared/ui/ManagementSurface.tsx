import { ArrowLeft, X } from 'lucide-react';
import { type PropsWithChildren, type ReactNode, useEffect, useRef, useState } from 'react';
import { registerNavigationGuard } from '../lib/navigation-guard.ts';
import { Button } from './Button.tsx';
import { Dialog } from './Dialog.tsx';
import { ToolbarButton } from './ToolbarButton.tsx';
import './management-surface.css';

export function ManagementSurface({
  back,
  backLabel,
  busy = false,
  children,
  close,
  closeLabel = 'Close',
  dirty = false,
  eyebrow,
  footer,
  title,
  titleId,
}: PropsWithChildren<{
  back?: () => void;
  backLabel?: string;
  busy?: boolean;
  close: () => void;
  closeLabel?: string;
  dirty?: boolean;
  eyebrow?: string;
  footer?: ReactNode;
  title: string;
  titleId: string;
}>) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const pendingNavigation = useRef<((discard: boolean) => void) | undefined>(undefined);
  useEffect(() => heading.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    if (!dirty) return;
    const unregister = registerNavigationGuard(() => {
      if (busy) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        pendingNavigation.current?.(false);
        pendingNavigation.current = resolve;
        setDiscardOpen(true);
      });
    });
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventUnload);
    return () => {
      unregister();
      window.removeEventListener('beforeunload', preventUnload);
      pendingNavigation.current?.(false);
      pendingNavigation.current = undefined;
    };
  }, [busy, dirty]);
  const resolveDiscard = (discard: boolean) => {
    setDiscardOpen(false);
    pendingNavigation.current?.(discard);
    pendingNavigation.current = undefined;
  };
  return (
    <section className={`management-surface${back ? ' has-back' : ''}`} aria-labelledby={titleId}>
      <header className="management-header">
        <div className={`management-header-inner${back ? ' has-back' : ''}`}>
          {back ? (
            <ToolbarButton className="management-back" label={backLabel ?? 'Back'} onClick={back} disabled={busy}>
              <ArrowLeft size={19} strokeWidth={1.8} aria-hidden="true" />
            </ToolbarButton>
          ) : null}
          <div className="management-heading">
            {eyebrow ? <p>{eyebrow}</p> : null}
            <h1 ref={heading} id={titleId} tabIndex={-1}>
              {title}
            </h1>
          </div>
          <ToolbarButton className="management-close" label={closeLabel} onClick={close} disabled={busy}>
            <X size={19} strokeWidth={1.8} aria-hidden="true" />
          </ToolbarButton>
        </div>
      </header>
      <div className="management-body">
        <div className="management-content">
          {children}
          {footer ? <footer>{footer}</footer> : null}
        </div>
      </div>
      <Dialog
        open={discardOpen}
        role="alertdialog"
        title="Discard unsaved changes?"
        onClose={() => resolveDiscard(false)}
        footer={
          <>
            <Button data-autofocus onClick={() => resolveDiscard(false)}>
              Keep editing
            </Button>
            <Button variant="danger" onClick={() => resolveDiscard(true)}>
              Discard changes
            </Button>
          </>
        }
      >
        <p>Your changes on this page have not been saved.</p>
      </Dialog>
    </section>
  );
}
