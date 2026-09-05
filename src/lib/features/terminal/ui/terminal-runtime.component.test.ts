import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { TerminalConnectionCallbacks } from '../api/connection.ts';
import { SubmissionRecovery } from '../model/submission-recovery.svelte.ts';
import {
  acquireTerminalRuntime,
  clearRecentTerminalRuntimes,
  releaseTerminalRuntime,
  type TerminalRuntimeOptions,
} from './terminal-runtime.ts';

const doubles = vi.hoisted(() => ({ connections: [] as any[], terminals: [] as any[] }));

vi.mock('../api/connection.ts', () => ({
  TerminalConnection: class {
    connectionId = 1;
    callbacks: TerminalConnectionCallbacks;
    send = vi.fn((_message: unknown) => true);
    stop = vi.fn();
    setRetryEnabled = vi.fn();
    markReady = vi.fn();
    retryNow = vi.fn();
    restart = vi.fn();
    context = { id: 1, isCurrent: () => true, send: (message: unknown) => this.send(message) };
    constructor(_url: unknown, callbacks: TerminalConnectionCallbacks) {
      this.callbacks = callbacks;
      doubles.connections.push(this);
    }
    start() {
      this.callbacks.onOpen?.(this.context);
    }
    receive(message: any) {
      this.callbacks.onMessage?.(message, this.context);
    }
  },
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: any;
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: true, applicationCursorKeysMode: false, mouseTrackingMode: 'none' };
    buffer = { active: { type: 'normal', baseY: 100, viewportY: 75 } };
    element = document.createElement('div');
    focus = vi.fn();
    dispose = vi.fn();
    refresh = vi.fn();
    reset = vi.fn();
    clearTextureAtlas = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onScroll = vi.fn(() => ({ dispose: vi.fn() }));
    loadAddon = vi.fn();
    constructor(options: unknown) {
      this.options = options;
      doubles.terminals.push(this);
    }
    open(element: HTMLElement) {
      element.append(this.element);
    }
    write(_data: string, done?: () => void) {
      done?.();
    }
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    }
    scrollToLine(line: number) {
      this.buffer.active.viewportY = line;
    }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn();
    proposeDimensions() {
      return { cols: 80, rows: 24 };
    }
  },
}));

function options(): TerminalRuntimeOptions {
  const element = document.createElement('div');
  document.body.append(element);
  return {
    element,
    workspaceId: 'workspace-a',
    fontSize: 14,
    minimumFontSize: 10,
    maximumFontSize: 22,
    themeChangeEvent: 'theme-change',
    getFontFamily: () => 'test-font',
    getTheme: () => ({}),
    shouldAutoFocus: () => true,
    onFontSizeChange: vi.fn(),
    onComposeShortcut: vi.fn(),
    onInputActivity: vi.fn(),
    onTerminalInput: vi.fn(),
    onOutputActivity: vi.fn(),
    onRepositoryStatus: vi.fn(),
    onStateChange: vi.fn(),
    onTerminalTap: vi.fn(),
    onSubmissionResult: vi.fn(),
    onSubmissionUncertain: vi.fn(),
  };
}

async function ready(initial = options()) {
  const runtime = acquireTerminalRuntime(initial);
  runtime.start();
  await vi.dynamicImportSettled();
  const connection = doubles.connections[0];
  connection.receive({ type: 'snapshot', data: 'hello', throughSequence: 0 });
  connection.receive({ type: 'screen-ready' });
  await vi.advanceTimersByTimeAsync(100);
  return { initial, runtime, connection, terminal: doubles.terminals[0] };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 1));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  doubles.connections.length = 0;
  doubles.terminals.length = 0;
  localStorage.clear();
});

afterEach(() => {
  clearRecentTerminalRuntimes();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

test('returning to a workspace reuses its connection, terminal and reading position', async () => {
  const { initial, runtime, connection, terminal } = await ready();
  expect(runtime.canSuspend).toBe(true);
  releaseTerminalRuntime(runtime);
  expect(runtime.send('hidden input')).toBe(false);
  expect(connection.stop).not.toHaveBeenCalled();
  const resumedOptions = options();
  const resumed = acquireTerminalRuntime(resumedOptions);
  expect(resumed).toBe(runtime);
  expect(doubles.connections).toHaveLength(1);
  expect(doubles.terminals).toHaveLength(1);
  expect(resumedOptions.element.contains(terminal.element)).toBe(true);
  expect(initial.element.contains(terminal.element)).toBe(false);
  expect(terminal.buffer.active.viewportY).toBe(75);
  expect(resumedOptions.onStateChange).toHaveBeenCalledWith(expect.objectContaining({ screenReady: true }));
  resumed.dispose();
});

test('reconnect does not steal focus and disconnected input reports failure', async () => {
  const { runtime, connection, terminal } = await ready();
  terminal.focus.mockClear();
  connection.callbacks.onDisconnect({ code: 1006, reason: '' }, true);
  expect(runtime.send('/')).toBe(false);
  connection.callbacks.onOpen(connection.context);
  expect(runtime.canSuspend).toBe(false);
  await vi.advanceTimersByTimeAsync(100);
  expect(terminal.focus).not.toHaveBeenCalled();
  runtime.dispose();
});

test('a new terminal does not take keyboard focus until input can be accepted', async () => {
  const initial = options();
  const runtime = acquireTerminalRuntime(initial);
  runtime.start();
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(100);
  const terminal = doubles.terminals[0];
  expect(terminal.focus).not.toHaveBeenCalled();
  doubles.connections[0].receive({ type: 'screen-ready' });
  await vi.advanceTimersByTimeAsync(100);
  expect(terminal.focus).toHaveBeenCalledOnce();
  runtime.dispose();
});

test('pending submissions survive a quick switch, acknowledge once and time out without retry', async () => {
  const { runtime, connection } = await ready();
  expect(runtime.submit('first', 'submit-1')).toBe(true);
  releaseTerminalRuntime(runtime);
  const resumedOptions = options();
  const resumed = acquireTerminalRuntime(resumedOptions);
  connection.receive({ type: 'submission-result', requestId: 'submit-1', status: 'completed' });
  expect(resumedOptions.onSubmissionResult).toHaveBeenCalledOnce();
  expect(resumed.submit('second', 'submit-2')).toBe(true);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(resumedOptions.onSubmissionUncertain).toHaveBeenCalledExactlyOnceWith('submit-2');
  expect(connection.send.mock.calls.filter(([message]: any[]) => message.type === 'submit')).toHaveLength(2);
  resumed.dispose();
});

test('IME composition is left to xterm instead of sending a Shift+Enter control', async () => {
  const { runtime, connection, terminal } = await ready();
  const handler = terminal.attachCustomKeyEventHandler.mock.calls[0][0];
  const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, isComposing: true });
  expect(handler(event)).toBe(true);
  expect(connection.send.mock.calls.filter(([message]: any[]) => message.type === 'input')).toHaveLength(0);
  runtime.dispose();
});

test('a confirmation while the workspace is unmounted updates its recovery journal', async () => {
  const initial = options();
  initial.workspaceId = 'warm-confirmation';
  const recovery = new SubmissionRecovery(initial.workspaceId);
  initial.onSubmissionResult = (result) => recovery.applyResult(result);
  initial.onSubmissionUncertain = (id) => recovery.markUncertain(id);
  const { runtime, connection } = await ready(initial);
  recovery.submit('wrapped', 'original', (data, id) => runtime.submit(data, id));
  const requestId = recovery.entries[0].requestId;
  releaseTerminalRuntime(runtime);
  connection.receive({ type: 'submission-result', requestId, status: 'completed' });
  expect(new SubmissionRecovery(initial.workspaceId).entries).toEqual([]);
});

test('an idle terminal expiry preserves its unconfirmed message without resending', async () => {
  const initial = options();
  initial.workspaceId = 'warm-timeout';
  const recovery = new SubmissionRecovery(initial.workspaceId);
  initial.onSubmissionResult = (result) => recovery.applyResult(result);
  initial.onSubmissionUncertain = (id) => recovery.markUncertain(id);
  const { runtime, connection } = await ready(initial);
  recovery.submit('wrapped', 'original', (data, id) => runtime.submit(data, id));
  releaseTerminalRuntime(runtime);
  await vi.advanceTimersByTimeAsync(30_001);
  expect(new SubmissionRecovery(initial.workspaceId).entries[0]).toMatchObject({
    draft: 'original',
    status: 'uncertain',
  });
  expect(connection.send.mock.calls.filter(([message]: any[]) => message.type === 'submit')).toHaveLength(1);
});

test('a busy hidden terminal is evicted instead of continually parsing background output', async () => {
  const { runtime, connection, terminal } = await ready();
  releaseTerminalRuntime(runtime);
  connection.receive({ type: 'output', data: 'x'.repeat(1024 * 1024), activity: false, activityAt: null, sequence: 1 });
  expect(terminal.dispose).toHaveBeenCalledOnce();
  expect(connection.stop).toHaveBeenCalledOnce();
  expect(runtime.canSuspend).toBe(false);
});
