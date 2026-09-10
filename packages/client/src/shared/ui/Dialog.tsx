import * as DialogPrimitive from '@baejino/react-ui/modal/dialog';
import { X } from 'lucide-react';
import { useRef, type PropsWithChildren, type ReactNode } from 'react';
import './dialog.css';

export function Dialog({
  children,
  footer,
  onClose,
  open,
  role = 'dialog',
  title,
}: PropsWithChildren<{
  footer?: ReactNode;
  onClose: () => void;
  open: boolean;
  role?: 'dialog' | 'alertdialog';
  title: string;
}>) {
  const content = useRef<HTMLDivElement>(null);
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="vampire-dialog-overlay" />
        <DialogPrimitive.Content
          ref={content}
          className="vampire-dialog-content"
          data-vampire-overlay
          role={role}
          onOpenAutoFocus={(event) => {
            const target = content.current?.querySelector<HTMLElement>('[data-autofocus]');
            if (!target) return;
            event.preventDefault();
            target.focus({ preventScroll: true });
          }}
        >
          <header className="vampire-dialog-header">
            <DialogPrimitive.Title className="vampire-dialog-title">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close className="vampire-dialog-close" aria-label="Close">
              <X size={18} aria-hidden="true" />
            </DialogPrimitive.Close>
          </header>
          <div className="vampire-dialog-body">{children}</div>
          {footer ? <footer className="vampire-dialog-footer">{footer}</footer> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
