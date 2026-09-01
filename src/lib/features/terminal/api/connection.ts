import {
  decodeTerminalServerMessage,
  encodeTerminalClientMessage,
  type TerminalClientMessage,
  type TerminalServerMessage,
} from '~/lib/shared/contracts/terminal-protocol.ts';

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;
const MAXIMUM_RECONNECT_DELAY_MS = 30_000;
const MAXIMUM_RECONNECT_ATTEMPTS = 5;
export const TERMINAL_READY_TIMEOUT_MS = 15_000;
export const TERMINAL_STABLE_READY_MS = 5_000;
const TERMINAL_READY_TIMEOUT_CLOSE_CODE = 4_000;
const TERMINAL_READY_TIMEOUT_REASON = 'terminal ready timeout';

export interface TerminalConnectionContext {
  id: number;
  isCurrent: () => boolean;
  send: (message: TerminalClientMessage) => boolean;
}

export interface TerminalConnectionCallbacks {
  onOpen?: (context: TerminalConnectionContext) => void;
  onMessage?: (message: TerminalServerMessage, context: TerminalConnectionContext) => void;
  onDisconnect?: (event: { code: number; reason: string }, retrying: boolean) => void;
  onRetrying?: (delay: number) => void;
  onReconnectExhausted?: () => void;
  onProtocolError?: (context: TerminalConnectionContext) => void;
}

export interface TerminalSocket {
  readyState: number;
  onopen: ((event: any) => void) | null;
  onmessage: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onclose: ((event: any) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

type Timer = unknown;

export interface TerminalConnectionDependencies {
  createSocket?: (url: string) => TerminalSocket;
  setTimeout?: (callback: () => void, delay: number) => Timer;
  clearTimeout?: (timer: Timer) => void;
}

export type TerminalConnectionUrl = string | URL | (() => string | URL);

export function terminalReconnectDelay(attempt: number): number {
  return Math.min(MAXIMUM_RECONNECT_DELAY_MS, 500 * 2 ** Math.min(Math.max(0, attempt), 6));
}

export function terminalCloseIsRetryable(event: { code: number; reason: string }): boolean {
  if (event.code === 1009 && event.reason === 'terminal screen exceeds limit') return false;
  if (event.code !== 1008) return true;
  return !['authentication expired', 'authentication revoked', 'message rate exceeded'].includes(event.reason);
}

export class TerminalConnection {
  #callbacks: TerminalConnectionCallbacks;
  #clearTimeout: (timer: Timer) => void;
  #connectionId = 0;
  #createSocket: (url: string) => TerminalSocket;
  #reconnectAttempt = 0;
  #reconnectTimer: Timer | undefined;
  #readyTimer: Timer | undefined;
  #retryEnabled = true;
  #setTimeout: (callback: () => void, delay: number) => Timer;
  #socket: TerminalSocket | undefined;
  #stableReadyTimer: Timer | undefined;
  #stopped = true;
  #url: () => string;

  constructor(
    url: TerminalConnectionUrl,
    callbacks: TerminalConnectionCallbacks,
    dependencies: TerminalConnectionDependencies = {}
  ) {
    this.#url = typeof url === 'function' ? () => String(url()) : () => String(url);
    this.#callbacks = callbacks;
    this.#createSocket = dependencies.createSocket ?? ((socketUrl) => new WebSocket(socketUrl));
    this.#setTimeout = dependencies.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
    this.#clearTimeout = dependencies.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  get connectionId(): number {
    return this.#connectionId;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    if (this.#retryEnabled) this.#connect();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#clearReconnectTimer();
    this.#clearReadyTimer();
    this.#clearStableReadyTimer();
    this.#reconnectAttempt = 0;
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket && socket.readyState !== SOCKET_CLOSED) socket.close(1000, 'terminal connection stopped');
  }

  retryNow(resetAttempts = true): void {
    if (this.#stopped) return;
    this.#retryEnabled = true;
    this.#clearReconnectTimer();
    if (resetAttempts) this.#reconnectAttempt = 0;
    this.#callbacks.onRetrying?.(0);
    this.#connect();
  }

  restart(reason = 'terminal stream restart'): void {
    if (this.#stopped) return;
    this.#clearReconnectTimer();
    this.#clearReadyTimer();
    this.#clearStableReadyTimer();
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket && socket.readyState !== SOCKET_CLOSED) {
      try {
        socket.close(4_001, reason);
      } catch {
        // Some browsers reject close() while the handshake is still pending.
      }
    }
    if (this.#retryEnabled) this.#scheduleReconnect();
  }

  setRetryEnabled(enabled: boolean): void {
    if (this.#retryEnabled === enabled) return;
    this.#retryEnabled = enabled;
    if (!enabled) {
      this.#clearReconnectTimer();
      return;
    }
    if (this.#stopped || this.#socket) return;
    if (this.#reconnectAttempt === 0) this.#connect();
    else this.#scheduleReconnect();
  }

  markReady(context: TerminalConnectionContext): void {
    if (!context.isCurrent()) return;
    this.#clearReadyTimer();
    this.#clearStableReadyTimer();
    this.#stableReadyTimer = this.#setTimeout(() => {
      this.#stableReadyTimer = undefined;
      if (context.isCurrent()) this.#reconnectAttempt = 0;
    }, TERMINAL_STABLE_READY_MS);
  }

  send(message: TerminalClientMessage): boolean {
    return this.#socket ? this.#sendToSocket(this.#socket, message) : false;
  }

  #connect(): void {
    if (
      this.#stopped ||
      !this.#retryEnabled ||
      this.#socket?.readyState === SOCKET_OPEN ||
      this.#socket?.readyState === SOCKET_CONNECTING
    )
      return;
    const socket = this.#createSocket(this.#url());
    this.#socket = socket;
    const id = ++this.#connectionId;
    const context: TerminalConnectionContext = {
      id,
      isCurrent: () => !this.#stopped && this.#socket === socket,
      send: (message) => this.#sendToSocket(socket, message),
    };
    this.#startReadyTimer(socket, context);

    socket.onopen = () => {
      if (!context.isCurrent()) return;
      this.#callbacks.onOpen?.(context);
    };
    socket.onmessage = (event) => {
      if (!context.isCurrent()) return;
      const message = decodeTerminalServerMessage(event.data);
      if (!message) {
        this.#callbacks.onProtocolError?.(context);
        return;
      }
      this.#callbacks.onMessage?.(message, context);
    };
    socket.onerror = () => undefined;
    socket.onclose = (event) => {
      if (!context.isCurrent()) return;
      this.#clearReadyTimer();
      this.#clearStableReadyTimer();
      this.#socket = undefined;
      const retrying = terminalCloseIsRetryable(event);
      this.#callbacks.onDisconnect?.(event, retrying);
      if (retrying) this.#scheduleReconnect();
    };
  }

  #startReadyTimer(socket: TerminalSocket, context: TerminalConnectionContext): void {
    this.#clearReadyTimer();
    this.#readyTimer = this.#setTimeout(() => {
      this.#readyTimer = undefined;
      if (!context.isCurrent()) return;
      this.#socket = undefined;
      try {
        socket.close(TERMINAL_READY_TIMEOUT_CLOSE_CODE, TERMINAL_READY_TIMEOUT_REASON);
      } catch {
        // A browser can reject close() while the WebSocket handshake is still pending.
      }
      this.#callbacks.onDisconnect?.(
        {
          code: TERMINAL_READY_TIMEOUT_CLOSE_CODE,
          reason: TERMINAL_READY_TIMEOUT_REASON,
        },
        true
      );
      this.#scheduleReconnect();
    }, TERMINAL_READY_TIMEOUT_MS);
  }

  #scheduleReconnect(): void {
    if (this.#stopped || !this.#retryEnabled || this.#reconnectTimer !== undefined) return;
    if (this.#reconnectAttempt >= MAXIMUM_RECONNECT_ATTEMPTS) {
      this.#callbacks.onReconnectExhausted?.();
      return;
    }
    const delay = terminalReconnectDelay(this.#reconnectAttempt);
    this.#reconnectAttempt += 1;
    this.#callbacks.onRetrying?.(delay);
    this.#reconnectTimer = this.#setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#connect();
    }, delay);
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer === undefined) return;
    this.#clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
  }

  #clearReadyTimer(): void {
    if (this.#readyTimer === undefined) return;
    this.#clearTimeout(this.#readyTimer);
    this.#readyTimer = undefined;
  }

  #clearStableReadyTimer(): void {
    if (this.#stableReadyTimer === undefined) return;
    this.#clearTimeout(this.#stableReadyTimer);
    this.#stableReadyTimer = undefined;
  }

  #sendToSocket(socket: TerminalSocket, message: TerminalClientMessage): boolean {
    if (this.#stopped || this.#socket !== socket || socket.readyState !== SOCKET_OPEN) return false;
    socket.send(encodeTerminalClientMessage(message));
    return true;
  }
}
