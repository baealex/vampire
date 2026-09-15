import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { useEffect, useRef } from 'react';

export function CodeEditor({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  const viewRef = useRef<EditorView | null>(null);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          lineNumbers(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': label }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
          EditorView.theme({
            '&': {
              height: '100%',
              backgroundColor: 'var(--color-code-background)',
              color: 'var(--color-code-text)',
            },
            '.cm-scroller': {
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-label)',
            },
            '.cm-content': { minHeight: '12rem' },
            '&.cm-focused': { outline: 'none' },
            '.cm-gutters': {
              backgroundColor: 'var(--color-surface-sunken)',
              color: 'var(--color-text-tertiary)',
              border: '0',
            },
            '.cm-cursor': { borderLeftColor: 'var(--color-terminal-cursor)' },
            '.cm-selectionBackground': { backgroundColor: 'var(--color-terminal-selection) !important' },
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, [label]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={host} className="vampire-code-editor" />;
}
