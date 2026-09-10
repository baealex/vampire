import type { FormEvent } from 'react';
import { Button, Field, Input, ThemeToggle } from '~/shared/ui/index.ts';
import './login-screen.css';

export function LoginScreen({
  error,
  onSubmit,
  onTokenChange,
  token,
}: {
  error: string;
  onSubmit: () => void;
  onTokenChange: (token: string) => void;
  token: string;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };
  return (
    <section className="login-screen" aria-label="Vampire access">
      <form className="login-panel" onSubmit={submit}>
        <header className="login-heading">
          <div className="login-brand">
            <img className="login-mark" src="/icon.svg" alt="" />
            <strong>Vampire</strong>
          </div>
          <ThemeToggle />
        </header>
        <Field label="VAMPIRE_TOKEN" htmlFor="token">
          <Input
            id="token"
            type="password"
            value={token}
            onChange={(event) => onTokenChange(event.currentTarget.value)}
            autoComplete="current-password"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'login-error' : undefined}
            required
          />
        </Field>
        <Button variant="primary" size="lg" block type="submit">
          Continue
        </Button>
        {error ? (
          <p id="login-error" className="login-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </section>
  );
}
