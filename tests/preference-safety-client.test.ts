import { describe, expect, it, vi } from 'vitest';

import {
  PreferenceSafetyClient,
  type PreferenceSafetyClientPort,
} from '../lib/preference-safety-client';

describe('PreferenceSafetyClient', () => {
  it('opens the gate only after a connected fresh snapshot is applied', async () => {
    const port = new FakeClientPort();
    const refreshed = deferred<void>();
    const onReady = vi.fn();
    const client = new PreferenceSafetyClient({
      connect: () => port,
      refreshCommittedSnapshot: () => refreshed.promise,
      onSafetyMessage: vi.fn(),
      onFailClosed: vi.fn(),
      onReady,
      createNonce: () => 'connection-1',
    });

    client.start();
    expect(port.posted).toContainEqual({
      kind: 'simul:preference-safety-v1:hello',
      version: 1,
      connectionNonce: 'connection-1',
    });
    port.ready('connection-1');
    await Promise.resolve();
    expect(client.ready).toBe(false);
    expect(onReady).not.toHaveBeenCalled();

    refreshed.resolve();
    await refreshed.promise;
    await Promise.resolve();
    expect(client.ready).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it('fails closed immediately and ignores hydration from a lost Port', async () => {
    const first = new FakeClientPort();
    const second = new FakeClientPort();
    const refreshed = deferred<void>();
    const onFailClosed = vi.fn();
    const onReady = vi.fn();
    const timers: Array<{ callback: () => void; delay: number }> = [];
    let connections = 0;
    const client = new PreferenceSafetyClient({
      connect: () => connections++ === 0 ? first : second,
      refreshCommittedSnapshot: () => refreshed.promise,
      onSafetyMessage: vi.fn(),
      onFailClosed,
      onReady,
      createNonce: () => `connection-${connections}`,
      setTimer: (callback, delay) => {
        const timer = { callback, delay };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => {
        const index = timers.indexOf(
          timer as { callback: () => void; delay: number },
        );
        if (index >= 0) timers.splice(index, 1);
      },
    });

    client.start();
    first.ready('connection-1');
    await Promise.resolve();
    first.disconnectFromBackground();

    expect(client.ready).toBe(false);
    expect(onFailClosed).toHaveBeenCalledTimes(1);
    expect(timers.map((timer) => timer.delay)).toEqual([100]);

    refreshed.resolve();
    await refreshed.promise;
    await Promise.resolve();
    expect(onReady).not.toHaveBeenCalled();

    timers.shift()!.callback();
    expect(connections).toBe(2);
    client.dispose();
  });

  it('caps reconnect delay while keeping the fail-closed gate in place', () => {
    const onFailClosed = vi.fn();
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    const client = new PreferenceSafetyClient({
      connect: () => {
        throw new Error('worker unavailable');
      },
      refreshCommittedSnapshot: async () => undefined,
      onSafetyMessage: vi.fn(),
      onFailClosed,
      onReady: vi.fn(),
      setTimer: (callback, delay) => {
        const timer = { callback, delay };
        scheduled.push(timer);
        return timer;
      },
      clearTimer: () => undefined,
    });

    client.start();
    const delays: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      const timer = scheduled.shift()!;
      delays.push(timer.delay);
      timer.callback();
    }

    expect(delays).toEqual([100, 250, 500, 1_000, 2_000, 2_000]);
    expect(client.ready).toBe(false);
    expect(onFailClosed).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it('does not post a safety reply until asynchronous teardown completes', async () => {
    const port = new FakeClientPort();
    const teardown = deferred<void>();
    const client = new PreferenceSafetyClient({
      connect: () => port,
      refreshCommittedSnapshot: async () => undefined,
      onSafetyMessage: async (_message, reply) => {
        await teardown.promise;
        reply({ kind: 'confirmed-after-teardown' });
      },
      onFailClosed: vi.fn(),
      onReady: vi.fn(),
      createNonce: () => 'async-teardown',
    });

    client.start();
    port.message({ kind: 'prepare' });
    expect(port.posted).not.toContainEqual({ kind: 'confirmed-after-teardown' });

    teardown.resolve();
    await teardown.promise;
    await Promise.resolve();
    expect(port.posted).toContainEqual({ kind: 'confirmed-after-teardown' });
    client.dispose();
  });

  it('invalidates the Port and stays fail closed when asynchronous teardown fails', async () => {
    const port = new FakeClientPort();
    const teardown = deferred<void>();
    const onFailClosed = vi.fn();
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const client = new PreferenceSafetyClient({
      connect: () => port,
      refreshCommittedSnapshot: async () => undefined,
      onSafetyMessage: async (_message, reply) => {
        await teardown.promise;
        reply({ kind: 'must-not-ack' });
      },
      onFailClosed,
      onReady: vi.fn(),
      createNonce: () => 'failed-teardown',
      setTimer: (callback, delay) => {
        const timer = { callback, delay };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => {
        const index = timers.indexOf(
          timer as { callback: () => void; delay: number },
        );
        if (index >= 0) timers.splice(index, 1);
      },
    });

    client.start();
    port.ready('failed-teardown');
    await Promise.resolve();
    await Promise.resolve();
    expect(client.ready).toBe(true);

    port.message({ kind: 'prepare' });
    teardown.reject(new Error('executeScript failed'));
    await teardown.promise.catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(port.posted).not.toContainEqual({ kind: 'must-not-ack' });
    expect(client.ready).toBe(false);
    expect(onFailClosed).toHaveBeenCalledTimes(1);
    expect(timers.map((timer) => timer.delay)).toEqual([100]);
    client.dispose();
  });
});

class FakeClientPort implements PreferenceSafetyClientPort {
  readonly posted: unknown[] = [];
  readonly #message = new FakeEvent<(message: unknown) => void>();
  readonly #disconnect = new FakeEvent<() => void>();
  readonly onMessage = this.#message.api;
  readonly onDisconnect = this.#disconnect.api;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  ready(connectionNonce: string): void {
    this.#message.emit({
      kind: 'simul:preference-safety-v1:ready',
      version: 1,
      connectionNonce,
    });
  }

  message(value: unknown): void {
    this.#message.emit(value);
  }

  disconnectFromBackground(): void {
    this.#disconnect.emit();
  }
}

class FakeEvent<T extends (...args: never[]) => void> {
  readonly #listeners = new Set<T>();
  readonly api = {
    addListener: (listener: T) => this.#listeners.add(listener),
    removeListener: (listener: T) => this.#listeners.delete(listener),
  };

  emit(...args: Parameters<T>): void {
    for (const listener of this.#listeners) listener(...args);
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}
