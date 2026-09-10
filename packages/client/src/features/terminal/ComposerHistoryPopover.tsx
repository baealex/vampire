import { History, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WorkspaceComposerPrompt } from '@vampire/lib/shared/contracts/workspace-composer-history.ts';
import { ToolbarButton } from '~/shared/ui/index.ts';
import './composer-history-popover.css';

export function ComposerHistoryPopover({
  load,
  onSelect,
}: {
  load: () => Promise<WorkspaceComposerPrompt[]>;
  onSelect: (prompt: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [prompts, setPrompts] = useState<WorkspaceComposerPrompt[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? prompts.filter((prompt) => prompt.text.toLocaleLowerCase().includes(needle)) : prompts;
  }, [prompts, query]);
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError('');
    void load()
      .then(setPrompts)
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'Unable to load Composer history.'))
      .finally(() => setLoading(false));
    window.setTimeout(() => input.current?.focus(), 0);
  }, [load, open]);
  const choose = (text: string) => {
    onSelect(text);
    setOpen(false);
    setQuery('');
  };
  const close = (restoreComposerFocus = false) => {
    setOpen(false);
    setQuery('');
    if (restoreComposerFocus)
      window.setTimeout(() => document.querySelector<HTMLTextAreaElement>('.composer-editor')?.focus(), 0);
  };
  return (
    <div className="composer-history">
      <ToolbarButton
        label={open ? 'Close Composer history' : 'Open Composer history'}
        title="Composer history (Ctrl+Alt+H)"
        onClick={() => setOpen((value) => !value)}
      >
        <History size={18} aria-hidden="true" />
      </ToolbarButton>
      {open
        ? createPortal(
            <section data-vampire-overlay role="region" aria-label="Composer history">
              <header>
                <strong>Composer history</strong>
                <ToolbarButton label="Close Composer history" onClick={() => close(true)}>
                  <X size={15} />
                </ToolbarButton>
              </header>
              <input
                ref={input}
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                  setSelected(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    close(true);
                  } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && filtered.length) {
                    event.preventDefault();
                    setSelected(
                      (current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length
                    );
                  } else if (event.key === 'Enter' && filtered[selected]) {
                    event.preventDefault();
                    choose(filtered[selected].text);
                  }
                }}
                placeholder="Search Composer history…"
                aria-label="Search sent prompts"
                role="combobox"
              />
              {loading ? (
                <p>Loading history…</p>
              ) : error ? (
                <p role="alert">{error}</p>
              ) : filtered.length === 0 ? (
                <p>
                  {prompts.length
                    ? `No prompts match “${query}”.`
                    : 'Prompts sent from this Composer will appear here.'}
                </p>
              ) : (
                <div role="listbox">
                  {filtered.map((prompt, index) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === selected}
                      className={index === selected ? 'selected' : ''}
                      key={prompt.id}
                      onMouseEnter={() => setSelected(index)}
                      onClick={() => choose(prompt.text)}
                    >
                      <span>{prompt.text}</span>
                      <time>{new Date(prompt.submittedAt).toLocaleString()}</time>
                    </button>
                  ))}
                </div>
              )}
              <small>Type to search · ↑↓ to choose · Enter to insert · Esc to close</small>
            </section>,
            document.body
          )
        : null}
    </div>
  );
}
