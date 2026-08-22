<script lang="ts">
let {
  value = $bindable(''),
  element = $bindable<HTMLTextAreaElement>(),
  class: className,
  id,
  name,
  placeholder,
  disabled = false,
  required = false,
  readonly = false,
  rows = 4,
  maxlength,
  spellcheck,
  wrap,
  ariaLabel,
  ariaDescribedby,
  size = 'md',
  mono = false,
  oninput,
  onkeydown,
  onfocus,
  onblur,
}: {
  value?: string;
  element?: HTMLTextAreaElement;
  class?: string;
  id?: string;
  name?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  readonly?: boolean;
  rows?: number;
  maxlength?: number;
  spellcheck?: boolean;
  wrap?: 'hard' | 'soft' | 'off';
  ariaLabel?: string;
  ariaDescribedby?: string;
  size?: 'sm' | 'md' | 'fill' | 'code';
  mono?: boolean;
  oninput?: (event: Event) => void;
  onkeydown?: (event: KeyboardEvent) => void;
  onfocus?: (event: FocusEvent) => void;
  onblur?: (event: FocusEvent) => void;
} = $props();

const textareaClass = $derived(`textarea textarea--${size}${mono ? ' textarea--mono' : ''}`);
const resolvedTextareaClass = $derived(`${textareaClass}${className ? ` ${className}` : ''}`);
</script>

<textarea
  bind:this={element}
  class={resolvedTextareaClass}
  bind:value
  {id}
  {name}
  {placeholder}
  {disabled}
  {required}
  {readonly}
  {rows}
  {maxlength}
  {spellcheck}
  {wrap}
  aria-label={ariaLabel}
  aria-describedby={ariaDescribedby}
  {oninput}
  {onkeydown}
  {onfocus}
  {onblur}
></textarea>

<style>
.textarea {
  width: 100%;
  min-width: 0;
  min-height: 7rem;
  padding: var(--space-4) var(--control-padding-inline-sm);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  outline: none;
  background: var(--color-field-background);
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-body);
  line-height: var(--leading-body);
  resize: vertical;
}

.textarea--sm {
  min-height: var(--control-height-sm);
  padding-block: var(--space-2);
}

.textarea--fill {
  height: 100%;
  min-height: 0;
  resize: none;
}

.textarea--code {
  min-height: 12rem;
  padding-block: var(--space-3);
  resize: vertical;
  font-family: var(--font-mono);
  line-height: 1.45;
  tab-size: 2;
  white-space: pre;
  overflow: auto;
}

.textarea--mono {
  font-family: var(--font-mono);
}

.textarea:focus {
  border-color: var(--color-accent);
  box-shadow: var(--shadow-accent-focus);
}

.textarea:focus-visible {
  outline: none;
}

.textarea::placeholder {
  color: var(--color-field-placeholder);
}

.textarea:disabled {
  cursor: wait;
  opacity: 0.62;
}

@media (max-width: 32rem) {
  .textarea:not(.textarea--code) {
    font-size: 1rem;
  }
}
</style>
