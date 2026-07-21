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
  // Source URLs and file formats never cross the observation boundary. This
  // same descriptor drives raster, external-SVG, and image-only media OCR.
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
  it('keeps the mutation quiet timer receiver-safe during replica activation', async () => {
    const receivers: unknown[] = [];
    const diagnostics: unknown[] = [];
    const setTimer = function (
      this: unknown,
      _callback: () => void,
      _milliseconds?: number,
    ): ReturnType<typeof setTimeout> {
      receivers.push(this);
      return 41 as unknown as ReturnType<typeof setTimeout>;
    };
    const clearTimer = function (
      this: unknown,
      _handle: ReturnType<typeof setTimeout>,
    ): void {
      receivers.push(this);
    };
    const controller = new ImageTranslationController({
      openSource: async () => ({
        measure: vi.fn(),
        dispose: vi.fn(),
      }),
      createPixelCoordinator: vi.fn(),
      createRecognitionCoordinator: vi.fn(),
      resolveAnchor: () => undefined,
      translationProvider: {
        availability: async () => 'available',
        createSession: vi.fn(),
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      setTimer,
      clearTimer,
      projector: testProjectorEnvironment(),
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

    expect(controller.activateReplica(request, 3, 1)).toBe(true);
    expect(diagnostics).toContain('source-connecting');
    expect(receivers).toEqual([undefined]);

    controller.dispose();
    expect(receivers).toEqual([undefined, undefined]);
    await Promise.resolve();
  });

  it('reports the initial disabled state once without exposing page content', () => {
    const diagnostics: unknown[] = [];
    const controller = new ImageTranslationController({
      openSource: vi.fn(),
      createPixelCoordinator: vi.fn(),
      createRecognitionCoordinator: vi.fn(),
      resolveAnchor: () => undefined,
      translationProvider: {
        availability: async () => 'available',
        createSession: vi.fn(),
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      projector: testProjectorEnvironment(),
    });
    const configuration = {
      enabled: false,
      scanPolicy: 'visible-only' as const,
      skipSmallImages: false,
      providerOrder: ['tesseract'] as const,
      sourceLanguage: 'en' as const,
      targetLanguage: 'ja' as const,
      translationIdle: true,
    };

    controller.configure(configuration);
    controller.configure(configuration);

    expect(diagnostics).toEqual([
      'disabled',
      {
        stage: 'configuration',
        status: 'disabled',
        reason: 'feature-off',
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toMatch(
      /(?:https?:|pixels|hash|nodeId|documentId)/iu,
    );
    controller.dispose();
  });

  it('activates one exact current replica atomically and idempotently', async () => {
    const diagnostics: unknown[] = [];
    const openSource = vi.fn(async () => ({
      ready: Promise.resolve({ candidateImages: 0, observedImages: 0 }),
      measure: vi.fn(),
      dispose: vi.fn(),
    }));
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
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      projector: testProjectorEnvironment(),
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

    expect(controller.activateReplica(
      { ...request, isCurrent: () => false },
      3,
      1,
    )).toBe(false);
    expect(controller.activateReplica(request, 3, 0)).toBe(false);
    expect(openSource).not.toHaveBeenCalled();

    let requestIsCurrent = true;
    const currentRequest = {
      ...request,
      isCurrent: () => requestIsCurrent,
    };
    expect(controller.activateReplica(currentRequest, 3, 4)).toBe(true);
    await vi.waitFor(() => expect(diagnostics).toContain('source-connected'));
    expect(openSource).toHaveBeenCalledOnce();
    expect(openSource).toHaveBeenCalledWith(
      currentRequest,
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(diagnostics.indexOf('waiting-for-replica')).toBeLessThan(
      diagnostics.indexOf('replica-ready'),
    );
    expect(diagnostics.indexOf('replica-ready')).toBeLessThan(
      diagnostics.indexOf('source-connecting'),
    );

    // A callback handoff followed by the post-run snapshot backstop must not
    // reopen the exact-document source.
    expect(controller.activateReplica(currentRequest, 3, 4)).toBe(true);
    expect(openSource).toHaveBeenCalledOnce();
    expect(controller.notifyReplicaCommit(
      { ...sourceDocument, documentId: 'unrelated-document' },
      5,
    )).toBe(false);
    expect(controller.notifyReplicaCommit(sourceDocument, 5)).toBe(true);
    expect(controller.notifyReplicaCommit(sourceDocument, 4)).toBe(false);
    requestIsCurrent = false;
    expect(controller.notifyReplicaCommit(sourceDocument, 6)).toBe(false);
    expect(JSON.stringify(diagnostics)).not.toMatch(
      /(?:https?:|pixels|hash|nodeId|documentId)/iu,
    );
    controller.dispose();
  });

  it('reports when the initial source scan finds no usable images', async () => {
    const diagnostics: unknown[] = [];
    const controller = new ImageTranslationController({
      openSource: async () => ({
        ready: Promise.resolve({ candidateImages: 0, observedImages: 0 }),
        measure: vi.fn(),
        dispose: vi.fn(),
      }),
      createPixelCoordinator: () => ({
        acquire: vi.fn(),
      }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: vi.fn(),
      resolveAnchor: () => undefined,
      translationProvider: {
        availability: async () => 'available',
        createSession: vi.fn(),
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      projector: testProjectorEnvironment(),
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
    controller.activateReplica(request, 3, 1);

    await vi.waitFor(() => expect(diagnostics).toContain('source-empty'));
    expect(diagnostics).toContainEqual({
      stage: 'source-summary',
      candidateImages: 0,
      observedImages: 0,
    });
    controller.dispose();
  });

  it('reports the content-free reason when visible pixel capture is deferred', async () => {
    const diagnostics: unknown[] = [];
    const acquire = vi.fn(async () => ({
      status: 'deferred' as const,
      reason: 'permission' as const,
    }));
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return { measure: vi.fn(), dispose: vi.fn() };
      },
      createPixelCoordinator: () => ({
        acquire,
      }) as unknown as PixelAcquisitionCoordinator,
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
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      projector: testProjectorEnvironment(),
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
    controller.activateReplica(request, 3, 1);

    await vi.waitFor(() => expect(diagnostics).toContainEqual({
      stage: 'capture-deferred',
      reason: 'permission',
      renderedWidth: 200,
      renderedHeight: 100,
    }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(acquire).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it('runs the format-opaque external-image path only after the user opts in', async () => {
    const { document } = parseHTML('<html><body><img lang="en"></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    image.getBoundingClientRect = () => ({
      left: 5, top: 6, width: 200, height: 100,
      right: 205, bottom: 106, x: 5, y: 6, toJSON: () => ({}),
    });
    let activeReplayLease = 7;
    const anchor: Omit<ReplicaImageAnchor, 'replayLease'> = {
      document: sourceDocument,
      image,
      iframe: { contentDocument: document } as HTMLIFrameElement,
    };
    let emit: ((change: SourceImageChange) => void) | undefined;
    const source: ImageSourceLease = {
      ready: Promise.resolve({ candidateImages: 1, observedImages: 1 }),
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
    const createTranslationSession = vi.fn(async () => ({
      translate: async (text: string) => `${text}-日本語`,
      destroy: vi.fn(),
    }));
    let projected!: () => void;
    const projectedPromise = new Promise<void>((resolve) => {
      projected = resolve;
    });
    const diagnostics: unknown[] = [];
    const controller = new ImageTranslationController({
      openSource,
      createPixelCoordinator: () => ({ acquire }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize,
        clear: vi.fn(),
      }) as unknown as ImageRecognitionCoordinator,
      resolveAnchor: () => ({ ...anchor, replayLease: activeReplayLease }),
      translationProvider: {
        availability: async () => 'available',
        createSession: createTranslationSession,
      },
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
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
    controller.activateReplica(request, 3, 7);
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
    expect(recognize).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        providerOrder: ['tesseract'],
        sourceLanguage: 'en',
        languageGroup: 'eng',
      }),
      expect.any(AbortSignal),
    );
    expect(diagnostics).toEqual(expect.arrayContaining([
      'disabled',
      'source-connected',
      {
        stage: 'source-summary',
        candidateImages: 1,
        observedImages: 1,
      },
      {
        stage: 'image-scheduling',
        status: 'queued',
        visibility: 'visible',
        renderedWidth: 200,
        renderedHeight: 100,
      },
      'recognition-started',
      {
        stage: 'recognition-complete',
        provider: 'tesseract',
        regions: 1,
        cacheHit: false,
      },
      'translation-started',
      'projected',
    ]));
    expect(document.querySelector('[data-simul-image-overlay="12"]')?.textContent)
      .toBe('hello-日本語');
    expect(createTranslationSession).toHaveBeenCalledOnce();
    activeReplayLease = 8;
    expect(controller.notifyReplicaCommit(
      { ...sourceDocument, documentId: 'stale-document' },
      8,
    )).toBe(false);
    expect(recognize).toHaveBeenCalledOnce();
    expect(controller.notifyReplicaCommit(sourceDocument, 8)).toBe(true);
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(
      diagnostics.filter((diagnostic) => diagnostic === 'projected'),
    ).toHaveLength(2));
    expect(document.querySelector('[data-simul-image-overlay="12"]')?.textContent)
      .toBe('hello-日本語');
    expect(createTranslationSession).toHaveBeenCalledOnce();
    emit?.({
      kind: 'remove',
      document: sourceDocument,
      nodeId: 12,
      contentRevision: 2,
      observationRevision: 2,
    });
    expect(document.querySelector('[data-simul-image-overlay="12"]')).toBeNull();
    emit?.({
      kind: 'upsert',
      descriptor: {
        ...descriptor,
        contentRevision: 3,
        observationRevision: 3,
      },
    });
    await vi.waitFor(() => expect(
      diagnostics.filter((diagnostic) => diagnostic === 'projected'),
    ).toHaveLength(3));
    expect(document.querySelector('[data-simul-image-overlay="12"]')?.textContent)
      .toBe('hello-日本語');
    expect(createTranslationSession).toHaveBeenCalledOnce();

    controller.configure({
      enabled: false,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      sourceLanguage: 'auto',
      detectedSourceLanguage: 'en',
      targetLanguage: 'ja',
      translationIdle: true,
    });

    expect(document.querySelector('[data-simul-image-overlay="12"]')).toBeNull();
    expect(source.dispose).toHaveBeenCalledOnce();
    controller.dispose();
    expect(source.dispose).toHaveBeenCalledOnce();
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
    controller.activateReplica(request, 3, 1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(createRecognitionCoordinator).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('starts the replacement OCR queue after a pair change cancels an active job', async () => {
    const { document } = parseHTML('<html><body><img lang="en"></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    image.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 200, height: 100,
      right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}),
    });
    let resolveFirst!: (result: {
      status: 'complete';
      cacheHit: false;
      result: {
        providerId: 'tesseract';
        bitmapWidth: number;
        bitmapHeight: number;
        transcript: string;
        regions: Array<{
          text: string;
          boundingBox: { x: number; y: number; width: number; height: number };
        }>;
      };
    }) => void;
    const firstRecognition = new Promise<Parameters<typeof resolveFirst>[0]>(
      (resolve) => { resolveFirst = resolve; },
    );
    const recognitionResult = {
      status: 'complete' as const,
      cacheHit: false as const,
      result: {
        providerId: 'tesseract' as const,
        bitmapWidth: 200,
        bitmapHeight: 100,
        transcript: 'hello',
        regions: [{
          text: 'hello',
          boundingBox: { x: 10, y: 10, width: 80, height: 20 },
        }],
      },
    };
    const recognize = vi.fn()
      .mockReturnValueOnce(firstRecognition)
      .mockResolvedValue(recognitionResult);
    const diagnostics: unknown[] = [];
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
            pixelHash: '91'.repeat(32),
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
      createRecognitionCoordinator: () => ({
        recognize,
        clear: vi.fn(),
      }) as unknown as ImageRecognitionCoordinator,
      resolveAnchor: () => ({
        document: sourceDocument,
        replayLease: 1,
        image,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({
          translate: async (text) => `${text}-translated`,
          destroy: vi.fn(),
        }),
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      setTimer: ((callback: TimerHandler) => {
        if (typeof callback === 'function') queueMicrotask(() => callback());
        return 1;
      }) as unknown as typeof setTimeout,
      clearTimer: vi.fn() as unknown as typeof clearTimeout,
      projector: {
        scheduleFrame: (callback) => { callback(); return 1; },
        cancelFrame: () => undefined,
        createResizeObserver: () => undefined,
      },
    });
    const initial = {
      enabled: true,
      scanPolicy: 'visible-only' as const,
      skipSmallImages: false,
      providerOrder: ['tesseract'] as const,
      sourceLanguage: 'en' as const,
      targetLanguage: 'ja' as const,
      translationIdle: true,
    };
    controller.configure(initial);
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce());

    controller.configure({ ...initial, targetLanguage: 'fr' });
    resolveFirst(recognitionResult);

    await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(diagnostics).toContain('projected'));
    expect(controller.busy).toBe(false);
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
    controller.activateReplica(request, 3, 1);
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
    controller.activateReplica(request, 3, 1);
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
    controller.activateReplica(request, 3, 1);

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
    controller.activateReplica(request, 3, 1);
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

function testProjectorEnvironment() {
  return {
    scheduleFrame: () => 1,
    cancelFrame: () => undefined,
    createResizeObserver: () => undefined,
  } as const;
}
