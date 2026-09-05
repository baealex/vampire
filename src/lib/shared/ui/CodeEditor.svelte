<script lang="ts">
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
  placeholder as editorPlaceholder,
} from '@codemirror/view';
import { onMount } from 'svelte';
import { themeState } from '~/lib/shared/theme/theme.svelte';

let {
  value = '',
  ariaLabel,
  placeholder = '',
  maxlength,
  disabled = false,
  compact = false,
  onReady = () => undefined,
  onValueChange = () => undefined,
}: {
  value?: string;
  ariaLabel: string;
  placeholder?: string;
  maxlength?: number;
  disabled?: boolean;
  compact?: boolean;
  onReady?: (controller: { focus: () => void; insert: (text: string) => void } | undefined) => void;
  onValueChange?: (value: string) => void;
} = $props();

let editorHost = $state<HTMLDivElement>();
let editorView: EditorView | undefined;
let editorReady = $state(false);
const themeCompartment = new Compartment();
const editableCompartment = new Compartment();

function editorTheme(dark: boolean): Extension {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        backgroundColor: 'var(--color-code-background)',
        color: 'var(--color-code-text)',
      },
      '.cm-scroller': {
        overflow: 'auto',
        fontFamily: 'var(--font-mono)',
      },
      '.cm-content': {
        minHeight: '100%',
        padding: '0.7rem 0 2rem',
        fontSize: '0.8125rem',
        lineHeight: '1.55',
        caretColor: 'var(--color-accent)',
        fontFamily: 'inherit',
      },
      '.cm-line': {
        padding: '0 0.85rem 0 0.65rem',
      },
      '.cm-gutters': {
        borderRight: '1px solid var(--color-border-subtle)',
        backgroundColor: 'var(--color-code-background)',
        color: 'var(--color-text-disabled)',
      },
      '.cm-lineNumbers .cm-gutterElement': {
        minWidth: '2.4rem',
        padding: '0 0.5rem 0 0.3rem',
        textAlign: 'right',
      },
      '.cm-activeLine, .cm-activeLineGutter': {
        backgroundColor: 'var(--color-surface-raised)',
      },
      '.cm-selectionBackground, ::selection': {
        backgroundColor: 'var(--color-terminal-selection) !important',
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: 'var(--color-accent)',
      },
      '.cm-focused': {
        outline: 'none',
      },
      '.cm-placeholder': {
        color: 'var(--color-field-placeholder)',
      },
      '.cm-scroller, .cm-content, .cm-gutters': {
        colorScheme: dark ? 'dark' : 'light',
      },
    },
    { dark }
  );
}

$effect(() => {
  const dark = themeState.current === 'dark';
  if (!editorReady || !editorView) return;
  editorView.dispatch({ effects: themeCompartment.reconfigure(editorTheme(dark)) });
});

$effect(() => {
  const editable = !disabled;
  if (!editorReady || !editorView) return;
  editorView.dispatch({
    effects: editableCompartment.reconfigure([EditorState.readOnly.of(!editable), EditorView.editable.of(editable)]),
  });
});

$effect(() => {
  const nextValue = value;
  if (!editorReady || !editorView || editorView.state.doc.toString() === nextValue) return;
  editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: nextValue } });
});

onMount(() => {
  if (!editorHost) return;
  const extensions: Extension[] = [
    themeCompartment.of(editorTheme(themeState.current === 'dark')),
    editableCompartment.of([EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled)]),
    lineNumbers(),
    EditorView.lineWrapping,
    drawSelection(),
    highlightActiveLine(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      value = update.state.doc.toString();
      onValueChange(value);
    }),
  ];
  if (placeholder) extensions.push(editorPlaceholder(placeholder));
  if (maxlength !== undefined) {
    extensions.push(
      EditorState.transactionFilter.of((transaction) => (transaction.newDoc.length <= maxlength ? transaction : []))
    );
  }
  editorView = new EditorView({
    state: EditorState.create({ doc: value, extensions }),
    parent: editorHost,
  });
  editorReady = true;
  onReady({
    focus: () => editorView?.focus(),
    insert: (text) => {
      if (!editorView || disabled) return;
      const selection = editorView.state.selection.main;
      editorView.dispatch({
        changes: { from: selection.from, to: selection.to, insert: text },
        selection: { anchor: selection.from + text.length },
        scrollIntoView: true,
      });
      editorView.focus();
    },
  });

  return () => {
    onReady(undefined);
    editorView?.destroy();
    editorView = undefined;
  };
});
</script>

<div class="code-editor" class:compact>
  <div bind:this={editorHost} class="editor-host"></div>
</div>

<style>
.code-editor {
  width: 100%;
  height: clamp(18rem, calc(100dvh - 20rem), 38rem);
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: var(--color-code-background);
}
.code-editor:focus-within {
  border-color: var(--color-accent);
  box-shadow: var(--shadow-accent-focus);
}
.code-editor.compact {
  height: clamp(13rem, 30dvh, 22rem);
}
.editor-host,
.editor-host :global(.cm-editor) {
  width: 100%;
  height: 100%;
  min-width: 0;
}
.editor-host :global(.cm-content),
.editor-host :global(.cm-line) {
  user-select: text;
  -webkit-user-select: text;
}
@media (max-width: 32rem) {
  .code-editor {
    height: clamp(14rem, calc(100dvh - 18rem), 32rem);
  }
}
</style>
