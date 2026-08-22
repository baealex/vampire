<script lang="ts">
import type { HTMLInputAttributes } from 'svelte/elements';

let {
  value = $bindable(''),
  element = $bindable<HTMLInputElement>(),
  class: className,
  type = 'text',
  id,
  name,
  placeholder,
  disabled = false,
  required = false,
  readonly = false,
  autocomplete,
  autocapitalize,
  spellcheck,
  maxlength,
  minlength,
  min,
  max,
  step,
  ariaLabel,
  ariaInvalid,
  ariaDescribedby,
  size = 'md',
  variant = 'default',
  mono = false,
  oninput,
  onkeydown,
  onchange,
  onfocus,
  onblur,
}: {
  value?: string;
  element?: HTMLInputElement;
  class?: string;
  type?: 'text' | 'password' | 'search' | 'number' | 'datetime-local';
  id?: string;
  name?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  readonly?: boolean;
  autocomplete?: HTMLInputAttributes['autocomplete'];
  autocapitalize?: HTMLInputAttributes['autocapitalize'];
  spellcheck?: HTMLInputAttributes['spellcheck'];
  maxlength?: number;
  minlength?: number;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  ariaLabel?: string;
  ariaInvalid?: boolean | 'true' | 'false';
  ariaDescribedby?: string;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'default' | 'embedded';
  mono?: boolean;
  oninput?: (event: Event) => void;
  onkeydown?: (event: KeyboardEvent) => void;
  onchange?: (event: Event) => void;
  onfocus?: (event: FocusEvent) => void;
  onblur?: (event: FocusEvent) => void;
} = $props();

const inputClass = $derived(
  `input input--${size}${variant === 'embedded' ? ' input--embedded' : ''}${mono ? ' input--mono' : ''}${className ? ` ${className}` : ''}`
);
</script>

<input
  bind:this={element}
  class={inputClass}
  bind:value
  {type}
  {id}
  {name}
  {placeholder}
  {disabled}
  {required}
  {readonly}
  {autocomplete}
  {autocapitalize}
  {spellcheck}
  {maxlength}
  {minlength}
  {min}
  {max}
  {step}
  aria-label={ariaLabel}
  aria-invalid={ariaInvalid}
  aria-describedby={ariaDescribedby}
  {oninput}
  {onkeydown}
  {onchange}
  {onfocus}
  {onblur}
>

<style>
.input {
  width: 100%;
  min-width: 0;
  min-height: var(--control-height-md);
  padding: 0 var(--control-padding-inline-sm);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  outline: none;
  background: var(--color-field-background);
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-label);
  line-height: var(--leading-ui);
}

.input--sm {
  min-height: var(--control-height-sm);
}

.input--lg {
  min-height: var(--control-height-lg);
}

.input--mono {
  font-family: var(--font-mono);
}

.input[type="number"] {
  appearance: textfield;
  -moz-appearance: textfield;
}

.input[type="number"]::-webkit-outer-spin-button,
.input[type="number"]::-webkit-inner-spin-button {
  margin: 0;
  -webkit-appearance: none;
}

.input--embedded {
  min-height: 0;
  padding: 0 var(--space-2);
  border: 0;
  border-radius: 0;
  background: transparent;
}

.input:focus {
  border-color: var(--color-accent);
  box-shadow: var(--shadow-accent-focus);
}

.input:focus-visible {
  outline: none;
}

.input--embedded:focus {
  border-color: transparent;
  box-shadow: none;
}

.input::placeholder {
  color: var(--color-field-placeholder);
}

.input:disabled {
  cursor: wait;
  opacity: 0.62;
}

.input[aria-invalid="true"] {
  border-color: var(--color-danger-border-strong);
}

@media (max-width: 32rem) {
  .input:not(.input--embedded) {
    font-size: 1rem;
  }
}
</style>
