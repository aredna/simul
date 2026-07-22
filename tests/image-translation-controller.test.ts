import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

import type {
  ImageRecognitionCoordinator,
  ImageRecognitionResult,
} from '../lib/ocr/image-analysis-coordinator';
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
    await vi.waitFor(() => expect(diagnostics).toContainEqual({
      stage: 'source-summary',
      candidateImages: 0,
      observedImages: 0,
    }));
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
    expect(diagnostics.indexOf('source-connecting')).toBeLessThan(
      diagnostics.indexOf('source-connected'),
    );
    expect(diagnostics.indexOf('source-connected')).toBeLessThan(
      diagnostics.findIndex((diagnostic) =>
        typeof diagnostic === 'object' &&
        diagnostic !== null &&
        'stage' in diagnostic &&
        diagnostic.stage === 'source-summary'),
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
      ordinal: 1,
      reason: 'permission',
      renderedWidth: 200,
      renderedHeight: 100,
    }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(acquire).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it('bounds a transient capture retry and requires two unchanged empty OCR results', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const pixels = {
      descriptor,
      pixelHash: 'ad'.repeat(32),
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
    };
    const acquire = vi.fn()
      .mockResolvedValueOnce({ status: 'deferred', reason: 'unstable' })
      .mockResolvedValue({ status: 'ready', pixels });
    const recognize = vi.fn<() => Promise<ImageRecognitionResult>>(async () => ({
      status: 'complete' as const,
      cacheHit: false,
      result: {
        providerId: 'tesseract' as const,
        bitmapWidth: 200,
        bitmapHeight: 100,
        transcript: '',
        regions: [],
      },
    }));
    const diagnostics: unknown[] = [];
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return { measure: vi.fn(), dispose: vi.fn() };
      },
      createPixelCoordinator: () => ({ acquire }) as unknown as PixelAcquisitionCoordinator,
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

    await vi.waitFor(() => expect(diagnostics).toContain('no-text-found'));
    expect(acquire).toHaveBeenCalledTimes(3);
    expect(recognize).toHaveBeenCalledTimes(2);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 'job-progress', status: 'capture-retry', attempt: 1,
      }),
      expect.objectContaining({
        stage: 'job-progress', status: 'no-text-retry', attempt: 1,
      }),
    ]));
    controller.dispose();
  });

  it('settles after one transient capture retry and resets it after a non-transient result', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const acquire = vi.fn()
      .mockResolvedValueOnce({ status: 'deferred', reason: 'unstable' })
      .mockResolvedValueOnce({ status: 'deferred', reason: 'api' })
      .mockResolvedValueOnce({ status: 'deferred', reason: 'permission' })
      .mockResolvedValueOnce({ status: 'deferred', reason: 'unstable' })
      .mockResolvedValueOnce({ status: 'deferred', reason: 'permission' });
    const diagnostics: unknown[] = [];
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return { measure: vi.fn(), dispose: vi.fn() };
      },
      createPixelCoordinator: () => ({ acquire }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: vi.fn(),
      resolveAnchor: () => ({
        document: sourceDocument,
        replayLease: 1,
        image,
        iframe: { contentDocument: document } as HTMLIFrameElement,
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

    await vi.waitFor(() => expect(diagnostics).toContainEqual(
      expect.objectContaining({
        stage: 'job-progress',
        status: 'capture-retry-exhausted',
        attempt: 1,
      }),
    ));
    expect(acquire).toHaveBeenCalledTimes(2);

    expect(controller.notifyReplicaCommit(sourceDocument, 2)).toBe(true);
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(3));
    expect(controller.notifyReplicaCommit(sourceDocument, 3)).toBe(true);
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(5));
    expect(diagnostics.filter((diagnostic) =>
      typeof diagnostic === 'object' && diagnostic !== null &&
      'stage' in diagnostic && diagnostic.stage === 'job-progress' &&
      'status' in diagnostic && diagnostic.status === 'capture-retry'
    )).toHaveLength(2);
    controller.dispose();
  });

  it('gives changed blank pixels one final bounded confirmation pass', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const acquired = (pixelHash: string) => ({
      status: 'ready' as const,
      pixels: {
        descriptor,
        pixelHash,
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
    });
    const acquire = vi.fn()
      .mockResolvedValueOnce(acquired('aa'.repeat(32)))
      .mockResolvedValueOnce(acquired('bb'.repeat(32)))
      .mockResolvedValueOnce(acquired('bb'.repeat(32)));
    const recognize = vi.fn(async () => ({
      status: 'complete' as const,
      cacheHit: false,
      result: {
        providerId: 'tesseract' as const,
        bitmapWidth: 200,
        bitmapHeight: 100,
        transcript: '',
        regions: [],
      },
    }));
    const diagnostics: unknown[] = [];
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return { measure: vi.fn(), dispose: vi.fn() };
      },
      createPixelCoordinator: () => ({ acquire }) as unknown as PixelAcquisitionCoordinator,
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

    await vi.waitFor(() => expect(diagnostics).toContain('no-text-found'));
    expect(acquire).toHaveBeenCalledTimes(3);
    expect(recognize).toHaveBeenCalledTimes(3);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 'job-progress', status: 'no-text-retry', attempt: 1,
      }),
      expect.objectContaining({
        stage: 'job-progress', status: 'no-text-retry', attempt: 2,
      }),
    ]));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      stage: 'job-progress', status: 'no-text-changed',
    }));
    controller.dispose();
  });

  it('clears blank-confirmation state after nonempty recognition', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    image.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 200, height: 100,
      right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}),
    });
    const pixels = {
      descriptor,
      pixelHash: 'bc'.repeat(32),
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
    };
    const blank = {
      status: 'complete' as const,
      cacheHit: false,
      result: {
        providerId: 'tesseract' as const,
        bitmapWidth: 200,
        bitmapHeight: 100,
        transcript: '',
        regions: [],
      },
    };
    const nonempty = {
      status: 'complete' as const,
      cacheHit: false,
      result: {
        providerId: 'tesseract' as const,
        bitmapWidth: 200,
        bitmapHeight: 100,
        transcript: 'hello',
        regions: [{
          text: 'hello',
          boundingBox: { x: 10, y: 10, width: 100, height: 20 },
        }],
      },
    };
    const recognize = vi.fn()
      .mockResolvedValueOnce(blank)
      .mockResolvedValueOnce(nonempty)
      .mockResolvedValueOnce(blank)
      .mockResolvedValueOnce(blank);
    const diagnostics: unknown[] = [];
    let activeReplayLease = 1;
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return { measure: vi.fn(), dispose: vi.fn() };
      },
      createPixelCoordinator: () => ({
        acquire: async () => ({ status: 'ready', pixels }),
      }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize,
        clear: vi.fn(),
      }) as unknown as ImageRecognitionCoordinator,
      resolveAnchor: () => ({
        document: sourceDocument,
        replayLease: activeReplayLease,
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
      projector: {
        scheduleFrame: (callback) => { callback(); return 1; },
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
    controller.activateReplica(request, 3, activeReplayLease);
    await vi.waitFor(() => expect(diagnostics).toContain('projected'));

    activeReplayLease = 2;
    expect(controller.notifyReplicaCommit(sourceDocument, activeReplayLease))
      .toBe(true);
    await vi.waitFor(() => expect(diagnostics).toContain('no-text-found'));

    expect(recognize).toHaveBeenCalledTimes(4);
    expect(diagnostics.filter((diagnostic) =>
      typeof diagnostic === 'object' && diagnostic !== null &&
      'stage' in diagnostic && diagnostic.stage === 'job-progress' &&
      'status' in diagnostic && diagnostic.status === 'no-text-retry'
    )).toHaveLength(2);
    expect(document.querySelector('[data-simul-image-overlay="12"]')).toBeNull();
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
    const recognize = vi.fn<() => Promise<ImageRecognitionResult>>(async () => ({
      status: 'complete' as const,
      cacheHit: false,
      cacheAccess: 'miss',
      cacheStats: {
        entries: 1,
        weight: 42,
        hits: 0,
        misses: 1,
        inFlightJoins: 0,
        loads: 1,
      },
      quality: {
        candidateRegions: 1,
        acceptedRegions: 1,
        corroboratedRegions: 0,
        uncertainRegions: 0,
        rejectedBlankRegions: 0,
        rejectedPunctuationRegions: 0,
        rejectedLowConfidenceRegions: 0,
        rejectedUncorroboratedRegions: 0,
      },
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
        stage: 'recognition-cache',
        access: 'miss',
        entries: 1,
        weight: 42,
        hits: 0,
        misses: 1,
        joins: 0,
        loads: 1,
      },
      {
        stage: 'recognition-quality',
        candidateRegions: 1,
        acceptedRegions: 1,
        corroboratedRegions: 0,
        uncertainRegions: 0,
        rejectedBlankRegions: 0,
        rejectedPunctuationRegions: 0,
        rejectedLowConfidenceRegions: 0,
        rejectedUncorroboratedRegions: 0,
      },
      {
        stage: 'recognition-complete',
        provider: 'tesseract',
        regions: 1,
        cacheHit: false,
        ordinal: 1,
        bitmapWidth: 200,
        bitmapHeight: 100,
      },
      {
        stage: 'translation-started',
        ordinal: 1,
        renderedWidth: 200,
        renderedHeight: 100,
        bitmapWidth: 200,
        bitmapHeight: 100,
      },
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

    recognize.mockResolvedValueOnce({
      status: 'complete',
      cacheHit: false,
      result: {
        providerId: 'tesseract',
        bitmapWidth: 200,
        bitmapHeight: 100,
        transcript: 'failure case',
        regions: [{
          text: 'failure case',
          boundingBox: { x: 20, y: 20, width: 100, height: 30 },
        }],
      },
    });
    createTranslationSession.mockRejectedValueOnce(
      new Error('content-free translation failure'),
    );
    emit?.({
      kind: 'upsert',
      descriptor: {
        ...descriptor,
        contentRevision: 4,
        observationRevision: 4,
      },
    });
    await vi.waitFor(() => expect(diagnostics).toContainEqual({
      stage: 'translation-failed',
      ordinal: 4,
      renderedWidth: 200,
      renderedHeight: 100,
      bitmapWidth: 200,
      bitmapHeight: 100,
    }));

    recognize.mockResolvedValueOnce({
      status: 'complete',
      cacheHit: false,
      result: {
        providerId: 'tesseract',
        bitmapWidth: 200,
        bitmapHeight: 100,
        transcript: ' ',
        regions: [{
          text: ' ',
          boundingBox: { x: 20, y: 20, width: 100, height: 30 },
        }],
      },
    });
    emit?.({
      kind: 'upsert',
      descriptor: {
        ...descriptor,
        contentRevision: 5,
        observationRevision: 5,
      },
    });
    await vi.waitFor(() => expect(diagnostics).toContainEqual({
      stage: 'translation-empty',
      ordinal: 5,
      renderedWidth: 200,
      renderedHeight: 100,
      bitmapWidth: 200,
      bitmapHeight: 100,
    }));
    expect(document.querySelector('[data-simul-image-overlay="12"]')).toBeNull();

    recognize.mockResolvedValueOnce({
      status: 'failed',
      code: 'provider-unavailable',
    });
    emit?.({
      kind: 'upsert',
      descriptor: {
        ...descriptor,
        contentRevision: 6,
        observationRevision: 6,
      },
    });
    await vi.waitFor(() => expect(diagnostics).toContainEqual({
      stage: 'recognition-failed',
      code: 'provider-unavailable',
      ordinal: 6,
      renderedWidth: 200,
      renderedHeight: 100,
      bitmapWidth: 200,
      bitmapHeight: 100,
    }));

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
    const openSource = vi.fn(async (_request, onChange: (change: {
      kind: 'upsert';
      descriptor: typeof descriptor;
    }) => void) => {
      queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
      return { measure: vi.fn(), dispose: vi.fn() };
    });
    const createPixelCoordinator = vi.fn(() => ({
      acquire: vi.fn(),
    }) as unknown as PixelAcquisitionCoordinator);
    const controller = new ImageTranslationController({
      openSource,
      createPixelCoordinator,
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

    expect(openSource).not.toHaveBeenCalled();
    expect(createPixelCoordinator).not.toHaveBeenCalled();
    expect(createRecognitionCoordinator).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('admits a direct Tesseract-Wasm-only runtime route', async () => {
    const source = { measure: vi.fn(), dispose: vi.fn() };
    const openSource = vi.fn(async () => source);
    const controller = createDormantController(openSource);
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract-wasm-direct'],
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      translationIdle: true,
    });
    controller.activateReplica(request, 3, 1);

    await vi.waitFor(() => expect(openSource).toHaveBeenCalledOnce());
    controller.dispose();
    expect(source.dispose).toHaveBeenCalledOnce();
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
      setTimer: ((callback: TimerHandler, milliseconds?: number) => {
        if (typeof callback === 'function' && milliseconds === 1_000) {
          queueMicrotask(() => callback());
        }
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
      ocrMinimumConfidence: 0.65 as const,
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
    controller.configure({
      ...initial,
      targetLanguage: 'fr',
      ocrMinimumConfidence: 0.8,
    });
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(3));
    expect(recognize.mock.calls[0]?.[1]).toMatchObject({
      minimumConfidence: 0.65,
    });
    expect(recognize.mock.calls[2]?.[1]).toMatchObject({
      minimumConfidence: 0.8,
    });
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

  it('promotes high-confidence Kana OCR for Auto and requeues all images', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    image.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 200, height: 100,
      right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}),
    });
    const pixels = {
      descriptor,
      pixelHash: '73'.repeat(32),
      encoded: new Blob([new Uint8Array([1])], { type: 'image/png' }),
      bitmapWidth: 200,
      bitmapHeight: 100,
      cropOffsetXCss: 0,
      cropOffsetYCss: 0,
      cropWidthCss: 200,
      cropHeightCss: 100,
      renderedWidthCss: 200,
      renderedHeightCss: 100,
    };
    const recognition = {
      status: 'complete' as const,
      cacheHit: false,
      result: {
        providerId: 'tesseract' as const,
        bitmapWidth: 200,
        bitmapHeight: 100,
        transcript: 'お知らせ',
        transcriptConfidence: 0.94,
        regions: [{
          text: 'お知らせ',
          confidence: 0.94,
          boundingBox: { x: 20, y: 25, width: 100, height: 30 },
        }],
      },
    };
    const recognize = vi.fn(async (_pixels: unknown, _route: unknown) => recognition);
    const detected: Array<readonly [string, string]> = [];
    const diagnostics: unknown[] = [];
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return { measure: vi.fn(), dispose: vi.fn() };
      },
      createPixelCoordinator: () => ({
        acquire: async () => ({ status: 'ready', pixels }),
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
          translate: async () => 'News',
          destroy: vi.fn(),
        }),
      },
      onAutoLanguageDetected: (language, evidence) => {
        detected.push([language, evidence]);
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      setTimer: ((callback: TimerHandler, milliseconds?: number) => {
        if (typeof callback === 'function' && milliseconds === 1_000) {
          queueMicrotask(() => callback());
        }
        return 1;
      }) as unknown as typeof setTimeout,
      clearTimer: vi.fn() as unknown as typeof clearTimeout,
      projector: {
        scheduleFrame: (callback) => { callback(); return 1; },
        cancelFrame: () => undefined,
        createResizeObserver: () => undefined,
      },
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      ocrMinimumConfidence: 0.65,
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      translationIdle: true,
    });
    controller.activateReplica(request, 3, 1);

    await vi.waitFor(() => expect(diagnostics).toContain('projected'));
    expect(detected).toEqual([['ja', 'single-strong-script']]);
    expect(recognize).toHaveBeenCalledTimes(2);
    expect(recognize.mock.calls[0]?.[1]).toMatchObject({
      sourceLanguage: 'ja',
      languageGroup: 'jpn+jpn_vert',
      minimumConfidence: 0.8,
    });
    expect(recognize.mock.calls[1]?.[1]).toMatchObject({
      sourceLanguage: 'ja',
      languageGroup: 'jpn+jpn_vert',
      minimumConfidence: 0.65,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      stage: 'auto-language-probe-resolved',
      language: 'ja',
      evidence: 'single-strong-script',
    }));
    controller.dispose();
  });

  it('retries the Japanese route when a no-text logo precedes a Japanese image', async () => {
    const secondDescriptor = { ...descriptor, nodeId: 13 };
    const logoPixels = autoProbePixels(descriptor, '81'.repeat(32));
    const japanesePixels = autoProbePixels(secondDescriptor, '82'.repeat(32));
    let emitChange: ((change: SourceImageChange) => void) | undefined;
    const detected: Array<readonly [string, string]> = [];
    const diagnostics: unknown[] = [];
    const timers = controlledProbeTimers();
    const recognize = vi.fn(async (
      pixels: typeof logoPixels,
      route: { sourceLanguage: string },
    ) => pixels.pixelHash === logoPixels.pixelHash
      ? autoProbeRecognition()
      : route.sourceLanguage === 'ja'
        ? autoProbeRecognition('お知らせ', 0.94)
        : autoProbeRecognition());
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        emitChange = onChange;
        return { measure: vi.fn(), dispose: vi.fn() };
      },
      createPixelCoordinator: () => ({
        acquire: async (current: SourceImageDescriptor) => ({
          status: 'ready',
          pixels: current.nodeId === descriptor.nodeId
            ? logoPixels
            : japanesePixels,
        }),
      }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize,
        clear: vi.fn(),
      }) as unknown as ImageRecognitionCoordinator,
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
      onAutoLanguageDetected: (language, evidence) => {
        detected.push([language, evidence]);
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      translationIdle: true,
    });
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(emitChange).toBeTypeOf('function'));

    emitChange?.({ kind: 'upsert', descriptor });
    await vi.waitFor(() => expect(diagnostics).toContain('unsupported-language'));
    expect(recognize.mock.calls.slice(0, 6).map((call) =>
      (call[1] as { sourceLanguage: string }).sourceLanguage
    )).toEqual(['ja', 'en', 'zh', 'zh-Hant', 'ko', 'ru']);

    emitChange?.({ kind: 'upsert', descriptor: secondDescriptor });
    await vi.waitFor(() => expect(detected).toEqual([
      ['ja', 'single-strong-script'],
    ]));
    const japaneseRouteCall = recognize.mock.calls.find((call) =>
      (call[0] as typeof japanesePixels).pixelHash === japanesePixels.pixelHash
    );
    expect((japaneseRouteCall?.[1] as { sourceLanguage: string }).sourceLanguage)
      .toBe('ja');
    controller.dispose();
  });

  it('holds controller OCR behind page resolution, then gives page evidence precedence or resumes probing', async () => {
    const run = async (pageLanguage?: 'en') => {
      let emitChange: ((change: SourceImageChange) => void) | undefined;
      const acquire = vi.fn(async () => ({
        status: 'ready' as const,
        pixels: autoProbePixels(descriptor, '93'.repeat(32)),
      }));
      const recognize = vi.fn(async (
        _pixels: unknown,
        route: { sourceLanguage: string },
      ) => route.sourceLanguage === 'ja'
        ? autoProbeRecognition('お知らせ', 0.94)
        : autoProbeRecognition());
      const detected: Array<{
        language: string;
        document: typeof sourceDocument;
      }> = [];
      const timers = controlledProbeTimers();
      const controller = new ImageTranslationController({
        openSource: async (_request, onChange) => {
          emitChange = onChange;
          return { measure: vi.fn(), dispose: vi.fn() };
        },
        createPixelCoordinator: () => ({ acquire }) as unknown as
          PixelAcquisitionCoordinator,
        createRecognitionCoordinator: () => ({
          recognize,
          clear: vi.fn(),
        }) as unknown as ImageRecognitionCoordinator,
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
        onAutoLanguageDetected: (language, _evidence, document) => {
          detected.push({ language, document });
        },
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
        projector: testProjectorEnvironment(),
      });
      const pendingConfiguration = {
        enabled: true,
        scanPolicy: 'visible-only' as const,
        skipSmallImages: false,
        providerOrder: ['tesseract'] as const,
        sourceLanguage: 'auto' as const,
        pageLanguageResolutionPending: true,
        targetLanguage: 'fr' as const,
        translationIdle: true,
      };
      controller.configure(pendingConfiguration);
      controller.activateReplica(request, 3, 1);
      await vi.waitFor(() => expect(emitChange).toBeTypeOf('function'));
      emitChange?.({ kind: 'upsert', descriptor });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(acquire).not.toHaveBeenCalled();
      expect(recognize).not.toHaveBeenCalled();
      expect(detected).toEqual([]);

      controller.configure({
        ...pendingConfiguration,
        pageLanguageResolutionPending: false,
        ...(pageLanguage ? { detectedSourceLanguage: pageLanguage } : {}),
      });
      if (pageLanguage) {
        await vi.waitFor(() => expect(recognize).toHaveBeenCalled());
        await vi.waitFor(() => expect(controller.busy).toBe(false));
        expect(recognize.mock.calls.every((call) =>
          (call[1] as { sourceLanguage: string }).sourceLanguage ===
            pageLanguage
        )).toBe(true);
        expect(detected).toEqual([]);
      } else {
        await vi.waitFor(() => expect(detected).toHaveLength(1));
        expect(detected[0]).toEqual({
          language: 'ja',
          document: sourceDocument,
        });
      }
      controller.dispose();
    };

    await run('en');
    await run();
  });

  it('retries the same image and route after an in-flight probe cancellation', async () => {
    let emitChange: ((change: SourceImageChange) => void) | undefined;
    const detected: Array<readonly [string, string]> = [];
    const timers = controlledProbeTimers();
    const pixels = autoProbePixels(descriptor, '87'.repeat(32));
    const recognize = vi.fn()
      .mockImplementationOnce(() =>
        new Promise<ImageRecognitionResult>(() => undefined),
      )
      .mockResolvedValue(autoProbeRecognition('お知らせ', 0.94));
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        emitChange = onChange;
        return { measure: vi.fn(), dispose: vi.fn() };
      },
      createPixelCoordinator: () => ({
        acquire: async () => ({ status: 'ready', pixels }),
      }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize,
        clear: vi.fn(),
      }) as unknown as ImageRecognitionCoordinator,
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
      onAutoLanguageDetected: (language, evidence) => {
        detected.push([language, evidence]);
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      translationIdle: true,
    });
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(emitChange).toBeTypeOf('function'));
    emitChange?.({ kind: 'upsert', descriptor });
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce());
    expect(controller.cancelCurrent()).toBe(true);
    await vi.waitFor(() => expect(controller.busy).toBe(false));
    emitChange?.({
      kind: 'upsert',
      descriptor: { ...descriptor, observationRevision: 2 },
    });

    await vi.waitFor(() => expect(detected).toEqual([
      ['ja', 'single-strong-script'],
    ]));
    expect(recognize).toHaveBeenCalledTimes(3);
    expect(recognize.mock.calls.slice(0, 2).map((call) =>
      (call[1] as { sourceLanguage: string }).sourceLanguage
    )).toEqual(['ja', 'ja']);
    controller.dispose();
  });

  it('stops a hung probe at its one hard deadline and ignores a stale timer after disposal', async () => {
    let emitChange: ((change: SourceImageChange) => void) | undefined;
    const diagnostics: unknown[] = [];
    const timers = controlledProbeTimers();
    const recognize = vi.fn(() => new Promise<ImageRecognitionResult>(() => undefined));
    const pixels = autoProbePixels(descriptor, '83'.repeat(32));
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        emitChange = onChange;
        return { measure: vi.fn(), dispose: vi.fn() };
      },
      createPixelCoordinator: () => ({
        acquire: async () => ({ status: 'ready', pixels }),
      }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize,
        clear: vi.fn(),
      }) as unknown as ImageRecognitionCoordinator,
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
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      translationIdle: true,
    });
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(emitChange).toBeTypeOf('function'));
    emitChange?.({ kind: 'upsert', descriptor });
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce());
    expect(timers.deadlineCallbacks).toHaveLength(1);

    timers.deadlineCallbacks[0]?.();
    await vi.waitFor(() => expect(diagnostics).toContainEqual(
      expect.objectContaining({
        stage: 'auto-language-probe-inconclusive',
        reason: 'deadline',
      }),
    ));
    await vi.waitFor(() => expect(controller.busy).toBe(false));
    const beforeDispose = diagnostics.length;
    controller.dispose();
    timers.deadlineCallbacks[0]?.();
    await Promise.resolve();
    expect(diagnostics).toHaveLength(beforeDispose);
    expect(timers.clearTimer).toHaveBeenCalled();
  });

  it('reports content-free provider and route failures before an inconclusive probe', async () => {
    let emitChange: ((change: SourceImageChange) => void) | undefined;
    const diagnostics: unknown[] = [];
    const timers = controlledProbeTimers();
    const pixels = autoProbePixels(descriptor, '84'.repeat(32));
    const recognize = vi.fn(async (_pixels: unknown, route: {
      sourceLanguage: string;
    }): Promise<ImageRecognitionResult> => route.sourceLanguage === 'ja'
      ? { status: 'failed', code: 'provider-unavailable' }
      : route.sourceLanguage === 'en'
        ? { status: 'failed', code: 'unsupported-language' }
        : autoProbeRecognition());
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        emitChange = onChange;
        return { measure: vi.fn(), dispose: vi.fn() };
      },
      createPixelCoordinator: () => ({
        acquire: async () => ({ status: 'ready', pixels }),
      }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize,
        clear: vi.fn(),
      }) as unknown as ImageRecognitionCoordinator,
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
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      translationIdle: true,
    });
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(emitChange).toBeTypeOf('function'));
    emitChange?.({ kind: 'upsert', descriptor });
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(6));
    const failures = diagnostics.filter((diagnostic) =>
      typeof diagnostic === 'object' && diagnostic !== null &&
      'stage' in diagnostic && diagnostic.stage === 'recognition-failed'
    );
    expect(failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'provider-unavailable' }),
      expect.objectContaining({ code: 'unsupported-language' }),
    ]));
    timers.deadlineCallbacks[0]?.();
    await vi.waitFor(() => expect(diagnostics).toContainEqual(
      expect.objectContaining({
        stage: 'auto-language-probe-inconclusive',
        reason: 'deadline',
      }),
    ));
    expect(JSON.stringify([...failures, diagnostics.at(-1)])).not.toMatch(
      /(?:transcript|pixelHash|nodeId|documentId|https?:)/iu,
    );
    controller.dispose();
  });

  it('preserves probe votes and its single deadline across the same-document reconnect', async () => {
    const secondDescriptor = { ...descriptor, nodeId: 14 };
    const revisedFirstDescriptor = {
      ...descriptor,
      contentRevision: 2,
      observationRevision: 2,
    };
    const firstPixels = autoProbePixels(descriptor, '85'.repeat(32));
    const revisedFirstPixels = autoProbePixels(
      revisedFirstDescriptor,
      '84'.repeat(32),
    );
    const secondPixels = autoProbePixels(secondDescriptor, '86'.repeat(32));
    const sourceChanges: Array<(change: SourceImageChange) => void> = [];
    const unavailable: Array<(error: ImageSourceUnavailableError) => void> = [];
    const detected: Array<readonly [string, string]> = [];
    const timers = controlledProbeTimers();
    const openSource = vi.fn(async (_request, onChange) => {
      sourceChanges.push(onChange);
      return {
        unavailable: new Promise<ImageSourceUnavailableError>((resolve) => {
          unavailable.push(resolve);
        }),
        measure: vi.fn(),
        dispose: vi.fn(),
      };
    });
    const recognize = vi.fn(async (
      _pixels: typeof firstPixels,
      route: { sourceLanguage: string },
    ) => route.sourceLanguage === 'ja'
      ? autoProbeRecognition('お知らせ', 0.89)
      : autoProbeRecognition());
    const controller = new ImageTranslationController({
      openSource,
      createPixelCoordinator: () => ({
        acquire: async (current: SourceImageDescriptor) => ({
          status: 'ready',
          pixels: current.nodeId === descriptor.nodeId
            ? current.contentRevision === descriptor.contentRevision
              ? firstPixels
              : revisedFirstPixels
            : secondPixels,
        }),
      }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize,
        clear: vi.fn(),
      }) as unknown as ImageRecognitionCoordinator,
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
      onAutoLanguageDetected: (language, evidence) => {
        detected.push([language, evidence]);
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      translationIdle: true,
    });
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(sourceChanges).toHaveLength(1));
    sourceChanges[0]?.({ kind: 'upsert', descriptor });
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(6));
    expect(timers.deadlineCallbacks).toHaveLength(1);

    unavailable[0]?.(new ImageSourceUnavailableError('same document reconnect'));
    await vi.waitFor(() => expect(openSource).toHaveBeenCalledTimes(2));
    sourceChanges[1]?.({ kind: 'upsert', descriptor: revisedFirstDescriptor });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // New pixels from the same source node remain the original sample. Its
    // six persisted routes neither create a second vote nor a seventh route.
    expect(recognize).toHaveBeenCalledTimes(6);
    expect(detected).toEqual([]);

    sourceChanges[1]?.({ kind: 'upsert', descriptor: secondDescriptor });
    await vi.waitFor(() => expect(detected).toEqual([
      ['ja', 'distinct-images'],
    ]));
    expect(timers.deadlineCallbacks).toHaveLength(1);
    controller.dispose();
  });

  it('keeps source-language probe evidence when only the target language changes', async () => {
    const secondDescriptor = { ...descriptor, nodeId: 15 };
    const firstPixels = autoProbePixels(descriptor, '88'.repeat(32));
    const secondPixels = autoProbePixels(secondDescriptor, '89'.repeat(32));
    let emitChange: ((change: SourceImageChange) => void) | undefined;
    const detected: Array<readonly [string, string]> = [];
    const timers = controlledProbeTimers();
    const recognize = vi.fn(async (
      _pixels: typeof firstPixels,
      route: { sourceLanguage: string },
    ) => route.sourceLanguage === 'ja'
      ? autoProbeRecognition('お知らせ', 0.89)
      : autoProbeRecognition());
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        emitChange = onChange;
        return { measure: vi.fn(), dispose: vi.fn() };
      },
      createPixelCoordinator: () => ({
        acquire: async (current: SourceImageDescriptor) => ({
          status: 'ready',
          pixels: current.nodeId === descriptor.nodeId
            ? firstPixels
            : secondPixels,
        }),
      }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize,
        clear: vi.fn(),
      }) as unknown as ImageRecognitionCoordinator,
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
      onAutoLanguageDetected: (language, evidence) => {
        detected.push([language, evidence]);
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      projector: testProjectorEnvironment(),
    });
    const configuration = {
      enabled: true,
      scanPolicy: 'visible-only' as const,
      skipSmallImages: false,
      providerOrder: ['tesseract'] as const,
      sourceLanguage: 'auto' as const,
      targetLanguage: 'en' as const,
      translationIdle: true,
    };
    controller.configure(configuration);
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(emitChange).toBeTypeOf('function'));
    emitChange?.({ kind: 'upsert', descriptor });
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(6));
    expect(timers.deadlineCallbacks).toHaveLength(1);

    controller.configure({ ...configuration, targetLanguage: 'fr' });
    emitChange?.({ kind: 'upsert', descriptor: secondDescriptor });
    await vi.waitFor(() => expect(detected).toEqual([
      ['ja', 'distinct-images'],
    ]));
    expect(timers.deadlineCallbacks).toHaveLength(1);
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

function autoProbePixels(
  sourceDescriptor: SourceImageDescriptor,
  pixelHash: string,
) {
  return {
    descriptor: sourceDescriptor,
    pixelHash,
    encoded: new Blob([new Uint8Array([1])], { type: 'image/png' }),
    bitmapWidth: sourceDescriptor.renderedWidth,
    bitmapHeight: sourceDescriptor.renderedHeight,
    cropOffsetXCss: 0,
    cropOffsetYCss: 0,
    cropWidthCss: sourceDescriptor.renderedWidth,
    cropHeightCss: sourceDescriptor.renderedHeight,
    renderedWidthCss: sourceDescriptor.renderedWidth,
    renderedHeightCss: sourceDescriptor.renderedHeight,
  };
}

function autoProbeRecognition(
  transcript = '',
  confidence?: number,
): ImageRecognitionResult {
  return {
    status: 'complete',
    cacheHit: false,
    result: {
      providerId: 'tesseract',
      bitmapWidth: 200,
      bitmapHeight: 100,
      transcript,
      ...(confidence === undefined ? {} : { transcriptConfidence: confidence }),
      regions: transcript
        ? [{
            text: transcript,
            ...(confidence === undefined ? {} : { confidence }),
            boundingBox: { x: 20, y: 25, width: 100, height: 30 },
          }]
        : [],
    },
  };
}

function controlledProbeTimers() {
  const deadlineCallbacks: (() => void)[] = [];
  const clearTimer = vi.fn();
  let nextHandle = 0;
  const setTimer = (
    callback: () => void,
    milliseconds?: number,
  ): ReturnType<typeof setTimeout> => {
    nextHandle += 1;
    if (milliseconds === 1_000) queueMicrotask(callback);
    else deadlineCallbacks.push(callback);
    return nextHandle as unknown as ReturnType<typeof setTimeout>;
  };
  return { setTimer, clearTimer, deadlineCallbacks };
}
