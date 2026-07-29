import { decodeTerminalServerMessage, encodeTerminalClientMessage } from './protocol.mjs';

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;
const MAXIMUM_RECONNECT_DELAY_MS = 30_000;

/** @typedef {import('./protocol.mjs').TerminalClientMessage} TerminalClientMessage */
/** @typedef {import('./protocol.mjs').TerminalServerMessage} TerminalServerMessage */
/** @typedef {{ id: number; isCurrent: () => boolean; send: (message: TerminalClientMessage) => boolean }} TerminalConnectionContext */
/** @typedef {{ onOpen?: (context: TerminalConnectionContext) => void; onMessage?: (message: TerminalServerMessage, context: TerminalConnectionContext) => void; onDisconnect?: (event: { code: number; reason: string }, retrying: boolean) => void; onRetrying?: (delay: number) => void; onProtocolError?: (context: TerminalConnectionContext) => void }} TerminalConnectionCallbacks */
/** @typedef {{ createSocket?: (url: string) => WebSocket; setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>; clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void }} TerminalConnectionDependencies */

/** @param {number} attempt */
export function terminalReconnectDelay(attempt) {
	return Math.min(MAXIMUM_RECONNECT_DELAY_MS, 500 * 2 ** Math.min(Math.max(0, attempt), 6));
}

/** @param {{ code: number; reason: string }} event */
export function terminalCloseIsRetryable(event) {
	if (event.code !== 1008) return true;
	return event.reason !== 'authentication expired' && event.reason !== 'message rate exceeded';
}

export class TerminalConnection {
	#callbacks;
	#clearTimeout;
	#connectionId = 0;
	#createSocket;
	#reconnectAttempt = 0;
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	#reconnectTimer;
	#setTimeout;
	/** @type {WebSocket | undefined} */
	#socket;
	#stopped = true;
	#url;

	/**
	 * @param {string | URL} url
	 * @param {TerminalConnectionCallbacks} callbacks
	 * @param {TerminalConnectionDependencies} [dependencies]
	 */
	constructor(url, callbacks, dependencies = {}) {
		this.#url = String(url);
		this.#callbacks = callbacks;
		this.#createSocket = dependencies.createSocket ?? ((socketUrl) => new WebSocket(socketUrl));
		this.#setTimeout = dependencies.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
		this.#clearTimeout = dependencies.clearTimeout ?? ((timer) => clearTimeout(timer));
	}

	get connectionId() {
		return this.#connectionId;
	}

	start() {
		if (!this.#stopped) return;
		this.#stopped = false;
		this.#connect();
	}

	stop() {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#clearReconnectTimer();
		this.#reconnectAttempt = 0;
		const socket = this.#socket;
		this.#socket = undefined;
		if (socket && socket.readyState !== SOCKET_CLOSED) socket.close(1000, 'terminal connection stopped');
	}

	retryNow() {
		if (this.#stopped) return;
		this.#clearReconnectTimer();
		this.#reconnectAttempt = 0;
		this.#callbacks.onRetrying?.(0);
		this.#connect();
	}

	/** @param {TerminalClientMessage} message */
	send(message) {
		return this.#socket ? this.#sendToSocket(this.#socket, message) : false;
	}

	#connect() {
		if (this.#stopped || this.#socket?.readyState === SOCKET_OPEN || this.#socket?.readyState === SOCKET_CONNECTING) return;
		const socket = this.#createSocket(this.#url);
		this.#socket = socket;
		const id = ++this.#connectionId;
		/** @type {TerminalConnectionContext} */
		const context = {
			id,
			isCurrent: () => !this.#stopped && this.#socket === socket,
			send: (message) => this.#sendToSocket(socket, message)
		};

		socket.onopen = () => {
			if (!context.isCurrent()) return;
			this.#reconnectAttempt = 0;
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
			this.#socket = undefined;
			const retrying = terminalCloseIsRetryable(event);
			this.#callbacks.onDisconnect?.(event, retrying);
			if (retrying) this.#scheduleReconnect();
		};
	}

	#scheduleReconnect() {
		if (this.#stopped || this.#reconnectTimer !== undefined) return;
		const delay = terminalReconnectDelay(this.#reconnectAttempt);
		this.#reconnectAttempt += 1;
		this.#callbacks.onRetrying?.(delay);
		this.#reconnectTimer = this.#setTimeout(() => {
			this.#reconnectTimer = undefined;
			this.#connect();
		}, delay);
	}

	#clearReconnectTimer() {
		if (this.#reconnectTimer === undefined) return;
		this.#clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = undefined;
	}

	/** @param {WebSocket} socket @param {TerminalClientMessage} message */
	#sendToSocket(socket, message) {
		if (this.#stopped || this.#socket !== socket || socket.readyState !== SOCKET_OPEN) return false;
		socket.send(encodeTerminalClientMessage(message));
		return true;
	}
}
