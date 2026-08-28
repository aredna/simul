import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HTML_MIRROR_INITIAL_CHECKPOINT_TIMEOUT_MS,
  openChromeHtmlMirrorStream,
  type HtmlMirrorStreamObserver,
} from '../lib/replica/html-mirror-client';
import {
  createHtmlMirrorCheckpoint,
  createHtmlMirrorError,
  createHtmlMirrorScrollUpdate,
} from '../lib/replica/html-mirror-protocol';
import type { ReplicaCaptureRequest } from '../lib/replica/contracts';
import { createHtmlMirrorRepresentabilityCollector } from '../lib/replica/html-mirror-sanitizer';
import { createReplicaIdentity } from '../lib/replica/replica-identity';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Chrome HTML mirror client', () => {
  it('sends the selected fidelity policy in the immutable start handshake', async () => {
    const port = new FakePort();
    installBrowser(port);

    const lease = await openChromeHtmlMirrorStream(request, 'passive');

    expect(port.posts[0]).toMatchObject({
      kind: 'simul:html-mirror-v2:start',
      identity,
      fidelityPolicy: 'passive',
    });
    port.emitMessage(checkpoint());
    await lease.initialCheckpoint;
    lease.dispose();
  });

  it('queues a disconnect that occurs after checkpoint but before observer setup', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(checkpoint());
    await expect(lease.initialCheckpoint).resolves.toMatchObject({
      kind: 'simul:html-mirror-v2:checkpoint',
    });
    port.emitDisconnect();
    const observer = fakeObserver();

    lease.setObserver(observer);

    expect(observer.onFailure).toHaveBeenCalledWith(
      'stream_failed',
      expect.objectContaining({ capacityOmissionCount: 0 }),
    );
  });

  it('suppresses a queued disconnect after the lease is explicitly disposed', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(checkpoint());
    await lease.initialCheckpoint;
    port.emitDisconnect();
    lease.dispose();
    const observer = fakeObserver();

    lease.setObserver(observer);

    expect(observer.onFailure).not.toHaveBeenCalled();
  });

  it('fails a live stream when an observer cannot apply its message', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(checkpoint());
    await lease.initialCheckpoint;
    const observer = fakeObserver();
    observer.onCheckpoint.mockImplementation(() => {
      throw new Error('replica apply failed');
    });
    lease.setObserver(observer);

    expect(() => port.emitMessage(checkpoint())).not.toThrow();

    expect(observer.onFailure).toHaveBeenCalledWith(
      'stream_failed',
      expect.objectContaining({ capacityOmissionCount: 0 }),
    );
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  it('fails safely when a queued message cannot be applied on attachment', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(checkpoint());
    await lease.initialCheckpoint;
    port.emitMessage(checkpoint());
    const observer = fakeObserver();
    observer.onCheckpoint.mockImplementation(() => {
      throw new Error('queued replica apply failed');
    });

    expect(() => lease.setObserver(observer)).not.toThrow();

    expect(observer.onFailure).toHaveBeenCalledWith(
      'stream_failed',
      expect.objectContaining({ capacityOmissionCount: 0 }),
    );
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  it('queues a typed scroll update that arrives before observer setup', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(checkpoint());
    await lease.initialCheckpoint;
    const update = createHtmlMirrorScrollUpdate(identity, {
      scrollTarget: 'document',
      scrollX: 0,
      scrollY: 320,
      maxScrollX: 0,
      maxScrollY: 900,
      documentScrollX: 0,
      documentScrollY: 320,
      documentMaxScrollX: 0,
      documentMaxScrollY: 900,
    })!;
    port.emitMessage(update);
    const observer = fakeObserver();

    lease.setObserver(observer);

    expect(observer.onScroll).toHaveBeenCalledOnce();
    expect(observer.onScroll).toHaveBeenCalledWith(update);
  });

  it('coalesces scroll bursts after checkpoint without consuming structural capacity', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(checkpoint());
    await lease.initialCheckpoint;
    for (let index = 1; index <= 12; index += 1) {
      port.emitMessage(scrollUpdate(index * 10));
    }
    port.emitMessage(checkpoint());
    const latest = scrollUpdate(700);
    port.emitMessage(latest);
    const observer = fakeObserver();

    lease.setObserver(observer);

    expect(observer.onFailure).not.toHaveBeenCalled();
    expect(observer.onCheckpoint).toHaveBeenCalledOnce();
    expect(observer.onScroll).toHaveBeenCalledOnce();
    expect(observer.onScroll).toHaveBeenCalledWith(latest);
    expect(observer.onCheckpoint.mock.invocationCallOrder[0])
      .toBeLessThan(observer.onScroll.mock.invocationCallOrder[0]!);
    expect(port.disconnect).not.toHaveBeenCalled();
    lease.dispose();
  });

  it('coalesces scroll bursts that precede the initial checkpoint', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    for (let index = 1; index <= 12; index += 1) {
      port.emitMessage(scrollUpdate(index * 10));
    }
    const latest = scrollUpdate(700);
    port.emitMessage(latest);
    port.emitMessage(checkpoint());
    await expect(lease.initialCheckpoint).resolves.toMatchObject({
      kind: 'simul:html-mirror-v2:checkpoint',
    });
    const observer = fakeObserver();

    lease.setObserver(observer);

    expect(observer.onFailure).not.toHaveBeenCalled();
    expect(observer.onScroll).toHaveBeenCalledOnce();
    expect(observer.onScroll).toHaveBeenCalledWith(latest);
    expect(port.disconnect).not.toHaveBeenCalled();
    lease.dispose();
  });

  it('still fails closed when the structural pre-observer backlog exceeds its bound', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(checkpoint());
    await lease.initialCheckpoint;
    for (let index = 0; index < 8; index += 1) {
      port.emitMessage(checkpoint());
      port.emitMessage(scrollUpdate(index * 10));
    }

    port.emitMessage(checkpoint());
    const observer = fakeObserver();
    lease.setObserver(observer);

    expect(observer.onCheckpoint).not.toHaveBeenCalled();
    expect(observer.onScroll).not.toHaveBeenCalled();
    expect(observer.onFailure).toHaveBeenCalledOnce();
    expect(observer.onFailure).toHaveBeenCalledWith(
      'stream_failed',
      expect.objectContaining({ capacityOmissionCount: 0 }),
    );
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  it('queues a recoverable early failure instead of silently dropping it', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(checkpoint());
    await lease.initialCheckpoint;
    const representability = createHtmlMirrorRepresentabilityCollector();
    representability.capacityOmissionCount = 1;
    port.emitMessage(createHtmlMirrorError(
      identity,
      'stream_overflow',
      representability,
    ));
    const observer = fakeObserver();

    lease.setObserver(observer);

    expect(observer.onFailure).toHaveBeenCalledWith(
      'stream_overflow',
      expect.objectContaining({ capacityOmissionCount: 1 }),
    );
    lease.requestCheckpoint(0);
    expect(port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v2:checkpoint-request',
    });
  });

  it('preserves capacity diagnostics when the initial checkpoint fails', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    const representability = createHtmlMirrorRepresentabilityCollector();
    representability.capacityOmissionCount = 2;

    port.emitMessage(createHtmlMirrorError(
      identity,
      'stream_overflow',
      representability,
    ));

    await expect(lease.initialCheckpoint).rejects.toMatchObject({
      code: 'stream_overflow',
      representability: expect.objectContaining({ capacityOmissionCount: 2 }),
    });
  });

  it('rejects a missing initial source checkpoint on a bounded deadline', async () => {
    vi.useFakeTimers();
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    const rejected = expect(lease.initialCheckpoint).rejects.toThrow(
      'initial checkpoint timed out',
    );

    await vi.advanceTimersByTimeAsync(HTML_MIRROR_INITIAL_CHECKPOINT_TIMEOUT_MS);

    await rejected;
    expect(port.disconnect).toHaveBeenCalledTimes(1);
  });

  it('rejects when exact-document injection finds no matching source session', async () => {
    const port = new FakePort();
    installBrowser(port, []);

    await expect(openChromeHtmlMirrorStream(request)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

const request: ReplicaCaptureRequest = {
  sessionId: 'client-session',
  pageEpoch: 1,
  generation: 1,
  tabId: 7,
  frameId: 0,
  documentId: 'client-document',
  isCurrent: () => true,
};

const identity = createReplicaIdentity({
  sessionId: request.sessionId,
  pageEpoch: request.pageEpoch,
  generation: request.generation,
  documentId: request.documentId,
  frameId: request.frameId,
  sequence: 0,
});

function checkpoint() {
  return createHtmlMirrorCheckpoint(identity, {
    root: {
      kind: 'element', id: 1, namespace: 'html', tagName: 'html',
      attributes: [], children: [
        { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
        { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [] },
      ],
    },
    adoptedStyleSheets: [],
    captureMs: 1,
    viewportWidth: 800,
    viewportHeight: 600,
    documentWidth: 800,
    documentHeight: 900,
  })!;
}

function scrollUpdate(scrollY: number) {
  return createHtmlMirrorScrollUpdate(identity, {
    scrollTarget: 'document',
    scrollX: 0,
    scrollY,
    maxScrollX: 0,
    maxScrollY: 900,
    documentScrollX: 0,
    documentScrollY: scrollY,
    documentMaxScrollX: 0,
    documentMaxScrollY: 900,
  })!;
}

function fakeObserver() {
  return {
    onPatch: vi.fn<HtmlMirrorStreamObserver['onPatch']>(),
    onCheckpoint: vi.fn<HtmlMirrorStreamObserver['onCheckpoint']>(),
    onScroll: vi.fn<HtmlMirrorStreamObserver['onScroll']>(),
    onFailure: vi.fn<HtmlMirrorStreamObserver['onFailure']>(),
  };
}

function installBrowser(
  port: FakePort,
  injections: unknown[] = [{ frameId: 0, documentId: request.documentId }],
): void {
  vi.stubGlobal('browser', {
    scripting: { executeScript: vi.fn(async () => injections) },
    tabs: { connect: vi.fn(() => port) },
  });
}

class FakePort {
  readonly onMessage = new FakeEvent<(message: unknown) => void>();
  readonly onDisconnect = new FakeEvent<() => void>();
  readonly posts: unknown[] = [];
  readonly disconnect = vi.fn();

  postMessage(message: unknown): void {
    this.posts.push(message);
  }

  emitMessage(message: unknown): void {
    this.onMessage.emit(message);
  }

  emitDisconnect(): void {
    this.onDisconnect.emit();
  }
}

class FakeEvent<T extends (...arguments_: never[]) => void> {
  readonly #listeners = new Set<T>();

  addListener(listener: T): void {
    this.#listeners.add(listener);
  }

  removeListener(listener: T): void {
    this.#listeners.delete(listener);
  }

  emit(...arguments_: Parameters<T>): void {
    for (const listener of this.#listeners) listener(...arguments_);
  }
}
