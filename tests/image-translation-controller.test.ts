import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

import type { ImageRecognitionCoordinator } from '../lib/ocr/image-analysis-coordinator';
import type { SourceImageChange, SourceImageDescriptor } from '../lib/ocr/contracts';
import {
  ImageTranslationController,
  type ImageTranslationControllerEnvironment,
} from '../lib/ocr/image-translation-controller';
import {
  ImageSourceUnavailableError,
  type ImageSourceLease,
} from '../lib/ocr/image-source-client';
import type { PixelAcquisitionCoordinator } from '../lib/ocr/pixel-acquisition';
import type { ReplicaCaptureRequest } from '../lib/replica/contracts';
import type { ReplicaImageAnchor } from '../lib/replica/rrweb-shadow-engine';

const sourceDocument = {
  sessionId: 'image-controller-session',
  pageEpoch: 5,
  generation: 5,
  documentId: 'image-controller-document',
  frameId: 0,
};
const descriptor: SourceImageDescriptor = {
  document: sourceDocument,
  nodeId: 12,
  sourceKind: 'img',
  contentRevision: 1,
  observationRevision: 1,
  visibility: 'visible',
  connected: true,
  renderedWidth: 200,
  renderedHeight: 100,
};
const request: ReplicaCaptureRequest = {
  ...sourceDocument,
  tabId: 4,
  isCurrent: () => true,
};

describe('ImageTranslationController', () => {
  it('stays dormant while disabled, then runs the local visible-image path when opted in', async () => {
    const { document } = parseHTML('<html><body><img lang="en"></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    image.getBoundingClientRect = () => ({
      left: 5, top: 6, width: 200, height: 100,
      right: 205, bottom: 106, x: 5, y: 6, toJSON: () => ({}),
    });
    const anchor: ReplicaImageAnchor = {
      document: sourceDocument,
      replayLease: 7,
      image,
      iframe: { contentDocument: document } as HTMLIFrameElement,
    };
    let emit: ((change: SourceImageChange) => void) | undefined;
    const source: ImageSourceLease = {
      measure: vi.fn(),
      dispose: vi.fn(),
    };
    const openSource = vi.fn(async (
      _request: ReplicaCaptureRequest,
      onChange: (change: SourceImageChange) => void,
    ) => {
      emit = onChange;
      queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
      return source;
    });
    const acquire = vi.fn(async () => ({
      status: 'ready' as const,
      pixels: {
        descriptor,
        pixelHash: 'cd'.repeat(32),
        encoded: new Blob([new Uint8Array([1])], { type: 'image/png' }),
        bitmapWidth: 200,
        bitmapHeight: 100,
        cropOffsetXCss: 0,
        cropOffsetYCss: 0,
        cropWidthCss: 200,
        cropHeightCss: 100,
        renderedWidthCss: 200,
        renderedHeightCss: 100,
        nearestElementLanguage: 'en' as const,
      },
    }));
    const recognize = vi.fn(async () => ({
      status: 'complete' as const,
      cacheHit: false,
      result: {
        providerId: 'tesseract' as const,
        bitmapWidth: 200,
        bitmapHeight: 100,
        transcript: 'hello',
        regions: [{
          text: 'hello',
          boundingBox: { x: 20, y: 20, width: 100, height: 30 },
        }],
      },
    }));
    let projected!: () => void;
    const projectedPromise = new Promise<void>((resolve) => {
      projected = resolve;
    });
    const controller = new ImageTranslationController({
      openSource,
      createPixelCoordinator: () => ({ acquire }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize,
        clear: vi.fn(),
      }) as unknown as ImageRecognitionCoordinator,
      resolveAnchor: () => anchor,
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({
          translate: async (text) => `${text}-日本語`,
          destroy: vi.fn(),
        }),
      },
      onDiagnostic: (diagnostic) => {
        if (diagnostic === 'projected') projected();
      },
      projector: {
        scheduleFrame: (callback) => {
          callback();
          return 1;
        },
        cancelFrame: () => undefined,
        createResizeObserver: () => undefined,
      },
    });
    controller.notifyReplicaCommit(7);
    controller.commitReplica(request, 3);
    await Promise.resolve();
    expect(openSource).not.toHaveBeenCalled();

    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      sourceLanguage: 'auto',
      detectedSourceLanguage: 'en',
      targetLanguage: 'ja',
      translationIdle: true,
    });
    await projectedPromise;

    expect(openSource).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenCalledOnce();
    expect(recognize).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-simul-image-overlay="12"]')?.textContent)
      .toBe('hello-日本語');
    emit?.({
      kind: 'remove',
      document: sourceDocument,
      nodeId: 12,
      contentRevision: 2,
      observationRevision: 2,
    });
    expect(document.querySelector('[data-simul-image-overlay="12"]')).toBeNull();
    controller.dispose();
  });

  it('does not create a recognition host when the source and target languages match', async () => {
    const createRecognitionCoordinator = vi.fn();
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return { measure: vi.fn(), dispose: vi.fn() };
      },
      createPixelCoordinator: () => ({
        acquire: async () => ({
          status: 'ready',
          pixels: {
            descriptor,
            pixelHash: 'ef'.repeat(32),
            encoded: new Blob([new Uint8Array([1])]),
            bitmapWidth: 200,
            bitmapHeight: 100,
            cropOffsetXCss: 0,
            cropOffsetYCss: 0,
            cropWidthCss: 200,
            cropHeightCss: 100,
            renderedWidthCss: 200,
            renderedHeightCss: 100,
            nearestElementLanguage: 'en',
          },
        }),
      }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator,
      resolveAnchor: () => ({
        document: sourceDocument,
        replayLease: 1,
        image: { isConnected: true } as HTMLImageElement,
        iframe: {} as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: vi.fn(),
      },
      projector: {
        scheduleFrame: () => 1,
        cancelFrame: () => undefined,
        createResizeObserver: () => undefined,
      },
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      sourceLanguage: 'en',
      targetLanguage: 'en',
      translationIdle: true,
    });
    controller.notifyReplicaCommit(1);
    controller.commitReplica(request, 3);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(createRecognitionCoordinator).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('reconnects once after a measurement detects a dead source, then degrades without a loop', async () => {
    const dispose = vi.fn();
    const acquire = vi.fn(async () => {
      throw new ImageSourceUnavailableError('source Port disconnected');
    });
    const openSource = vi.fn(async (
      _request: ReplicaCaptureRequest,
      onChange: (change: SourceImageChange) => void,
    ) => {
      queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
      return { measure: vi.fn(), dispose };
    });
    const controller = new ImageTranslationController({
      openSource,
      createPixelCoordinator: () => ({ acquire }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: vi.fn(),
      resolveAnchor: () => ({
        document: sourceDocument,
        replayLease: 1,
        image: { isConnected: true } as HTMLImageElement,
        iframe: {} as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: vi.fn(),
      },
      projector: {
        scheduleFrame: () => 1,
        cancelFrame: () => undefined,
        createResizeObserver: () => undefined,
      },
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      translationIdle: true,
    });
    controller.notifyReplicaCommit(1);
    controller.commitReplica(request, 3);
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(openSource).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(controller.busy).toBe(false);
    controller.dispose();
  });

  it('reconnects once when an otherwise idle source Port disconnects', async () => {
    const unavailable: ((error: ImageSourceUnavailableError) => void)[] = [];
    const dispose = vi.fn();
    const openSource = vi.fn(async () => {
      let signal!: (error: ImageSourceUnavailableError) => void;
      const unavailablePromise = new Promise<ImageSourceUnavailableError>(
        (resolve) => {
          signal = resolve;
        },
      );
      unavailable.push(signal);
      return {
        unavailable: unavailablePromise,
        measure: vi.fn(),
        dispose,
      };
    });
    const controller = createDormantController(openSource);
    controller.notifyReplicaCommit(1);
    controller.commitReplica(request, 3);
    await vi.waitFor(() => expect(openSource).toHaveBeenCalledOnce());

    unavailable[0]?.(new ImageSourceUnavailableError('idle disconnect'));
    await vi.waitFor(() => expect(openSource).toHaveBeenCalledTimes(2));
    unavailable[1]?.(new ImageSourceUnavailableError('second disconnect'));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(openSource).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('uses its one reconnect after an initial open failure', async () => {
    const dispose = vi.fn();
    const openSource = vi.fn()
      .mockRejectedValueOnce(new ImageSourceUnavailableError('start failed'))
      .mockResolvedValue({ measure: vi.fn(), dispose });
    const controller = createDormantController(openSource);
    controller.notifyReplicaCommit(1);
    controller.commitReplica(request, 3);

    await vi.waitFor(() => expect(openSource).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(openSource).toHaveBeenCalledTimes(2);
    controller.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('ignores a late disconnect signal after replica release', async () => {
    let unavailable!: (error: ImageSourceUnavailableError) => void;
    const openSource = vi.fn(async () => ({
      unavailable: new Promise<ImageSourceUnavailableError>((resolve) => {
        unavailable = resolve;
      }),
      measure: vi.fn(),
      dispose: vi.fn(),
    }));
    const controller = createDormantController(openSource);
    controller.notifyReplicaCommit(1);
    controller.commitReplica(request, 3);
    await vi.waitFor(() => expect(openSource).toHaveBeenCalledOnce());

    controller.releaseReplica();
    unavailable(new ImageSourceUnavailableError('late disconnect'));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(openSource).toHaveBeenCalledOnce();
    controller.dispose();
  });
});

function createDormantController(
  openSource: ImageTranslationControllerEnvironment['openSource'],
): ImageTranslationController {
  const controller = new ImageTranslationController({
    openSource,
    createPixelCoordinator: () => ({
      acquire: vi.fn(),
    }) as unknown as PixelAcquisitionCoordinator,
    createRecognitionCoordinator: vi.fn(),
    resolveAnchor: () => undefined,
    translationProvider: {
      availability: async () => 'available',
      createSession: vi.fn(),
    },
    projector: {
      scheduleFrame: () => 1,
      cancelFrame: () => undefined,
      createResizeObserver: () => undefined,
    },
  });
  controller.configure({
    enabled: true,
    scanPolicy: 'visible-only',
    skipSmallImages: false,
    providerOrder: ['tesseract'],
    sourceLanguage: 'en',
    targetLanguage: 'ja',
    translationIdle: true,
  });
  return controller;
}
