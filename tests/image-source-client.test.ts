import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SourceImageDescriptor } from '../lib/ocr/contracts';
import {
  ImageSourceUnavailableError,
  openChromeImageSource,
} from '../lib/ocr/image-source-client';
import type { ReplicaCaptureRequest } from '../lib/replica/contracts';

afterEach(() => vi.unstubAllGlobals());

describe('Chrome image source client', () => {
  it('exposes a start-post failure even when the lease is dead on arrival', async () => {
    const port = new FakePort();
    port.failPosts = true;
    installBrowser(port);

    const lease = await openChromeImageSource(request, vi.fn());

    await expect(lease.unavailable).resolves.toBeInstanceOf(
      ImageSourceUnavailableError,
    );
    await expect(lease.measure(descriptor)).rejects.toBeInstanceOf(
      ImageSourceUnavailableError,
    );
    expect(port.disconnects).toBe(1);
  });

  it('exposes an idle Port disconnect without requiring a measurement', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeImageSource(request, vi.fn());

    port.emitDisconnect();

    await expect(lease.unavailable).resolves.toMatchObject({
      name: 'ImageSourceUnavailableError',
      message: 'Image source disconnected.',
    });
    expect(port.disconnects).toBe(0);
  });
});

const request: ReplicaCaptureRequest = {
  sessionId: 'image-source-client-session',
  pageEpoch: 2,
  generation: 2,
  tabId: 7,
  frameId: 0,
  documentId: 'image-source-client-document',
  isCurrent: () => true,
};

const descriptor: SourceImageDescriptor = {
  document: {
    sessionId: request.sessionId,
    pageEpoch: request.pageEpoch,
    generation: request.generation,
    documentId: request.documentId,
    frameId: request.frameId,
  },
  nodeId: 1,
  sourceKind: 'img',
  contentRevision: 1,
  observationRevision: 1,
  visibility: 'visible',
  connected: true,
  renderedWidth: 100,
  renderedHeight: 50,
};

function installBrowser(port: FakePort): void {
  vi.stubGlobal('browser', {
    tabs: {
      connect: vi.fn(() => port),
    },
  });
}

class FakePort {
  readonly onMessage = new FakeEvent<(message: unknown) => void>();
  readonly onDisconnect = new FakeEvent<() => void>();
  failPosts = false;
  disconnects = 0;

  postMessage(): void {
    if (this.failPosts) throw new Error('no receiver');
  }

  disconnect(): void {
    this.disconnects += 1;
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
