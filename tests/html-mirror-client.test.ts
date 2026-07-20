import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HTML_MIRROR_INITIAL_CHECKPOINT_TIMEOUT_MS,
  openChromeHtmlMirrorStream,
  type HtmlMirrorStreamObserver,
} from '../lib/replica/html-mirror-client';
import {
  createHtmlMirrorCheckpoint,
  createHtmlMirrorError,
} from '../lib/replica/html-mirror-protocol';
import type { ReplicaCaptureRequest } from '../lib/replica/contracts';
import { createReplicaIdentity } from '../lib/replica/protocol-v2';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Chrome HTML mirror client', () => {
  it('queues a disconnect that occurs after checkpoint but before observer setup', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(checkpoint());
    await expect(lease.initialCheckpoint).resolves.toMatchObject({
      kind: 'simul:html-mirror-v1:checkpoint',
    });
    port.emitDisconnect();
    const observer = fakeObserver();

    lease.setObserver(observer);

    expect(observer.onFailure).toHaveBeenCalledWith('stream_failed');
  });

  it('queues a recoverable early failure instead of silently dropping it', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(checkpoint());
    await lease.initialCheckpoint;
    port.emitMessage(createHtmlMirrorError(identity, 'stream_overflow'));
    const observer = fakeObserver();

    lease.setObserver(observer);

    expect(observer.onFailure).toHaveBeenCalledWith('stream_overflow');
    lease.requestCheckpoint(0);
    expect(port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v1:checkpoint-request',
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

function fakeObserver() {
  return {
    onPatch: vi.fn<HtmlMirrorStreamObserver['onPatch']>(),
    onCheckpoint: vi.fn<HtmlMirrorStreamObserver['onCheckpoint']>(),
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
