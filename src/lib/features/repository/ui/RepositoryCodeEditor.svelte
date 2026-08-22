<script lang="ts">
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { onMount } from 'svelte';
import { themeState } from '~/lib/shared/theme/theme.svelte';
import { RepositoryClient } from '../api/client';
import type { WorkspaceFile } from '~/lib/shared/contracts/repository';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const textEncoder = new TextEncoder();

let {
  workspaceId,
  file,
  onSaved,
  onDirtyChange,
}: {
  workspaceId: string;
  file: WorkspaceFile;
  onSaved: (file: WorkspaceFile) => void;
  onDirtyChange?: (dirty: boolean) => void;
} = $props();

let editorHost = $state<HTMLDivElement>();
let editorView: EditorView | undefined;
let themeCompartment = new Compartment();
let editorReady = $state(false);
let dirty = $state(false);
let saving = $state(false);
let saveError = $state('');
let savedContent = $state('');
let currentVersion = $state('');
let byteSize = $state(0);
const saveStatus = $derived(saving ? 'Saving…' : saveError ? 'Save failed' : dirty ? 'Unsaved changes' : 'Saved');

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
        padding: '0.85rem 0 3rem',
        fontSize: '0.8125rem',
        lineHeight: '1.55',
        caretColor: 'var(--color-accent)',
        fontFamily: 'inherit',
      },
      '.cm-line': {
        padding: '0 1rem 0 0.75rem',
      },
      '.cm-gutters': {
        borderRight: '1px solid var(--color-border-subtle)',
        backgroundColor: 'var(--color-code-background)',
        color: 'var(--color-text-disabled)',
      },
      '.cm-lineNumbers .cm-gutterElement': {
        minWidth: '2.6rem',
        padding: '0 0.55rem 0 0.35rem',
        textAlign: 'right',
      },
      '.cm-activeLine, .cm-activeLineGutter': {
        backgroundColor: 'var(--color-surface-raised)',
      },
      '.cm-activeLineGutter': {
        color: 'var(--color-text-secondary)',
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
      '.cm-scroller, .cm-content, .cm-gutters': {
        colorScheme: dark ? 'dark' : 'light',
      },
    },
    { dark }
  );
}

const repositoryApi = $derived(new RepositoryClient(workspaceId));

async function saveFile() {
  if (!editorView || saving || !dirty) return;
  const content = editorView.state.doc.toString();
  const contentBytes = textEncoder.encode(content).byteLength;
  if (contentBytes > MAX_FILE_BYTES) {
    saveError = 'Files larger than 5 MB cannot be saved.';
    return;
  }

  saving = true;
  saveError = '';
  const versionAtSave = currentVersion;
  try {
    const saved = await repositoryApi.updateFile(file.path, content, versionAtSave);
    currentVersion = saved.version;
    savedContent = saved.content;
    byteSize = textEncoder.encode(content).byteLength;
    const currentContent = editorView?.state.doc.toString() ?? content;
    dirty = currentContent !== savedContent;
    onDirtyChange?.(dirty);
    onSaved(saved);
  } catch (error) {
    saveError = error instanceof Error ? error.message : 'The file could not be saved.';
  } finally {
    saving = false;
  }
}

$effect(() => {
  const dark = themeState.current === 'dark';
  if (!editorReady || !editorView) return;
  editorView.dispatch({ effects: themeCompartment.reconfigure(editorTheme(dark)) });
});

onMount(() => {
  if (!editorHost) return;
  savedContent = file.content;
  currentVersion = file.version;
  byteSize = textEncoder.encode(file.content).byteLength;
  const saveKeymap = keymap.of([
    {
      key: 'Mod-s',
      run: () => {
        void saveFile();
        return true;
      },
    },
  ]);
  const updateListener = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    const content = update.state.doc.toString();
    byteSize = textEncoder.encode(content).byteLength;
    dirty = content !== savedContent;
    saveError = '';
    onDirtyChange?.(dirty);
  });
  const state = EditorState.create({
    doc: file.content,
    extensions: [
      themeCompartment.of(editorTheme(themeState.current === 'dark')),
      lineNumbers(),
      EditorView.lineWrapping,
      drawSelection(),
      highlightActiveLine(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      saveKeymap,
      updateListener,
    ],
  });
  editorView = new EditorView({ state, parent: editorHost });
  editorReady = true;
  onDirtyChange?.(false);
  editorView.focus();

  return () => {
    editorView?.destroy();
    editorView = undefined;
  };
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
</script>

<div class="code-editor" aria-label={`Edit ${file.path}`}>
  <div bind:this={editorHost} class="editor-host"></div>
  <footer class="editor-status">
    <span>{formatBytes(byteSize)} / 5 MB</span>
    <span class:error={Boolean(saveError)} role="status">{saveStatus}</span>
    <button type="button" class="save-button" onclick={() => void saveFile()} disabled={!dirty || saving}>
      {saving ? 'Saving…' : 'Save'}
    </button>
  </footer>
  {#if saveError}
    <p class="editor-error" role="alert">{saveError}</p>
  {/if}
</div>

<style>
.code-editor {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: var(--color-code-background);
  color: var(--color-text);
}
.editor-host {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  touch-action: auto;
}
.editor-host :global(.cm-editor) {
  height: 100%;
}
.editor-host :global(.cm-content),
.editor-host :global(.cm-line) {
  user-select: text;
  -webkit-user-select: text;
}
.editor-status {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 0.8rem;
  min-height: var(--control-height-sm);
  padding: 0.25rem 0.7rem;
  border-top: 1px solid var(--color-border-subtle);
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  font-variant-numeric: tabular-nums;
}
.editor-status > span:nth-child(2) {
  margin-left: auto;
}
.editor-status .error {
  color: var(--color-danger-text);
}
.save-button {
  min-height: 1.8rem;
  padding: 0 0.6rem;
  border: 1px solid var(--color-accent);
  border-radius: 0.38rem;
  background: var(--color-accent);
  color: var(--color-accent-ink);
  font: inherit;
  font-weight: var(--weight-medium);
  cursor: pointer;
}
@media (hover: hover) {
  .save-button:hover:not(:disabled) {
    border-color: var(--color-accent-hover);
    background: var(--color-accent-hover);
  }
}
.save-button:disabled {
  cursor: default;
  opacity: 0.5;
}
.editor-error {
  flex: 0 0 auto;
  margin: 0;
  padding: 0.4rem 0.7rem;
  border-top: 1px solid var(--color-danger-border);
  background: var(--color-danger-surface);
  color: var(--color-danger-text);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}

@media (max-width: 40rem) {
  .editor-status {
    gap: 0.5rem;
    padding-inline: 0.5rem;
  }
  .editor-status > span:first-child {
    display: none;
  }
}
</style>
