import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import type { ReplicaCheckpointResponse } from '../lib/replica/contracts';
import {
  createLiveAckMessage,
  createLiveCheckpointAckMessage,
  createLiveCheckpointRequest,
  createReplicaLivePortName,
  createStartLiveMessage,
} from '../lib/replica/live-protocol';
import {
  captureMaskedCheckpoint,
  installPageRecorderBridge,
  type PageRecorderBridgeEnvironment,
  type RecorderOptions,
} from '../lib/replica/page-recorder';
import {
  MAX_REPLICA_STRING_LENGTH,
  createCheckpointCommand,
  createCheckpointError,
  createReplicaIdentity,
} from '../lib/replica/protocol-v2';

const identity = createReplicaIdentity({
  sessionId: 'session-recorder',
  pageEpoch: 1,
  generation: 1,
  documentId: 'document-recorder',
  frameId: 0,
  sequence: 0,
});

describe('page recorder checkpoint', () => {
  it('keeps checkpoint timers receiver-free inside the recorder environment', async () => {
    const receivers: unknown[] = [];
    const setTimer = function (
      this: unknown,
      _callback: () => void,
      _milliseconds?: number,
    ): ReturnType<typeof setTimeout> {
      receivers.push(this);
      return 19 as unknown as ReturnType<typeof setTimeout>;
    };
    const clearTimer = function (
      this: unknown,
      _handle: ReturnType<typeof setTimeout>,
    ): void {
      receivers.push(this);
    };

    await expect(captureMaskedCheckpoint(identity, {
      document: createDocument(),
      window: createWindow(),
      setTimer,
      clearTimer,
      start: (options) => {
        options.emit({
          type: 4,
          data: { href: 'https://example.test/', width: 800, height: 600 },
          timestamp: 1,
        });
        options.emit({
          type: 2,
          data: {
            node: { type: 0, id: 1, childNodes: [] },
            initialOffset: { top: 0, left: 0 },
          },
          timestamp: 2,
        });
        return () => undefined;
      },
    })).resolves.toMatchObject({ kind: 'simul:replica-v2:checkpoint' });

    expect(receivers).toEqual([undefined, undefined]);
  });

  it('configures one full masked snapshot with interaction and canvas tails disabled', async () => {
    let observedOptions: Record<string, unknown> | undefined;
    let stopped = false;
    const sourceWindow = createWindow();
    const response = await captureMaskedCheckpoint(identity, {
      document: createDocument(),
      window: sourceWindow,
      now: increasingClock(),
      start: (options) => {
        observedOptions = options as unknown as Record<string, unknown>;
        options.emit({
          type: 4,
          data: { href: 'https://example.test/', width: 800, height: 600 },
          timestamp: 1,
        });
        options.emit({
          type: 2,
          data: {
            node: {
              type: 0,
              id: 1,
              childNodes: [
                {
                  type: 2,
                  id: 2,
                  tagName: 'textarea',
                  attributes: {},
                  childNodes: [
                    { type: 3, id: 3, textContent: 'RECORDER-PRIVATE-CANARY' },
                  ],
                },
              ],
            },
            initialOffset: { top: 0, left: 0 },
          },
          timestamp: 2,
        });
        return () => {
          stopped = true;
        };
      },
    });

    expect(response.kind).toBe('simul:replica-v2:checkpoint');
    expect(JSON.stringify(response)).not.toContain('RECORDER-PRIVATE-CANARY');
    expect(observedOptions).toMatchObject({
      maskAllInputs: true,
      inlineStylesheet: true,
      inlineImages: false,
      recordCanvas: false,
      recordCrossOriginIframes: false,
      collectFonts: false,
      userTriggeredOnInput: false,
      blockSelector: 'iframe,frame',
      sampling: { mousemove: false, mouseInteraction: false },
    });
    expect(stopped).toBe(true);
  });

  it('fails closed outside the requested top-frame identity', async () => {
    const childWindow = createWindow();
    Object.defineProperty(childWindow, 'top', {
      configurable: true,
      value: {} as Window,
    });

    await expect(
      captureMaskedCheckpoint(identity, {
        document: createDocument(),
        window: childWindow,
      }),
    ).resolves.toMatchObject({
      kind: 'simul:replica-v2:checkpoint-error',
      payload: { code: 'capture_failed' },
    });
  });

  it('rejects an oversized source before starting synchronous rrweb capture', async () => {
    const oversizedDocument = createDocument() as Document & {
      childNodes: NodeListOf<ChildNode>;
      nodeType: number;
      styleSheets: StyleSheetList;
    };
    const oversizedText = {
      nodeType: 3,
      nodeValue: 'x'.repeat(MAX_REPLICA_STRING_LENGTH + 1),
      childNodes: nodeList(),
    } as unknown as ChildNode;
    Object.defineProperties(oversizedDocument, {
      nodeType: { configurable: true, value: 9 },
      childNodes: { configurable: true, value: nodeList(oversizedText) },
      styleSheets: { configurable: true, value: [] },
    });
    let recorderStarted = false;

    const response = await captureMaskedCheckpoint(identity, {
      document: oversizedDocument,
      window: createWindow(),
      start: () => {
        recorderStarted = true;
        return () => undefined;
      },
    });

    expect(response).toMatchObject({
      kind: 'simul:replica-v2:checkpoint-error',
      payload: { code: 'checkpoint_too_large' },
    });
    expect(recorderStarted).toBe(false);
  });
});

describe('page recorder bridge ownership', () => {
  it('keeps the live recorder exclusive and reports capture_busy to one-off capture', async () => {
    const harness = createBridgeHarness();
    const port = new FakePort(createReplicaLivePortName(identity.sessionId));
    harness.connect(port);
    port.emitMessage(createStartLiveMessage(identity));

    const result = harness.message(createCheckpointCommand(identity));

    await expect(result).resolves.toMatchObject({
      kind: 'simul:replica-v2:checkpoint-error',
      payload: { code: 'capture_busy' },
    });
    expect(harness.startCount()).toBe(1);
    expect(harness.captureCount()).toBe(0);
    port.disconnect();
    expect(harness.stopCount()).toBe(1);
  });

  it('rejects a live Port while one-off capture owns rrweb', async () => {
    const pending = deferred<ReplicaCheckpointResponse>();
    const harness = createBridgeHarness(async () => pending.promise);
    const capture = harness.message(createCheckpointCommand(identity));
    const port = new FakePort(createReplicaLivePortName(identity.sessionId));
    harness.connect(port);

    port.emitMessage(createStartLiveMessage(identity));

    expect(port.posted).toMatchObject([
      { kind: 'simul:replica-v2:stream-error', payload: { code: 'stream_failed' } },
    ]);
    expect(port.disconnects).toBe(1);
    expect(harness.startCount()).toBe(0);
    pending.resolve(createCheckpointError(identity, 'capture_failed'));
    await capture;
  });

  it('does not let a rejected duplicate Port evict the legitimate subscriber', () => {
    const harness = createBridgeHarness();
    const first = new FakePort(createReplicaLivePortName(identity.sessionId));
    harness.connect(first);
    first.emitMessage(createStartLiveMessage(identity));
    const duplicate = new FakePort(createReplicaLivePortName(identity.sessionId));
    harness.connect(duplicate);
    duplicate.emitMessage(createStartLiveMessage(identity));

    expect(duplicate.disconnects).toBe(1);
    first.emitMessage(createLiveCheckpointAckMessage(identity, 0));
    harness.emit({
      type: 3,
      data: { source: 3, id: 2, x: 1, y: 2 },
      timestamp: 3,
    });
    harness.runFrame();

    expect(first.posted.some(
      (message) => isRecord(message) && message.kind === 'simul:replica-v2:batch',
    )).toBe(true);
    expect(harness.stopCount()).toBe(0);
    first.disconnect();
    expect(harness.stopCount()).toBe(1);
  });

  it('replaces a stable-session Port by generation despite delayed old disconnect', () => {
    const harness = createBridgeHarness();
    const oldPort = new FakePort(createReplicaLivePortName(identity.sessionId));
    harness.connect(oldPort);
    oldPort.emitMessage(createStartLiveMessage(identity));
    oldPort.emitMessage(createLiveCheckpointAckMessage(identity, 0));

    const replacementIdentity = createReplicaIdentity({
      sessionId: identity.sessionId,
      pageEpoch: 2,
      generation: 2,
      documentId: identity.documentId,
      frameId: identity.frameId,
      sequence: 0,
    });
    const replacement = new FakePort(
      createReplicaLivePortName(replacementIdentity.sessionId),
    );
    harness.connect(replacement);
    replacement.emitMessage(createStartLiveMessage(replacementIdentity));

    expect(replacement.disconnects).toBe(0);
    expect(harness.startCount()).toBe(1);
    expect(replacement.posted).toMatchObject([
      {
        kind: 'simul:replica-v2:checkpoint',
        identity: { generation: 2 },
      },
    ]);
    replacement.emitMessage(createLiveCheckpointAckMessage(replacementIdentity, 0));

    oldPort.emitMessage(createLiveAckMessage(identity, 0));
    oldPort.emitMessage(createLiveCheckpointAckMessage(identity, 0));
    oldPort.emitMessage(createLiveCheckpointRequest(identity, 0));
    expect(harness.checkoutCount()).toBe(0);

    const oldMessageCount = oldPort.posted.length;
    oldPort.disconnect();
    expect(harness.stopCount()).toBe(0);

    harness.emit({
      type: 3,
      data: { source: 3, id: 2, x: 1, y: 2 },
      timestamp: 3,
    });
    harness.runFrame();

    expect(oldPort.posted).toHaveLength(oldMessageCount);
    expect(replacement.posted).toMatchObject([
      { kind: 'simul:replica-v2:checkpoint' },
      {
        kind: 'simul:replica-v2:batch',
        identity: { generation: 2, sequence: 1 },
      },
    ]);
    replacement.disconnect();
    expect(harness.stopCount()).toBe(1);
  });

  it('clears a synchronously failed live session so the next Port can retry', () => {
    const harness = createBridgeHarness(undefined, 1);
    const failed = new FakePort(createReplicaLivePortName(identity.sessionId));
    harness.connect(failed);
    failed.emitMessage(createStartLiveMessage(identity));

    expect(failed.posted).toMatchObject([
      { kind: 'simul:replica-v2:stream-error', payload: { code: 'stream_failed' } },
    ]);
    expect(failed.disconnects).toBe(1);

    const retry = new FakePort(createReplicaLivePortName(identity.sessionId));
    harness.connect(retry);
    retry.emitMessage(createStartLiveMessage(identity));

    expect(harness.startCount()).toBe(2);
    expect(retry.posted.some(
      (message) => isRecord(message) &&
        message.kind === 'simul:replica-v2:checkpoint',
    )).toBe(true);
    expect(retry.disconnects).toBe(0);
    retry.disconnect();
    expect(harness.stopCount()).toBe(1);
  });

  it('clears recorder ownership when initial checkpoint delivery throws', () => {
    const harness = createBridgeHarness();
    const closed = new FakePort(
      createReplicaLivePortName(identity.sessionId),
      true,
    );
    harness.connect(closed);
    closed.emitMessage(createStartLiveMessage(identity));

    const retry = new FakePort(createReplicaLivePortName(identity.sessionId));
    harness.connect(retry);
    retry.emitMessage(createStartLiveMessage(identity));

    expect(closed.disconnects).toBe(1);
    expect(harness.startCount()).toBe(2);
    expect(retry.posted.some(
      (message) => isRecord(message) &&
        message.kind === 'simul:replica-v2:checkpoint',
    )).toBe(true);
    retry.disconnect();
    expect(harness.stopCount()).toBe(2);
  });
});

function createWindow(): Window {
  const sourceWindow = {
    innerWidth: 800,
    innerHeight: 600,
  } as unknown as Window;
  Object.defineProperty(sourceWindow, 'top', {
    configurable: true,
    value: sourceWindow,
  });
  return sourceWindow;
}

function createDocument(): Document {
  return {
    documentElement: { scrollWidth: 1_200, scrollHeight: 2_000 },
    body: { scrollWidth: 1_100, scrollHeight: 1_900 },
  } as unknown as Document;
}

function increasingClock(): () => number {
  let value = 0;
  return () => ++value;
}

function nodeList(...nodes: ChildNode[]): NodeListOf<ChildNode> {
  return {
    length: nodes.length,
    item: (index: number) => nodes[index] ?? null,
    forEach: (callback: (value: ChildNode, key: number, parent: NodeListOf<ChildNode>) => void) => {
      const list = nodeList(...nodes);
      nodes.forEach((node, index) => callback(node, index, list));
    },
    [Symbol.iterator]: () => nodes[Symbol.iterator](),
    entries: () => nodes.entries(),
    keys: () => nodes.keys(),
    values: () => nodes.values(),
  } as NodeListOf<ChildNode>;
}

function createBridgeHarness(
  captureCheckpoint: (
    identity: ReturnType<typeof createReplicaIdentity>,
  ) => Promise<ReplicaCheckpointResponse> = async (nextIdentity) =>
    createCheckpointError(nextIdentity, 'capture_failed'),
  recorderStartFailures = 0,
): {
  connect(port: FakePort): void;
  message(message: unknown): Promise<unknown>;
  emit(event: unknown, checkout?: boolean): void;
  runFrame(): void;
  startCount(): number;
  stopCount(): number;
  checkoutCount(): number;
  captureCount(): number;
} {
  const { document, window } = parseHTML('<html><body><p>bridge</p></body></html>');
  Object.defineProperty(window, 'top', { configurable: true, value: window });
  const onConnect = new FakeEvent<(port: Browser.runtime.Port) => void>();
  const onMessage = new FakeEvent<(message: unknown) => unknown>();
  const runtime = {
    onConnect: eventAdapter(onConnect),
    onMessage: eventAdapter(onMessage),
  } as unknown as PageRecorderBridgeEnvironment['runtime'];
  let options: RecorderOptions | undefined;
  let starts = 0;
  let stops = 0;
  let captures = 0;
  let checkouts = 0;
  const frames: Array<() => void> = [];
  const emitCheckpoint = (checkout = false): void => {
    options?.emit(bridgeCheckpointEvents()[0], checkout);
    options?.emit(bridgeCheckpointEvents()[1], checkout);
  };
  installPageRecorderBridge({
    global: {} as typeof globalThis,
    runtime,
    document,
    window,
    now: () => 10,
    preflight: () => undefined,
    start: (nextOptions) => {
      starts += 1;
      options = nextOptions;
      if (starts <= recorderStartFailures) return undefined;
      emitCheckpoint();
      return () => {
        stops += 1;
      };
    },
    takeFullSnapshot: () => {
      checkouts += 1;
      emitCheckpoint(true);
    },
    scheduleFrame: (callback) => {
      frames.push(callback);
      return callback;
    },
    cancelFrame: (handle) => {
      const index = frames.indexOf(handle as () => void);
      if (index >= 0) frames.splice(index, 1);
    },
    captureCheckpoint: async (nextIdentity) => {
      captures += 1;
      return captureCheckpoint(nextIdentity);
    },
  });
  return {
    connect: (port) => onConnect.emit(port as unknown as Browser.runtime.Port),
    message: async (message) => {
      const result = onMessage.emit(message)[0];
      return result instanceof Promise ? result : result;
    },
    emit: (event, checkout = false) => options?.emit(event, checkout),
    runFrame: () => frames.shift()?.(),
    startCount: () => starts,
    stopCount: () => stops,
    checkoutCount: () => checkouts,
    captureCount: () => captures,
  };
}

class FakePort {
  readonly posted: unknown[] = [];
  readonly onMessage = new FakeEvent<(message: unknown) => void>();
  readonly onDisconnect = new FakeEvent<() => void>();
  disconnects = 0;

  constructor(
    readonly name: string,
    private readonly throwOnPost = false,
  ) {}

  postMessage(message: unknown): void {
    if (this.throwOnPost) throw new Error('Port is closed.');
    this.posted.push(message);
  }

  disconnect(): void {
    this.disconnects += 1;
    this.onDisconnect.emit();
  }

  emitMessage(message: unknown): void {
    this.onMessage.emit(message);
  }
}

class FakeEvent<T extends (...args: never[]) => unknown> {
  readonly #listeners = new Set<T>();

  addListener(listener: T): void {
    this.#listeners.add(listener);
  }

  removeListener(listener: T): void {
    this.#listeners.delete(listener);
  }

  hasListener(listener: T): boolean {
    return this.#listeners.has(listener);
  }

  emit(...args: Parameters<T>): ReturnType<T>[] {
    return [...this.#listeners].map((listener) => listener(...args) as ReturnType<T>);
  }
}

function eventAdapter<T extends (...args: never[]) => unknown>(event: FakeEvent<T>) {
  return {
    addListener: (listener: T) => event.addListener(listener),
    removeListener: (listener: T) => event.removeListener(listener),
    hasListener: (listener: T) => event.hasListener(listener),
  };
}

function bridgeCheckpointEvents(): readonly [Record<string, unknown>, Record<string, unknown>] {
  return [
    {
      type: 4,
      data: { href: 'https://example.test/', width: 800, height: 600 },
      timestamp: 1,
    },
    {
      type: 2,
      data: {
        node: {
          type: 0,
          id: 1,
          childNodes: [
            {
              type: 2,
              id: 2,
              tagName: 'html',
              attributes: {},
              childNodes: [],
            },
          ],
        },
        initialOffset: { top: 0, left: 0 },
      },
      timestamp: 2,
    },
  ];
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
