<script lang="ts">
import guideMarkdown from './status-widget-guide.md?raw';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function inlineMarkup(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function renderGuide(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let paragraph: string[] = [];
  let listType: 'ul' | 'ol' | undefined;
  let code = false;

  function flushParagraph() {
    if (paragraph.length === 0) return;
    html.push(`<p>${inlineMarkup(paragraph.join(' '))}</p>`);
    paragraph = [];
  }

  function closeList() {
    if (!listType) return;
    html.push(`</${listType}>`);
    listType = undefined;
  }

  for (const line of lines) {
    if (code) {
      if (/^```\s*$/.test(line)) {
        html.push('</code></pre>');
        code = false;
      } else {
        html.push(`${escapeHtml(line)}\n`);
      }
      continue;
    }

    if (/^```(?:[a-zA-Z0-9_-]+)?\s*$/.test(line)) {
      flushParagraph();
      closeList();
      html.push('<pre><code>');
      code = true;
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1]!.length;
      html.push(`<h${level}>${inlineMarkup(heading[2]!)}</h${level}>`);
      continue;
    }

    const unordered = /^[-*]\s+(.+)$/.exec(line);
    const ordered = /^\d+\.\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const nextListType = unordered ? 'ul' : 'ol';
      if (listType !== nextListType) {
        closeList();
        html.push(`<${nextListType}>`);
        listType = nextListType;
      }
      html.push(`<li>${inlineMarkup((unordered ?? ordered)![1]!)}</li>`);
      continue;
    }

    closeList();
    paragraph.push(line.trim());
  }

  if (code) html.push('</code></pre>');
  flushParagraph();
  closeList();
  return html.join('');
}

const renderedGuide = renderGuide(guideMarkdown);
</script>

<article class="status-widget-guide">{@html renderedGuide}</article>

<style>
.status-widget-guide {
  display: grid;
  gap: 0.85rem;
  color: var(--color-text-secondary);
  font-size: var(--text-body);
  line-height: var(--leading-body);
}
.status-widget-guide :global(h1),
.status-widget-guide :global(h2),
.status-widget-guide :global(h3),
.status-widget-guide :global(p),
.status-widget-guide :global(ul),
.status-widget-guide :global(ol),
.status-widget-guide :global(pre) {
  margin: 0;
}
.status-widget-guide :global(h1) {
  color: var(--color-text);
  font-size: var(--text-heading);
  font-weight: var(--weight-strong);
  line-height: var(--leading-tight);
}
.status-widget-guide :global(h2) {
  margin-top: 0.45rem;
  color: var(--color-text);
  font-size: var(--text-label);
  font-weight: var(--weight-strong);
  line-height: var(--leading-ui);
}
.status-widget-guide :global(h3) {
  color: var(--color-text);
  font-size: var(--text-label);
  font-weight: var(--weight-strong);
  line-height: var(--leading-ui);
}
.status-widget-guide :global(ul),
.status-widget-guide :global(ol) {
  display: grid;
  gap: 0.34rem;
  padding-left: 1.2rem;
}
.status-widget-guide :global(li) {
  padding-left: 0.12rem;
}
.status-widget-guide :global(strong) {
  color: var(--color-text);
  font-weight: var(--weight-medium);
}
.status-widget-guide :global(code) {
  padding: 0.08rem 0.25rem;
  border-radius: 0.25rem;
  background: var(--color-surface-raised);
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: 0.92em;
}
.status-widget-guide :global(pre) {
  min-width: 0;
  max-width: 100%;
  overflow: auto;
  padding: 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-control-background);
}
.status-widget-guide :global(pre code) {
  display: block;
  padding: 0;
  background: transparent;
  color: var(--color-text);
  font-size: var(--text-label);
  line-height: 1.55;
  white-space: pre;
}
.status-widget-guide :global(a) {
  color: var(--color-accent);
  text-decoration: underline;
  text-underline-offset: 0.15em;
}
</style>
