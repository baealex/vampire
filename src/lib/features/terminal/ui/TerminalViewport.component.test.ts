import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import TerminalViewport from './TerminalViewport.svelte';

const runtimeHarness = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  released: [] as Array<Record<string, unknown>>,
  runtimes: [] as Array<Record<string, unknown>>,
}));

vi.mock('./terminal-runtime.ts', () => ({
  acquireTerminalRuntime: (options: Record<string, unknown>) => {
    const runtime = {
      claimControl: vi.fn(),
      focus: vi.fn(),
      pendingSubmissionIds: [],
      reconnect: vi.fn(),
      scrollPageDown: vi.fn(),
      scrollPageUp: vi.fn(),
      scrollToBottom: vi.fn(),
      scrollToTop: vi.fn(),
      send: vi.fn(() => false),
      sendControl: vi.fn(),
      setFontSize: vi.fn(),
      start: vi.fn(),
      submit: vi.fn(() => false),
    };
    runtimeHarness.options.push(options);
    runtimeHarness.runtimes.push(runtime);
    return runtime;
  },
  releaseTerminalRuntime: (runtime: Record<string, unknown>) => runtimeHarness.released.push(runtime),
}));

let animationFrames: Map<number, FrameRequestCallback>;
let nextAnimationFrame: number;

function renderViewport(workspaceId = 'workspace-a', terminalId = 'terminal-a') {
  return render(TerminalViewport, {
    workspaceId,
    terminalId,
    composerTemplateContext: { workspace: { name: 'Vampire', cwd: '/work/vampire' } },
    composerHistoryEnabled: false,
    onRecordComposerPrompt: vi.fn(async () => undefined),
    onLoadComposerPrompts: vi.fn(async () => []),
  });
}

async function flushAnimationFrames() {
  await tick();
  for (let pass = 0; pass < 6 && animationFrames.size > 0; pass += 1) {
    const callbacks = [...animationFrames.entries()];
    animationFrames.clear();
    for (const [, callback] of callbacks) callback(0);
    await tick();
  }
}

function latestRuntimeOptions() {
  return runtimeHarness.options.at(-1) as {
    onStateChange: (state: {
      connected: boolean;
      controlSizeMismatch: boolean;
      controlsTerminal: boolean | undefined;
      error: string;
      inputReady: boolean;
      openingStage: 'opening' | 'attaching' | 'restoring';
      openingVisible: boolean;
      outputPaused: boolean;
      reconnecting: boolean;
      screenReady: boolean;
    }) => void;
    shouldAutoFocus: () => boolean;
  };
}

beforeEach(() => {
  animationFrames = new Map();
  nextAnimationFrame = 1;
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const frame = nextAnimationFrame;
    nextAnimationFrame += 1;
    animationFrames.set(frame, callback);
    return frame;
  });
  vi.stubGlobal('cancelAnimationFrame', (frame: number) => animationFrames.delete(frame));
  runtimeHarness.options.length = 0;
  runtimeHarness.released.length = 0;
  runtimeHarness.runtimes.length = 0;
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

test('focuses Compose after its child mounts without waiting for a connection state', async () => {
  renderViewport();
  const composer = screen.getByLabelText('Send text to the shell');

  expect(composer).not.toHaveFocus();
  await flushAnimationFrames();

  expect(composer).toHaveFocus();
});

test('a later connection state does not take focus back from an explicit control', async () => {
  renderViewport();
  await flushAnimationFrames();

  const control = document.createElement('button');
  document.body.append(control);
  control.focus();
  latestRuntimeOptions().onStateChange({
    connected: true,
    controlSizeMismatch: false,
    controlsTerminal: true,
    error: '',
    inputReady: true,
    openingStage: 'restoring',
    openingVisible: false,
    outputPaused: false,
    reconnecting: false,
    screenReady: true,
  });
  await flushAnimationFrames();

  expect(control).toHaveFocus();
});

test('keeps Compose active when a terminal toggle occurs before input is ready', async () => {
  renderViewport();
  await flushAnimationFrames();
  const composer = screen.getByLabelText('Send text to the shell');

  await fireEvent.keyDown(composer, { code: 'Slash', key: '/', metaKey: true });

  expect(composer).toHaveFocus();
  expect(runtimeHarness.runtimes[0].focus as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  expect(latestRuntimeOptions().shouldAutoFocus()).toBe(false);
});

test('does not override an open overlay during initial focus restoration', async () => {
  const overlay = document.createElement('div');
  overlay.dataset.vampireOverlay = '';
  const overlayControl = document.createElement('button');
  overlay.append(overlayControl);
  document.body.append(overlay);
  overlayControl.focus();

  renderViewport();
  await flushAnimationFrames();

  expect(overlayControl).toHaveFocus();
});

test('does not override focus chosen after a previously focused workspace node is removed', async () => {
  const previousComposer = document.createElement('textarea');
  const persistentControl = document.createElement('button');
  document.body.append(previousComposer, persistentControl);
  previousComposer.focus();

  renderViewport();
  previousComposer.remove();
  persistentControl.focus();
  await flushAnimationFrames();

  expect(persistentControl).toHaveFocus();
});

test('releases the runtime and cancels pending Compose focus when unmounted', async () => {
  const persistentControl = document.createElement('button');
  document.body.append(persistentControl);
  const view = renderViewport();
  await tick();
  view.unmount();
  persistentControl.focus();
  await flushAnimationFrames();

  expect(runtimeHarness.released).toEqual([runtimeHarness.runtimes[0]]);
  expect(persistentControl).toHaveFocus();
});

test('restores a terminal preference only for its workspace and terminal', async () => {
  sessionStorage.setItem('vampire:last-focused-input-surface:v2:workspace-a:terminal-a', 'terminal');

  const terminalView = renderViewport('workspace-a', 'terminal-a');
  expect(latestRuntimeOptions().shouldAutoFocus()).toBe(true);
  await flushAnimationFrames();
  expect(screen.getByLabelText('Send text to the shell')).not.toHaveFocus();
  terminalView.unmount();

  renderViewport('workspace-b', 'terminal-a');
  expect(latestRuntimeOptions().shouldAutoFocus()).toBe(false);
  await flushAnimationFrames();
  expect(screen.getByLabelText('Send text to the shell')).toHaveFocus();
});
