import type { PropsWithChildren } from 'react';
import './primitives.css';

export function Field({
  children,
  description,
  error,
  htmlFor,
  label,
}: PropsWithChildren<{ description?: string; error?: string; htmlFor?: string; label: string }>) {
  return (
    <label className="vampire-field" htmlFor={htmlFor}>
      <span className="vampire-field__label">{label}</span>
      {children}
      {description ? <span className="vampire-field__description">{description}</span> : null}
      {error ? (
        <span className="vampire-field__error" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}
