import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SourceImageDescriptor } from '../lib/ocr/contracts';
import {
  ImageSourceUnavailableError,
  openChromeImageSource,
} from '../lib/ocr/image-source-client';
import type { ReplicaCaptureRequest } from '../lib/replica/contracts';

afterEach(() => vi.unstubAllGlobals());

describe('Chrome image source client', () => {
  it('opens an engine-owned isolated HTML image source Port', async () => {
    const port = new FakePort();
    const connect = installBrowser(port);

    const lease = await openChromeImageSource(
      request,
      vi.fn(),
      undefined,
      'isolated-html',
    );

    expect(connect).toHaveBeenCalledWith(request.tabId, expect.objectContaining({
      name: `simul:image-source-v1:isolated-html:${request.sessionId}`,
    }));
    port.emitMessage({
      kind: 'simul:image-source-v1:ready',
      document: {
        sessionId: request.sessionId,
        pageEpoch: request.pageEpoch,
        generation: request.generation,
        documentId: request.documentId,
        frameId: request.frameId,
      },
      summary: { candidateImages: 5, observedImages: 2 },
    });
    await expect(lease.ready).resolves.toEqual({
      candidateImages: 5,
      observedImages: 2,
    });
    lease.dispose();
  });

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

  it('round-trips an explicit accessibility read without logging it', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeImageSource(
      request,
      vi.fn(),
      undefined,
      'isolated-html',
      {
        policyFingerprint: 'read-v1-111000',
        controlImages: true,
        accessibilityTextEnabled: true,
      },
    );
    const task = lease.readAccessibilityText!(
      descriptor,
      'read-v1-111000',
      true,
    );
    const requestId = (port.messages.at(-1) as { requestId?: string })
      ?.requestId;
    expect(requestId).toBeDefined();
    port.emitMessage({
      kind: 'simul:image-source-v1:accessibility-text',
      requestId,
      descriptor,
      status: 'ready',
      evidence: {
        document: descriptor.document,
        nodeId: descriptor.nodeId,
        contentRevision: descriptor.contentRevision,
        observationRevision: descriptor.observationRevision,
        text: 'お知らせ',
        source: 'alt',
        nearestElementLanguage: 'ja',
      },
    });
    await expect(task).resolves.toMatchObject({ text: 'お知らせ' });
    lease.dispose();
  });

  it('rejects accessibility evidence that does not match the pending descriptor', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeImageSource(
      request,
      vi.fn(),
      undefined,
      'isolated-html',
      {
        policyFingerprint: 'read-v1-111000',
        controlImages: true,
        accessibilityTextEnabled: true,
      },
    );
    const task = lease.readAccessibilityText!(
      descriptor,
      'read-v1-111000',
      true,
    );
    const requestId = (port.messages.at(-1) as { requestId?: string })
      ?.requestId;
    port.emitMessage({
      kind: 'simul:image-source-v1:accessibility-text',
      requestId,
      descriptor: { ...descriptor, nodeId: descriptor.nodeId + 1 },
      status: 'ready',
      evidence: {
        document: descriptor.document,
        nodeId: descriptor.nodeId + 1,
        contentRevision: descriptor.contentRevision,
        observationRevision: descriptor.observationRevision,
        text: 'forged',
        source: 'alt',
      },
    });

    await expect(task).rejects.toMatchObject({
      name: 'ImageSourceUnavailableError',
      message: 'Mismatched accessibility text response.',
    });
    expect(port.disconnects).toBe(1);
  });

  it('rejects an accessibility read outside the lease start gates', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeImageSource(
      request,
      vi.fn(),
      undefined,
      'isolated-html',
      {
        policyFingerprint: 'read-v1-100000',
        controlImages: false,
        accessibilityTextEnabled: false,
      },
    );

    await expect(lease.readAccessibilityText!(
      descriptor,
      'read-v1-100000',
      false,
    )).rejects.toMatchObject({
      name: 'ImageSourceUnavailableError',
      message: 'Accessibility text is outside the image source policy.',
    });
    expect(port.messages).toHaveLength(1);
    lease.dispose();
  });

  it('shares one bounded pending budget across measurements and accessibility reads', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeImageSource(
      request,
      vi.fn(),
      undefined,
      'isolated-html',
      {
        policyFingerprint: 'read-v1-111000',
        controlImages: true,
        accessibilityTextEnabled: true,
      },
    );
    const pending = Array.from({ length: 16 }, () =>
      lease.readAccessibilityText!(
        descriptor,
        'read-v1-111000',
        true,
      ));

    await expect(lease.measure(descriptor)).rejects.toBeInstanceOf(
      ImageSourceUnavailableError,
    );
    expect(port.messages).toHaveLength(17);

    lease.dispose();
    const settled = await Promise.allSettled(pending);
    expect(settled.every(({ status }) => status === 'rejected')).toBe(true);
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

function installBrowser(port: FakePort): ReturnType<typeof vi.fn> {
  const connect = vi.fn(() => port);
  vi.stubGlobal('browser', {
    tabs: {
      connect,
    },
  });
  return connect;
}

class FakePort {
  readonly onMessage = new FakeEvent<(message: unknown) => void>();
  readonly onDisconnect = new FakeEvent<() => void>();
  failPosts = false;
  disconnects = 0;
  readonly messages: unknown[] = [];

  postMessage(message: unknown): void {
    if (this.failPosts) throw new Error('no receiver');
    this.messages.push(message);
  }

  disconnect(): void {
    this.disconnects += 1;
  }

  emitDisconnect(): void {
    this.onDisconnect.emit();
  }

  emitMessage(message: unknown): void {
    this.onMessage.emit(message);
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
