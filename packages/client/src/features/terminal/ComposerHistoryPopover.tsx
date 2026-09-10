import * as Popover from '@radix-ui/react-popover';
import type { WorkspaceComposerPrompt } from '@vampire/lib/shared/contracts/workspace-composer-history.ts';
import { History, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ToolbarButton } from '~/shared/ui/index.ts';
import styles from './composer-history-popover.module.css';

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
  const restoreComposerFocus = useRef(false);
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
  }, [load, open]);
  const choose = (text: string) => {
    restoreComposerFocus.current = true;
    onSelect(text);
    setOpen(false);
    setQuery('');
  };
  const close = (restoreFocus = false) => {
    restoreComposerFocus.current = restoreFocus;
    setOpen(false);
    setQuery('');
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <ToolbarButton
          label={open ? 'Close Composer history' : 'Open Composer history'}
          title="Composer history (Ctrl+Alt+H)"
        >
          <History size={18} aria-hidden="true" />
        </ToolbarButton>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          data-vampire-overlay
          className={styles.popover}
          role="region"
          aria-label="Composer history"
          align="end"
          side="top"
          sideOffset={8}
          collisionPadding={8}
          sticky="always"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            input.current?.focus();
          }}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            close(true);
          }}
          onCloseAutoFocus={(event) => {
            if (!restoreComposerFocus.current) return;
            event.preventDefault();
            restoreComposerFocus.current = false;
            document.querySelector<HTMLTextAreaElement>('.composer-editor')?.focus();
          }}
        >
          <div className={styles.content}>
            <header className={styles.header}>
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
                    (current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length,
                  );
                } else if (event.key === 'Enter' && filtered[selected]) {
                  event.preventDefault();
                  choose(filtered[selected].text);
                }
              }}
              placeholder="Search Composer history…"
              aria-label="Search sent prompts"
              role="combobox"
              className={styles.search}
            />
            {loading ? (
              <p className={styles.message}>Loading history…</p>
            ) : error ? (
              <p className={`${styles.message} ${styles.error}`} role="alert">
                {error}
              </p>
            ) : filtered.length === 0 ? (
              <p className={styles.message}>
                {prompts.length ? `No prompts match “${query}”.` : 'Prompts sent from this Composer will appear here.'}
              </p>
            ) : (
              <div className={styles.list} role="listbox">
                {filtered.map((prompt, index) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === selected}
                    className={`${styles.item}${index === selected ? ` ${styles.selected}` : ''}`}
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
            <small className={styles.help}>Type to search · ↑↓ to choose · Enter to insert · Esc to close</small>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
