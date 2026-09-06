<script lang="ts">
import Send from '@lucide/svelte/icons/send';
import ImagePlus from '@lucide/svelte/icons/image-plus';
import ArrowLeftRight from '@lucide/svelte/icons/arrow-left-right';
import Ellipsis from '@lucide/svelte/icons/ellipsis';
import PopoverShell from '~/lib/shared/ui/PopoverShell.svelte';
import { onDestroy, onMount } from 'svelte';
import {
  parseWorkspaceEntryDragEntries,
  WORKSPACE_ENTRY_DRAG_TYPE,
  workspaceEntryDragText,
} from '~/lib/shared/lib/workspace-entry-drag.ts';
import { loadComposerDraft, saveComposerDraft } from '../model/composer-draft-storage.ts';
import {
  captureComposerEditorState,
  loadComposerEditorState,
  normalizeComposerEditorState,
  restoreComposerEditorState,
  saveComposerEditorState,
  type ComposerEditorState,
} from '../model/composer-editor-state.ts';
import { composerKeyboardCommand } from '../model/composer-keyboard.ts';
import type { RecoverableComposerSubmission } from '../model/composer-submission.ts';
import {
  isInputSurfaceToggleShortcut,
  terminalScrollCommand,
  type TerminalControlKey,
} from '../model/terminal-control.ts';
import { renderComposerTemplate, type ComposerTemplateContext } from '~/lib/shared/lib/composer-template.ts';
import type { WorkspaceComposerPrompt } from '~/lib/shared/contracts/workspace-composer-history.ts';
import ComposerHistoryDialog from './ComposerHistoryDialog.svelte';
import ComposerSubmissionRecovery from './ComposerSubmissionRecovery.svelte';

let {
  workspaceId,
  terminalId,
  connected,
  inputSurface = 'compose',
  composerTemplate,
  composerTemplateContext,
  sendControl,
  submit,
  composerHistoryEnabled = true,
  onSubmitted,
  loadPrompts,
  onImageSelected,
  scrollPageUp,
  scrollPageDown,
  scrollToTop,
  scrollToBottom,
  handoffToTerminal,
  onToggleInputSurface,
  onComposerFocus = () => undefined,
  recoverableSubmissions = [],
  onDismissSubmission = () => undefined,
  composerElement = $bindable(),
}: {
  workspaceId: string;
  terminalId?: string;
  connected: boolean;
  inputSurface?: 'compose' | 'terminal';
  composerTemplate?: string;
  composerTemplateContext: ComposerTemplateContext;
  sendControl: (control: TerminalControlKey) => void;
  submit: (data: string, draft: string) => boolean;
  composerHistoryEnabled?: boolean;
  onSubmitted: (prompt: string) => Promise<void>;
  loadPrompts: (refresh?: boolean) => Promise<WorkspaceComposerPrompt[]>;
  onImageSelected: (image: File) => void;
  scrollPageUp: () => void;
  scrollPageDown: () => void;
  scrollToTop: () => void;
  scrollToBottom: () => void;
  handoffToTerminal: (data: string) => boolean;
  onToggleInputSurface: () => void;
  onComposerFocus?: () => void;
  recoverableSubmissions?: RecoverableComposerSubmission[];
  onDismissSubmission?: (requestId: string) => void;
  composerElement?: HTMLTextAreaElement;
} = $props();

let imageInputElement: HTMLInputElement;
let composerMessage = $state('');
let additionalComposerLines = $state(0);
let lineMeasurementQueued = false;
let composerDropActive = $state(false);
let messageActionsOpen = $state(false);
let inputShortcut = $state('Ctrl + `');
let messageActionHandoff = false;
let draftPersistenceTimer: ReturnType<typeof setTimeout> | undefined;
let pendingDraftValue = '';
let editorPersistenceTimer: ReturnType<typeof setTimeout> | undefined;
let pendingEditorState: ComposerEditorState | undefined;
let draftStorageReady = false;
let draftPersistenceFailed = $state(false);
let editorPersistenceFailed = $state(false);
let savedEditorState: ComposerEditorState | undefined;
let overlayEditorState: ComposerEditorState | undefined;
let terminalControlFocusTarget: HTMLElement | undefined;
let historyLoadRequest = 0;
let disposed = false;
const deferredFrames = new Set<number>();

function deferFrame(callback: () => void) {
  if (disposed) return;
  const frame = requestAnimationFrame(() => {
    deferredFrames.delete(frame);
    if (!disposed) callback();
  });
  deferredFrames.add(frame);
}

function measureComposerLines() {
  if (!composerElement || lineMeasurementQueued) return;
  lineMeasurementQueued = true;
  deferFrame(() => {
    lineMeasurementQueued = false;
    if (!composerElement) return;
    const style = getComputedStyle(composerElement);
    const lineHeight = Number.parseFloat(style.lineHeight);
    const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    const contentScrollHeight = Math.max(0, composerElement.scrollHeight - verticalPadding);
    additionalComposerLines =
      composerMessage && lineHeight > 0 ? Math.max(0, Math.round(contentScrollHeight / lineHeight) - 1) : 0;
  });
}

$effect(() => {
  void composerMessage;
  void composerElement;
  measureComposerLines();
});

function flushComposerDraft(value = pendingDraftValue) {
  if (!draftStorageReady) return;
  if (draftPersistenceTimer !== undefined) clearTimeout(draftPersistenceTimer);
  draftPersistenceTimer = undefined;
  pendingDraftValue = value;
  draftPersistenceFailed = !saveComposerDraft(workspaceId, terminalId, value);
}

function persistComposerDraft(value = composerMessage, immediate = false) {
  if (!draftStorageReady) return;
  pendingDraftValue = value;
  if (immediate) {
    flushComposerDraft(value);
    return;
  }
  if (draftPersistenceTimer !== undefined) clearTimeout(draftPersistenceTimer);
  draftPersistenceTimer = setTimeout(() => flushComposerDraft(pendingDraftValue), 250);
}

function updateComposerMessage(value: string, immediate = false) {
  composerMessage = value;

  persistComposerDraft(value, immediate);
}

function flushComposerEditorState(value = pendingEditorState) {
  if (!draftStorageReady || !value) return;
  if (editorPersistenceTimer !== undefined) clearTimeout(editorPersistenceTimer);
  editorPersistenceTimer = undefined;
  pendingEditorState = value;
  savedEditorState = value;
  editorPersistenceFailed = !saveComposerEditorState(workspaceId, terminalId, value);
}

function persistComposerEditorState(immediate = false) {
  if (!draftStorageReady || !composerElement) return;
  savedEditorState = captureComposerEditorState(composerElement);
  pendingEditorState = savedEditorState;
  if (immediate) {
    flushComposerEditorState(savedEditorState);
    return;
  }
  if (editorPersistenceTimer !== undefined) clearTimeout(editorPersistenceTimer);
  editorPersistenceTimer = setTimeout(() => flushComposerEditorState(pendingEditorState), 250);
}

function captureOverlayEditorState() {
  if (!composerElement) return;
  overlayEditorState = captureComposerEditorState(composerElement);
  persistComposerEditorState(true);
}

function restoreComposerFocus(state = overlayEditorState ?? savedEditorState) {
  overlayEditorState = undefined;
  deferFrame(() => {
    if (!composerElement) return;
    composerElement.focus({ preventScroll: true });
    if (state) savedEditorState = restoreComposerEditorState(composerElement, state);
    persistComposerEditorState();
  });
}

onMount(() => {
  inputShortcut = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? '⌘ /' : 'Ctrl + `';
  draftStorageReady = true;
  const restoredDraft = loadComposerDraft(workspaceId, terminalId);
  const restoredEditor = loadComposerEditorState(workspaceId, terminalId);
  composerMessage = restoredDraft.value;
  draftPersistenceFailed = !restoredDraft.available;
  editorPersistenceFailed = !restoredEditor.available;

  savedEditorState = restoredEditor.value;
  pendingDraftValue = composerMessage;
  const handlePageHide = () => {
    flushComposerDraft();
    if (composerElement) pendingEditorState = captureComposerEditorState(composerElement);
    flushComposerEditorState();
  };
  window.addEventListener('pagehide', handlePageHide);
  const closeDesktopActions = () => {
    if (messageActionsOpen && window.matchMedia?.('(max-width: 32rem)').matches === false) {
      messageActionHandoff = true;
      messageActionsOpen = false;
    }
  };
  window.addEventListener('resize', closeDesktopActions);
  const lineObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measureComposerLines);
  if (composerElement) lineObserver?.observe(composerElement);
  deferFrame(() => {
    if (composerElement && savedEditorState) {
      savedEditorState = restoreComposerEditorState(composerElement, savedEditorState);
    }
  });
  return () => {
    window.removeEventListener('pagehide', handlePageHide);
    window.removeEventListener('resize', closeDesktopActions);
    lineObserver?.disconnect();
  };
});
let promptHistoryOpen = $state(false);
let promptHistoryLoading = $state(false);
let promptHistoryError = $state('');
let promptHistory = $state<WorkspaceComposerPrompt[]>([]);
let promptHistoryLoaded = false;
let promptSaveError = $state('');
let composerTemplateWarning = $state('');

onDestroy(() => {
  disposed = true;
  historyLoadRequest += 1;
  flushComposerDraft();
  if (composerElement) pendingEditorState = captureComposerEditorState(composerElement);
  flushComposerEditorState();
  if (draftPersistenceTimer !== undefined) clearTimeout(draftPersistenceTimer);
  if (editorPersistenceTimer !== undefined) clearTimeout(editorPersistenceTimer);
  for (const frame of deferredFrames) cancelAnimationFrame(frame);
  deferredFrames.clear();
  terminalControlFocusTarget = undefined;
});

function preventButtonFocus(event: PointerEvent) {
  event.preventDefault();
}

function prepareTerminalControl(event: PointerEvent) {
  event.preventDefault();
  const focusTarget = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  terminalControlFocusTarget = focusTarget;
  if (!focusTarget) return;
  deferFrame(() => {
    if (terminalControlFocusTarget === focusTarget) restoreTerminalControlFocus();
  });
}

function restoreTerminalControlFocus() {
  const focusTarget = terminalControlFocusTarget;
  terminalControlFocusTarget = undefined;
  if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
}

function sendTerminalControl(control: TerminalControlKey) {
  sendControl(control);
  restoreTerminalControlFocus();
}

function runTerminalControl(action: () => void) {
  action();
  restoreTerminalControlFocus();
}

function renderSubmittedPrompt(prompt: string) {
  return renderComposerTemplate(composerTemplate, prompt, composerTemplateContext);
}

function sendComposerMessage(): boolean {
  if (!connected) return false;
  if (!composerMessage.trim()) return false;
  const submittedPrompt = composerMessage;
  const rendered = renderSubmittedPrompt(submittedPrompt);
  flushComposerDraft(submittedPrompt);
  if (!submit(rendered.text, submittedPrompt)) return false;
  composerTemplateWarning = rendered.error
    ? `The Compose template could not be applied, so the original message was sent. ${rendered.error}`
    : '';
  updateComposerMessage('', true);
  savedEditorState = { selectionStart: 0, selectionEnd: 0, selectionDirection: 'none', scrollTop: 0 };
  if (!composerHistoryEnabled) {
    deferFrame(() => {
      composerElement?.focus();
      persistComposerEditorState(true);
    });
    return true;
  }
  promptSaveError = '';
  void onSubmitted(submittedPrompt)
    .then(async () => {
      if (disposed || !promptHistoryOpen) return;
      const refreshedPrompts = await loadPrompts(true);
      if (disposed) return;
      promptHistory = refreshedPrompts;
      promptHistoryLoaded = true;
    })
    .catch((error) => {
      if (disposed) return;
      promptSaveError = error instanceof Error ? error.message : 'Vampire could not save this prompt to history.';
    });
  deferFrame(() => {
    composerElement?.focus();
    persistComposerEditorState(true);
  });
  return true;
}

async function openPromptHistory() {
  if (!promptHistoryOpen) {
    captureOverlayEditorState();
    promptHistoryOpen = true;
  }
  if (promptHistoryLoaded || promptHistoryLoading) return;
  const request = ++historyLoadRequest;
  promptHistoryLoading = true;
  promptHistoryError = '';
  try {
    const loadedPrompts = await loadPrompts();
    if (disposed || request !== historyLoadRequest) return;
    promptHistory = loadedPrompts;
    promptHistoryLoaded = true;
  } catch (error) {
    if (disposed || request !== historyLoadRequest) return;
    promptHistoryError = error instanceof Error ? error.message : 'Unable to load Composer history.';
  } finally {
    if (!disposed && request === historyLoadRequest) promptHistoryLoading = false;
  }
}

function closePromptHistory() {
  if (!promptHistoryOpen) return;
  promptHistoryOpen = false;
  restoreComposerFocus();
}

function dismissPromptHistoryOutside() {
  if (!promptHistoryOpen) return;
  promptHistoryOpen = false;
  overlayEditorState = undefined;
}

function insertComposerPrompt(prompt: string) {
  const selection = normalizeComposerEditorState(
    overlayEditorState ??
      savedEditorState ?? {
        selectionStart: composerMessage.length,
        selectionEnd: composerMessage.length,
        scrollTop: 0,
      },
    composerMessage.length
  );
  const start = selection.selectionStart;
  const end = selection.selectionEnd;
  updateComposerMessage(`${composerMessage.slice(0, start)}${prompt}${composerMessage.slice(end)}`);
  const caretPosition = start + prompt.length;
  const nextEditorState: ComposerEditorState = {
    selectionStart: caretPosition,
    selectionEnd: caretPosition,
    selectionDirection: 'none',
    scrollTop: selection.scrollTop,
  };
  promptHistoryOpen = false;
  restoreComposerFocus(nextEditorState);
}

function restoreSubmission(submission: RecoverableComposerSubmission) {
  const selection = composerElement
    ? captureComposerEditorState(composerElement)
    : (savedEditorState ?? {
        selectionStart: composerMessage.length,
        selectionEnd: composerMessage.length,
        scrollTop: 0,
      });
  const caretPosition = Math.min(selection.selectionStart, composerMessage.length);
  updateComposerMessage(
    `${composerMessage.slice(0, caretPosition)}${submission.draft}${composerMessage.slice(caretPosition)}`,
    true
  );
  const nextCaretPosition = caretPosition + submission.draft.length;
  if (!draftPersistenceFailed) onDismissSubmission(submission.requestId);
  restoreComposerFocus({
    selectionStart: nextCaretPosition,
    selectionEnd: nextCaretPosition,
    selectionDirection: 'none',
    scrollTop: selection.scrollTop,
  });
}

function restoreLatestSubmission(): boolean {
  for (let index = recoverableSubmissions.length - 1; index >= 0; index -= 1) {
    const submission = recoverableSubmissions[index];
    if (submission.status === 'pending') continue;
    restoreSubmission(submission);
    return true;
  }
  return false;
}

function hasWorkspaceEntry(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes(WORKSPACE_ENTRY_DRAG_TYPE);
}

function handleComposerDragOver(event: DragEvent) {
  if (!connected || !event.dataTransfer || !hasWorkspaceEntry(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  composerDropActive = true;
}

function handleComposerDragLeave() {
  composerDropActive = false;
}

function handleComposerDrop(event: DragEvent) {
  composerDropActive = false;
  if (!connected) return;
  const raw = event.dataTransfer?.getData(WORKSPACE_ENTRY_DRAG_TYPE);
  const entries = raw ? parseWorkspaceEntryDragEntries(raw) : undefined;
  if (!entries?.length) return;
  event.preventDefault();
  const insertion = entries.map(workspaceEntryDragText).join(' ');
  const start = composerElement?.selectionStart ?? composerMessage.length;
  const end = composerElement?.selectionEnd ?? start;
  updateComposerMessage(`${composerMessage.slice(0, start)}${insertion}${composerMessage.slice(end)}`);
  const caretPosition = start + insertion.length;
  restoreComposerFocus({
    selectionStart: caretPosition,
    selectionEnd: caretPosition,
    selectionDirection: 'none',
    scrollTop: composerElement?.scrollTop ?? 0,
  });
}

function handleComposerInput(event: Event) {
  const element = event.currentTarget as HTMLTextAreaElement;
  updateComposerMessage(element.value);
  savedEditorState = captureComposerEditorState(element);
  persistComposerEditorState();
}

function handleComposerSelectionChange() {
  persistComposerEditorState();
}

function handleComposerBlur() {
  flushComposerDraft();
  if (composerElement) pendingEditorState = captureComposerEditorState(composerElement);
  flushComposerEditorState();
}

function handleComposerFocus() {
  onComposerFocus();
}

function shouldHandoffSlash(data: string | null): boolean {
  return (
    data === '/' &&
    composerMessage.length === 0 &&
    (composerElement?.selectionStart ?? 0) === 0 &&
    (composerElement?.selectionEnd ?? 0) === 0
  );
}

function handleComposerBeforeInput(event: InputEvent) {
  if (event.isComposing || event.inputType !== 'insertText' || !shouldHandoffSlash(event.data)) return;
  if (!handoffToTerminal('/')) return;
  event.preventDefault();
  persistComposerEditorState(true);
}

function insertLiteralSlash() {
  const start = composerElement?.selectionStart ?? composerMessage.length;
  const end = composerElement?.selectionEnd ?? start;
  updateComposerMessage(`${composerMessage.slice(0, start)}/${composerMessage.slice(end)}`);
  restoreComposerFocus({
    selectionStart: start + 1,
    selectionEnd: start + 1,
    selectionDirection: 'none',
    scrollTop: composerElement?.scrollTop ?? 0,
  });
}

function handleComposerCommand(event: KeyboardEvent): boolean {
  const command = composerKeyboardCommand(event);
  if (!command) return false;

  if (command === 'history') {
    if (!composerHistoryEnabled) return false;
    event.preventDefault();
    void openPromptHistory();
    return true;
  }
  if (command === 'restore-submission') {
    if (!recoverableSubmissions.some((submission) => submission.status !== 'pending')) return false;
    event.preventDefault();
    restoreLatestSubmission();
    return true;
  }

  event.preventDefault();
  insertLiteralSlash();
  return true;
}

function handleComposerKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return;
  if (isInputSurfaceToggleShortcut(event)) {
    event.preventDefault();
    event.stopPropagation();
    toggleInputSurface();
    return;
  }
  const scrollCommand = composerMessage.length === 0 ? terminalScrollCommand(event) : undefined;
  if (scrollCommand) {
    event.preventDefault();
    ({ top: scrollToTop, bottom: scrollToBottom, up: scrollPageUp, down: scrollPageDown })[scrollCommand]();
    return;
  }
  if (handleComposerCommand(event)) return;
  if (!event.ctrlKey && !event.metaKey && !event.altKey && shouldHandoffSlash(event.key)) {
    if (handoffToTerminal('/')) {
      event.preventDefault();
      persistComposerEditorState(true);
      flushComposerDraft();
    }
    return;
  }
  if (event.key === 'Enter' && event.repeat) {
    event.preventDefault();
    return;
  }
  if (composerMessage.length === 0 && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    const terminalControl = (
      {
        Escape: 'escape',
        Backspace: 'backspace',
        ArrowUp: 'arrow-up',
        ArrowDown: 'arrow-down',
        ArrowLeft: 'arrow-left',
        ArrowRight: 'arrow-right',
      } satisfies Record<string, TerminalControlKey>
    )[event.key];
    if (terminalControl) {
      event.preventDefault();
      if (connected) sendTerminalControl(terminalControl);
      return;
    }
  }
  if (event.key === 'Enter') {
    if (event.shiftKey) return;
    event.preventDefault();
    if (composerMessage.length === 0) {
      if (connected) sendTerminalControl('enter');
    } else sendComposerMessage();
  }
}

function openMessageAction(action: () => void, handoffFocus = true) {
  messageActionHandoff = handoffFocus;
  messageActionsOpen = false;
  action();
}

function closeMessageActionsFocus(event: Event) {
  if (messageActionHandoff) event.preventDefault();
  messageActionHandoff = false;
}

function toggleInputSurface() {
  persistComposerEditorState(true);
  flushComposerDraft();
  onToggleInputSurface();
}

function handleImageSelection(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const image = input.files?.[0];
  if (image) onImageSelected(image);
  input.value = '';
}
</script>

<div class="input-dock">
  <div class="touch-toolbar" role="group" aria-label="Terminal controls">
    <button
      type="button"
      disabled={!connected}
      onpointerdown={prepareTerminalControl}
      onclick={() => sendTerminalControl('escape')}
    >
      Esc
    </button>
    <button
      type="button"
      class="wide-key"
      disabled={!connected}
      onpointerdown={prepareTerminalControl}
      onclick={() => sendTerminalControl('interrupt')}
    >
      Ctrl+C
    </button>
    <button
      type="button"
      disabled={!connected}
      onpointerdown={prepareTerminalControl}
      onclick={() => sendTerminalControl('tab')}
    >
      Tab
    </button>
    <button
      type="button"
      class="wide-key"
      disabled={!connected}
      onpointerdown={prepareTerminalControl}
      onclick={() => sendTerminalControl('backspace')}
    >
      Backspace
    </button>
    <button
      type="button"
      class="wide-key"
      disabled={!connected}
      onpointerdown={prepareTerminalControl}
      onclick={() => sendTerminalControl('enter')}
    >
      Enter
    </button>
    <span class="toolbar-divider" aria-hidden="true"></span>
    <button
      type="button"
      disabled={!connected}
      aria-label="Arrow up"
      onpointerdown={prepareTerminalControl}
      onclick={() => sendTerminalControl('arrow-up')}
    >
      ↑
    </button>
    <button
      type="button"
      disabled={!connected}
      aria-label="Arrow down"
      onpointerdown={prepareTerminalControl}
      onclick={() => sendTerminalControl('arrow-down')}
    >
      ↓
    </button>
    <button
      type="button"
      disabled={!connected}
      aria-label="Arrow left"
      onpointerdown={prepareTerminalControl}
      onclick={() => sendTerminalControl('arrow-left')}
    >
      ←
    </button>
    <button
      type="button"
      disabled={!connected}
      aria-label="Arrow right"
      onpointerdown={prepareTerminalControl}
      onclick={() => sendTerminalControl('arrow-right')}
    >
      →
    </button>
    <span class="toolbar-divider" aria-hidden="true"></span>
    <button
      type="button"
      class="wide-key"
      aria-label="Scroll to terminal top"
      title="Scroll to top"
      onpointerdown={prepareTerminalControl}
      onclick={() => runTerminalControl(scrollToTop)}
    >
      Top
    </button>
    <button
      type="button"
      class="wide-key"
      aria-label="Scroll terminal up one page"
      title="Scroll up one page"
      onpointerdown={prepareTerminalControl}
      onclick={() => runTerminalControl(scrollPageUp)}
    >
      PgUp
    </button>
    <button
      type="button"
      class="wide-key"
      aria-label="Scroll terminal down one page"
      title="Scroll down one page"
      onpointerdown={prepareTerminalControl}
      onclick={() => runTerminalControl(scrollPageDown)}
    >
      PgDn
    </button>
    <button
      type="button"
      class="wide-key"
      aria-label="Scroll to terminal bottom"
      title="Scroll to bottom"
      onpointerdown={prepareTerminalControl}
      onclick={() => runTerminalControl(scrollToBottom)}
    >
      Bottom
    </button>
  </div>
  <ComposerSubmissionRecovery
    submissions={recoverableSubmissions}
    restore={restoreSubmission}
    dismiss={onDismissSubmission}
  />
  {#if promptSaveError}
    <p class="prompt-save-error" role="alert">{promptSaveError}</p>
  {/if}
  {#if composerTemplateWarning}
    <p class="composer-send-warning" role="status">{composerTemplateWarning}</p>
  {/if}
  <div class="composer-slot">
    <div
      class="composer"
      class:history-disabled={!composerHistoryEnabled}
      class:drop-target={composerDropActive}
      class:terminal-target={inputSurface === 'terminal'}
      role="group"
      aria-label="Terminal input"
      ondragenter={handleComposerDragOver}
      ondragover={handleComposerDragOver}
      ondragleave={handleComposerDragLeave}
      ondrop={handleComposerDrop}
    >
      <div class="composer-input-tools">
        <button
          class="composer-mode"
          type="button"
          onclick={toggleInputSurface}
          aria-label="Switch between Compose and Terminal"
          aria-keyshortcuts="Meta+/ Control+`"
          title={`Switch to ${inputSurface === 'terminal' ? 'Compose' : 'Terminal'} (${inputShortcut})`}
        >
          <ArrowLeftRight size={18} strokeWidth={1.8} aria-hidden="true" />
          <span>Switch input</span>
          <kbd aria-hidden="true">{inputShortcut}</kbd>
        </button>
      </div>
      <label class="visually-hidden" for="shell-message">Send text to the shell</label>
      <input
        class="visually-hidden"
        bind:this={imageInputElement}
        type="file"
        accept="image/avif,image/gif,image/jpeg,image/png,image/webp"
        onchange={handleImageSelection}
        tabindex="-1"
      >
      <div class="composer-editor">
        <label class="composer-editor-field" for="shell-message">
          <textarea
            id="shell-message"
            bind:this={composerElement}
            value={composerMessage}
            oninput={handleComposerInput}
            onbeforeinput={handleComposerBeforeInput}
            onkeydown={handleComposerKeydown}
            onfocus={handleComposerFocus}
            onblur={handleComposerBlur}
            onselect={handleComposerSelectionChange}
            onscroll={handleComposerSelectionChange}
            rows="1"
            placeholder="Compose a message…"
            title="Switch to the terminal with Command+/ or Ctrl+`"
            aria-keyshortcuts="Meta+/ Control+` Control+Alt+H Control+Alt+R Control+/"
            autocapitalize="off"
            autocomplete="off"
            spellcheck="false"
          ></textarea>
        </label>
        {#if additionalComposerLines > 0}
          <span class="composer-line-count">
            + {additionalComposerLines} {additionalComposerLines === 1 ? 'line' : 'lines'}
          </span>
        {/if}
      </div>
      <div class="composer-secondary-actions">
        {#if composerHistoryEnabled}
          <ComposerHistoryDialog
            open={promptHistoryOpen}
            prompts={promptHistory}
            loading={promptHistoryLoading}
            error={promptHistoryError}
            requestOpen={() => void openPromptHistory()}
            close={closePromptHistory}
            dismissOutside={dismissPromptHistoryOutside}
            select={insertComposerPrompt}
          />
        {/if}
        <button
          class="image-button"
          type="button"
          onclick={() => imageInputElement?.click()}
          disabled={!connected}
          aria-label="Send an image to the shell"
          title="Send an image"
        >
          <ImagePlus size={18} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
      <PopoverShell
        bind:open={messageActionsOpen}
        side="top"
        align="end"
        trapFocus={false}
        triggerClass="composer-actions-trigger"
        triggerLabel="More message actions"
        triggerTitle="Message actions"
        contentClass="composer-actions-popover"
        onInteractOutside={() => { messageActionHandoff = true; messageActionsOpen = false; }}
        onCloseAutoFocus={closeMessageActionsFocus}
      >
        {#snippet trigger()}
          <Ellipsis size={18} strokeWidth={1.8} aria-hidden="true" />
        {/snippet}
        {#snippet children()}
          <div class="composer-action-list" data-vampire-overlay>
            {#if composerHistoryEnabled}
              <button type="button" onclick={() => openMessageAction(() => void openPromptHistory())}>
                Open Composer history
              </button>
            {/if}
            <button
              type="button"
              disabled={!connected}
              onclick={() => openMessageAction(() => imageInputElement?.click(), false)}
            >
              Send an image to the shell
            </button>
          </div>
        {/snippet}
      </PopoverShell>
      <button
        class="send-button"
        type="button"
        onpointerdown={preventButtonFocus}
        onclick={sendComposerMessage}
        disabled={!connected || !composerMessage.trim()}
        aria-label="Send to shell"
        title="Send text and press Enter"
      >
        <Send size={19} strokeWidth={1.8} aria-hidden="true" />
      </button>
    </div>
  </div>
  {#if draftPersistenceFailed || editorPersistenceFailed}
    <p class="draft-persistence-error" role="status">
      This draft or its editing position could not be saved in this browser.
    </p>
  {/if}
</div>

<style>
.input-dock {
  --dock-inline-start: max(0.55rem, env(safe-area-inset-left));
  --dock-inline-end: max(0.55rem, env(safe-area-inset-right));
  --composer-control-size: 2.5rem;
  --composer-grid-gap: 0.35rem;
  min-width: 0;
  position: relative;
  border-top: 1px solid var(--color-border-subtle);
  background: var(--color-panel);
  box-shadow: var(--shadow-terminal-dock);
}
.touch-toolbar {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  min-width: 0;
  overflow-x: auto;
  padding: 0.35rem var(--dock-inline-end) 0.15rem var(--dock-inline-start);
  scrollbar-width: none;
}
.touch-toolbar::-webkit-scrollbar {
  display: none;
}
.touch-toolbar button {
  flex: 0 0 auto;
  width: auto;
  min-width: 2.5rem;
  height: 2.25rem;
  min-height: 2.25rem;
  padding: 0 0.65rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-control-background);
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-caption);
  font-weight: var(--weight-medium);
  cursor: pointer;
  touch-action: manipulation;
}
@media (hover: hover) {
  .touch-toolbar button:hover:not(:disabled) {
    background: var(--color-surface-hover);
  }
}
.touch-toolbar button:disabled {
  color: var(--color-text-disabled);
  cursor: default;
}
.touch-toolbar .wide-key {
  flex-basis: auto;
  width: auto;
  min-width: 3.75rem;
  padding-inline: 0.75rem;
}
.toolbar-divider {
  flex: 0 0 1px;
  width: 1px;
  height: 2.25rem;
  margin: 0 0.15rem;
  background: var(--color-border);
}
.composer-slot {
  position: relative;
  height: calc(var(--composer-control-size) + 0.36rem + 2px);
  margin: 0.35rem var(--dock-inline-end) max(0.5rem, env(safe-area-inset-bottom)) var(--dock-inline-start);
}
.composer {
  position: absolute;
  z-index: 4;
  right: 0;
  bottom: 0;
  left: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) repeat(3, var(--composer-control-size));
  align-items: end;
  gap: var(--composer-grid-gap);
  min-width: 0;
  padding: 0.18rem;
  border: 1px solid var(--color-border);
  border-radius: 0.78rem;
  background: var(--color-control-background);
}
.composer .composer-mode {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  width: auto;
  min-width: var(--composer-control-size);
  padding: 0 0.5rem;
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  font-size: var(--text-caption);
}
.composer-input-tools {
  display: flex;
  align-items: center;
}
.composer-mode kbd {
  display: none;
  padding: 0.12rem 0.3rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xs);
  color: var(--color-text-secondary);
  font: inherit;
  white-space: nowrap;
}
@media (hover: hover) and (pointer: fine) {
  .touch-toolbar {
    display: none;
  }
  .composer-mode kbd {
    display: inline-block;
  }
}
.composer .composer-mode:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
@media (hover: hover) {
  .composer .composer-mode:hover {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }
}
.composer.history-disabled {
  grid-template-columns: auto minmax(0, 1fr) repeat(2, var(--composer-control-size));
}
.composer-secondary-actions {
  display: contents;
}
:global(.composer-actions-trigger) {
  display: none;
  width: var(--composer-control-size);
  height: var(--composer-control-size);
  padding: 0;
  border: 0;
  border-radius: 0.58rem;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}
:global(.composer-actions-trigger:focus-visible) {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
:global(.composer-actions-popover) {
  z-index: 70;
  min-width: 13rem;
  max-width: calc(100vw - 1rem);
  padding: 0.35rem;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-control);
  background: var(--color-panel);
  box-shadow: var(--shadow-popover);
}
.composer-action-list {
  display: grid;
  gap: 0.2rem;
}
.composer-action-list button {
  min-height: 2.75rem;
  padding: 0.5rem 0.65rem;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-caption);
  text-align: left;
  cursor: pointer;
}
.composer-action-list button:disabled {
  color: var(--color-text-disabled);
  cursor: default;
}
.composer-action-list button:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
@media (hover: hover) {
  .composer-action-list button:hover:not(:disabled),
  :global(.composer-actions-trigger:hover) {
    background: var(--color-surface-hover);
  }
}
@media (max-width: 32rem) {
  :global(.composer-actions-trigger) {
    display: grid;
    place-items: center;
  }
  .composer,
  .composer.history-disabled {
    grid-template-columns: var(--composer-control-size) minmax(0, 1fr) repeat(2, var(--composer-control-size));
  }
  .composer-mode span {
    display: none;
  }
  .composer-secondary-actions {
    /* Keep the hidden popup triggers anchored to the visible actions button. */
    position: absolute;
    right: calc(var(--composer-control-size) + var(--composer-grid-gap) + 0.18rem);
    bottom: 0.18rem;
    display: grid;
    width: var(--composer-control-size);
    height: var(--composer-control-size);
    visibility: hidden;
    pointer-events: none;
  }
  .composer-secondary-actions > :global(*) {
    grid-area: 1 / 1;
  }
}
.composer:focus-within {
  border-color: var(--color-accent);
  box-shadow: var(--shadow-accent-focus);
}
.composer.drop-target {
  border-color: var(--color-accent);
  background: var(--color-surface-active);
  box-shadow: var(--shadow-accent-focus);
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
.composer-editor {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
  height: var(--composer-control-size);
}
.composer-editor-field {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  min-width: 0;
  height: 100%;
}
.composer textarea {
  width: 100%;
  min-width: 0;
  min-height: var(--composer-control-size);
  height: var(--composer-control-size);
  max-height: var(--composer-control-size);
  padding: calc((var(--composer-control-size) - 1lh) / 2) 0.62rem;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: none;
  resize: none;
  border: 0;
  border-radius: var(--radius-sm);
  outline: none;
  background: transparent;
  color: var(--color-text);
  font: inherit;
  font-size: 1rem;
  line-height: var(--leading-ui);
}
.composer textarea::-webkit-scrollbar {
  display: none;
}
.composer .composer-line-count {
  position: absolute;
  right: 0.62rem;
  bottom: 0;
  width: auto;
  height: auto;
  padding: 0;
  border: 0;
  background: transparent;
  pointer-events: none;
  color: var(--color-text-tertiary);
  font-size: var(--text-nano);
  line-height: 1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.composer textarea:placeholder-shown {
  white-space: pre;
}
.composer textarea::placeholder {
  color: var(--color-field-placeholder);
}
.draft-persistence-error {
  margin: 0;
  padding: 0.15rem var(--dock-inline-end) 0.35rem var(--dock-inline-start);
  color: var(--color-danger-text);
  font-size: var(--text-caption);
}
.composer button {
  display: grid;
  place-items: center;
  width: var(--composer-control-size);
  height: var(--composer-control-size);
  padding: 0;
  border: 0;
  border-radius: 0.58rem;
  cursor: pointer;
  touch-action: manipulation;
}
.image-button {
  background: transparent;
  color: var(--color-text-secondary);
}
@media (hover: hover) {
  .image-button:hover:not(:disabled) {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }
}
.prompt-save-error,
.composer-send-warning {
  margin: 0;
  padding: 0.7rem 0.75rem;
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
.prompt-save-error {
  color: var(--color-danger);
}
.prompt-save-error {
  padding: 0.35rem var(--dock-inline-end) 0 var(--dock-inline-start);
}
.composer-send-warning {
  padding: 0.35rem var(--dock-inline-end) 0 var(--dock-inline-start);
  color: var(--color-warning-text, var(--color-text-secondary));
}
.send-button {
  background: var(--color-accent);
  color: var(--color-accent-ink);
}
@media (hover: hover) {
  .send-button:hover:not(:disabled) {
    background: var(--color-accent-hover);
  }
}
.composer button:disabled {
  background: transparent;
  color: var(--color-text-disabled);
  cursor: default;
}

@media (any-pointer: fine) {
  .input-dock {
    --dock-inline-start: 0.75rem;
    --dock-inline-end: 0.75rem;
    --composer-grid-gap: 0.2rem;
  }
  .touch-toolbar {
    padding: 0.4rem var(--dock-inline-end) 0 var(--dock-inline-start);
  }
  .touch-toolbar button {
    min-width: 2.25rem;
    height: 2rem;
    min-height: 2rem;
    padding-inline: 0.55rem;
  }
  .toolbar-divider {
    height: 1.65rem;
  }
  .composer-slot {
    margin: 0.6rem var(--dock-inline-end) 0.7rem var(--dock-inline-start);
  }
  .composer textarea {
    font-size: var(--text-body);
  }
}
</style>
