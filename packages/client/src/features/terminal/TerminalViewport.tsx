import { loadComposerDraft, saveComposerDraft } from '@vampire/lib/features/terminal/model/composer-draft-storage.ts';
import {
  loadLastFocusedInputSurface,
  saveLastFocusedInputSurface,
  type TerminalInputSurface,
} from '@vampire/lib/features/terminal/model/input-surface-preference.ts';
import {
  isInputSurfaceToggleShortcut,
  type TerminalControlKey,
} from '@vampire/lib/features/terminal/model/terminal-control.ts';
import { loadTerminalFontSize } from '@vampire/lib/features/terminal/model/terminal-display-preference.ts';
import {
  acquireTerminalRuntime,
  releaseTerminalRuntime,
  type TerminalRuntime,
  type TerminalRuntimeState,
} from '@vampire/lib/features/terminal/ui/terminal-runtime.ts';
import type { TerminalInputSettings } from '@vampire/lib/shared/contracts/terminal-input.ts';
import type { WorkspaceComposerPrompt } from '@vampire/lib/shared/contracts/workspace-composer-history.ts';
import { renderComposerTemplate } from '@vampire/lib/shared/lib/composer-template.ts';
import {
  parseWorkspaceEntryDragEntries,
  WORKSPACE_ENTRY_DRAG_TYPE,
  type WorkspaceEntryDragData,
  workspaceEntryDragText,
} from '@vampire/lib/shared/lib/workspace-entry-drag.ts';
import { ArrowLeftRight, CircleAlert, Ellipsis, ImagePlus, MonitorSmartphone, RefreshCw, Send } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { requestJson } from '~/shared/api/request.ts';
import { THEME_CHANGE_EVENT, terminalFontFamily, terminalTheme } from '~/shared/theme/theme.ts';
import { Button, Textarea, ToolbarButton } from '~/shared/ui/index.ts';
import { ComposerHistoryPopover } from './ComposerHistoryPopover.tsx';
import { SubmissionRecovery } from './model/submission-recovery.ts';
import '@xterm/xterm/css/xterm.css';
import './terminal-viewport.css';

const EMPTY_COMPOSER_CONTROLS: Partial<Record<string, TerminalControlKey>> = {
  Escape: 'escape',
  Backspace: 'backspace',
  ArrowUp: 'arrow-up',
  ArrowDown: 'arrow-down',
  ArrowLeft: 'arrow-left',
  ArrowRight: 'arrow-right',
};
const INITIAL_STATE: TerminalRuntimeState = {
  connected: false,
  controlSizeMismatch: false,
  controlsTerminal: undefined,
  error: '',
  inputReady: false,
  openingStage: 'opening',
  openingVisible: false,
  reconnecting: false,
  screenReady: false,
};
const DEFAULT_INPUT: TerminalInputSettings = { mode: 'terminal', slashHandoff: true };

type Props = {
  composerHistoryEnabled: boolean;
  composerTemplate?: string;
  composerTemplateContext: { workspace: { cwd: string; name: string } };
  onInputActivity: (workspaceId: string, timestamp: number) => void;
  onLoadComposerPrompts: (workspaceId: string, refresh?: boolean) => Promise<WorkspaceComposerPrompt[]>;
  onOutputActivity: (workspaceId: string, active: boolean, timestamp?: number) => void;
  onRecordComposerPrompt: (workspaceId: string, prompt: string) => Promise<void>;
  onRepositoryStatus: (changeCount: number, worktreeCount: number, branch?: string) => void;
  onWorkspaceObserved: (workspaceId: string) => void;
  onUploadFiles?: (dataTransfer: DataTransfer) => Promise<string[]>;
  pathInsertion?: { entry: WorkspaceEntryDragData; token: number };
  terminalId?: string;
  workspaceId: string;
};

export const TerminalViewport = observer(function TerminalViewport(props: Props) {
  const {
    composerHistoryEnabled,
    composerTemplate,
    composerTemplateContext,
    onInputActivity,
    onLoadComposerPrompts,
    onOutputActivity,
    onRecordComposerPrompt,
    onRepositoryStatus,
    onWorkspaceObserved,
    onUploadFiles,
    pathInsertion,
    terminalId,
    workspaceId,
  } = props;
  const terminalElement = useRef<HTMLDivElement>(null);
  const composerElement = useRef<HTMLTextAreaElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const imageNoticeTimer = useRef<number | undefined>(undefined);
  const runtime = useRef<TerminalRuntime | null>(null);
  const activityCallbacks = useRef({ onInputActivity, onOutputActivity, onRepositoryStatus, onWorkspaceObserved });
  activityCallbacks.current = { onInputActivity, onOutputActivity, onRepositoryStatus, onWorkspaceObserved };
  const [runtimeState, setRuntimeState] = useState<TerminalRuntimeState>(INITIAL_STATE);
  const [recovery] = useState(() => new SubmissionRecovery(workspaceId, terminalId));
  const [draft, setDraft] = useState(() => loadComposerDraft(workspaceId, terminalId).value);
  const [templateWarning, setTemplateWarning] = useState('');
  const [imageError, setImageError] = useState('');
  const [imageNotice, setImageNotice] = useState('');
  const [uploadingImage, setUploadingImage] = useState(false);
  const [messageActionsOpen, setMessageActionsOpen] = useState(false);
  const [terminalDropKind, setTerminalDropKind] = useState<'' | 'files' | 'path'>('');
  const [inputSettings, setInputSettings] = useState(DEFAULT_INPUT);
  const [inputSurface, setInputSurface] = useState<TerminalInputSurface>(
    () => loadLastFocusedInputSurface(workspaceId, terminalId).value ?? 'compose',
  );
  const loadPrompts = useCallback(() => onLoadComposerPrompts(workspaceId), [onLoadComposerPrompts, workspaceId]);
  const inputShortcut = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? '⌘ /' : 'Ctrl `';

  useEffect(() => {
    let active = true;
    void requestJson<TerminalInputSettings>('/api/terminal-input/settings', { cache: 'no-store' })
      .then((value) => {
        if (!active) return;
        setInputSettings(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const closeDesktopActions = () => {
      if (!window.matchMedia('(max-width: 32rem)').matches) setMessageActionsOpen(false);
    };
    window.addEventListener('resize', closeDesktopActions);
    return () => window.removeEventListener('resize', closeDesktopActions);
  }, []);
  useEffect(() => {
    const element = terminalElement.current;
    if (!element) return;
    const terminalRuntime = acquireTerminalRuntime({
      element,
      workspaceId,
      terminalId,
      fontSize: loadTerminalFontSize(14),
      minimumFontSize: 10,
      maximumFontSize: 22,
      themeChangeEvent: THEME_CHANGE_EVENT,
      getFontFamily: terminalFontFamily,
      getTheme: terminalTheme,
      shouldAutoFocus: () => false,
      onFontSizeChange: () => undefined,
      onComposeShortcut: () => {
        setInputSurface('compose');
        saveLastFocusedInputSurface(workspaceId, terminalId, 'compose');
        composerElement.current?.focus({ preventScroll: true });
      },
      onInputActivity: (id, timestamp) => activityCallbacks.current.onInputActivity(id, timestamp),
      onTerminalInput: () => {
        setInputSurface('terminal');
        saveLastFocusedInputSurface(workspaceId, terminalId, 'terminal');
      },
      onOutputActivity: (id, active, timestamp) => activityCallbacks.current.onOutputActivity(id, active, timestamp),
      onRepositoryStatus: (changeCount, worktreeCount, branch) =>
        activityCallbacks.current.onRepositoryStatus(changeCount, worktreeCount, branch),
      onStateChange: (state) => setRuntimeState({ ...state }),
      onTerminalTap: () => {
        setInputSurface('terminal');
        saveLastFocusedInputSurface(workspaceId, terminalId, 'terminal');
        terminalRuntime.focus();
      },
      onSubmissionResult: (result) => recovery.applyResult(result),
      onSubmissionUncertain: (requestId) => recovery.markUncertain(requestId),
    });
    runtime.current = terminalRuntime;
    terminalRuntime.start();
    return () => {
      runtime.current = null;
      releaseTerminalRuntime(terminalRuntime);
    };
  }, [recovery, terminalId, workspaceId]);
  useEffect(() => {
    if (!pathInsertion || !runtimeState.inputReady) return;
    if (runtime.current?.send(workspaceEntryDragText(pathInsertion.entry))) {
      chooseInputSurface('terminal');
      runtime.current.focus();
    }
  }, [pathInsertion?.token, runtimeState.inputReady]);

  useEffect(() => {
    if (!runtimeState.screenReady) return;
    activityCallbacks.current.onWorkspaceObserved(workspaceId);
    if (document.querySelector('[data-terminal-autofocus="preserve"]')) return;
    if (inputSurface === 'compose') composerElement.current?.focus({ preventScroll: true });
    else runtime.current?.focus();
  }, [inputSurface, runtimeState.screenReady]);

  const chooseInputSurface = (surface: TerminalInputSurface) => {
    setInputSurface(surface);
    saveLastFocusedInputSurface(workspaceId, terminalId, surface);
  };
  const toggleInput = () => {
    const surface = inputSurface === 'compose' ? 'terminal' : 'compose';
    chooseInputSurface(surface);
    if (surface === 'compose') composerElement.current?.focus({ preventScroll: true });
    else runtime.current?.focus();
  };
  const submit = () => {
    if (!draft.trim()) return;
    const prompt = draft;
    const rendered = renderComposerTemplate(composerTemplate, prompt, composerTemplateContext);
    const sent = recovery.submit(
      rendered.text,
      prompt,
      (data, requestId) => runtime.current?.submit(data, requestId) ?? false,
    );
    if (!sent) return;
    setTemplateWarning(
      rendered.error
        ? `The Compose template could not be applied, so the original message was sent. ${rendered.error}`
        : '',
    );
    setDraft('');
    saveComposerDraft(workspaceId, terminalId, '');
    void onRecordComposerPrompt(workspaceId, prompt);
  };
  const sendControl = (control: TerminalControlKey) => runtime.current?.sendControl(control);
  const insertPrompt = (text: string) => {
    const element = composerElement.current;
    const start = element?.selectionStart ?? draft.length;
    const end = element?.selectionEnd ?? start;
    const next = `${draft.slice(0, start)}${text}${draft.slice(end)}`;
    setDraft(next);
    saveComposerDraft(workspaceId, terminalId, next);
    window.setTimeout(() => {
      element?.focus();
      element?.setSelectionRange(start + text.length, start + text.length);
    }, 0);
  };
  const uploadImage = useCallback(
    async (image: File) => {
      if (!runtimeState.inputReady) {
        setImageError('Connect to the terminal before sending an image.');
        return;
      }
      if (imageNoticeTimer.current !== undefined) window.clearTimeout(imageNoticeTimer.current);
      setUploadingImage(true);
      setImageError('');
      setImageNotice('Sending image to the shell…');
      const form = new FormData();
      form.set('image', image, image.name || 'pasted-image');
      const query = terminalId ? `?terminal=${encodeURIComponent(terminalId)}` : '';
      try {
        await requestJson(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/image${query}`,
          { method: 'POST', body: form },
          'Unable to send the image to the shell.',
        );
        setImageNotice('Image pasted into the shell.');
        imageNoticeTimer.current = window.setTimeout(() => {
          setImageNotice('');
          imageNoticeTimer.current = undefined;
        }, 5_000);
      } catch (cause) {
        setImageNotice('');
        setImageError(cause instanceof Error ? cause.message : 'Unable to send the image to the shell.');
      } finally {
        setUploadingImage(false);
      }
    },
    [runtimeState.inputReady, terminalId, workspaceId],
  );
  useEffect(() => {
    const pasteImage = (event: ClipboardEvent) => {
      const imageItem = Array.from(event.clipboardData?.items ?? []).find(
        (item) => item.kind === 'file' && item.type.startsWith('image/'),
      );
      const image =
        imageItem?.getAsFile() ??
        Array.from(event.clipboardData?.files ?? []).find((file) => file.type.startsWith('image/'));
      if (!image) return;
      event.preventDefault();
      void uploadImage(image);
    };
    window.addEventListener('paste', pasteImage, true);
    return () => {
      window.removeEventListener('paste', pasteImage, true);
      if (imageNoticeTimer.current !== undefined) window.clearTimeout(imageNoticeTimer.current);
    };
  }, [uploadImage]);
  const handleTerminalDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    setTerminalDropKind('');
    const raw = event.dataTransfer.getData(WORKSPACE_ENTRY_DRAG_TYPE);
    const dragged = raw ? parseWorkspaceEntryDragEntries(raw) : undefined;
    if (dragged?.length) {
      event.preventDefault();
      if (runtime.current?.send(dragged.map(workspaceEntryDragText).join(' '))) runtime.current.focus();
      return;
    }
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    try {
      if (!onUploadFiles) return;
      const entries = (await onUploadFiles(event.dataTransfer)).map((path) => ({ path, kind: 'file' as const }));
      if (entries.length && runtime.current?.send(entries.map(workspaceEntryDragText).join(' ')))
        runtime.current.focus();
    } catch (cause) {
      setImageError(cause instanceof Error ? cause.message : 'The dropped files could not be added.');
    }
  };
  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.ctrlKey && event.altKey && event.key.toLocaleLowerCase() === 'h' && composerHistoryEnabled) {
      event.preventDefault();
      document.querySelector<HTMLButtonElement>('[aria-label="Open Composer history"]')?.click();
      return;
    }
    if (event.ctrlKey && !event.altKey && event.key === '/') {
      event.preventDefault();
      insertPrompt('/');
      return;
    }
    if (event.key === 'Enter' && event.repeat) {
      event.preventDefault();
      return;
    }
    if (draft.length === 0 && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const control = EMPTY_COMPOSER_CONTROLS[event.key];
      if (control) {
        event.preventDefault();
        sendControl(control);
        return;
      }
      if (event.key === '/' && inputSettings.slashHandoff) {
        event.preventDefault();
        runtime.current?.send('/');
        runtime.current?.focus();
        chooseInputSurface('terminal');
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (draft.length === 0) sendControl('enter');
      else submit();
    }
  };

  return (
    <div
      className="terminal-body"
      onKeyDownCapture={(event) => {
        if (!isInputSurfaceToggleShortcut(event.nativeEvent)) return;
        event.preventDefault();
        event.stopPropagation();
        toggleInput();
      }}
    >
      <div className="terminal-frame">
        <div
          ref={terminalElement}
          className={`terminal${runtimeState.screenReady ? ' screen-ready' : ''}`}
          role="application"
          aria-label="Interactive shell terminal"
          onDragEnter={(event) => {
            const kind = event.dataTransfer.types.includes(WORKSPACE_ENTRY_DRAG_TYPE)
              ? 'path'
              : event.dataTransfer.types.includes('Files')
                ? 'files'
                : '';
            if (kind) {
              event.preventDefault();
              setTerminalDropKind(kind);
            }
          }}
          onDragOver={(event) => {
            const kind = event.dataTransfer.types.includes(WORKSPACE_ENTRY_DRAG_TYPE)
              ? 'path'
              : event.dataTransfer.types.includes('Files')
                ? 'files'
                : '';
            if (kind) {
              event.preventDefault();
              setTerminalDropKind(kind);
            }
          }}
          onDragLeave={() => setTerminalDropKind('')}
          onDrop={(event) => void handleTerminalDrop(event)}
          onClick={() => {
            chooseInputSurface('terminal');
            runtime.current?.focus();
          }}
        />
        {terminalDropKind ? (
          <div className="terminal-drop-prompt" aria-hidden="true">
            {terminalDropKind === 'files' ? 'Copy to workspace and insert path' : 'Insert path into terminal'}
          </div>
        ) : null}
        {runtimeState.connected && runtimeState.screenReady && runtimeState.controlsTerminal === false ? (
          <div className="terminal-control-handoff" role="status">
            <MonitorSmartphone size={16} aria-hidden="true" />
            <span>
              {runtimeState.controlSizeMismatch ? 'Sized for another device' : 'Layout controlled by another device'}
            </span>
            <Button size="sm" onClick={() => runtime.current?.claimControl()}>
              Use this device
            </Button>
          </div>
        ) : null}
        {runtimeState.error ? (
          <div className="terminal-status-card terminal-error" role="alert">
            <CircleAlert size={17} aria-hidden="true" />
            <span>{runtimeState.error}</span>
            <Button size="sm" variant="danger-outline" onClick={() => location.reload()}>
              Reconnect
            </Button>
          </div>
        ) : runtimeState.reconnecting ? (
          <div className="terminal-status-card terminal-connection-status" role="status">
            <RefreshCw size={16} aria-hidden="true" />
            <span>Reconnecting to terminal…</span>
            <Button size="sm" onClick={() => runtime.current?.reconnect()}>
              Retry now
            </Button>
          </div>
        ) : runtimeState.openingVisible ? (
          <div className="terminal-opening" role="status">
            {runtimeState.openingStage === 'restoring'
              ? 'Restoring terminal…'
              : runtimeState.openingStage === 'attaching'
                ? 'Attaching to terminal…'
                : 'Opening terminal…'}
          </div>
        ) : null}
      </div>
      <div className="terminal-input-region input-dock">
        <div className="touch-toolbar" role="group" aria-label="Terminal controls">
          {(
            [
              ['escape', 'Esc'],
              ['interrupt', 'Ctrl+C'],
              ['tab', 'Tab'],
              ['backspace', 'Backspace'],
              ['enter', 'Enter'],
            ] as const
          ).map(([control, label]) => (
            <button
              key={control}
              type="button"
              className={
                control === 'interrupt' || control === 'backspace' || control === 'enter' ? 'wide-key' : undefined
              }
              disabled={!runtimeState.inputReady}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => sendControl(control)}
            >
              {label}
            </button>
          ))}
          <span className="toolbar-divider" aria-hidden="true" />
          {(
            [
              ['arrow-up', '↑', 'Arrow up'],
              ['arrow-down', '↓', 'Arrow down'],
              ['arrow-left', '←', 'Arrow left'],
              ['arrow-right', '→', 'Arrow right'],
            ] as const
          ).map(([control, label, ariaLabel]) => (
            <button
              key={control}
              type="button"
              aria-label={ariaLabel}
              disabled={!runtimeState.inputReady}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => sendControl(control)}
            >
              {label}
            </button>
          ))}
          <span className="toolbar-divider" aria-hidden="true" />
          {(
            [
              ['Scroll to terminal top', 'Top', () => runtime.current?.scrollToTop()],
              ['Scroll terminal up one page', 'PgUp', () => runtime.current?.scrollPageUp()],
              ['Scroll terminal down one page', 'PgDn', () => runtime.current?.scrollPageDown()],
              ['Scroll to terminal bottom', 'Bottom', () => runtime.current?.scrollToBottom()],
            ] as const
          ).map(([label, text, action]) => (
            <button
              key={label}
              type="button"
              className="wide-key"
              aria-label={label}
              onPointerDown={(event) => event.preventDefault()}
              onClick={action}
            >
              {text}
            </button>
          ))}
        </div>
        <div className="composer-feedback">
          {recovery.entries.length ? (
            <div className="submission-recovery" role="region" aria-label="Compose delivery status">
              {recovery.entries.map((entry) => (
                <div key={entry.requestId}>
                  <span>{entry.status === 'pending' ? 'Sending message…' : entry.message}</span>
                  {entry.status !== 'pending' ? <span aria-label="Draft excerpt">{entry.draft}</span> : null}
                  {entry.status !== 'pending' ? (
                    <Button
                      size="sm"
                      aria-label="Restore draft"
                      onClick={() => {
                        setDraft(entry.draft);
                        saveComposerDraft(workspaceId, terminalId, entry.draft);
                        recovery.dismiss(entry.requestId);
                      }}
                    >
                      Restore draft
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {recovery.error ? (
            <p className="composer-notice" role="alert">
              {recovery.error}
            </p>
          ) : null}
          {templateWarning ? (
            <p className="composer-notice" role="status">
              {templateWarning}
            </p>
          ) : null}
          {imageError ? (
            <p className="composer-notice" role="alert">
              {imageError}
            </p>
          ) : null}
          {imageNotice ? (
            <p className="composer-notice" role="status">
              {imageNotice}
            </p>
          ) : null}
        </div>
        <div className="composer-slot">
          <div className={`terminal-composer composer ${inputSurface}-mode`} role="group" aria-label="Terminal input">
            <button
              className="composer-mode"
              type="button"
              aria-label="Switch between Compose and Terminal"
              title={`Switch to ${inputSurface === 'compose' ? 'Terminal' : 'Compose'} (${inputShortcut})`}
              aria-pressed={inputSurface === 'terminal'}
              onClick={toggleInput}
            >
              <ArrowLeftRight size={18} />
              <span>{inputSurface === 'compose' ? 'Compose' : 'Terminal'}</span>
            </button>
            <Textarea
              ref={composerElement}
              className="composer-editor"
              size="sm"
              rows={1}
              value={draft}
              onInput={(event) => {
                const value = event.currentTarget.value;
                setDraft(value);
                saveComposerDraft(workspaceId, terminalId, value);
              }}
              onKeyDown={handleComposerKeyDown}
              onPointerDown={() => setMessageActionsOpen(false)}
              onFocus={() => chooseInputSurface('compose')}
              onBlur={() => saveComposerDraft(workspaceId, terminalId, draft)}
              placeholder="Compose a message…"
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
              aria-label="Send text to the shell"
            />
            <div className="composer-secondary-actions">
              {composerHistoryEnabled ? (
                <div>
                  <ComposerHistoryPopover load={loadPrompts} onSelect={insertPrompt} />
                </div>
              ) : null}
              <input
                ref={imageInput}
                type="file"
                hidden
                accept="image/avif,image/gif,image/jpeg,image/png,image/webp"
                onChange={(event) => {
                  const image = event.currentTarget.files?.[0];
                  if (image) void uploadImage(image);
                  event.currentTarget.value = '';
                }}
              />
              <ToolbarButton
                className="image-button"
                label="Send an image to the shell"
                onClick={() => imageInput.current?.click()}
                disabled={!runtimeState.inputReady || uploadingImage}
              >
                <ImagePlus size={18} />
              </ToolbarButton>
            </div>
            <div className="composer-actions">
              <ToolbarButton
                className="composer-actions-trigger"
                label="More message actions"
                active={messageActionsOpen}
                aria-expanded={messageActionsOpen}
                onClick={() => setMessageActionsOpen((open) => !open)}
              >
                <Ellipsis size={18} />
              </ToolbarButton>
              {messageActionsOpen ? (
                <div className="composer-action-list" data-vampire-overlay>
                  {composerHistoryEnabled ? (
                    <button
                      type="button"
                      onClick={() => {
                        setMessageActionsOpen(false);
                        window.setTimeout(
                          () =>
                            document
                              .querySelector<HTMLButtonElement>(
                                '.composer-secondary-actions [aria-label="Open Composer history"]',
                              )
                              ?.click(),
                          0,
                        );
                      }}
                    >
                      Open Composer history
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={!runtimeState.inputReady || uploadingImage}
                    onClick={() => {
                      setMessageActionsOpen(false);
                      imageInput.current?.click();
                    }}
                  >
                    Send an image to the shell
                  </button>
                </div>
              ) : null}
            </div>
            <Button
              className="send-button"
              variant="primary"
              aria-label="Send to shell"
              title="Send text and press Enter"
              disabled={!runtimeState.inputReady || !draft.trim()}
              onPointerDown={(event) => event.preventDefault()}
              onClick={submit}
            >
              <Send size={17} />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
});
