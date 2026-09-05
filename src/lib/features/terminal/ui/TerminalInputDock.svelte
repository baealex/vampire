<script lang="ts">
import Send from '@lucide/svelte/icons/send';
import ImagePlus from '@lucide/svelte/icons/image-plus';
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
import { loadComposerTemplateBypass, saveComposerTemplateBypass } from '../model/composer-message-options.ts';
import type { RecoverableComposerSubmission } from '../model/composer-submission.ts';
import { isInputSurfaceToggleShortcut, type TerminalControlKey } from '../model/terminal-control.ts';
import { renderComposerTemplate, type ComposerTemplateContext } from '~/lib/shared/lib/composer-template.ts';
import type { WorkspaceComposerPrompt } from '~/lib/shared/contracts/workspace-composer-history.ts';
import ComposerHistoryDialog from './ComposerHistoryDialog.svelte';
import ComposerSubmissionRecovery from './ComposerSubmissionRecovery.svelte';
import ComposerTemplateTools from './ComposerTemplateTools.svelte';

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
  fontSize,
  minimumFontSize,
  maximumFontSize,
  decreaseFontSize,
  increaseFontSize,
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
  fontSize: number;
  minimumFontSize: number;
  maximumFontSize: number;
  decreaseFontSize: () => void;
  increaseFontSize: () => void;
  handoffToTerminal: (data: string) => boolean;
  onToggleInputSurface: () => void;
  onComposerFocus?: () => void;
  recoverableSubmissions?: RecoverableComposerSubmission[];
  onDismissSubmission?: (requestId: string) => void;
  composerElement?: HTMLTextAreaElement;
} = $props();

let imageInputElement: HTMLInputElement;
let composerMessage = $state('');
let composerDropActive = $state(false);
let composerResizeFrame: number | undefined;
let draftPersistenceTimer: ReturnType<typeof setTimeout> | undefined;
let pendingDraftValue = '';
let editorPersistenceTimer: ReturnType<typeof setTimeout> | undefined;
let pendingEditorState: ComposerEditorState | undefined;
let draftStorageReady = false;
let draftPersistenceFailed = $state(false);
let editorPersistenceFailed = $state(false);
let messageOptionsPersistenceFailed = $state(false);
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
  if (value.length === 0 && templateBypassed) {
    templateBypassed = false;
    messageOptionsPersistenceFailed = !saveComposerTemplateBypass(workspaceId, terminalId, false);
  }
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
    resizeComposer();
  });
}

onMount(() => {
  draftStorageReady = true;
  const restoredDraft = loadComposerDraft(workspaceId, terminalId);
  const restoredEditor = loadComposerEditorState(workspaceId, terminalId);
  const restoredTemplateBypass = loadComposerTemplateBypass(workspaceId, terminalId);
  composerMessage = restoredDraft.value;
  draftPersistenceFailed = !restoredDraft.available;
  editorPersistenceFailed = !restoredEditor.available;
  messageOptionsPersistenceFailed = !restoredTemplateBypass.available;
  templateBypassed = composerMessage.length > 0 && restoredTemplateBypass.value;
  if (composerMessage.length === 0 && restoredTemplateBypass.value) {
    messageOptionsPersistenceFailed = !saveComposerTemplateBypass(workspaceId, terminalId, false);
  }
  savedEditorState = restoredEditor.value;
  pendingDraftValue = composerMessage;
  const handlePageHide = () => {
    flushComposerDraft();
    if (composerElement) pendingEditorState = captureComposerEditorState(composerElement);
    flushComposerEditorState();
  };
  window.addEventListener('pagehide', handlePageHide);
  deferFrame(() => {
    resizeComposer();
    if (composerElement && savedEditorState) {
      savedEditorState = restoreComposerEditorState(composerElement, savedEditorState);
    }
  });
  return () => window.removeEventListener('pagehide', handlePageHide);
});
let promptHistoryOpen = $state(false);
let promptHistoryLoading = $state(false);
let promptHistoryError = $state('');
let promptHistory = $state<WorkspaceComposerPrompt[]>([]);
let promptHistoryLoaded = false;
let promptSaveError = $state('');
let composerTemplateWarning = $state('');
let templateBypassed = $state(false);
let templatePreviewOpen = $state(false);
let templatePreviewText = $state('');
let templatePreviewWarning = $state('');

onDestroy(() => {
  disposed = true;
  historyLoadRequest += 1;
  flushComposerDraft();
  if (composerElement) pendingEditorState = captureComposerEditorState(composerElement);
  flushComposerEditorState();
  if (draftPersistenceTimer !== undefined) clearTimeout(draftPersistenceTimer);
  if (editorPersistenceTimer !== undefined) clearTimeout(editorPersistenceTimer);
  if (composerResizeFrame !== undefined) cancelAnimationFrame(composerResizeFrame);
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
  if (templateBypassed) return { text: prompt, usedFallback: false };
  return renderComposerTemplate(composerTemplate, prompt, composerTemplateContext);
}

function sendComposerMessage() {
  if (!connected) return;
  if (!composerMessage.trim()) return;
  const submittedPrompt = composerMessage;
  const rendered = renderSubmittedPrompt(submittedPrompt);
  flushComposerDraft(submittedPrompt);
  if (!submit(rendered.text, submittedPrompt)) return;
  composerTemplateWarning =
    !templateBypassed && rendered.error
      ? `The Compose template could not be applied, so the original message was sent. ${rendered.error}`
      : '';
  updateComposerMessage('', true);
  templateBypassed = false;
  savedEditorState = { selectionStart: 0, selectionEnd: 0, selectionDirection: 'none', scrollTop: 0 };
  if (!composerHistoryEnabled) {
    deferFrame(() => {
      resizeComposer();
      composerElement?.focus();
      persistComposerEditorState(true);
    });
    return;
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
    resizeComposer();
    composerElement?.focus();
    persistComposerEditorState(true);
  });
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

function toggleTemplateBypass() {
  if (!composerMessage) return;
  templateBypassed = !templateBypassed;
  messageOptionsPersistenceFailed = !saveComposerTemplateBypass(workspaceId, terminalId, templateBypassed);
  composerTemplateWarning = '';
}

function openTemplatePreview() {
  if (!composerMessage || templatePreviewOpen) return;
  captureOverlayEditorState();
  const preview = renderSubmittedPrompt(composerMessage);
  templatePreviewText = preview.text;
  templatePreviewWarning =
    !templateBypassed && preview.error
      ? `The template cannot be applied. Compose will submit the original message. ${preview.error}`
      : '';
  templatePreviewOpen = true;
}

function closeTemplatePreview() {
  if (!templatePreviewOpen) return;
  templatePreviewOpen = false;
  restoreComposerFocus();
}

function dismissTemplatePreviewOutside() {
  if (!templatePreviewOpen) return;
  templatePreviewOpen = false;
  overlayEditorState = undefined;
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

function resizeComposer() {
  if (disposed || !composerElement || composerResizeFrame !== undefined) return;
  composerResizeFrame = requestAnimationFrame(() => {
    composerResizeFrame = undefined;
    if (disposed || !composerElement) return;
    composerElement.style.height = 'auto';
    const nextHeight = Math.min(composerElement.scrollHeight, 128);
    composerElement.style.height = `${nextHeight}px`;
  });
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
  resizeComposer();
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

function insertComposerLineBreak() {
  const start = composerElement?.selectionStart ?? composerMessage.length;
  const end = composerElement?.selectionEnd ?? start;
  updateComposerMessage(composerMessage.slice(0, start) + '\n' + composerMessage.slice(end));
  restoreComposerFocus({
    selectionStart: start + 1,
    selectionEnd: start + 1,
    selectionDirection: 'none',
    scrollTop: composerElement?.scrollTop ?? 0,
  });
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
  if (command === 'preview-template') {
    if (!composerMessage) return false;
    event.preventDefault();
    openTemplatePreview();
    return true;
  }
  if (command === 'toggle-template') {
    if (!composerMessage) return false;
    event.preventDefault();
    toggleTemplateBypass();
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
    event.preventDefault();
    if (event.shiftKey) insertComposerLineBreak();
    else if (composerMessage.length === 0) {
      if (connected) sendTerminalControl('enter');
    } else sendComposerMessage();
  }
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
    <span class="toolbar-divider" aria-hidden="true"></span>
    <button
      type="button"
      aria-label="Decrease terminal text size"
      title={`Decrease text size (currently ${fontSize}px)`}
      disabled={fontSize <= minimumFontSize}
      onpointerdown={prepareTerminalControl}
      onclick={() => runTerminalControl(decreaseFontSize)}
    >
      A−
    </button>
    <button
      type="button"
      aria-label="Increase terminal text size"
      title={`Increase text size (currently ${fontSize}px)`}
      disabled={fontSize >= maximumFontSize}
      onpointerdown={prepareTerminalControl}
      onclick={() => runTerminalControl(increaseFontSize)}
    >
      A+
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
      <div class="composer-meta">
        <button
          class="composer-mode"
          type="button"
          onclick={toggleInputSurface}
          aria-label={`Input target: ${inputSurface === 'terminal' ? 'Terminal' : 'Compose'}. Switch input target`}
          aria-keyshortcuts="Meta+/ Control+`"
          title="Switch input target (Command+/ or Ctrl+`)"
        >
          <span class:active={inputSurface === 'compose'}>Compose</span>
          <span aria-hidden="true">↔</span>
          <span class:active={inputSurface === 'terminal'}>Terminal</span>
        </button>
        <ComposerTemplateTools
          bypassed={templateBypassed}
          hasDraft={composerMessage.length > 0}
          previewOpen={templatePreviewOpen}
          previewText={templatePreviewText}
          previewWarning={templatePreviewWarning}
          toggleBypass={toggleTemplateBypass}
          openPreview={openTemplatePreview}
          closePreview={closeTemplatePreview}
          dismissPreviewOutside={dismissTemplatePreviewOutside}
        />
        <span class="composer-shortcut" aria-live="polite">
          {#if inputSurface === 'terminal'}
            Terminal receives typing · ⌘/ or Ctrl+` returns
          {:else if composerMessage.length === 0}
            / commands · ↑↓ Enter controls Terminal
          {:else if composerMessage.trim()}
            Enter sends · Shift+Enter adds a line
          {:else}
            Whitespace draft retained · add text to send
          {/if}
        </span>
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
        aria-keyshortcuts="Meta+/ Control+` Control+Alt+H Control+Alt+P Control+Alt+B Control+Alt+R Control+/"
        autocapitalize="off"
        autocomplete="off"
        spellcheck="false"
      ></textarea>
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
  {#if draftPersistenceFailed || editorPersistenceFailed || messageOptionsPersistenceFailed}
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
  --composer-meta-height: 1.88rem;
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
  height: calc(var(--composer-control-size) + var(--composer-meta-height) + var(--composer-grid-gap) + 0.36rem + 2px);
  margin: 0.35rem var(--dock-inline-end) max(0.5rem, env(safe-area-inset-bottom)) var(--dock-inline-start);
}
.composer {
  position: absolute;
  z-index: 4;
  right: 0;
  bottom: 0;
  left: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) repeat(3, var(--composer-control-size));
  align-items: end;
  gap: var(--composer-grid-gap);
  min-width: 0;
  padding: 0.18rem;
  border: 1px solid var(--color-border);
  border-radius: 0.78rem;
  background: var(--color-control-background);
}
.composer-meta {
  display: flex;
  flex-wrap: nowrap;
  grid-column: 1 / -1;
  align-items: center;
  gap: 0.45rem;
  min-width: 0;
  padding: 0.08rem 0.35rem 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.composer-meta::-webkit-scrollbar {
  display: none;
}
:global(.composer-meta > .composer-template-tools) {
  flex: 0 0 auto;
}
.composer .composer-mode {
  display: inline-flex;
  align-items: center;
  gap: 0.28rem;
  width: auto;
  min-width: 0;
  height: 1.8rem;
  padding: 0 0.48rem;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-pill);
  background: var(--color-surface-raised);
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-micro);
  cursor: pointer;
}
.composer-mode span {
  color: var(--color-text-disabled);
}
.composer-mode span.active {
  color: var(--color-text);
  font-weight: var(--weight-semibold);
}
@media (hover: hover) {
  .composer .composer-mode:hover {
    background: var(--color-surface-hover);
  }
}
.composer-shortcut {
  display: none;
  flex: 1 1 16rem;
  min-width: 0;
  margin-left: auto;
  color: var(--color-text-disabled);
  font-size: var(--text-micro);
  overflow-wrap: anywhere;
  text-align: right;
}
.composer.history-disabled {
  grid-template-columns: minmax(0, 1fr) repeat(2, var(--composer-control-size));
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
.composer textarea {
  width: 100%;
  min-width: 0;
  min-height: var(--composer-control-size);
  max-height: 8rem;
  padding: 0.52rem 0.62rem;
  overflow-y: auto;
  resize: none;
  border: 0;
  border-radius: var(--radius-sm);
  outline: none;
  background: transparent;
  color: var(--color-text);
  font: inherit;
  font-family: var(--font-mono);
  font-size: 1rem;
  line-height: var(--leading-ui);
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

@media (min-width: 64rem) {
  .composer-shortcut {
    display: inline;
  }
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
  .composer {
    grid-template-columns: minmax(0, 1fr) repeat(3, var(--composer-control-size));
  }
  .composer-slot {
    margin: 0.6rem var(--dock-inline-end) 0.7rem var(--dock-inline-start);
  }
  .composer textarea {
    font-size: var(--text-body);
  }
}

@media (max-height: 22rem) {
  .composer-slot {
    height: calc(var(--composer-control-size) + 0.36rem + 2px);
  }
  .composer-meta {
    display: none;
  }
}
</style>
