<script lang="ts">
let { size = 'medium' }: { size?: 'small' | 'medium' } = $props();
</script>

<span class="spinner" class:small={size === 'small'} aria-hidden="true"></span>

<style>
.spinner {
  width: 1rem;
  height: 1rem;
  border: 2px solid var(--color-border-strong);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.spinner.small {
  width: 0.9rem;
  height: 0.9rem;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation-duration: 1.6s;
  }
}
</style>
