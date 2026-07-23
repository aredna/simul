import {
  PREFERENCE_SAFETY_PROTOCOL_VERSION,
  readPreferenceSafetyReadyMessage,
} from './preference-safety-coordinator';

export interface PreferenceSafetyClientPort {
  readonly onMessage: {
    addListener(listener: (message: unknown) => void): void;
    removeListener(listener: (message: unknown) => void): void;
  };
  readonly onDisconnect: {
    addListener(listener: () => void): void;
    removeListener(listener: () => void): void;
  };
  postMessage(message: unknown): void;
  disconnect?(): void;
}

export interface PreferenceSafetyClientOptions {
  readonly connect: () => PreferenceSafetyClientPort;
  readonly refreshCommittedSnapshot: () => Promise<void>;
  readonly onSafetyMessage: (
    message: unknown,
    reply: (message: unknown) => void,
  ) => void | Promise<void>;
  readonly onFailClosed: () => void;
  readonly onReady: () => void;
  readonly createNonce?: () => string;
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
  readonly handshakeTimeoutMs?: number;
}

interface PortListeners {
  readonly message: (message: unknown) => void;
  readonly disconnect: () => void;
}

const RECONNECT_DELAYS_MS = Object.freeze([100, 250, 500, 1_000, 2_000]);
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 2_000;

/**
 * Keeps a companion attached to the background-owned privacy barrier.
 * Disconnect is always fail-closed; broader work resumes only after the new
 * port handshakes and a fresh committed preference snapshot has been applied.
 */
export class PreferenceSafetyClient {
  #port: PreferenceSafetyClientPort | undefined;
  #listeners: PortListeners | undefined;
  #connectionNonce: string | undefined;
  #generation = 0;
  #reconnectAttempt = 0;
  #reconnectTimer: unknown;
  #handshakeTimer: unknown;
  #started = false;
  #disposed = false;
  #ready = false;
  #failClosedNotified = false;

  constructor(private readonly options: PreferenceSafetyClientOptions) {}

  get ready(): boolean {
    return this.#ready;
  }

  start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    this.#connectNow();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearReconnectTimer();
    this.#clearHandshakeTimer();
    const port = this.#port;
    this.#detachPort(port);
    try {
      port?.disconnect?.();
    } catch {
      // The connection is already being discarded.
    }
  }

  #connectNow(): void {
    if (this.#disposed || this.#port) return;
    this.#clearReconnectTimer();
    const generation = ++this.#generation;
    let port: PreferenceSafetyClientPort;
    try {
      port = this.options.connect();
    } catch {
      this.#notifyFailClosed();
      this.#scheduleReconnect();
      return;
    }
    if (this.#disposed || generation !== this.#generation) {
      try {
        port.disconnect?.();
      } catch {
        // A stale connection has no authority to reopen the gate.
      }
      return;
    }

    const listeners: PortListeners = {
      message: (message) => this.#receive(port, generation, message),
      disconnect: () => this.#disconnect(port, generation),
    };
    this.#port = port;
    this.#listeners = listeners;
    port.onMessage.addListener(listeners.message);
    port.onDisconnect.addListener(listeners.disconnect);

    const nonce = (this.options.createNonce ?? (() => crypto.randomUUID()))();
    this.#connectionNonce = nonce;
    const timeoutMs = positiveTimeout(
      this.options.handshakeTimeoutMs,
      DEFAULT_HANDSHAKE_TIMEOUT_MS,
    );
    this.#handshakeTimer = this.#setTimer(
      () => this.#invalidate(port, generation, true),
      timeoutMs,
    );
    try {
      port.postMessage({
        kind: 'simul:preference-safety-v1:hello',
        version: PREFERENCE_SAFETY_PROTOCOL_VERSION,
        connectionNonce: nonce,
      });
    } catch {
      this.#invalidate(port, generation, false);
      return;
    }
  }

  #receive(
    port: PreferenceSafetyClientPort,
    generation: number,
    value: unknown,
  ): void {
    if (!this.#isCurrent(port, generation)) return;
    const ready = readPreferenceSafetyReadyMessage(value);
    if (ready && ready.connectionNonce === this.#connectionNonce) {
      this.#clearHandshakeTimer();
      this.#connectionNonce = undefined;
      void this.#hydrate(port, generation);
      return;
    }
    try {
      const handling = this.options.onSafetyMessage(value, (message) => {
        if (!this.#isCurrent(port, generation)) return;
        port.postMessage(message);
      });
      if (handling) {
        void Promise.resolve(handling).catch(() => {
          this.#invalidate(port, generation, true);
        });
      }
    } catch {
      this.#invalidate(port, generation, true);
    }
  }

  async #hydrate(
    port: PreferenceSafetyClientPort,
    generation: number,
  ): Promise<void> {
    try {
      await this.options.refreshCommittedSnapshot();
    } catch {
      this.#invalidate(port, generation, true);
      return;
    }
    if (!this.#isCurrent(port, generation)) return;
    this.#ready = true;
    this.#failClosedNotified = false;
    this.#reconnectAttempt = 0;
    try {
      this.options.onReady();
    } catch {
      this.#ready = false;
      this.#invalidate(port, generation, true);
    }
  }

  #disconnect(
    port: PreferenceSafetyClientPort,
    generation: number,
  ): void {
    this.#invalidate(port, generation, false);
  }

  #invalidate(
    port: PreferenceSafetyClientPort,
    generation: number,
    requestDisconnect: boolean,
  ): void {
    if (!this.#isCurrent(port, generation)) return;
    this.#clearHandshakeTimer();
    this.#detachPort(port);
    this.#generation += 1;
    this.#ready = false;
    this.#notifyFailClosed();
    if (requestDisconnect) {
      try {
        port.disconnect?.();
      } catch {
        // The fail-closed state no longer depends on this Port.
      }
    }
    this.#scheduleReconnect();
  }

  #detachPort(port: PreferenceSafetyClientPort | undefined): void {
    const listeners = this.#listeners;
    if (port && listeners) {
      port.onMessage.removeListener(listeners.message);
      port.onDisconnect.removeListener(listeners.disconnect);
    }
    if (this.#port === port) this.#port = undefined;
    this.#listeners = undefined;
    this.#connectionNonce = undefined;
  }

  #notifyFailClosed(): void {
    if (this.#failClosedNotified || this.#disposed) return;
    this.#failClosedNotified = true;
    try {
      this.options.onFailClosed();
    } catch {
      // Reconnection must remain live even if UI cleanup reports an error.
    }
  }

  #scheduleReconnect(): void {
    if (this.#disposed || this.#reconnectTimer !== undefined) return;
    const delay = RECONNECT_DELAYS_MS[
      Math.min(this.#reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
    ]!;
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = this.#setTimer(() => {
      this.#reconnectTimer = undefined;
      this.#connectNow();
    }, delay);
  }

  #isCurrent(
    port: PreferenceSafetyClientPort,
    generation: number,
  ): boolean {
    return !this.#disposed && this.#port === port && this.#generation === generation;
  }

  #setTimer(callback: () => void, delayMs: number): unknown {
    return (this.options.setTimer ?? ((run, delay) => setTimeout(run, delay)))(
      callback,
      delayMs,
    );
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer === undefined) return;
    (this.options.clearTimer ?? ((timer) => clearTimeout(
      timer as ReturnType<typeof setTimeout>,
    )))(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
  }

  #clearHandshakeTimer(): void {
    if (this.#handshakeTimer === undefined) return;
    (this.options.clearTimer ?? ((timer) => clearTimeout(
      timer as ReturnType<typeof setTimeout>,
    )))(this.#handshakeTimer);
    this.#handshakeTimer = undefined;
  }
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}
