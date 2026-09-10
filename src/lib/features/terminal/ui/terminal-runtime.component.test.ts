import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { TerminalConnectionCallbacks } from '../api/connection.ts';
import { SubmissionRecovery } from '../model/submission-recovery.svelte.ts';
import { acquireTerminalRuntime, releaseTerminalRuntime, type TerminalRuntimeOptions } from './terminal-runtime.ts';

const doubles = vi.hoisted(() => ({ connections: [] as any[], fitAddons: [] as any[], terminals: [] as any[] }));

vi.mock('../api/connection.ts', () => ({
  TerminalConnection: class {
    connectionId = 1;
    resolveUrl: () => URL;
    urls: URL[] = [];
    callbacks: TerminalConnectionCallbacks;
    send = vi.fn((_message: unknown) => true);
    stop = vi.fn();
    setRetryEnabled = vi.fn();
    markReady = vi.fn();
    retryNow = vi.fn();
    restart = vi.fn();
    context = { id: 1, isCurrent: () => true, send: (message: unknown) => this.send(message) };
    constructor(url: string | URL | (() => string | URL), callbacks: TerminalConnectionCallbacks) {
      this.resolveUrl = () => new URL(typeof url === 'function' ? url() : url);
      this.callbacks = callbacks;
      doubles.connections.push(this);
    }
    start() {
      this.urls.push(this.resolveUrl());
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
    renderHandler: (() => void) | undefined;
    renderOnRefresh = true;
    onRender = vi.fn((handler: () => void) => {
      this.renderHandler = handler;
      return { dispose: vi.fn() };
    });
    refresh = vi.fn(() => {
      if (this.renderOnRefresh) this.renderHandler?.();
    });
    reset = vi.fn();
    clearTextureAtlas = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    scrollHandler: ((viewportY: number) => void) | undefined;
    onScroll = vi.fn((handler: (viewportY: number) => void) => {
      this.scrollHandler = handler;
      return { dispose: vi.fn() };
    });
    loadAddon = vi.fn();
    constructor(options: unknown) {
      this.options = options;
      doubles.terminals.push(this);
    }
    open(element: HTMLElement) {
      element.append(this.element);
    }
    write = vi.fn((_data: string, done?: () => void) => {
      done?.();
    });
    resize = vi.fn((cols: number, rows: number) => {
      this.cols = cols;
      this.rows = rows;
    });
    scrollToLine(line: number) {
      this.buffer.active.viewportY = line;
    }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn();
    constructor() {
      doubles.fitAddons.push(this);
    }
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

async function ready(initial = options(), history?: { loaded: number; available: number }) {
  const runtime = acquireTerminalRuntime(initial);
  runtime.start();
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(3);
  const connection = doubles.connections[0];
  connection.receive({ type: 'snapshot', data: 'hello', throughSequence: 0, ...(history ? { history } : {}) });
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
  doubles.fitAddons.length = 0;
  doubles.terminals.length = 0;
  localStorage.clear();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

test('leaving a workspace disposes its connection and terminal', async () => {
  const { runtime, connection, terminal } = await ready();
  releaseTerminalRuntime(runtime);
  expect(runtime.send('hidden input')).toBe(false);
  expect(connection.stop).toHaveBeenCalledOnce();
  expect(terminal.dispose).toHaveBeenCalledOnce();
});

test('returning to a workspace creates a fresh authoritative terminal connection', async () => {
  const { runtime } = await ready();
  releaseTerminalRuntime(runtime);
  const next = acquireTerminalRuntime(options());
  next.start();
  await vi.dynamicImportSettled();
  expect(next).not.toBe(runtime);
  expect(doubles.connections).toHaveLength(2);
  expect(doubles.terminals).toHaveLength(2);
  next.dispose();
});

test('reconnect does not steal focus and disconnected input reports failure', async () => {
  const { initial, runtime, connection, terminal } = await ready();
  terminal.focus.mockClear();
  connection.callbacks.onDisconnect({ code: 1006, reason: '' }, true);
  expect(runtime.send('/')).toBe(false);
  expect(terminal.element.style.opacity).toBe('0');
  expect(initial.onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ screenReady: false }));
  connection.callbacks.onOpen(connection.context);
  await vi.advanceTimersByTimeAsync(100);
  expect(terminal.focus).not.toHaveBeenCalled();
  runtime.dispose();
});

test('does not proactively report app colors during attach or control handoff', async () => {
  const initial = options();
  initial.getTheme = () => ({ foreground: '#2c2527', background: '#fbfafa', cursor: '#c83f4e' });
  const { runtime, connection } = await ready(initial);

  expect(connection.send.mock.calls.filter(([message]: any[]) => message.type === 'terminal-color')).toHaveLength(0);

  connection.send.mockClear();
  runtime.claimControl();
  window.dispatchEvent(new Event('theme-change'));

  expect(connection.send.mock.calls.filter(([message]: any[]) => message.type === 'terminal-color')).toHaveLength(0);
  runtime.dispose();
});

test('normal output goes straight to xterm without a screen replacement', async () => {
  const { initial, runtime, connection, terminal } = await ready();
  vi.mocked(initial.onStateChange).mockClear();
  terminal.write.mockClear();
  terminal.reset.mockClear();

  connection.receive({ type: 'output', data: 'redraw', sequence: 1 });
  await vi.advanceTimersByTimeAsync(5);

  expect(terminal.reset).not.toHaveBeenCalled();
  expect(terminal.write).toHaveBeenCalledOnce();
  expect(terminal.write).toHaveBeenCalledWith('redraw', expect.any(Function));
  expect(initial.onStateChange).not.toHaveBeenCalled();
  runtime.dispose();
});

test('coalesces output fragments that arrive in the same render frame', async () => {
  const { runtime, connection, terminal } = await ready();
  terminal.write.mockClear();

  connection.receive({ type: 'output', data: 'first', sequence: 1 });
  connection.receive({ type: 'output', data: 'second', sequence: 2 });

  expect(terminal.write).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);

  expect(terminal.write).toHaveBeenCalledOnce();
  expect(terminal.write).toHaveBeenCalledWith('firstsecond', expect.any(Function));
  runtime.dispose();
});

test('delegates geometry changes to xterm without requesting retained history', async () => {
  const { runtime, connection, terminal } = await ready(options(), { loaded: 0, available: 120 });
  connection.send.mockClear();

  connection.receive({ type: 'geometry', columns: 79, rows: 24 });

  expect(terminal.options).toMatchObject({ reflowCursorLine: true });
  expect(terminal.resize).toHaveBeenCalledWith(79, 24);
  expect(connection.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'load-history' }));
  expect(terminal.buffer.active.viewportY).toBe(75);
  runtime.dispose();
});

test('keeps an active xterm fitted to its local container when an old geometry arrives', async () => {
  const { runtime, connection, terminal } = await ready();
  const fitAddon = doubles.fitAddons[0];
  terminal.resize.mockClear();
  fitAddon.fit.mockClear();

  connection.receive({ type: 'geometry', columns: 70, rows: 20, active: true });

  expect(fitAddon.fit).toHaveBeenCalledOnce();
  expect(terminal.resize).not.toHaveBeenCalledWith(70, 20);
  runtime.dispose();
});

test('renders a passive xterm with the authoritative tmux geometry', async () => {
  const { runtime, connection, terminal } = await ready();
  const fitAddon = doubles.fitAddons[0];
  terminal.resize.mockClear();
  fitAddon.fit.mockClear();

  connection.receive({ type: 'geometry', columns: 70, rows: 20, active: false });

  expect(terminal.resize).toHaveBeenCalledExactlyOnceWith(70, 20);
  expect(fitAddon.fit).not.toHaveBeenCalled();
  runtime.dispose();
});

test('requests retained history when xterm reports a user viewport at the top', async () => {
  const { runtime, connection, terminal } = await ready(options(), { loaded: 0, available: 120 });
  connection.send.mockClear();

  terminal.scrollHandler?.(0);
  expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'load-history' }));
  runtime.dispose();
});

test('a snapshot resets once and releases queued output only after screen-ready', async () => {
  const initial = options();
  const runtime = acquireTerminalRuntime(initial);
  runtime.start();
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(3);
  const connection = doubles.connections[0];
  const terminal = doubles.terminals[0];
  terminal.reset.mockClear();
  terminal.write.mockClear();
  connection.send.mockClear();

  connection.receive({ type: 'snapshot', data: 'snapshot', throughSequence: 0 });
  connection.receive({ type: 'output', data: 'queued', sequence: 1 });

  expect(terminal.reset).toHaveBeenCalledOnce();
  expect(terminal.write).toHaveBeenCalledOnce();
  expect(terminal.write).toHaveBeenCalledWith('snapshot', expect.any(Function));
  expect(terminal.element.style.opacity).toBe('0');
  expect(connection.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'snapshot-ready' }));

  connection.receive({ type: 'screen-ready' });

  expect(terminal.write).toHaveBeenNthCalledWith(2, 'queued', expect.any(Function));
  expect(terminal.element.style.opacity).toBe('');
  expect(connection.send).toHaveBeenCalledWith({ type: 'snapshot-ready' });
  expect(connection.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal-color' }));
  runtime.dispose();
});

test('does not expose a snapshot until xterm has rendered it', async () => {
  const initial = options();
  const runtime = acquireTerminalRuntime(initial);
  runtime.start();
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(3);
  const connection = doubles.connections[0];
  const terminal = doubles.terminals[0];
  terminal.renderOnRefresh = false;

  connection.receive({ type: 'snapshot', data: 'snapshot', throughSequence: 0 });
  connection.receive({ type: 'screen-ready' });
  await vi.advanceTimersByTimeAsync(100);

  expect(initial.onStateChange).not.toHaveBeenCalledWith(expect.objectContaining({ screenReady: true }));
  expect(connection.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'snapshot-ready' }));

  terminal.renderHandler?.();

  expect(initial.onStateChange).toHaveBeenCalledWith(expect.objectContaining({ screenReady: true }));
  expect(connection.send).toHaveBeenCalledWith({ type: 'snapshot-ready' });
  runtime.dispose();
});

test('retries identify the same runtime without repeating its initial control claim', async () => {
  const runtime = acquireTerminalRuntime(options());
  runtime.start();
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(3);
  const connection = doubles.connections[0];
  const first = connection.urls[0];
  const retry = connection.resolveUrl();
  expect(first.searchParams.get('client-id')).toMatch(/^[a-f0-9]{32}$/);
  expect(retry.searchParams.get('client-id')).toBe(first.searchParams.get('client-id'));
  expect(first.searchParams.get('connection-attempt')).toBe('1');
  expect(retry.searchParams.get('connection-attempt')).toBe('2');
  expect(first.searchParams.get('active')).toBe('1');
  expect(retry.searchParams.has('active')).toBe(false);
  runtime.dispose();
});

test.each(['online', 'focus', 'visibilitychange'])(
  '%s restarts exhausted transient retries without replaying input or claiming control',
  async (eventName) => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { initial, runtime, connection } = await ready();
    connection.callbacks.onDisconnect({ code: 1006, reason: '' }, true);
    connection.callbacks.onReconnectExhausted();
    connection.send.mockClear();
    const target = eventName === 'visibilitychange' ? document : window;
    target.dispatchEvent(new Event(eventName));
    expect(connection.retryNow).toHaveBeenCalledExactlyOnceWith();
    expect(initial.onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ error: '', reconnecting: true }));
    target.dispatchEvent(new Event(eventName));
    expect(connection.retryNow.mock.calls.filter((args: unknown[]) => args.length === 0)).toHaveLength(1);
    for (const type of ['input', 'submit', 'activate']) {
      expect(connection.send).not.toHaveBeenCalledWith(expect.objectContaining({ type }));
    }
    runtime.dispose();
    visibility.mockRestore();
  }
);

test('connectivity events leave permanent disconnects alone', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const { runtime, connection } = await ready();
  connection.callbacks.onDisconnect({ code: 1008, reason: 'authentication revoked' }, false);
  window.dispatchEvent(new Event('online'));
  window.dispatchEvent(new Event('focus'));
  expect(connection.retryNow).not.toHaveBeenCalled();
  runtime.dispose();
  visibility.mockRestore();
});

test('an online event in a hidden tab does not restart exhausted retries', async () => {
  const { runtime, connection } = await ready();
  connection.callbacks.onDisconnect({ code: 1006, reason: '' }, true);
  connection.callbacks.onReconnectExhausted();
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  window.dispatchEvent(new Event('online'));
  expect(connection.retryNow).not.toHaveBeenCalled();
  runtime.dispose();
  visibility.mockRestore();
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

test('leaving marks pending submissions uncertain without retrying them', async () => {
  const initial = options();
  const { runtime, connection } = await ready(initial);
  expect(runtime.submit('first', 'submit-1')).toBe(true);
  releaseTerminalRuntime(runtime);
  expect(initial.onSubmissionUncertain).toHaveBeenLastCalledWith();
  connection.receive({ type: 'submission-result', requestId: 'submit-1', status: 'completed' });
  expect(initial.onSubmissionResult).not.toHaveBeenCalled();
  expect(connection.send.mock.calls.filter(([message]: any[]) => message.type === 'submit')).toHaveLength(1);
});

test('IME composition is left to xterm instead of sending a Shift+Enter control', async () => {
  const { runtime, connection, terminal } = await ready();
  const handler = terminal.attachCustomKeyEventHandler.mock.calls[0][0];
  const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, isComposing: true });
  expect(handler(event)).toBe(true);
  expect(connection.send.mock.calls.filter(([message]: any[]) => message.type === 'input')).toHaveLength(0);
  runtime.dispose();
});

test('leaving preserves an unconfirmed message as uncertain', async () => {
  const initial = options();
  initial.workspaceId = 'warm-confirmation';
  const recovery = new SubmissionRecovery(initial.workspaceId);
  initial.onSubmissionResult = (result) => recovery.applyResult(result);
  initial.onSubmissionUncertain = (id) => recovery.markUncertain(id);
  const { runtime, connection } = await ready(initial);
  recovery.submit('wrapped', 'original', (data, id) => runtime.submit(data, id));
  releaseTerminalRuntime(runtime);
  expect(new SubmissionRecovery(initial.workspaceId).entries[0]).toMatchObject({
    draft: 'original',
    status: 'uncertain',
  });
  expect(connection.send.mock.calls.filter(([message]: any[]) => message.type === 'submit')).toHaveLength(1);
});
