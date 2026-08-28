<script lang="ts">
import Button from '~/lib/shared/ui/Button.svelte';
import Field from '~/lib/shared/ui/Field.svelte';
import Input from '~/lib/shared/ui/Input.svelte';
import ThemeToggle from '~/lib/shared/theme/ThemeToggle.svelte';

let {
  token,
  error,
  onTokenChange,
  onSubmit,
}: {
  token: string;
  error: string;
  onTokenChange: (token: string) => void;
  onSubmit: () => void;
} = $props();
</script>

<section class="login-screen" aria-label="Vampire access">
  <form class="login-panel" onsubmit={(event) => { event.preventDefault(); onSubmit(); }}>
    <header class="login-heading">
      <div class="login-brand">
        <img class="login-mark" src="/icon.svg" alt="">
        <strong>Vampire</strong>
      </div>
      <ThemeToggle />
    </header>
    <Field label="VAMPIRE_TOKEN" id="token">
      <Input
        id="token"
        type="password"
        value={token}
        oninput={(event) => onTokenChange((event.currentTarget as HTMLInputElement).value)}
        autocomplete="current-password"
        ariaInvalid={error ? 'true' : undefined}
        ariaDescribedby={error ? 'login-error' : undefined}
        required
      />
    </Field>
    <Button variant="primary" size="lg" block type="submit">Continue</Button>
    {#if error}
      <p id="login-error" class="error" role="alert">{error}</p>
    {/if}
  </form>
</section>

<style>
.login-screen {
  display: grid;
  min-height: 100dvh;
  place-items: center;
  overflow: hidden;
  padding: max(1rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right))
    max(1rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left));
  background: var(--color-canvas);
  color: var(--color-text);
}
.login-panel {
  display: grid;
  width: min(100%, 25rem);
  min-width: 0;
  gap: 1.25rem;
  padding: 1.5rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: var(--shadow-dialog);
}
.login-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
.login-brand {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.7rem;
}
.login-brand strong {
  font-size: var(--text-heading);
  font-weight: var(--weight-strong);
  line-height: var(--leading-tight);
}
.login-mark {
  display: block;
  width: 2.75rem;
  height: 2.75rem;
  border-radius: var(--radius-md);
}
.error {
  margin: 0.1rem 0 0;
  color: var(--color-danger);
  font-size: var(--text-label);
  line-height: var(--leading-ui);
}

@media (max-width: 48rem) {
  .login-screen {
    overflow: auto;
  }
}
</style>
