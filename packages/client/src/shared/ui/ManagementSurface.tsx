import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef, type PropsWithChildren, type ReactNode } from 'react';
import './management-surface.css';

export function ManagementSurface({
  back,
  backLabel,
  busy = false,
  children,
  close,
  closeLabel = 'Close',
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
  eyebrow?: string;
  footer?: ReactNode;
  title: string;
  titleId: string;
}>) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus({ preventScroll: true }), []);
  return (
    <section className="management-surface" aria-labelledby={titleId}>
      <header className="management-header">
        <div className="management-header-inner">
          <button
            type="button"
            className="management-back"
            onClick={back ?? close}
            disabled={busy}
            aria-label={back ? (backLabel ?? 'Back') : closeLabel}
          >
            <ArrowLeft size={19} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <div className="management-heading">
            {eyebrow ? <p>{eyebrow}</p> : null}
            <h1 ref={heading} id={titleId} tabIndex={-1}>
              {title}
            </h1>
          </div>
        </div>
      </header>
      <div className="management-body">
        <div className="management-content">
          {children}
          {footer ? <footer>{footer}</footer> : null}
        </div>
      </div>
    </section>
  );
}
