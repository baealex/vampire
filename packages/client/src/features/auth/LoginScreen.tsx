import { ArrowRight, Eye, EyeOff, LockKeyhole } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Button, Field, Input, ThemeToggle } from '~/shared/ui/index.ts';
import './login-screen.css';

export function LoginScreen({
  error,
  onSubmit,
  onTokenChange,
  token,
}: {
  error: string;
  onSubmit: () => Promise<void>;
  onTokenChange: (token: string) => void;
  token: string;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [visible, setVisible] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting || !token.trim()) return;
    setSubmitting(true);
    try {
      await onSubmit();
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <section className="login-screen" aria-label="Vampire access">
      <form className="login-panel" onSubmit={(event) => void submit(event)} aria-busy={submitting}>
        <header className="login-heading">
          <div className="login-brand">
            <img className="login-mark" src="/icon.svg" alt="" />
            <strong>Vampire</strong>
          </div>
          <ThemeToggle />
        </header>
        <div className="login-intro">
          <h1>Connect to your workspace</h1>
          <p>Enter the access token configured on your Vampire server.</p>
        </div>
        <Field label="Access token" htmlFor="token">
          <span className="login-token-field">
            <Input
              id="token"
              type={visible ? 'text' : 'password'}
              name="token"
              value={token}
              onChange={(event) => onTokenChange(event.currentTarget.value)}
              autoComplete="current-password"
              autoCapitalize="none"
              spellCheck={false}
              disabled={submitting}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'login-error login-token-hint' : 'login-token-hint'}
              required
            />
            <Button
              variant="icon"
              className="login-token-toggle"
              aria-label={visible ? 'Hide token' : 'Show token'}
              aria-pressed={visible}
              onClick={() => setVisible((current) => !current)}
            >
              {visible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
            </Button>
          </span>
        </Field>
        <div className="login-feedback">
          {error ? (
            <p id="login-error" className="login-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <Button variant="primary" size="lg" block type="submit" disabled={submitting || !token.trim()}>
          {submitting ? 'Connecting…' : 'Continue'}
          <ArrowRight size={16} aria-hidden="true" />
        </Button>
        <p id="login-token-hint" className="login-token-hint">
          <LockKeyhole size={14} aria-hidden="true" />
          Use the token from your server configuration, not your system password.
        </p>
      </form>
    </section>
  );
}
