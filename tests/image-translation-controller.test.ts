import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

import {
  ImageRecognitionCoordinator,
  type ImageRecognitionContinuation,
  type ImageRecognitionResult,
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
import {
  readOffscreenOcrCommand,
  type OffscreenOcrJob,
} from '../lib/ocr/offscreen-protocol';
import {
  OCR_NATIVE_PREPROCESSING_VERSION,
} from '../lib/ocr/preprocessing-profile';
import type {
  TransientImageInputStore,
} from '../lib/ocr/transient-image-store';
import type { ReplicaCaptureRequest } from '../lib/replica/contracts';
import type { ReplicaImageAnchor } from '../lib/replica/rrweb-shadow-engine';
import { TranslationMemory } from '../lib/translation/translation-memory';

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
      scanPolicy: 'visible-only' as const,
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      translationIdle: true,
      resetEpoch: 0,
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
      resetEpoch: 0,
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
      resetEpoch: 0,
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
      {
        accessibilityTextEnabled: false,
        controlImages: false,
        policyFingerprint: 'read-v1-000000',
      },
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
      resetEpoch: 0,
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
      resetEpoch: 0,
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

  it('translates accessibility text before OCR without acquiring pixels', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const tinyDescriptor = {
      ...descriptor,
      renderedWidth: 24,
      renderedHeight: 24,
    };
    image.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 24, height: 24,
      right: 24, bottom: 24, x: 0, y: 0, toJSON: () => ({}),
    });
    const acquire = vi.fn();
    const recognize = vi.fn();
    const memory = new TranslationMemory();
    const readAccessibilityText = vi.fn(async () => ({
      document: sourceDocument,
      nodeId: tinyDescriptor.nodeId,
      contentRevision: tinyDescriptor.contentRevision,
      observationRevision: tinyDescriptor.observationRevision,
      text: 'お知らせ',
      source: 'alt' as const,
      nearestElementLanguage: 'ja' as const,
    }));
    const diagnostics: unknown[] = [];
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({
          kind: 'upsert',
          descriptor: tinyDescriptor,
        }));
        return {
          measure: vi.fn(),
          readAccessibilityText,
          dispose: vi.fn(),
        };
      },
      createPixelCoordinator: () => ({ acquire }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize,
        clear: vi.fn(),
        advanceResetEpoch: vi.fn(() => true),
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
      translationMemory: memory,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      projector: {
        scheduleFrame: (callback) => { callback(); return 1; },
        cancelFrame: () => undefined,
        createResizeObserver: () => undefined,
      },
    });
    const configuration = {
      enabled: true,
      scanPolicy: 'visible-only' as const,
      skipSmallImages: true,
      providerOrder: ['tesseract'] as const,
      methodOrder: ['accessibility-text', 'tesseract'] as const,
      disabledMethodIds: [] as const,
      policyFingerprint: 'read-v1-111000',
      controlImages: true,
      sourceLanguage: 'auto' as const,
      targetLanguage: 'en' as const,
      translationIdle: true,
      resetEpoch: 0,
    };
    controller.configure(configuration);
    controller.activateReplica(request, 3, 1);

    await vi.waitFor(() => expect(diagnostics).toContain(
      'accessibility-text-complete',
    ));
    expect(readAccessibilityText).toHaveBeenCalledWith(
      tinyDescriptor,
      'read-v1-111000',
      true,
      expect.any(AbortSignal),
    );
    expect(acquire).not.toHaveBeenCalled();
    expect(recognize).not.toHaveBeenCalled();
    const overlay = document.querySelector<HTMLElement>(
      '[data-simul-image-method="accessibility-text"]',
    );
    expect(overlay?.textContent).toBe('News');
    expect(memory.size).toBeGreaterThan(0);
    expect(JSON.stringify(diagnostics)).not.toContain('お知らせ');

    controller.configure({
      ...configuration,
      disabledMethodIds: ['accessibility-text'],
    });
    expect(memory.size).toBe(0);
    expect(document.querySelector('[data-simul-image-method]')).toBeNull();
    controller.dispose();
  });

  it('promotes accessibility language only after two distinct image labels agree', async () => {
    const { document } = parseHTML(
      '<html><body><img id="first"><img id="second"></body></html>',
    );
    const firstImage = document.querySelector('#first') as unknown as
      HTMLImageElement;
    const secondImage = document.querySelector('#second') as unknown as
      HTMLImageElement;
    const secondDescriptor = { ...descriptor, nodeId: 13 };
    let emitChange: ((change: SourceImageChange) => void) | undefined;
    const detected: Array<readonly [string, string, string]> = [];
    const diagnostics: unknown[] = [];
    const timers = controlledProbeTimers();
    const readAccessibilityText = vi.fn(async (
      current: SourceImageDescriptor,
    ) => ({
      document: sourceDocument,
      nodeId: current.nodeId,
      contentRevision: current.contentRevision,
      observationRevision: current.observationRevision,
      text: current.nodeId === descriptor.nodeId ? 'お知らせ' : '法人番号',
      source: 'alt' as const,
    }));
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        emitChange = onChange;
        return {
          measure: vi.fn(),
          readAccessibilityText,
          dispose: vi.fn(),
        };
      },
      createPixelCoordinator: () => ({ acquire: vi.fn() }) as unknown as
        PixelAcquisitionCoordinator,
      createRecognitionCoordinator: vi.fn(),
      resolveAnchor: (_identity, nodeId) => ({
        document: sourceDocument,
        replayLease: 1,
        image: nodeId === descriptor.nodeId ? firstImage : secondImage,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({
          translate: async () => 'News',
          destroy: vi.fn(),
        }),
      },
      detectLanguage: async () => ({
        isReliable: true,
        languages: [{ language: 'ja', percentage: 96 }],
      }),
      onAutoLanguageDetected: (language, evidence, _document, origin) => {
        detected.push([language, evidence, origin]);
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
      providerOrder: [],
      methodOrder: ['accessibility-text'],
      disabledMethodIds: [],
      policyFingerprint: 'read-v1-100000',
      controlImages: true,
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(emitChange).toBeTypeOf('function'));

    emitChange?.({ kind: 'upsert', descriptor });
    await vi.waitFor(() => expect(readAccessibilityText).toHaveBeenCalledTimes(1));
    expect(detected).toEqual([]);

    emitChange?.({ kind: 'upsert', descriptor: secondDescriptor });
    await vi.waitFor(() => expect(detected).toEqual([
      ['ja', 'distinct-images', 'accessibility-text'],
    ]));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      stage: 'auto-language-probe-resolved',
      language: 'ja',
      evidence: 'distinct-images',
      attempts: 0,
      samples: 2,
    }));
    controller.dispose();
  });

  it('executes OCR A, accessibility text, then OCR B in exact order', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const events: string[] = [];
    const pixels = autoProbePixels(descriptor, '19'.repeat(32));
    const acquire = vi.fn(async () => ({ status: 'ready' as const, pixels }));
    const readAccessibilityText = vi.fn(async () => {
      events.push('accessibility-text');
      return undefined;
    });
    const recognize = vi.fn(async (
      _pixels: unknown,
      route: { readonly providerOrder?: readonly string[] },
    ): Promise<ImageRecognitionResult> => {
      const provider = route.providerOrder?.[0] ?? 'none';
      events.push(`ocr:${provider}`);
      if (provider === 'chrome-text-detector') {
        return { status: 'failed', code: 'provider-unavailable' };
      }
      return {
        status: 'complete',
        cacheHit: false,
        result: {
          providerId: 'tesseract',
          bitmapWidth: 200,
          bitmapHeight: 100,
          transcript: 'News',
          regions: [{
            text: 'News',
            boundingBox: { x: 10, y: 10, width: 100, height: 30 },
          }],
        },
      };
    });
    const diagnostics: unknown[] = [];
    const clearRecognition = vi.fn();
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return {
          measure: vi.fn(),
          readAccessibilityText,
          dispose: vi.fn(),
        };
      },
      createPixelCoordinator: () => ({ acquire }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize,
        clear: clearRecognition,
        advanceResetEpoch: vi.fn(() => true),
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
          translate: async () => 'ニュース',
          destroy: vi.fn(),
        }),
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['chrome-text-detector', 'tesseract'],
      methodOrder: [
        'chrome-text-detector',
        'accessibility-text',
        'tesseract',
      ],
      disabledMethodIds: [],
      policyFingerprint: 'read-v1-100000',
      controlImages: false,
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);

    await vi.waitFor(() => expect(diagnostics).toContain('projected'));
    expect(events).toEqual([
      'ocr:chrome-text-detector',
      'accessibility-text',
      'ocr:tesseract',
    ]);
    expect(acquire).toHaveBeenCalledOnce();
    controller.releaseReplica();
    expect(clearRecognition).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it('groups TextDetector with Tesseract for confidence-free corroboration', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const pixels = {
      ...autoProbePixels(descriptor, '1c'.repeat(32)),
      preprocessingVersion: OCR_NATIVE_PREPROCESSING_VERSION,
    };
    const records = new Map<string, Blob>();
    let inputSequence = 0;
    const store: TransientImageInputStore = {
      put: async (blob, id = `controller-input-${++inputSequence}`) => {
        records.set(id, blob);
        return id;
      },
      get: async (id) => records.get(id),
      remove: async (id) => {
        records.delete(id);
      },
      clearExpired: async () => undefined,
    };
    const calls: OffscreenOcrJob[] = [];
    const sendMessage = vi.fn(async (message: unknown) => {
      const record = message as Record<string, unknown>;
      if (record.kind === 'simul:ocr-v1:ensure-host') {
        return { kind: 'simul:ocr-v1:host-ready', version: 1, ready: true };
      }
      const command = readOffscreenOcrCommand(message);
      if (command?.kind !== 'simul:ocr-v1:run') return undefined;
      const ocrJob = command.job;
      calls.push(ocrJob);
      const confidence = ocrJob.providerId === 'chrome-text-detector'
        ? undefined
        : 0.4;
      return {
        kind: 'simul:ocr-v1:result',
        version: 1,
        jobId: ocrJob.jobId,
        clientId: ocrJob.clientId,
        attempt: ocrJob.attempt,
        document: ocrJob.document,
        nodeId: ocrJob.nodeId,
        contentRevision: ocrJob.contentRevision,
        observationRevision: ocrJob.observationRevision,
        pixelHash: ocrJob.pixelHash,
        result: {
          providerId: ocrJob.providerId,
          bitmapWidth: ocrJob.bitmapWidth,
          bitmapHeight: ocrJob.bitmapHeight,
          transcript: 'News',
          regions: [{
            text: 'News',
            ...(confidence === undefined ? {} : { confidence }),
            boundingBox: { x: 12, y: 14, width: 90, height: 24 },
          }],
        },
      };
    });
    const recognizer = new ImageRecognitionCoordinator({
      store,
      resetEpoch: 0,
      sendMessage,
      clientId: 'controller-grouped-corroboration',
    });
    const diagnostics: unknown[] = [];
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return { measure: vi.fn(), dispose: vi.fn() };
      },
      createPixelCoordinator: () => ({
        acquire: vi.fn(async () => ({ status: 'ready' as const, pixels })),
      }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => recognizer,
      resolveAnchor: () => ({
        document: sourceDocument,
        replayLease: 1,
        image,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({
          translate: async () => 'ニュース',
          destroy: vi.fn(),
        }),
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['chrome-text-detector', 'tesseract'],
      methodOrder: ['chrome-text-detector', 'tesseract'],
      disabledMethodIds: [],
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      ocrMinimumConfidence: 0.65,
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);

    await vi.waitFor(() => expect(diagnostics).toContain('projected'));
    expect(calls.map(({ providerId }) => providerId)).toEqual([
      'chrome-text-detector',
      'tesseract',
    ]);
    expect(calls[1]?.hints).toEqual([{
      text: '',
      boundingBox: { x: 12, y: 14, width: 90, height: 24 },
    }]);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      stage: 'recognition-quality',
      corroboratedRegions: 1,
    }));
    expect(document.querySelector(
      '[data-simul-image-method="tesseract"]',
    )?.textContent).toBe('ニュース');
    controller.dispose();
  });

  it('falls through thrown OCR and accessibility method failures without exposing errors', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const events: string[] = [];
    const pixels = autoProbePixels(descriptor, '1a'.repeat(32));
    const recognize = vi.fn(async (
      _pixels: unknown,
      route: { readonly providerOrder?: readonly string[] },
    ): Promise<ImageRecognitionResult> => {
      const provider = route.providerOrder?.[0] ?? 'none';
      events.push(`ocr:${provider}`);
      if (provider === 'chrome-text-detector') {
        throw new Error('private provider failure detail');
      }
      return {
        status: 'complete',
        cacheHit: false,
        result: {
          providerId: 'tesseract',
          bitmapWidth: 200,
          bitmapHeight: 100,
          transcript: 'News',
          regions: [{
            text: 'News',
            boundingBox: { x: 10, y: 10, width: 100, height: 30 },
          }],
        },
      };
    });
    const readAccessibilityText = vi.fn(async () => {
      events.push('accessibility-text');
      throw new Error('private accessibility failure detail');
    });
    const diagnostics: unknown[] = [];
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return {
          measure: vi.fn(),
          readAccessibilityText,
          dispose: vi.fn(),
        };
      },
      createPixelCoordinator: () => ({
        acquire: vi.fn(async () => ({ status: 'ready' as const, pixels })),
      }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize,
        clear: vi.fn(),
        advanceResetEpoch: vi.fn(() => true),
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
          translate: async () => 'ニュース',
          destroy: vi.fn(),
        }),
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['chrome-text-detector', 'tesseract'],
      methodOrder: [
        'chrome-text-detector',
        'accessibility-text',
        'tesseract',
      ],
      disabledMethodIds: [],
      policyFingerprint: 'read-v1-100000',
      controlImages: false,
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);

    await vi.waitFor(() => expect(diagnostics).toContain('projected'));
    expect(events).toEqual([
      'ocr:chrome-text-detector',
      'accessibility-text',
      'ocr:tesseract',
    ]);
    expect(diagnostics).toContain('recognition-failed');
    expect(diagnostics).toContain('accessibility-text-blocked');
    expect(JSON.stringify(diagnostics)).not.toContain('private');
    expect(document.querySelector(
      '[data-simul-image-method="tesseract"]',
    )?.textContent).toBe('ニュース');
    controller.dispose();
  });

  it('tries every adjacent OCR provider after translation throws or is empty', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const routes: string[][] = [];
    const providerAttempts: string[] = [];
    const pixels = autoProbePixels(descriptor, '1b'.repeat(32));
    const afterChrome = Object.freeze({
      kind: 'simul:image-recognition-continuation' as const,
    }) satisfies ImageRecognitionContinuation;
    const afterPaddle = Object.freeze({
      kind: 'simul:image-recognition-continuation' as const,
    }) satisfies ImageRecognitionContinuation;
    const candidate = (
      provider: 'chrome-text-detector' | 'paddleocr-wasm' | 'tesseract',
      continuation?: ImageRecognitionContinuation,
    ): ImageRecognitionResult => ({
      status: 'complete',
      cacheHit: false,
      ...(continuation ? { continuation } : {}),
      result: {
        providerId: provider,
        bitmapWidth: 200,
        bitmapHeight: 100,
        transcript: 'News',
        regions: [{
          text: 'News',
          boundingBox: { x: 10, y: 10, width: 100, height: 30 },
        }],
      },
    });
    const recognize = vi.fn(async (
      _pixels: unknown,
      route: { readonly providerOrder?: readonly string[] },
    ): Promise<ImageRecognitionResult> => {
      routes.push([...(route.providerOrder ?? [])]);
      providerAttempts.push('chrome-text-detector');
      return candidate('chrome-text-detector', afterChrome);
    });
    const continueRecognition = vi.fn(async (
      _pixels: unknown,
      continuation: ImageRecognitionContinuation,
    ): Promise<ImageRecognitionResult> => {
      if (continuation === afterChrome) {
        providerAttempts.push('paddleocr-wasm');
        return candidate('paddleocr-wasm', afterPaddle);
      }
      providerAttempts.push('tesseract');
      return candidate('tesseract');
    });
    let translationAttempt = 0;
    const diagnostics: unknown[] = [];
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return { measure: vi.fn(), dispose: vi.fn() };
      },
      createPixelCoordinator: () => ({
        acquire: vi.fn(async () => ({ status: 'ready' as const, pixels })),
      }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize,
        continueRecognition,
        clear: vi.fn(),
        advanceResetEpoch: vi.fn(() => true),
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
          translate: async () => {
            translationAttempt += 1;
            if (translationAttempt === 1) throw new Error('first failed');
            if (translationAttempt === 2) return '';
            return 'ニュース';
          },
          destroy: vi.fn(),
        }),
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: [
        'chrome-text-detector',
        'paddleocr-wasm',
        'tesseract',
      ],
      methodOrder: [
        'chrome-text-detector',
        'paddleocr-wasm',
        'tesseract',
      ],
      disabledMethodIds: [],
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);

    await vi.waitFor(() => expect(diagnostics).toContain('projected'));
    expect(routes).toEqual([[
      'chrome-text-detector',
      'paddleocr-wasm',
      'tesseract',
    ]]);
    expect(providerAttempts).toEqual([
      'chrome-text-detector',
      'paddleocr-wasm',
      'tesseract',
    ]);
    expect(continueRecognition).toHaveBeenCalledTimes(2);
    expect(translationAttempt).toBe(3);
    expect(document.querySelector(
      '[data-simul-image-method="tesseract"]',
    )?.textContent).toBe('ニュース');
    controller.dispose();
  });

  it('continues to accessibility text after pixel permission is unavailable', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const recognize = vi.fn();
    const readAccessibilityText = vi.fn(async () => ({
      document: sourceDocument,
      nodeId: descriptor.nodeId,
      contentRevision: descriptor.contentRevision,
      observationRevision: descriptor.observationRevision,
      text: 'お知らせ',
      source: 'alt' as const,
      nearestElementLanguage: 'ja' as const,
    }));
    const diagnostics: unknown[] = [];
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return {
          measure: vi.fn(),
          readAccessibilityText,
          dispose: vi.fn(),
        };
      },
      createPixelCoordinator: () => ({
        acquire: vi.fn(async () => ({
          status: 'deferred' as const,
          reason: 'permission' as const,
        })),
      }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize,
        clear: vi.fn(),
        advanceResetEpoch: vi.fn(() => true),
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
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      methodOrder: ['tesseract', 'accessibility-text'],
      disabledMethodIds: [],
      policyFingerprint: 'read-v1-100000',
      controlImages: false,
      sourceLanguage: 'ja',
      targetLanguage: 'en',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);

    await vi.waitFor(() => expect(diagnostics).toContain(
      'accessibility-text-complete',
    ));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      stage: 'capture-deferred',
      reason: 'permission',
    }));
    expect(readAccessibilityText).toHaveBeenCalledOnce();
    expect(recognize).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('reopens the policy-bound source after live method and control changes', async () => {
    const disposals: ReturnType<typeof vi.fn>[] = [];
    const openSource = vi.fn(async (
      ..._args: Parameters<ImageTranslationControllerEnvironment['openSource']>
    ) => {
      const dispose = vi.fn();
      disposals.push(dispose);
      return { measure: vi.fn(), dispose };
    });
    const controller = new ImageTranslationController({
      openSource,
      createPixelCoordinator: () => ({ acquire: vi.fn() }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: vi.fn(),
      resolveAnchor: () => undefined,
      translationProvider: {
        availability: async () => 'available',
        createSession: vi.fn(),
      },
      projector: testProjectorEnvironment(),
    });
    const base = {
      enabled: true,
      scanPolicy: 'visible-only' as const,
      skipSmallImages: false,
      providerOrder: ['tesseract'] as const,
      methodOrder: ['tesseract', 'accessibility-text'] as const,
      disabledMethodIds: ['accessibility-text'] as const,
      policyFingerprint: 'read-v1-100000',
      controlImages: false,
      sourceLanguage: 'en' as const,
      targetLanguage: 'ja' as const,
      translationIdle: true,
      resetEpoch: 0,
    };
    controller.configure(base);
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(openSource).toHaveBeenCalledTimes(1));

    controller.configure({
      ...base,
      methodOrder: ['accessibility-text', 'tesseract'],
    });
    await vi.waitFor(() => expect(openSource).toHaveBeenCalledTimes(2));
    controller.configure({
      ...base,
      methodOrder: ['accessibility-text', 'tesseract'],
      disabledMethodIds: [],
    });
    await vi.waitFor(() => expect(openSource).toHaveBeenCalledTimes(3));
    controller.configure({
      ...base,
      methodOrder: ['accessibility-text', 'tesseract'],
      disabledMethodIds: [],
      policyFingerprint: 'read-v1-110000',
      controlImages: true,
    });
    await vi.waitFor(() => expect(openSource).toHaveBeenCalledTimes(4));

    expect(disposals.slice(0, 3).every((dispose) =>
      dispose.mock.calls.length === 1
    )).toBe(true);
    expect(openSource.mock.calls.at(-1)?.[3]).toEqual({
      policyFingerprint: 'read-v1-110000',
      controlImages: true,
      accessibilityTextEnabled: true,
    });
    controller.dispose();
  });

  it('purges image-derived caches and projections when a method or the feature is disabled', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const memory = new TranslationMemory();
    const sourceCallbacks: ((change: SourceImageChange) => void)[] = [];
    const openSource = vi.fn(async (
      _request: ReplicaCaptureRequest,
      onChange: (change: SourceImageChange) => void,
    ) => {
      sourceCallbacks.push(onChange);
      return { measure: vi.fn(), dispose: vi.fn() };
    });
    const pixels = {
      ...autoProbePixels(descriptor, '5f'.repeat(32)),
      nearestElementLanguage: 'en' as const,
    };
    const clearRecognition = vi.fn();
    const recognize = vi.fn(async () => autoProbeRecognition('Private notice', 0.95));
    const createSession = vi.fn(async () => ({
      translate: async () => '非公開のお知らせ',
      destroy: vi.fn(),
    }));
    const controller = new ImageTranslationController({
      openSource,
      createPixelCoordinator: () => ({
        acquire: async () => ({ status: 'ready', pixels }),
      }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize,
        clear: clearRecognition,
        advanceResetEpoch: vi.fn(() => true),
      }) as unknown as ImageRecognitionCoordinator,
      resolveAnchor: () => ({
        document: sourceDocument,
        replayLease: 1,
        image,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession,
      },
      translationMemory: memory,
      projector: testProjectorEnvironment(),
    });
    const configuration = {
      enabled: true,
      scanPolicy: 'visible-only' as const,
      skipSmallImages: false,
      providerOrder: ['tesseract'] as const,
      methodOrder: ['tesseract'] as const,
      disabledMethodIds: [] as const,
      sourceLanguage: 'en' as const,
      targetLanguage: 'ja' as const,
      translationIdle: true,
      resetEpoch: 0,
    };
    controller.configure(configuration);
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(sourceCallbacks).toHaveLength(1));
    sourceCallbacks[0]?.({ kind: 'upsert', descriptor });
    await vi.waitFor(() => expect(document.querySelector(
      '[data-simul-image-method="tesseract"]',
    )).not.toBeNull());
    expect(memory.size).toBeGreaterThan(0);

    controller.configure({
      ...configuration,
      disabledMethodIds: ['tesseract'],
    });
    expect(clearRecognition).toHaveBeenCalledOnce();
    expect(memory.size).toBe(0);
    expect(document.querySelector('[data-simul-image-method]')).toBeNull();

    controller.configure(configuration);
    await vi.waitFor(() => expect(sourceCallbacks).toHaveLength(2));
    sourceCallbacks[1]?.({ kind: 'upsert', descriptor });
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(memory.size).toBeGreaterThan(0));
    expect(createSession).toHaveBeenCalledTimes(2);

    controller.configure({ ...configuration, enabled: false });
    expect(clearRecognition).toHaveBeenCalledTimes(2);
    expect(memory.size).toBe(0);
    expect(document.querySelector('[data-simul-image-method]')).toBeNull();
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
        advanceResetEpoch: vi.fn(() => true),
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
      resetEpoch: 0,
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
      resetEpoch: 0,
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
        advanceResetEpoch: vi.fn(() => true),
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
      resetEpoch: 0,
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
        advanceResetEpoch: vi.fn(() => true),
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
      resetEpoch: 0,
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
        advanceResetEpoch: vi.fn(() => true),
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
      resetEpoch: 0,
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
      resetEpoch: 0,
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
      resetEpoch: 0,
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
      resetEpoch: 0,
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
        advanceResetEpoch: vi.fn(() => true),
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
      resetEpoch: 0,
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
      resetEpoch: 0,
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

  it('continues accepted but inconclusive Auto evidence through the OCR group', async () => {
    const pixels = autoProbePixels(descriptor, '6a'.repeat(32));
    const continuation = Object.freeze({
      kind: 'simul:image-recognition-continuation' as const,
    });
    const recognize = vi.fn(async (
      _pixels: unknown,
      route: { minimumConfidence?: number },
    ): Promise<ImageRecognitionResult> => route.minimumConfidence === 0.8
      ? {
          status: 'complete',
          cacheHit: false,
          continuation,
          result: {
            providerId: 'chrome-text-detector',
            bitmapWidth: 200,
            bitmapHeight: 100,
            transcript: 'Public notice',
            transcriptConfidence: 0.95,
            regions: [{
              text: 'Public notice',
              confidence: 0.95,
              boundingBox: { x: 20, y: 25, width: 100, height: 30 },
            }],
          },
        }
      : autoProbeRecognition('お知らせ', 0.94));
    const continueRecognition = vi.fn(async () =>
      autoProbeRecognition('お知らせ', 0.94)
    );
    const detected: string[] = [];
    const timers = controlledProbeTimers();
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
        continueRecognition,
        clear: vi.fn(),
        advanceResetEpoch: vi.fn(() => true),
      }) as unknown as ImageRecognitionCoordinator,
      resolveAnchor: () => ({
        document: sourceDocument,
        replayLease: 1,
        image: { isConnected: true } as HTMLImageElement,
        iframe: {} as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({
          translate: async () => 'News',
          destroy: vi.fn(),
        }),
      },
      detectLanguage: async () => ({
        isReliable: true,
        languages: [{ language: 'en', percentage: 99 }],
      }),
      onAutoLanguageDetected: (language) => detected.push(language),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['chrome-text-detector', 'tesseract'],
      methodOrder: ['chrome-text-detector', 'tesseract'],
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);

    await vi.waitFor(() => expect(detected).toEqual(['ja']));
    expect(continueRecognition).toHaveBeenCalledOnce();
    expect(continueRecognition).toHaveBeenCalledWith(
      pixels,
      continuation,
      expect.any(AbortSignal),
    );
    controller.dispose();
  });

  it('resumes the same bounded Auto routes after an empty semantic separator', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const pixels = autoProbePixels(descriptor, '6b'.repeat(32));
    const events: string[] = [];
    const diagnostics: unknown[] = [];
    const detected: string[] = [];
    const timers = controlledProbeTimers();
    const recognize = vi.fn(async (
      _pixels: unknown,
      route: {
        providerOrder?: readonly string[];
        sourceLanguage: string;
      },
    ): Promise<ImageRecognitionResult> => {
      const provider = route.providerOrder?.[0] ?? 'none';
      events.push(`${provider}:${route.sourceLanguage}`);
      return provider === 'tesseract' && route.sourceLanguage === 'ja'
        ? autoProbeRecognition('お知らせ', 0.94)
        : autoProbeRecognition();
    });
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return {
          measure: vi.fn(),
          readAccessibilityText: vi.fn(async () => {
            events.push('accessibility-text');
            return undefined;
          }),
          dispose: vi.fn(),
        };
      },
      createPixelCoordinator: () => ({
        acquire: async () => ({ status: 'ready', pixels }),
      }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize,
        clear: vi.fn(),
        advanceResetEpoch: vi.fn(() => true),
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
      onAutoLanguageDetected: (language) => detected.push(language),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['chrome-text-detector', 'tesseract'],
      methodOrder: [
        'chrome-text-detector',
        'accessibility-text',
        'tesseract',
      ],
      disabledMethodIds: [],
      policyFingerprint: 'read-v1-100000',
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);

    await vi.waitFor(() => expect(detected).toEqual(['ja']));
    expect(events.slice(0, 8)).toEqual([
      'chrome-text-detector:ja',
      'chrome-text-detector:en',
      'chrome-text-detector:zh',
      'chrome-text-detector:zh-Hant',
      'chrome-text-detector:ko',
      'chrome-text-detector:ru',
      'accessibility-text',
      'tesseract:ja',
    ]);
    expect(diagnostics.filter((diagnostic) =>
      typeof diagnostic === 'object' && diagnostic !== null &&
      'stage' in diagnostic &&
      diagnostic.stage === 'auto-language-probe-attempt'
    )).toHaveLength(6);
    controller.dispose();
  });

  it('requeues active and queued image work when the reset epoch advances', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const pixels = autoProbePixels(descriptor, '6c'.repeat(32));
    const diagnostics: unknown[] = [];
    const advanceResetEpoch = vi.fn(() => true);
    let recognitionAttempt = 0;
    const recognize = vi.fn((
      _pixels: unknown,
      _route: unknown,
      signal?: AbortSignal,
    ): Promise<ImageRecognitionResult> => {
      recognitionAttempt += 1;
      if (recognitionAttempt > 1) {
        return Promise.resolve(autoProbeRecognition('News', 0.94));
      }
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });
    });
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
        advanceResetEpoch,
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
          translate: async () => 'ニュース',
          destroy: vi.fn(),
        }),
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      projector: testProjectorEnvironment(),
    });
    const configuration = {
      enabled: true,
      scanPolicy: 'visible-only' as const,
      skipSmallImages: false,
      providerOrder: ['tesseract'] as const,
      methodOrder: ['tesseract'] as const,
      sourceLanguage: 'en' as const,
      targetLanguage: 'ja' as const,
      translationIdle: true,
      resetEpoch: 0,
    };
    controller.configure(configuration);
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce());

    controller.configure({ ...configuration, resetEpoch: 1 });

    await vi.waitFor(() => expect(diagnostics).toContain('projected'));
    expect(recognize).toHaveBeenCalledTimes(2);
    expect(advanceResetEpoch).toHaveBeenCalledWith(1);
    expect(controller.busy).toBe(false);
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
        advanceResetEpoch: vi.fn(() => true),
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
      resetEpoch: 0,
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
        advanceResetEpoch: vi.fn(() => true),
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
      resetEpoch: 0,
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
          advanceResetEpoch: vi.fn(() => true),
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
        resetEpoch: 0,
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
        advanceResetEpoch: vi.fn(() => true),
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
      resetEpoch: 0,
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
        advanceResetEpoch: vi.fn(() => true),
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
      resetEpoch: 0,
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
        advanceResetEpoch: vi.fn(() => true),
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
      resetEpoch: 0,
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
        advanceResetEpoch: vi.fn(() => true),
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
      resetEpoch: 0,
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
        advanceResetEpoch: vi.fn(() => true),
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
      resetEpoch: 0,
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
    resetEpoch: 0,
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
