import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ReplicaCaptureRequest,
  ReplicaLiveStreamObserver,
} from '../lib/replica/contracts';
import {
  createLiveBatchEnvelope,
  createLiveStreamError,
  createReplicaLivePortName,
} from '../lib/replica/live-protocol';
import { openChromeReplicaLiveStream } from '../lib/replica/live-stream-client';
import {
  createCheckpointEnvelope,
  createReplicaIdentity,
} from '../lib/replica/protocol-v2';

afterEach(() => vi.unstubAllGlobals());

describe('Chrome replica live stream client', () => {
  it('injects and connects only to the exact document, then ACKs applied state', async () => {
    const fixture = installBrowserFixture();
    const lease = await openChromeReplicaLiveStream(request());

    expect(fixture.executeScript).toHaveBeenCalledWith({
      target: { tabId: 42, documentIds: ['document-client'] },
      files: ['/page-recorder.js'],
    });
    expect(fixture.connect).toHaveBeenCalledWith(42, {
      documentId: 'document-client',
      frameId: 0,
      name: createReplicaLivePortName('session-client'),
    });
    expect(fixture.port.posted[0]).toMatchObject({
      kind: 'simul:replica-v2:start-live',
      identity: { sequence: 0 },
    });

    fixture.port.emitMessage(checkpointAt(0));
    await expect(lease.initialCheckpoint).resolves.toMatchObject({
      kind: 'simul:replica-v2:checkpoint',
    });
    lease.acknowledgeCheckpoint(0);
    expect(fixture.port.posted.at(-1)).toMatchObject({
      kind: 'simul:replica-v2:checkpoint-ack',
      identity: { sequence: 0 },
    });
    const observer = createObserver();
    lease.setObserver(observer.value);
    fixture.port.emitMessage(batchEnvelope(1));

    expect(observer.batches).toHaveLength(1);
    lease.acknowledge(1);
    expect(fixture.port.posted.at(-1)).toMatchObject({
      kind: 'simul:replica-v2:ack',
      identity: { sequence: 1 },
    });
  });

  it('detects a gap, requests one checkpoint, and resumes from its sequence', async () => {
    const fixture = installBrowserFixture();
    const lease = await openChromeReplicaLiveStream(request());
    fixture.port.emitMessage(checkpointAt(0));
    await lease.initialCheckpoint;
    const observer = createObserver();
    lease.setObserver(observer.value);

    fixture.port.emitMessage(batchEnvelope(2));
    expect(observer.failures).toEqual(['stream_gap']);
    expect(fixture.port.posted.filter(
      (message) => isRecord(message) &&
        message.kind === 'simul:replica-v2:request-checkpoint',
    )).toHaveLength(1);

    fixture.port.emitMessage(batchEnvelope(3));
    expect(observer.batches).toEqual([]);
    fixture.port.emitMessage(checkpointAt(3));
    expect(observer.checkpoints).toHaveLength(1);
    fixture.port.emitMessage(batchEnvelope(4));
    expect(observer.batches).toMatchObject([
      { firstSequence: 4, lastSequence: 4 },
    ]);
  });

  it('recovers once from a malformed same-document batch after commit', async () => {
    const fixture = installBrowserFixture();
    const lease = await openChromeReplicaLiveStream(request());
    fixture.port.emitMessage(checkpointAt(0));
    await lease.initialCheckpoint;
    const observer = createObserver();
    lease.setObserver(observer.value);
    const malformed = batchEnvelope(1);

    fixture.port.emitMessage({
      ...malformed,
      payload: { ...malformed.payload, byteLength: malformed.payload.byteLength + 1 },
    });

    expect(observer.failures).toEqual(['stream_gap']);
    expect(fixture.port.disconnects).toBe(0);
    expect(fixture.port.posted.filter(
      (message) => isRecord(message) &&
        message.kind === 'simul:replica-v2:request-checkpoint',
    )).toHaveLength(1);

    fixture.port.emitMessage(checkpointAt(1));
    fixture.port.emitMessage(batchEnvelope(2));

    expect(observer.checkpoints).toMatchObject([
      { identity: { sequence: 1 } },
    ]);
    expect(observer.batches).toMatchObject([
      { firstSequence: 2, lastSequence: 2 },
    ]);
    expect(fixture.port.disconnects).toBe(0);
  });

  it('fails closed on a wrong-document message and disposes exactly once', async () => {
    const fixture = installBrowserFixture();
    const lease = await openChromeReplicaLiveStream(request());
    fixture.port.emitMessage(checkpointAt(0));
    await lease.initialCheckpoint;
    const observer = createObserver();
    lease.setObserver(observer.value);

    fixture.port.emitMessage({
      ...batchEnvelope(1),
      identity: {
        ...batchEnvelope(1).identity,
        documentId: 'wrong-document',
      },
    });

    expect(observer.failures).toEqual(['stream_failed']);
    expect(fixture.port.disconnects).toBe(1);
    lease.dispose();
    expect(fixture.port.disconnects).toBe(1);
  });

  it('rejects a stale injection result before opening a Port', async () => {
    const fixture = installBrowserFixture('another-document');
    await expect(openChromeReplicaLiveStream(request())).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it('rejects an initial recorder failure immediately and closes the Port', async () => {
    const fixture = installBrowserFixture();
    const lease = await openChromeReplicaLiveStream(request());
    fixture.port.emitMessage(createLiveStreamError(
      createReplicaIdentity({
        sessionId: 'session-client',
        pageEpoch: 5,
        generation: 5,
        documentId: 'document-client',
        frameId: 0,
        sequence: 0,
      }),
      'stream_overflow',
    ));

    await expect(lease.initialCheckpoint).rejects.toMatchObject({
      name: 'ReplicaLiveProtocolError',
      code: 'stream_overflow',
    });
    expect(fixture.port.disconnects).toBe(1);
  });

  it('delivers an unsolicited same-sequence checkpoint for source resize', async () => {
    const fixture = installBrowserFixture();
    const lease = await openChromeReplicaLiveStream(request());
    fixture.port.emitMessage(checkpointAt(0));
    await lease.initialCheckpoint;
    const observer = createObserver();
    lease.setObserver(observer.value);

    fixture.port.emitMessage(checkpointAt(0));

    expect(observer.checkpoints).toHaveLength(1);
    expect(observer.failures).toEqual([]);
    expect(fixture.port.disconnects).toBe(0);
  });

  it('accepts a monotonic forward authoritative checkpoint', async () => {
    const fixture = installBrowserFixture();
    const lease = await openChromeReplicaLiveStream(request());
    fixture.port.emitMessage(checkpointAt(0));
    await lease.initialCheckpoint;
    const observer = createObserver();
    lease.setObserver(observer.value);

    fixture.port.emitMessage(checkpointAt(1));

    expect(observer.checkpoints).toMatchObject([
      { identity: { sequence: 1 } },
    ]);
    expect(observer.failures).toEqual([]);
    expect(fixture.port.disconnects).toBe(0);
  });

  it('fails closed on a checkpoint that regresses received sequence', async () => {
    const fixture = installBrowserFixture();
    const lease = await openChromeReplicaLiveStream(request());
    fixture.port.emitMessage(checkpointAt(0));
    await lease.initialCheckpoint;
    const observer = createObserver();
    lease.setObserver(observer.value);
    fixture.port.emitMessage(batchEnvelope(1));

    fixture.port.emitMessage(checkpointAt(0));

    expect(observer.checkpoints).toEqual([]);
    expect(observer.failures).toEqual(['stream_failed']);
    expect(fixture.port.disconnects).toBe(1);
  });

  it('rejects a batch that arrives before the initial checkpoint', async () => {
    const fixture = installBrowserFixture();
    const lease = await openChromeReplicaLiveStream(request());

    fixture.port.emitMessage(batchEnvelope(1));

    await expect(lease.initialCheckpoint).rejects.toThrow(
      'events before its checkpoint',
    );
    expect(fixture.port.disconnects).toBe(1);
  });

  it('drops queued pre-recovery batches and retains the replacement checkpoint', async () => {
    const fixture = installBrowserFixture();
    const lease = await openChromeReplicaLiveStream(request());
    fixture.port.emitMessage(checkpointAt(0));
    await lease.initialCheckpoint;
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      fixture.port.emitMessage(batchEnvelope(sequence));
    }
    fixture.port.emitMessage(createLiveStreamError(
      createReplicaIdentity({
        sessionId: 'session-client',
        pageEpoch: 5,
        generation: 5,
        documentId: 'document-client',
        frameId: 0,
        sequence: 4,
      }),
      'stream_overflow',
    ));
    fixture.port.emitMessage(checkpointAt(5));
    const observer = createObserver();

    lease.setObserver(observer.value);

    expect(observer.batches).toEqual([]);
    expect(observer.checkpoints).toHaveLength(1);
    expect(observer.checkpoints).toMatchObject([
      { identity: { sequence: 5 } },
    ]);
    expect(fixture.port.posted.filter(
      (message) => isRecord(message) &&
        message.kind === 'simul:replica-v2:request-checkpoint',
    )).toHaveLength(0);
  });

  it('reports a terminal disconnect registered before the observer exactly once', async () => {
    const fixture = installBrowserFixture();
    const lease = await openChromeReplicaLiveStream(request());
    fixture.port.emitMessage(checkpointAt(0));
    await lease.initialCheckpoint;

    fixture.port.emitDisconnect();
    const observer = createObserver();
    lease.setObserver(observer.value);
    lease.setObserver(createObserver().value);
    lease.dispose();

    expect(observer.failures).toEqual(['stream_failed']);
    expect(fixture.port.disconnects).toBe(1);
  });

  it('fails closed and stops draining when a queued observer callback throws', async () => {
    const fixture = installBrowserFixture();
    const lease = await openChromeReplicaLiveStream(request());
    fixture.port.emitMessage(checkpointAt(0));
    await lease.initialCheckpoint;
    fixture.port.emitMessage(batchEnvelope(1));
    fixture.port.emitMessage(batchEnvelope(2));
    let batches = 0;
    const failures: string[] = [];

    lease.setObserver({
      onBatch: () => {
        batches += 1;
        throw new Error('consumer failed');
      },
      onCheckpoint: () => undefined,
      onFailure: (code) => failures.push(code),
    });
    lease.dispose();

    expect(batches).toBe(1);
    expect(failures).toEqual(['stream_failed']);
    expect(fixture.port.disconnects).toBe(1);
  });
});

function request(): ReplicaCaptureRequest {
  return {
    sessionId: 'session-client',
    pageEpoch: 5,
    generation: 5,
    tabId: 42,
    frameId: 0,
    documentId: 'document-client',
    isCurrent: () => true,
  };
}

function installBrowserFixture(documentId = 'document-client'): {
  port: FakePort;
  executeScript: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
} {
  const port = new FakePort();
  const executeScript = vi.fn().mockResolvedValue([
    { frameId: 0, documentId },
  ]);
  const connect = vi.fn(() => port);
  vi.stubGlobal('browser', {
    scripting: { executeScript },
    tabs: { connect },
  });
  return { port, executeScript, connect };
}

class FakePort {
  readonly posted: unknown[] = [];
  readonly onMessage = new FakeEvent<(message: unknown) => void>();
  readonly onDisconnect = new FakeEvent<() => void>();
  disconnects = 0;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  disconnect(): void {
    this.disconnects += 1;
  }

  emitMessage(message: unknown): void {
    this.onMessage.emit(message);
  }

  emitDisconnect(): void {
    this.onDisconnect.emit();
  }
}

class FakeEvent<T extends (...args: never[]) => void> {
  readonly #listeners = new Set<T>();

  addListener(listener: T): void {
    this.#listeners.add(listener);
  }

  removeListener(listener: T): void {
    this.#listeners.delete(listener);
  }

  emit(...args: Parameters<T>): void {
    for (const listener of this.#listeners) listener(...args);
  }
}

function checkpointAt(sequence: number) {
  const identity = createReplicaIdentity({
    sessionId: 'session-client',
    pageEpoch: 5,
    generation: 5,
    documentId: 'document-client',
    frameId: 0,
    sequence,
  });
  return createCheckpointEnvelope(identity, {
    events: [
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
    ],
    captureMs: 1,
    viewportWidth: 800,
    viewportHeight: 600,
    documentWidth: 900,
    documentHeight: 1_200,
  });
}

function batchEnvelope(firstSequence: number) {
  const event = {
    type: 3,
    data: { source: 3, id: 2, x: firstSequence, y: firstSequence },
    timestamp: 10 + firstSequence,
  };
  const envelope = createLiveBatchEnvelope(
    createReplicaIdentity({
      sessionId: 'session-client',
      pageEpoch: 5,
      generation: 5,
      documentId: 'document-client',
      frameId: 0,
      sequence: 0,
    }),
    firstSequence,
    [event],
  );
  if (!envelope) throw new Error('Live batch fixture was rejected.');
  return envelope;
}

function createObserver(): {
  value: ReplicaLiveStreamObserver;
  batches: unknown[];
  checkpoints: unknown[];
  failures: string[];
} {
  const batches: unknown[] = [];
  const checkpoints: unknown[] = [];
  const failures: string[] = [];
  return {
    batches,
    checkpoints,
    failures,
    value: {
      onBatch: (batch) => batches.push(batch),
      onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
      onFailure: (code) => failures.push(code),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
