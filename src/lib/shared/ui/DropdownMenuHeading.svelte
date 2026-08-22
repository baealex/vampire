<script lang="ts">
let { title, subtitle }: { title: string; subtitle: string } = $props();
</script>

<div class="heading" role="presentation">
  <strong>{title}</strong>
  <span>{subtitle}</span>
</div>

<style>
.heading {
  display: grid;
  min-width: 0;
  gap: 0.15rem;
  padding: 0.45rem 0.55rem;
}

.heading strong,
.heading span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.heading strong {
  color: var(--color-text);
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
}

.heading span {
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
  font-size: var(--text-micro);
}
</style>
