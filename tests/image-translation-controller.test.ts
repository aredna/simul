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
import type {
  AcquiredImagePixels,
  PixelAcquisitionCoordinator,
} from '../lib/ocr/pixel-acquisition';
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
import type { ReplicaImageAnchor } from '../lib/replica/contracts';
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
    await vi.waitFor(() => expect(diagnostics).toContain('source-connected'));
    expect(diagnostics).toContainEqual({
      stage: 'source-read-policy',
      controlImagesEnabled: false,
    });
    expect(diagnostics.indexOf('source-connecting')).toBeLessThan(
      diagnostics.findIndex((diagnostic) =>
        typeof diagnostic === 'object' && diagnostic !== null &&
        'stage' in diagnostic && diagnostic.stage === 'source-read-policy'),
    );
    expect(diagnostics.findIndex((diagnostic) =>
      typeof diagnostic === 'object' && diagnostic !== null &&
      'stage' in diagnostic && diagnostic.stage === 'source-read-policy'),
    ).toBeLessThan(diagnostics.indexOf('source-connected'));
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

  it('purges reusable results across every top-page source scope transition', () => {
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
    const purgeCount = () => diagnostics.filter((diagnostic) =>
      typeof diagnostic === 'object' &&
      diagnostic !== null &&
      'stage' in diagnostic &&
      diagnostic.stage === 'image-evidence-cache' &&
      'access' in diagnostic &&
      diagnostic.access === 'purge'
    ).length;

    expect(purgeCount()).toBe(0);
    controller.setTopPageOrigin(undefined);
    expect(purgeCount()).toBe(1);
    controller.setTopPageOrigin(undefined);
    expect(purgeCount()).toBe(2);

    controller.setTopPageOrigin('about:blank');
    expect(purgeCount()).toBe(3);
    controller.setTopPageOrigin('about:blank#same-document');
    expect(purgeCount()).toBe(4);
    controller.setTopPageOrigin('about:srcdoc');
    expect(purgeCount()).toBe(5);

    controller.setTopPageOrigin('file:///tmp/one.html');
    expect(purgeCount()).toBe(6);
    controller.setTopPageOrigin('file:///tmp/one.html#same-document');
    expect(purgeCount()).toBe(7);
    controller.setTopPageOrigin('file:///tmp/two.html');
    expect(purgeCount()).toBe(8);

    controller.setTopPageOrigin('data:text/html,one');
    expect(purgeCount()).toBe(9);
    controller.setTopPageOrigin('data:text/html,two');
    expect(purgeCount()).toBe(10);

    controller.setTopPageOrigin('https://example.test/one');
    expect(purgeCount()).toBe(11);
    controller.setTopPageOrigin('https://example.test/two');
    expect(purgeCount()).toBe(11);
    controller.setTopPageOrigin('https://other.test/next');
    expect(purgeCount()).toBe(12);
    expect(JSON.stringify(diagnostics)).not.toMatch(
      /(?:about:|file:|data:|https?:)/iu,
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
    // A permission refusal settles the image; resume() has nothing to re-queue.
    controller.resume();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(acquire).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it('defers capture while the source tab is inactive and re-queues it on resume', async () => {
    const diagnostics: unknown[] = [];
    const acquire = vi.fn(async () => ({
      status: 'deferred' as const,
      reason: 'inactive' as const,
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
      reason: 'inactive',
      renderedWidth: 200,
      renderedHeight: 100,
    }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    // No retry loop while the tab stays in the background.
    expect(acquire).toHaveBeenCalledOnce();

    // The followed tab is activated again: the deferred image is retried
    // with the same observation instead of staying done for the session.
    controller.resume();
    await vi.waitFor(() => expect(diagnostics).toContainEqual({
      stage: 'capture-deferred',
      ordinal: 2,
      reason: 'inactive',
      renderedWidth: 200,
      renderedHeight: 100,
    }));
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(diagnostics)).not.toMatch(
      /(?:https?:|pixels|hash|nodeId|documentId)/iu,
    );
    controller.dispose();
    controller.resume();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it('defers a transient OCR host failure and re-runs it on resume', async () => {
    const diagnostics: unknown[] = [];
    const pixels = {
      ...autoProbePixels(descriptor, '7a'.repeat(32)),
      nearestElementLanguage: 'en' as const,
    };
    const recognize = vi.fn(async (): Promise<ImageRecognitionResult> => ({
      status: 'failed',
      code: 'host-unavailable',
    }));
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
    const failure = (ordinal: number, code: string) => ({
      stage: 'recognition-failed',
      code,
      ordinal,
      renderedWidth: 200,
      renderedHeight: 100,
      bitmapWidth: 200,
      bitmapHeight: 100,
    });

    await vi.waitFor(() => expect(diagnostics).toContainEqual(
      failure(1, 'host-unavailable'),
    ));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(recognize).toHaveBeenCalledOnce();

    // The offscreen host is back: the image is retried, not marked done.
    controller.resume();
    await vi.waitFor(() => expect(diagnostics).toContainEqual(
      failure(2, 'host-unavailable'),
    ));
    expect(recognize).toHaveBeenCalledTimes(2);

    // Losing the worker mid-job is transient in the same way.
    recognize.mockResolvedValueOnce({ status: 'failed', code: 'worker-lost' });
    controller.resume();
    await vi.waitFor(() => expect(diagnostics).toContainEqual(
      failure(3, 'worker-lost'),
    ));

    // A recognition error is final for this revision and stays settled.
    recognize.mockResolvedValueOnce({
      status: 'failed',
      code: 'recognition-failed',
    });
    controller.resume();
    await vi.waitFor(() => expect(diagnostics).toContainEqual(
      failure(4, 'recognition-failed'),
    ));
    controller.resume();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(recognize).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(diagnostics)).not.toMatch(
      /(?:https?:|pixels|hash|nodeId|documentId)/iu,
    );
    controller.dispose();
  });

  it('re-queues anchor-deferred images when the live replica commits', async () => {
    const diagnostics: unknown[] = [];
    let anchorAvailable = false;
    const acquire = vi.fn(async () => ({
      status: 'deferred' as const,
      reason: 'hidden' as const,
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
      resolveAnchor: () => anchorAvailable
        ? {
            document: sourceDocument,
            replayLease: 1,
            image: { isConnected: true } as HTMLImageElement,
            iframe: {} as HTMLIFrameElement,
          }
        : undefined,
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
    const anchorDeferrals = () =>
      diagnostics.filter((diagnostic) => diagnostic === 'anchor-deferred').length;

    await vi.waitFor(() => expect(anchorDeferrals()).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(acquire).not.toHaveBeenCalled();

    // A same-lease live commit re-checks the anchor; still missing.
    expect(controller.notifyReplicaCommit(sourceDocument, 1)).toBe(true);
    await vi.waitFor(() => expect(anchorDeferrals()).toBe(2));
    expect(acquire).not.toHaveBeenCalled();

    // The commit that adds the replica node lets the job proceed to capture.
    anchorAvailable = true;
    expect(controller.notifyReplicaCommit(sourceDocument, 1)).toBe(true);
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(diagnostics).toContainEqual({
      stage: 'capture-deferred',
      ordinal: 3,
      reason: 'hidden',
      renderedWidth: 200,
      renderedHeight: 100,
    }));

    // An observation deferral (hidden) is not an anchor deferral: further
    // commits leave it alone until resume() or a new observation.
    expect(controller.notifyReplicaCommit(sourceDocument, 1)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(acquire).toHaveBeenCalledOnce();
    controller.resume();
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(2));
    expect(anchorDeferrals()).toBe(2);
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

  it('keeps tiny accessibility images schedulable after a live size-filter change and ignores stale removal', async () => {
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
    let emitChange: ((change: SourceImageChange) => void) | undefined;
    const acquire = vi.fn();
    const recognize = vi.fn();
    const diagnostics: unknown[] = [];
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        emitChange = onChange;
        return {
          measure: vi.fn(),
          readAccessibilityText: async () => ({
            document: sourceDocument,
            nodeId: tinyDescriptor.nodeId,
            contentRevision: tinyDescriptor.contentRevision,
            observationRevision: tinyDescriptor.observationRevision,
            text: 'お知らせ',
            source: 'alt' as const,
            nearestElementLanguage: 'ja' as const,
          }),
          dispose: vi.fn(),
        };
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
    const configuration = {
      enabled: true,
      scanPolicy: 'visible-only' as const,
      skipSmallImages: false,
      providerOrder: ['tesseract'] as const,
      methodOrder: ['accessibility-text', 'tesseract'] as const,
      disabledMethodIds: [] as const,
      sourceLanguage: 'ja' as const,
      targetLanguage: 'en' as const,
      translationIdle: true,
      resetEpoch: 0,
    };
    controller.configure(configuration);
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(emitChange).toBeTypeOf('function'));

    controller.configure({ ...configuration, skipSmallImages: true });
    emitChange?.({ kind: 'upsert', descriptor: tinyDescriptor });
    await vi.waitFor(() => expect(diagnostics).toContain(
      'accessibility-text-complete',
    ));
    expect(acquire).not.toHaveBeenCalled();
    expect(recognize).not.toHaveBeenCalled();

    emitChange?.({
      kind: 'remove',
      document: sourceDocument,
      nodeId: tinyDescriptor.nodeId,
      contentRevision: tinyDescriptor.contentRevision,
      observationRevision: tinyDescriptor.observationRevision,
    });
    await Promise.resolve();
    expect(document.querySelector(
      '[data-simul-image-method="accessibility-text"]',
    )?.textContent).toBe('News');
    controller.dispose();
  });

  it('requeues settled work when a new replay lease cannot install its overlay', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const pixels = autoProbePixels(descriptor, 'ab'.repeat(32));
    const diagnostics: unknown[] = [];
    const recognize = vi.fn(async (): Promise<ImageRecognitionResult> => ({
      status: 'complete',
      cacheHit: false,
      selectedQuality: acceptedQualitySummary(),
      result: {
        providerId: 'tesseract',
        bitmapWidth: 200,
        bitmapHeight: 100,
        transcript: 'Opening hours',
        transcriptConfidence: 0.95,
        regions: [{
          text: 'Opening hours',
          confidence: 0.95,
          boundingBox: { x: 10, y: 10, width: 180, height: 40 },
        }],
      },
    }));
    // The replica under lease 2 has no node for the image until it commits;
    // the resolver reports no anchor at all until then.
    let anchorLease = 1;
    let anchorAvailable = true;
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
      resolveAnchor: () => anchorAvailable
        ? {
            document: sourceDocument,
            replayLease: anchorLease,
            image,
            iframe: { contentDocument: document } as HTMLIFrameElement,
          }
        : undefined,
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({
          translate: async (text: string) => `translated:${text}`,
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
    const overlay = () =>
      document.querySelector('[data-simul-image-method="tesseract"]');
    const projections = () =>
      diagnostics.filter((diagnostic) => diagnostic === 'projected').length;
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(diagnostics).toContain('projected'));
    expect(overlay()?.textContent).toBe('translated:Opening hours');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const settled = projections();

    // The recovered replica arrives under a new lease before its image node
    // exists: the retained overlay cannot be rebound, so the settled work is
    // reopened and waits on the anchor instead of staying "projected" with
    // nothing on screen in the new replica.
    anchorAvailable = false;
    controller.activateReplica(request, 3, 2);
    await vi.waitFor(() => expect(diagnostics).toContain('anchor-deferred'));
    expect(diagnostics).toContain('projection-deferred');
    expect(projections()).toBe(settled);

    // The commit that adds the node under lease 2 lets it project again.
    anchorLease = 2;
    anchorAvailable = true;
    expect(controller.notifyReplicaCommit(sourceDocument, 2)).toBe(true);
    await vi.waitFor(() => expect(projections()).toBeGreaterThan(settled));
    expect(overlay()?.textContent).toBe('translated:Opening hours');
    controller.dispose();
  });

  it('suppresses a provisional accessibility label and translates stronger OCR once', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const pixels = autoProbePixels(descriptor, '91'.repeat(32));
    const translate = vi.fn(async (text: string) => `translated:${text}`);
    const diagnostics: unknown[] = [];
    const recognize = vi.fn(async (): Promise<ImageRecognitionResult> => ({
      status: 'complete',
      cacheHit: false,
      selectedQuality: acceptedQualitySummary(),
      result: {
        providerId: 'tesseract',
        bitmapWidth: 200,
        bitmapHeight: 100,
        transcript: 'Latest account security update',
        transcriptConfidence: 0.96,
        regions: [{
          text: 'Latest account security update',
          confidence: 0.96,
          boundingBox: { x: 10, y: 10, width: 180, height: 40 },
        }],
      },
    }));
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return {
          measure: vi.fn(),
          readAccessibilityText: async () => ({
            document: sourceDocument,
            nodeId: descriptor.nodeId,
            contentRevision: descriptor.contentRevision,
            observationRevision: descriptor.observationRevision,
            text: 'IRS Help',
            source: 'alt' as const,
            nearestElementLanguage: 'en' as const,
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
        createSession: async () => ({ translate, destroy: vi.fn() }),
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
      methodOrder: ['accessibility-text', 'tesseract'],
      disabledMethodIds: [],
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);

    await vi.waitFor(() => expect(diagnostics).toContain('projected'));
    expect(recognize).toHaveBeenCalledOnce();
    expect(translate.mock.calls.map(([text]) => text)).toEqual([
      'Latest account security update',
    ]);
    expect(diagnostics).not.toContain('accessibility-text-provisional');
    expect(diagnostics).toContainEqual({
      stage: 'evidence-selection',
      selected: 'ocr',
      reason: 'ocr-decisive',
    });
    expect(document.querySelector(
      '[data-simul-image-method="tesseract"]',
    )?.textContent).toBe('translated:Latest account security update');
    expect(JSON.stringify(diagnostics)).not.toContain('IRS Help');
    controller.dispose();
  });

  it('projects admissible accessibility text while OCR is still pending, then replaces it', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const semanticText = 'Official corporate registration news and public notices';
    const ocrText = `${semanticText} updated today`;
    const pixels = autoProbePixels(descriptor, '90'.repeat(32));
    const diagnostics: unknown[] = [];
    const translate = vi.fn(async (text: string) => `translated:${text}`);
    let finishRecognition!: (result: ImageRecognitionResult) => void;
    const pendingRecognition = new Promise<ImageRecognitionResult>((resolve) => {
      finishRecognition = resolve;
    });
    const recognize = vi.fn(() => pendingRecognition);
    const acquire = vi.fn(async () => ({ status: 'ready' as const, pixels }));
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return {
          measure: vi.fn(),
          readAccessibilityText: async () => ({
            document: sourceDocument,
            nodeId: descriptor.nodeId,
            contentRevision: descriptor.contentRevision,
            observationRevision: descriptor.observationRevision,
            text: semanticText,
            source: 'alt' as const,
            nearestElementLanguage: 'en' as const,
          }),
          dispose: vi.fn(),
        };
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
        image,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({ translate, destroy: vi.fn() }),
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      methodOrder: ['accessibility-text', 'tesseract'],
      disabledMethodIds: [],
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);

    await vi.waitFor(() => expect(diagnostics).toContain(
      'accessibility-text-provisional',
    ));
    expect(document.querySelector(
      '[data-simul-image-method="accessibility-text"]',
    )?.textContent).toBe(`translated:${semanticText}`);
    expect(recognize).toHaveBeenCalledOnce();

    finishRecognition({
      status: 'complete',
      cacheHit: false,
      selectedQuality: acceptedQualitySummary(),
      result: {
        providerId: 'tesseract',
        bitmapWidth: 200,
        bitmapHeight: 100,
        transcript: ocrText,
        transcriptConfidence: 0.98,
        regions: [{
          text: ocrText,
          confidence: 0.98,
          boundingBox: { x: 10, y: 10, width: 180, height: 40 },
        }],
      },
    });
    await vi.waitFor(() => expect(document.querySelector(
      '[data-simul-image-method="tesseract"]',
    )?.textContent).toBe(`translated:${ocrText}`));
    expect(acquire).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it('reads accessibility text only for the scheduler-selected job before OCR', async () => {
    const { document } = parseHTML(
      '<html><body><img><img><img><img></body></html>',
    );
    const images = [...document.querySelectorAll('img')] as unknown as
      HTMLImageElement[];
    const descriptors = [
      descriptor,
      { ...descriptor, nodeId: descriptor.nodeId + 1 },
      { ...descriptor, nodeId: descriptor.nodeId + 2 },
      { ...descriptor, nodeId: descriptor.nodeId + 3 },
    ] as const;
    const labels = new Map<number, string>([
      [descriptors[0].nodeId, 'Official filing notices and public updates'],
      [descriptors[1].nodeId, 'CDN Media'],
      [descriptors[2].nodeId, 'Tax services for registered users'],
      [descriptors[3].nodeId, 'CDN Media'],
    ]);
    const events: string[] = [];
    let releaseFirstCapture!: () => void;
    const firstCapture = new Promise<void>((resolve) => {
      releaseFirstCapture = resolve;
    });
    const acquire = vi.fn(async (current: SourceImageDescriptor) => {
      events.push(`capture:${current.nodeId}`);
      if (current.nodeId === descriptor.nodeId) await firstCapture;
      return {
        status: 'ready' as const,
        pixels: {
          ...autoProbePixels(
            current,
            String(current.nodeId).padStart(2, '0').repeat(32),
          ),
          nearestElementLanguage: 'en' as const,
        },
      };
    });
    const readAccessibilityText = vi.fn(async (
      current: SourceImageDescriptor,
    ) => {
      events.push(`read:${current.nodeId}`);
      return {
        document: sourceDocument,
        nodeId: current.nodeId,
        contentRevision: current.contentRevision,
        observationRevision: current.observationRevision,
        text: labels.get(current.nodeId)!,
        source: 'alt' as const,
        nearestElementLanguage: 'en' as const,
      };
    });
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => {
          for (const current of descriptors) {
            onChange({ kind: 'upsert', descriptor: current });
          }
        });
        return { measure: vi.fn(), readAccessibilityText, dispose: vi.fn() };
      },
      createPixelCoordinator: () => ({ acquire }) as unknown as
        PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize: async (
          pixels: AcquiredImagePixels,
        ): Promise<ImageRecognitionResult> => ({
          status: 'complete',
          cacheHit: false,
          selectedQuality: acceptedQualitySummary(),
          result: {
            providerId: 'tesseract',
            bitmapWidth: pixels.bitmapWidth,
            bitmapHeight: pixels.bitmapHeight,
            transcript: 'Recognized image text',
            transcriptConfidence: 0.97,
            regions: [{
              text: 'Recognized image text',
              confidence: 0.97,
              boundingBox: { x: 5, y: 5, width: 170, height: 30 },
            }],
          },
        }),
        clear: vi.fn(),
        advanceResetEpoch: vi.fn(() => true),
      }) as unknown as ImageRecognitionCoordinator,
      resolveAnchor: (_identity, nodeId) => ({
        document: sourceDocument,
        replayLease: 1,
        image: images[nodeId - descriptor.nodeId]!,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({
          translate: async (text: string) => {
            events.push(`translate:${text}`);
            return `translated:${text}`;
          },
          destroy: vi.fn(),
        }),
      },
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      methodOrder: ['accessibility-text', 'tesseract'],
      disabledMethodIds: [],
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);

    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
    expect(readAccessibilityText).toHaveBeenCalledOnce();
    expect(events).toEqual([
      `read:${descriptors[0].nodeId}`,
      `translate:${labels.get(descriptors[0].nodeId)}`,
      `capture:${descriptors[0].nodeId}`,
    ]);
    expect(document.querySelectorAll(
      '[data-simul-image-method="accessibility-text"]',
    )).toHaveLength(1);
    expect(document.body.textContent).not.toContain('CDN Media');

    releaseFirstCapture();
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(4));
    controller.dispose();
  });

  it('starts only the highest-priority job across a 512-image mixed queue', async () => {
    const count = 512;
    const { document } = parseHTML(
      `<html><body>${'<img>'.repeat(count)}</body></html>`,
    );
    const images = [...document.querySelectorAll('img')] as unknown as
      HTMLImageElement[];
    const descriptors = Array.from({ length: count }, (_, index) => ({
      ...descriptor,
      nodeId: descriptor.nodeId + index,
      visibility: index === count - 1
        ? 'visible' as const
        : 'background' as const,
    }));
    const readAccessibilityText = vi.fn(async (
      _current: SourceImageDescriptor,
    ) => undefined);
    let finishRecognition!: (result: ImageRecognitionResult) => void;
    const recognition = new Promise<ImageRecognitionResult>((resolve) => {
      finishRecognition = resolve;
    });
    const recognize = vi.fn(() => recognition);
    const acquire = vi.fn(async (current: SourceImageDescriptor) => ({
      status: 'ready' as const,
      pixels: autoProbePixels(
        current,
        String(current.nodeId).padStart(4, '0').repeat(16),
      ),
    }));
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => {
          for (const current of descriptors) {
            onChange({ kind: 'upsert', descriptor: current });
          }
        });
        return { measure: vi.fn(), readAccessibilityText, dispose: vi.fn() };
      },
      createPixelCoordinator: () => ({ acquire }) as unknown as
        PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize,
        clear: vi.fn(),
        advanceResetEpoch: vi.fn(() => true),
      }) as unknown as ImageRecognitionCoordinator,
      resolveAnchor: (_identity, nodeId) => ({
        document: sourceDocument,
        replayLease: 1,
        image: images[nodeId - descriptor.nodeId]!,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: vi.fn(),
      },
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-first-background-prescan',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      methodOrder: ['accessibility-text', 'tesseract'],
      disabledMethodIds: [],
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);

    await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce(), {
      timeout: 5_000,
    });
    const selected = descriptors.at(-1)!;
    try {
      expect(readAccessibilityText).toHaveBeenCalledOnce();
      expect(readAccessibilityText.mock.calls[0]?.[0]).toEqual(selected);
      expect(acquire).toHaveBeenCalledOnce();
      expect(acquire.mock.calls[0]?.[0]).toEqual(selected);
    } finally {
      controller.dispose();
      finishRecognition({
        status: 'failed',
        code: 'provider-unavailable',
      });
    }
  });

  it('previews an image discovered during OCR before dispatching the next OCR job', async () => {
    const { document } = parseHTML('<html><body><img><img></body></html>');
    const images = [...document.querySelectorAll('img')] as unknown as
      HTMLImageElement[];
    const nextDescriptor = { ...descriptor, nodeId: descriptor.nodeId + 1 };
    const events: string[] = [];
    let emitChange: ((change: SourceImageChange) => void) | undefined;
    let finishFirstRecognition!: (result: ImageRecognitionResult) => void;
    const firstRecognition = new Promise<ImageRecognitionResult>((resolve) => {
      finishFirstRecognition = resolve;
    });
    const acquire = vi.fn(async (current: SourceImageDescriptor) => {
      events.push(`capture:${current.nodeId}`);
      return {
        status: 'ready' as const,
        pixels: {
          ...autoProbePixels(
            current,
            String(current.nodeId).padStart(2, '0').repeat(32),
          ),
          nearestElementLanguage: 'en' as const,
        },
      };
    });
    const readAccessibilityText = vi.fn(async (
      current: SourceImageDescriptor,
    ) => {
      events.push(`read:${current.nodeId}`);
      return {
        document: sourceDocument,
        nodeId: current.nodeId,
        contentRevision: current.contentRevision,
        observationRevision: current.observationRevision,
        text: `Official image label ${current.nodeId}`,
        source: 'alt' as const,
        nearestElementLanguage: 'en' as const,
      };
    });
    const recognize = vi.fn((pixels): Promise<ImageRecognitionResult> => {
      events.push(`recognize:${pixels.descriptor.nodeId}`);
      if (pixels.descriptor.nodeId === descriptor.nodeId) {
        return firstRecognition;
      }
      return Promise.resolve(autoProbeRecognition('Recognized update', 0.97));
    });
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        emitChange = onChange;
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return { measure: vi.fn(), readAccessibilityText, dispose: vi.fn() };
      },
      createPixelCoordinator: () => ({ acquire }) as unknown as
        PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize,
        clear: vi.fn(),
        advanceResetEpoch: vi.fn(() => true),
      }) as unknown as ImageRecognitionCoordinator,
      resolveAnchor: (_identity, nodeId) => ({
        document: sourceDocument,
        replayLease: 1,
        image: images[nodeId - descriptor.nodeId]!,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({
          translate: async (text: string) => `translated:${text}`,
          destroy: vi.fn(),
        }),
      },
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      methodOrder: ['accessibility-text', 'tesseract'],
      disabledMethodIds: [],
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce());

    emitChange?.({ kind: 'upsert', descriptor: nextDescriptor });
    await Promise.resolve();
    expect(readAccessibilityText).toHaveBeenCalledOnce();
    finishFirstRecognition(autoProbeRecognition('First recognized update', 0.98));

    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(2));
    expect(events.indexOf(`read:${nextDescriptor.nodeId}`)).toBeGreaterThan(
      events.indexOf(`recognize:${descriptor.nodeId}`),
    );
    expect(events.indexOf(`read:${nextDescriptor.nodeId}`)).toBeLessThan(
      events.indexOf(`capture:${nextDescriptor.nodeId}`),
    );
    expect(document.querySelector(
      '[data-simul-image-method="accessibility-text"]',
    )).not.toBeNull();
    controller.dispose();
  });

  it('does not project a background preview removed by a policy change', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const background = { ...descriptor, visibility: 'background' as const };
    let finishTranslation!: (text: string) => void;
    const pendingTranslation = new Promise<string>((resolve) => {
      finishTranslation = resolve;
    });
    const acquire = vi.fn();
    const translate = vi.fn(() => pendingTranslation);
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor: background }));
        return {
          measure: vi.fn(),
          readAccessibilityText: async () => ({
            document: sourceDocument,
            nodeId: background.nodeId,
            contentRevision: background.contentRevision,
            observationRevision: background.observationRevision,
            text: 'Background account help',
            source: 'alt' as const,
            nearestElementLanguage: 'en' as const,
          }),
          dispose: vi.fn(),
        };
      },
      createPixelCoordinator: () => ({ acquire }) as unknown as
        PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize: vi.fn(),
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
        createSession: async () => ({ translate, destroy: vi.fn() }),
      },
      projector: testProjectorEnvironment(),
    });
    const configuration = {
      enabled: true,
      scanPolicy: 'eager-all' as const,
      skipSmallImages: false,
      providerOrder: ['tesseract'] as const,
      methodOrder: ['accessibility-text', 'tesseract'] as const,
      disabledMethodIds: [] as const,
      sourceLanguage: 'en' as const,
      targetLanguage: 'ja' as const,
      translationIdle: true,
      resetEpoch: 0,
    };
    controller.configure(configuration);
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(translate).toHaveBeenCalledOnce());

    controller.configure({ ...configuration, scanPolicy: 'visible-only' });
    finishTranslation('translated:Background account help');
    await vi.waitFor(() => expect(controller.busy).toBe(false));

    expect(document.querySelector('[data-simul-image-overlay]')).toBeNull();
    expect(acquire).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('isolates a mismatched accessibility response and previews later labels', async () => {
    const { document } = parseHTML('<html><body><img><img></body></html>');
    const images = [...document.querySelectorAll('img')] as unknown as
      HTMLImageElement[];
    const second = { ...descriptor, nodeId: descriptor.nodeId + 1 };
    const readAccessibilityText = vi.fn(async (
      current: SourceImageDescriptor,
    ) => ({
      document: sourceDocument,
      nodeId: current.nodeId === descriptor.nodeId
        ? current.nodeId + 100
        : current.nodeId,
      contentRevision: current.contentRevision,
      observationRevision: current.observationRevision,
      text: current.nodeId === descriptor.nodeId
        ? 'Mismatched response'
        : 'Valid account help',
      source: 'alt' as const,
      nearestElementLanguage: 'en' as const,
    }));
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => {
          onChange({ kind: 'upsert', descriptor });
          onChange({ kind: 'upsert', descriptor: second });
        });
        return { measure: vi.fn(), readAccessibilityText, dispose: vi.fn() };
      },
      createPixelCoordinator: () => ({ acquire: vi.fn() }) as unknown as
        PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize: vi.fn(),
        clear: vi.fn(),
        advanceResetEpoch: vi.fn(() => true),
      }) as unknown as ImageRecognitionCoordinator,
      resolveAnchor: (_identity, nodeId) => ({
        document: sourceDocument,
        replayLease: 1,
        image: images[nodeId - descriptor.nodeId]!,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({
          translate: async (text: string) => `translated:${text}`,
          destroy: vi.fn(),
        }),
      },
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: [],
      methodOrder: ['accessibility-text'],
      disabledMethodIds: [],
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);

    await vi.waitFor(() => expect(document.querySelector(
      '[data-simul-image-method="accessibility-text"]',
    )?.textContent).toBe('translated:Valid account help'));
    expect(readAccessibilityText).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('retries the ranked semantic winner after its provisional translation fails', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const semanticText = 'Official corporate registration and account help';
    const translate = vi.fn()
      .mockRejectedValueOnce(new Error('temporary translator failure'))
      .mockImplementation(async (text: string) => `translated:${text}`);
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return {
          measure: vi.fn(),
          readAccessibilityText: async () => ({
            document: sourceDocument,
            nodeId: descriptor.nodeId,
            contentRevision: descriptor.contentRevision,
            observationRevision: descriptor.observationRevision,
            text: semanticText,
            source: 'alt' as const,
            nearestElementLanguage: 'en' as const,
          }),
          dispose: vi.fn(),
        };
      },
      createPixelCoordinator: () => ({
        acquire: async () => ({
          status: 'ready' as const,
          pixels: autoProbePixels(descriptor, '9a'.repeat(32)),
        }),
      }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize: async () => ({
          ...autoProbeRecognition('Help', 0.7),
          selectedQuality: acceptedQualitySummary(),
        }),
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
        createSession: async () => ({ translate, destroy: vi.fn() }),
      },
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      methodOrder: ['tesseract', 'accessibility-text'],
      disabledMethodIds: [],
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);

    await vi.waitFor(() => expect(document.querySelector(
      '[data-simul-image-method="accessibility-text"]',
    )?.textContent).toBe(`translated:${semanticText}`));
    expect(translate.mock.calls.map(([text]) => text)).toEqual([
      semanticText,
      semanticText,
    ]);
    controller.dispose();
  });

  it('returns to semantic evidence before trying an unranked OCR continuation', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const pixels = autoProbePixels(descriptor, '95'.repeat(32));
    const firstOcrText = 'Important account security and registration update';
    const continuation = Object.freeze({
      kind: 'simul:image-recognition-continuation' as const,
    }) satisfies ImageRecognitionContinuation;
    const continueRecognition = vi.fn(async (): Promise<ImageRecognitionResult> => ({
      status: 'complete',
      cacheHit: false,
      result: {
        providerId: 'tesseract',
        bitmapWidth: 200,
        bitmapHeight: 100,
        transcript: 'Unranked continuation',
        regions: [{
          text: 'Unranked continuation',
          boundingBox: { x: 10, y: 10, width: 160, height: 30 },
        }],
      },
    }));
    const translate = vi.fn(async (text: string) => {
      if (text === firstOcrText) throw new Error('selected OCR unavailable');
      return `translated:${text}`;
    });
    const diagnostics: unknown[] = [];
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return {
          measure: vi.fn(),
          readAccessibilityText: async () => ({
            document: sourceDocument,
            nodeId: descriptor.nodeId,
            contentRevision: descriptor.contentRevision,
            observationRevision: descriptor.observationRevision,
            text: 'Account help',
            source: 'alt' as const,
            nearestElementLanguage: 'en' as const,
          }),
          dispose: vi.fn(),
        };
      },
      createPixelCoordinator: () => ({
        acquire: async () => ({ status: 'ready', pixels }),
      }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize: async (): Promise<ImageRecognitionResult> => ({
          status: 'complete',
          cacheHit: false,
          continuation,
          selectedQuality: acceptedQualitySummary(),
          result: {
            providerId: 'tesseract',
            bitmapWidth: 200,
            bitmapHeight: 100,
            transcript: firstOcrText,
            transcriptConfidence: 0.96,
            regions: [{
              text: firstOcrText,
              confidence: 0.96,
              boundingBox: { x: 10, y: 10, width: 180, height: 40 },
            }],
          },
        }),
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
        createSession: async () => ({ translate, destroy: vi.fn() }),
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      methodOrder: ['accessibility-text', 'tesseract'],
      disabledMethodIds: [],
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);

    await vi.waitFor(() => expect(diagnostics).toContain(
      'accessibility-text-complete',
    ));
    expect(continueRecognition).not.toHaveBeenCalled();
    expect(translate.mock.calls.map(([text]) => text)).toEqual([
      firstOcrText,
      'Account help',
    ]);
    expect(document.querySelector(
      '[data-simul-image-method="accessibility-text"]',
    )?.textContent).toBe('translated:Account help');
    controller.dispose();
  });

  it('uses saved priority when short semantic and accepted OCR evidence are close', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const pixels = autoProbePixels(descriptor, '92'.repeat(32));
    const translate = vi.fn(async (_text: string) => 'News');
    const acquire = vi.fn(async () => ({ status: 'ready' as const, pixels }));
    const recognize = vi.fn(async (): Promise<ImageRecognitionResult> => ({
      status: 'complete',
      cacheHit: false,
      selectedQuality: acceptedQualitySummary(),
      result: {
        providerId: 'tesseract',
        bitmapWidth: 200,
        bitmapHeight: 100,
        transcript: 'notice',
        transcriptConfidence: 0.96,
        regions: [{
          text: 'not',
          confidence: 0.96,
          boundingBox: { x: 10, y: 10, width: 50, height: 40 },
        }, {
          text: 'ice',
          confidence: 0.96,
          boundingBox: { x: 65, y: 10, width: 55, height: 40 },
        }],
      },
    }));
    const diagnostics: unknown[] = [];
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return {
          measure: vi.fn(),
          readAccessibilityText: async () => ({
            document: sourceDocument,
            nodeId: descriptor.nodeId,
            contentRevision: descriptor.contentRevision,
            observationRevision: descriptor.observationRevision,
            text: 'お知らせ',
            source: 'alt' as const,
            nearestElementLanguage: 'ja' as const,
          }),
          dispose: vi.fn(),
        };
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
        image,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({ translate, destroy: vi.fn() }),
      },
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
      skipSmallImages: false,
      providerOrder: ['tesseract'] as const,
      methodOrder: ['accessibility-text', 'tesseract'] as const,
      disabledMethodIds: [] as const,
      sourceLanguage: 'ja' as const,
      targetLanguage: 'en' as const,
      translationIdle: true,
      resetEpoch: 0,
    };
    controller.configure(configuration);
    controller.activateReplica(request, 3, 1);

    await vi.waitFor(() => expect(diagnostics).toContain(
      'accessibility-text-complete',
    ));
    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate.mock.calls[0]?.[0]).toBe('お知らせ');
    expect(diagnostics).toContainEqual({
      stage: 'evidence-selection',
      selected: 'semantic',
      reason: 'priority-tie',
    });
    expect(document.querySelector(
      '[data-simul-image-method="accessibility-text"]',
    )?.textContent).toBe('News');

    controller.configure({
      ...configuration,
      methodOrder: ['tesseract', 'accessibility-text'],
    });
    await vi.waitFor(() => expect(document.querySelector(
      '[data-simul-image-method="tesseract"]',
    )?.textContent).toBe('NewsNews'));
    expect(acquire).toHaveBeenCalledOnce();
    expect(recognize).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it('ranks later descriptive accessibility evidence after accepted OCR', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const pixels = autoProbePixels(descriptor, '93'.repeat(32));
    const semanticText = 'Official corporate registration news and public notices';
    const events: string[] = [];
    const translate = vi.fn(async (text: string) => `translated:${text}`);
    const diagnostics: unknown[] = [];
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return {
          measure: vi.fn(),
          readAccessibilityText: async () => {
            events.push('accessibility-text');
            return {
              document: sourceDocument,
              nodeId: descriptor.nodeId,
              contentRevision: descriptor.contentRevision,
              observationRevision: descriptor.observationRevision,
              text: semanticText,
              source: 'alt' as const,
              nearestElementLanguage: 'en' as const,
            };
          },
          dispose: vi.fn(),
        };
      },
      createPixelCoordinator: () => ({
        acquire: async () => ({ status: 'ready', pixels }),
      }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize: async (): Promise<ImageRecognitionResult> => {
          events.push('ocr:tesseract');
          return {
            status: 'complete',
            cacheHit: false,
            selectedQuality: acceptedQualitySummary(),
            result: {
              providerId: 'tesseract',
              bitmapWidth: 200,
              bitmapHeight: 100,
              transcript: 'News',
              transcriptConfidence: 0.7,
              regions: [{
                text: 'News',
                confidence: 0.7,
                boundingBox: { x: 10, y: 10, width: 100, height: 30 },
              }],
            },
          };
        },
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
        createSession: async () => ({ translate, destroy: vi.fn() }),
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
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);

    await vi.waitFor(() => expect(diagnostics).toContain(
      'accessibility-text-complete',
    ));
    expect(events).toEqual(['accessibility-text', 'ocr:tesseract']);
    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate).toHaveBeenCalledWith(
      semanticText,
      expect.any(AbortSignal),
    );
    expect(diagnostics).toContainEqual({
      stage: 'evidence-selection',
      selected: 'semantic',
      reason: 'semantic-decisive',
    });
    controller.dispose();
  });

  it('does not promote a staged OCR Auto vote when later semantic evidence wins', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const semanticText = '法人番号に関する重要なお知らせと登録情報';
    const revisedSemanticText = `${semanticText}更新`;
    const ocrText = 'おしらせはこちらです';
    let emitChange: ((change: SourceImageChange) => void) | undefined;
    const detected: string[] = [];
    const diagnostics: unknown[] = [];
    const translate = vi.fn(async (text: string) => {
      if (text === revisedSemanticText) {
        throw new Error('semantic translation unavailable');
      }
      return `translated:${text}`;
    });
    const recognize = vi.fn(async (): Promise<ImageRecognitionResult> => ({
      status: 'complete',
      cacheHit: false,
      selectedQuality: acceptedQualitySummary(),
      result: {
        providerId: 'tesseract',
        bitmapWidth: 200,
        bitmapHeight: 100,
        transcript: ocrText,
        transcriptConfidence: 0.96,
        regions: [{
          text: ocrText,
          confidence: 0.96,
          boundingBox: { x: 10, y: 10, width: 160, height: 30 },
        }],
      },
    }));
    const timers = controlledProbeTimers();
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        emitChange = onChange;
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return {
          measure: vi.fn(),
          readAccessibilityText: async (current) => ({
            document: sourceDocument,
            nodeId: current.nodeId,
            contentRevision: current.contentRevision,
            observationRevision: current.observationRevision,
            text: current.contentRevision === descriptor.contentRevision
              ? semanticText
              : revisedSemanticText,
            source: 'alt' as const,
          }),
          dispose: vi.fn(),
        };
      },
      createPixelCoordinator: () => ({
        acquire: async (current: SourceImageDescriptor) => ({
          status: 'ready' as const,
          pixels: autoProbePixels(
            current,
            current.contentRevision === descriptor.contentRevision
              ? '94'.repeat(32)
              : '96'.repeat(32),
          ),
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
        createSession: async () => ({ translate, destroy: vi.fn() }),
      },
      detectLanguage: async () => ({
        isReliable: true,
        languages: [{ language: 'ja', percentage: 99 }],
      }),
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
      providerOrder: ['tesseract'],
      methodOrder: ['tesseract', 'accessibility-text'],
      disabledMethodIds: [],
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);

    await vi.waitFor(() => expect(diagnostics).toContain(
      'accessibility-text-complete',
    ));
    expect(detected).toEqual([]);
    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate).toHaveBeenCalledWith(
      semanticText,
      expect.any(AbortSignal),
    );
    expect(diagnostics).toContainEqual({
      stage: 'evidence-selection',
      selected: 'semantic',
      reason: 'semantic-decisive',
    });

    emitChange?.({
      kind: 'upsert',
      descriptor: {
        ...descriptor,
        contentRevision: 2,
        observationRevision: 2,
      },
    });
    await vi.waitFor(() => expect(detected).toEqual(['ja']));
    await vi.waitFor(() => expect(document.querySelector(
      '[data-simul-image-method="tesseract"]',
    )?.textContent).toBe(`translated:${ocrText}`));
    controller.dispose();
  });

  it('falls back to held semantic evidence when OCR pixel permission is unavailable', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const recognize = vi.fn();
    const diagnostics: unknown[] = [];
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return {
          measure: vi.fn(),
          readAccessibilityText: async () => ({
            document: sourceDocument,
            nodeId: descriptor.nodeId,
            contentRevision: descriptor.contentRevision,
            observationRevision: descriptor.observationRevision,
            text: 'お知らせ',
            source: 'alt' as const,
            nearestElementLanguage: 'ja' as const,
          }),
          dispose: vi.fn(),
        };
      },
      createPixelCoordinator: () => ({
        acquire: async () => ({
          status: 'deferred',
          reason: 'permission',
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
          translate: async () => 'News',
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
      methodOrder: ['accessibility-text', 'tesseract'],
      disabledMethodIds: [],
      sourceLanguage: 'ja',
      targetLanguage: 'en',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);

    await vi.waitFor(() => expect(diagnostics).toContain(
      'accessibility-text-complete',
    ));
    expect(recognize).not.toHaveBeenCalled();
    expect(diagnostics).toContainEqual({
      stage: 'evidence-selection',
      selected: 'semantic',
      reason: 'semantic-fallback',
    });
    controller.dispose();
  });

  it('falls back to held semantic evidence after one transient capture retry', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const acquire = vi.fn(async () => ({
      status: 'deferred' as const,
      reason: 'unstable' as const,
    }));
    const recognize = vi.fn();
    const diagnostics: unknown[] = [];
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return {
          measure: vi.fn(),
          readAccessibilityText: async () => ({
            document: sourceDocument,
            nodeId: descriptor.nodeId,
            contentRevision: descriptor.contentRevision,
            observationRevision: descriptor.observationRevision,
            text: 'お知らせ',
            source: 'alt' as const,
            nearestElementLanguage: 'ja' as const,
          }),
          dispose: vi.fn(),
        };
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
      methodOrder: ['accessibility-text', 'tesseract'],
      disabledMethodIds: [],
      sourceLanguage: 'ja',
      targetLanguage: 'en',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);

    await vi.waitFor(() => expect(diagnostics).toContain(
      'accessibility-text-complete',
    ));
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(recognize).not.toHaveBeenCalled();
    expect(diagnostics).toContainEqual(expect.objectContaining({
      stage: 'job-progress',
      status: 'capture-retry-exhausted',
      attempt: 1,
    }));
    expect(diagnostics).toContainEqual({
      stage: 'evidence-selection',
      selected: 'semantic',
      reason: 'semantic-fallback',
    });
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

  it('does not admit provisional semantic candidates rejected in favor of OCR to Auto votes', async () => {
    const { document } = parseHTML(
      '<html><body><img id="first"><img id="second"></body></html>',
    );
    const firstImage = document.querySelector('#first') as unknown as
      HTMLImageElement;
    const secondImage = document.querySelector('#second') as unknown as
      HTMLImageElement;
    const secondDescriptor = { ...descriptor, nodeId: 13 };
    let emitChange: ((change: SourceImageChange) => void) | undefined;
    const detected: string[] = [];
    const diagnostics: unknown[] = [];
    const translate = vi.fn(async (text: string) => `translated:${text}`);
    const labels = new Map([
      [descriptor.nodeId, 'IRS Help'],
      [secondDescriptor.nodeId, 'EU Login'],
    ]);
    const transcripts = new Map([
      [descriptor.nodeId, '重要な法人番号のお知らせ'],
      [
        secondDescriptor.nodeId,
        '最新の法人手続きと重要な更新情報を確認してください',
      ],
    ]);
    const recognize = vi.fn(async (pixels: ReturnType<typeof autoProbePixels>) => {
      const transcript = transcripts.get(pixels.descriptor.nodeId)!;
      return {
        status: 'complete' as const,
        cacheHit: false,
        selectedQuality: acceptedQualitySummary(),
        result: {
          providerId: 'tesseract' as const,
          bitmapWidth: 200,
          bitmapHeight: 100,
          transcript,
          transcriptConfidence: 0.96,
          regions: [{
            text: transcript,
            confidence: 0.96,
            boundingBox: { x: 10, y: 10, width: 180, height: 40 },
          }],
        },
      };
    });
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        emitChange = onChange;
        return {
          measure: vi.fn(),
          readAccessibilityText: async (current) => ({
            document: sourceDocument,
            nodeId: current.nodeId,
            contentRevision: current.contentRevision,
            observationRevision: current.observationRevision,
            text: labels.get(current.nodeId)!,
            source: 'alt' as const,
          }),
          dispose: vi.fn(),
        };
      },
      createPixelCoordinator: () => ({
        acquire: async (current: SourceImageDescriptor) => ({
          status: 'ready' as const,
          pixels: {
            ...autoProbePixels(
              current,
              current.nodeId === descriptor.nodeId
                ? 'a1'.repeat(32)
                : 'b2'.repeat(32),
            ),
            nearestElementLanguage: 'ja' as const,
          },
        }),
      }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize,
        clear: vi.fn(),
        advanceResetEpoch: vi.fn(() => true),
      }) as unknown as ImageRecognitionCoordinator,
      resolveAnchor: (_identity, nodeId) => ({
        document: sourceDocument,
        replayLease: 1,
        image: nodeId === descriptor.nodeId ? firstImage : secondImage,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({ translate, destroy: vi.fn() }),
      },
      detectLanguage: async () => ({
        isReliable: true,
        languages: [{ language: 'ja', percentage: 96 }],
      }),
      onAutoLanguageDetected: (language) => detected.push(language),
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
      methodOrder: ['accessibility-text', 'tesseract'],
      disabledMethodIds: [],
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(emitChange).toBeTypeOf('function'));

    emitChange?.({ kind: 'upsert', descriptor });
    emitChange?.({ kind: 'upsert', descriptor: secondDescriptor });
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(translate.mock.calls.length).toBeGreaterThanOrEqual(2));

    expect(detected).toEqual([]);
    const translatedSources = translate.mock.calls.map(([text]) => text);
    expect(translatedSources).toEqual([
      transcripts.get(descriptor.nodeId),
      transcripts.get(secondDescriptor.nodeId),
    ]);
    expect(diagnostics.filter((entry) =>
      typeof entry === 'object' && entry !== null &&
      'stage' in entry && entry.stage === 'evidence-selection' &&
      'selected' in entry && entry.selected === 'ocr'
    )).toHaveLength(2);

    controller.dispose();
  });

  it('does not admit semantic Auto votes when translation fails and OCR becomes the fallback', async () => {
    const { document } = parseHTML(
      '<html><body><img id="first"><img id="second"></body></html>',
    );
    const images = [...document.querySelectorAll('img')] as unknown as
      HTMLImageElement[];
    const secondDescriptor = { ...descriptor, nodeId: 13 };
    const labels = new Map([
      [descriptor.nodeId, '重要な手続きのお知らせ一'],
      [secondDescriptor.nodeId, '法人登録に関する更新情報二'],
    ]);
    const transcripts = new Map([
      [descriptor.nodeId, '画像から読んだ手続き情報'],
      [secondDescriptor.nodeId, '画像から読んだ登録情報'],
    ]);
    let emitChange: ((change: SourceImageChange) => void) | undefined;
    const detected: string[] = [];
    const diagnostics: unknown[] = [];
    const translate = vi.fn(async (text: string) => {
      if ([...labels.values()].includes(text)) {
        throw new Error('semantic translation unavailable');
      }
      return `translated:${text}`;
    });
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        emitChange = onChange;
        return {
          measure: vi.fn(),
          readAccessibilityText: async (current) => ({
            document: sourceDocument,
            nodeId: current.nodeId,
            contentRevision: current.contentRevision,
            observationRevision: current.observationRevision,
            text: labels.get(current.nodeId)!,
            source: 'alt' as const,
          }),
          dispose: vi.fn(),
        };
      },
      createPixelCoordinator: () => ({
        acquire: async (current: SourceImageDescriptor) => ({
          status: 'ready' as const,
          pixels: {
            ...autoProbePixels(
              current,
              current.nodeId === descriptor.nodeId
                ? 'a3'.repeat(32)
                : 'b4'.repeat(32),
            ),
            nearestElementLanguage: 'ja' as const,
          },
        }),
      }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize: async (pixels: ReturnType<typeof autoProbePixels>):
          Promise<ImageRecognitionResult> => {
          const transcript = transcripts.get(pixels.descriptor.nodeId)!;
          return {
            status: 'complete',
            cacheHit: false,
            selectedQuality: acceptedQualitySummary(),
            result: {
              providerId: 'tesseract',
              bitmapWidth: 200,
              bitmapHeight: 100,
              transcript,
              transcriptConfidence: 0.7,
              regions: [{
                text: transcript,
                confidence: 0.7,
                boundingBox: { x: 10, y: 10, width: 180, height: 40 },
              }],
            },
          };
        },
        clear: vi.fn(),
        advanceResetEpoch: vi.fn(() => true),
      }) as unknown as ImageRecognitionCoordinator,
      resolveAnchor: (_identity, nodeId) => ({
        document: sourceDocument,
        replayLease: 1,
        image: images[nodeId - descriptor.nodeId]!,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({ translate, destroy: vi.fn() }),
      },
      detectLanguage: async () => ({
        isReliable: true,
        languages: [{ language: 'ja', percentage: 98 }],
      }),
      onAutoLanguageDetected: (language) => detected.push(language),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      methodOrder: ['accessibility-text', 'tesseract'],
      disabledMethodIds: [],
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(emitChange).toBeTypeOf('function'));

    emitChange?.({ kind: 'upsert', descriptor });
    emitChange?.({ kind: 'upsert', descriptor: secondDescriptor });
    await vi.waitFor(() => expect(diagnostics.filter((entry) =>
      entry === 'projected'
    )).toHaveLength(2));

    expect(detected).toEqual([]);
    expect(translate.mock.calls.map(([text]) => text)).toEqual([
      labels.get(descriptor.nodeId),
      transcripts.get(descriptor.nodeId),
      labels.get(secondDescriptor.nodeId),
      transcripts.get(secondDescriptor.nodeId),
    ]);
    expect(diagnostics.filter((entry) =>
      entry === 'accessibility-text-blocked'
    )).toHaveLength(2);
    controller.dispose();
  });

  it('clears selected semantic Auto votes across a same-document source reconnect', async () => {
    const { document } = parseHTML(
      '<html><body><img id="first"><img id="second"><img id="third"></body></html>',
    );
    const images = [...document.querySelectorAll('img')] as unknown as
      HTMLImageElement[];
    const secondDescriptor = { ...descriptor, nodeId: 13 };
    const thirdDescriptor = { ...descriptor, nodeId: 14 };
    const labels = new Map([
      [descriptor.nodeId, 'お知らせ'],
      [secondDescriptor.nodeId, '法人番号'],
      [thirdDescriptor.nodeId, '最新情報'],
    ]);
    const sourceChanges: Array<(change: SourceImageChange) => void> = [];
    const unavailable: Array<(error: ImageSourceUnavailableError) => void> = [];
    const detected: string[] = [];
    const diagnostics: unknown[] = [];
    const timers = controlledProbeTimers();
    const readAccessibilityText = vi.fn(async (
      current: SourceImageDescriptor,
    ) => ({
      document: sourceDocument,
      nodeId: current.nodeId,
      contentRevision: current.contentRevision,
      observationRevision: current.observationRevision,
      text: labels.get(current.nodeId)!,
      source: 'alt' as const,
    }));
    const openSource = vi.fn(async (
      _request: ReplicaCaptureRequest,
      onChange: (change: SourceImageChange) => void,
    ) => {
      sourceChanges.push(onChange);
      return {
        unavailable: new Promise<ImageSourceUnavailableError>((resolve) => {
          unavailable.push(resolve);
        }),
        measure: vi.fn(),
        readAccessibilityText,
        dispose: vi.fn(),
      };
    });
    const controller = new ImageTranslationController({
      openSource,
      createPixelCoordinator: () => ({ acquire: vi.fn() }) as unknown as
        PixelAcquisitionCoordinator,
      createRecognitionCoordinator: vi.fn(),
      resolveAnchor: (_identity, nodeId) => ({
        document: sourceDocument,
        replayLease: 1,
        image: images[nodeId - descriptor.nodeId]!,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({
          translate: async () => 'translated',
          destroy: vi.fn(),
        }),
      },
      detectLanguage: async () => ({
        isReliable: true,
        languages: [{ language: 'ja', percentage: 96 }],
      }),
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
      providerOrder: [],
      methodOrder: ['accessibility-text'],
      disabledMethodIds: [],
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(sourceChanges).toHaveLength(1));
    await vi.waitFor(() => expect(diagnostics).toContain('source-connected'));

    sourceChanges[0]?.({ kind: 'upsert', descriptor });
    await vi.waitFor(() => expect(readAccessibilityText).toHaveBeenCalledTimes(1));
    expect(detected).toEqual([]);

    unavailable[0]?.(new ImageSourceUnavailableError('same document reconnect'));
    await vi.waitFor(() => expect(openSource).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(diagnostics.filter((entry) =>
      entry === 'source-connected'
    )).toHaveLength(2));
    sourceChanges[1]?.({ kind: 'upsert', descriptor: secondDescriptor });
    await vi.waitFor(() => expect(readAccessibilityText).toHaveBeenCalledTimes(2));
    expect(detected).toEqual([]);

    sourceChanges[1]?.({ kind: 'upsert', descriptor: thirdDescriptor });
    await vi.waitFor(() => expect(detected).toEqual(['ja']));
    expect(timers.deadlineCallbacks).toHaveLength(1);
    controller.dispose();
  });

  it('re-ranks retained evidence when duplicate-label status changes', async () => {
    const { document } = parseHTML(
      '<html><body><img id="first"><img id="second"></body></html>',
    );
    const firstImage = document.querySelector('#first') as unknown as
      HTMLImageElement;
    const secondImage = document.querySelector('#second') as unknown as
      HTMLImageElement;
    const secondDescriptor = { ...descriptor, nodeId: 13 };
    const semanticText = 'Corporate updates and public notices';
    const ocrText = 'Emergency service updates and corporate filing notices';
    let emitChange: ((change: SourceImageChange) => void) | undefined;
    const diagnostics: unknown[] = [];
    const translate = vi.fn(async (text: string) => `translated:${text}`);
    const recognize = vi.fn(async (): Promise<ImageRecognitionResult> => ({
      status: 'complete',
      cacheHit: false,
      selectedQuality: acceptedQualitySummary(),
      result: {
        providerId: 'tesseract',
        bitmapWidth: 200,
        bitmapHeight: 100,
        transcript: ocrText,
        transcriptConfidence: 0.96,
        regions: [{
          text: ocrText,
          confidence: 0.96,
          boundingBox: { x: 10, y: 10, width: 180, height: 40 },
        }],
      },
    }));
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        emitChange = onChange;
        return {
          measure: vi.fn(),
          readAccessibilityText: async (current) => ({
            document: sourceDocument,
            nodeId: current.nodeId,
            contentRevision: current.contentRevision,
            observationRevision: current.observationRevision,
            text: semanticText,
            source: 'alt' as const,
            nearestElementLanguage: 'en' as const,
          }),
          dispose: vi.fn(),
        };
      },
      createPixelCoordinator: () => ({
        acquire: async (current: SourceImageDescriptor) => ({
          status: 'ready' as const,
          pixels: {
            ...autoProbePixels(
              current,
              current.nodeId === descriptor.nodeId
                ? 'c3'.repeat(32)
                : 'd4'.repeat(32),
            ),
            nearestElementLanguage: 'en' as const,
          },
        }),
      }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize,
        clear: vi.fn(),
        advanceResetEpoch: vi.fn(() => true),
      }) as unknown as ImageRecognitionCoordinator,
      resolveAnchor: (_identity, nodeId) => ({
        document: sourceDocument,
        replayLease: 1,
        image: nodeId === descriptor.nodeId ? firstImage : secondImage,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({ translate, destroy: vi.fn() }),
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
      methodOrder: ['accessibility-text', 'tesseract'],
      disabledMethodIds: [],
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(emitChange).toBeTypeOf('function'));

    emitChange?.({ kind: 'upsert', descriptor });
    await vi.waitFor(() => expect(diagnostics).toContain(
      'accessibility-text-provisional',
    ));
    emitChange?.({ kind: 'upsert', descriptor: secondDescriptor });

    await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(diagnostics.filter((entry) =>
      typeof entry === 'object' && entry !== null &&
      'stage' in entry && entry.stage === 'evidence-selection'
    )).toHaveLength(3));
    await vi.waitFor(() => expect(document.querySelectorAll(
      '[data-simul-image-method="tesseract"]',
    )).toHaveLength(2));
    expect(document.querySelector(
      '[data-simul-image-method="accessibility-text"]',
    )).toBeNull();
    expect(translate.mock.calls.map(([text]) => text)).toEqual([
      semanticText,
      ocrText,
    ]);
    expect(diagnostics.filter((entry) =>
      typeof entry === 'object' && entry !== null &&
      'stage' in entry && entry.stage === 'evidence-selection' &&
      'selected' in entry && entry.selected === 'ocr'
    )).toHaveLength(3);

    emitChange?.({
      kind: 'remove',
      document: sourceDocument,
      nodeId: secondDescriptor.nodeId,
      contentRevision: 2,
      observationRevision: 2,
    });
    await vi.waitFor(() => expect(diagnostics.filter((entry) =>
      typeof entry === 'object' && entry !== null &&
      'stage' in entry && entry.stage === 'evidence-selection'
    )).toHaveLength(4));
    expect(recognize).toHaveBeenCalledTimes(2);
    expect(translate).toHaveBeenCalledTimes(2);
    expect(firstImage.parentElement?.querySelector(
      '[data-simul-image-method="accessibility-text"]',
    )).toBeNull();
    expect(document.querySelectorAll(
      '[data-simul-image-method="tesseract"]',
    )).toHaveLength(1);
    controller.dispose();
  });

  it('removes a prior semantic Auto vote when duplication changes its selected evidence', async () => {
    const { document } = parseHTML(
      '<html><body><img><img><img></body></html>',
    );
    const images = [...document.querySelectorAll('img')] as unknown as
      HTMLImageElement[];
    const secondDescriptor = { ...descriptor, nodeId: 13 };
    const thirdDescriptor = { ...descriptor, nodeId: 14 };
    const repeatedLabel = '共通の法人登録に関する重要なお知らせと詳細情報';
    const distinctLabel = '行政手続きに関する最新の公開案内と更新情報';
    const richerOcr =
      '画像から読み取った法人登録に関する重要なお知らせと詳細な更新情報をご確認ください';
    let emitChange: ((change: SourceImageChange) => void) | undefined;
    const detected: string[] = [];
    const diagnostics: unknown[] = [];
    const recognize = vi.fn(async (): Promise<ImageRecognitionResult> => ({
      status: 'complete',
      cacheHit: false,
      selectedQuality: acceptedQualitySummary(),
      result: {
        providerId: 'tesseract',
        bitmapWidth: 200,
        bitmapHeight: 100,
        transcript: richerOcr,
        transcriptConfidence: 0.96,
        regions: [{
          text: richerOcr,
          confidence: 0.96,
          boundingBox: { x: 10, y: 10, width: 180, height: 40 },
        }],
      },
    }));
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        emitChange = onChange;
        return {
          measure: vi.fn(),
          readAccessibilityText: async (current) => ({
            document: sourceDocument,
            nodeId: current.nodeId,
            contentRevision: current.contentRevision,
            observationRevision: current.observationRevision,
            text: current.nodeId === thirdDescriptor.nodeId
              ? distinctLabel
              : repeatedLabel,
            source: 'alt' as const,
            nearestElementLanguage: 'ja' as const,
          }),
          dispose: vi.fn(),
        };
      },
      createPixelCoordinator: () => ({
        acquire: async (current: SourceImageDescriptor) => ({
          status: 'ready' as const,
          pixels: {
            ...autoProbePixels(current, `${current.nodeId}`.repeat(64).slice(0, 64)),
            nearestElementLanguage: 'ja' as const,
          },
        }),
      }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize,
        clear: vi.fn(),
        advanceResetEpoch: vi.fn(() => true),
      }) as unknown as ImageRecognitionCoordinator,
      resolveAnchor: (_identity, nodeId) => ({
        document: sourceDocument,
        replayLease: 1,
        image: images[nodeId - descriptor.nodeId]!,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({
          translate: async (text: string) => `translated:${text}`,
          destroy: vi.fn(),
        }),
      },
      onAutoLanguageDetected: (language) => detected.push(language),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      methodOrder: ['accessibility-text', 'tesseract'],
      disabledMethodIds: [],
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(emitChange).toBeTypeOf('function'));

    emitChange?.({ kind: 'upsert', descriptor });
    await vi.waitFor(() => expect(diagnostics).toContain(
      'accessibility-text-provisional',
    ));
    emitChange?.({ kind: 'upsert', descriptor: secondDescriptor });
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(2));
    emitChange?.({ kind: 'upsert', descriptor: thirdDescriptor });
    await vi.waitFor(() => expect(document.querySelectorAll(
      '[data-simul-image-method="tesseract"]',
    )).toHaveLength(3));

    expect(detected).toEqual([]);
    expect(document.querySelectorAll(
      '[data-simul-image-method="accessibility-text"]',
    )).toHaveLength(0);
    controller.dispose();
  });

  it('preloads accessibility text while preserving OCR provider order', async () => {
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
      'accessibility-text',
      'ocr:chrome-text-detector',
      'ocr:tesseract',
    ]);
    expect(acquire).toHaveBeenCalledOnce();
    controller.setTopPageOrigin('https://example.test/first');
    controller.releaseReplica();
    expect(clearRecognition).toHaveBeenCalledOnce();
    controller.setTopPageOrigin('https://example.test/second');
    expect(clearRecognition).toHaveBeenCalledOnce();
    controller.setTopPageOrigin('https://other.test/next');
    expect(clearRecognition).toHaveBeenCalledTimes(2);
    controller.purgeSourceDerivedCache();
    expect(clearRecognition).toHaveBeenCalledTimes(3);
    controller.dispose();
  });

  it('reuses pixel-confirmed OCR and translation evidence across same-origin documents', async () => {
    const replicas = new Map<string, ReturnType<typeof parseHTML>>();
    let activeDocumentId = 'origin-document-1';
    const makeRequest = (documentId: string, pageEpoch: number) => ({
      sessionId: 'origin-cache-session',
      pageEpoch,
      generation: pageEpoch,
      documentId,
      frameId: 0,
      tabId: 4,
      isCurrent: () => activeDocumentId === documentId,
    }) satisfies ReplicaCaptureRequest;
    const firstRequest = makeRequest('origin-document-1', 11);
    const secondRequest = makeRequest('origin-document-2', 12);
    const thirdRequest = makeRequest('origin-document-3', 13);
    const fourthRequest = makeRequest('origin-document-4', 14);
    for (const current of [
      firstRequest,
      secondRequest,
      thirdRequest,
      fourthRequest,
    ]) {
      replicas.set(current.documentId, parseHTML('<html><body><img></body></html>'));
    }
    const callbacks = new Map<string, (change: SourceImageChange) => void>();
    const openSource = vi.fn(async (
      current: ReplicaCaptureRequest,
      onChange: (change: SourceImageChange) => void,
    ) => {
      callbacks.set(current.documentId, onChange);
      const currentDocument = {
        sessionId: current.sessionId,
        pageEpoch: current.pageEpoch,
        generation: current.generation,
        documentId: current.documentId,
        frameId: current.frameId,
      };
      queueMicrotask(() => onChange({
        kind: 'upsert',
        descriptor: {
          ...descriptor,
          document: currentDocument,
        },
      }));
      return { measure: vi.fn(), dispose: vi.fn() };
    });
    const acquire = vi.fn(async (current: SourceImageDescriptor) => ({
      status: 'ready' as const,
      pixels: {
        ...autoProbePixels(current, '91'.repeat(32)),
        nearestElementLanguage: 'en' as const,
      },
    }));
    const recognize = vi.fn(async (): Promise<ImageRecognitionResult> => ({
      status: 'complete',
      cacheHit: false,
      selectedQuality: acceptedQualitySummary(),
      result: {
        providerId: 'tesseract',
        bitmapWidth: 200,
        bitmapHeight: 100,
        transcript: 'Mainichi Newspaper',
        transcriptConfidence: 0.97,
        regions: [{
          text: 'Mainichi Newspaper',
          confidence: 0.97,
          boundingBox: { x: 10, y: 10, width: 170, height: 40 },
        }],
      },
    }));
    const translate = vi.fn(async () => '毎日新聞');
    const createSession = vi.fn(async () => ({ translate, destroy: vi.fn() }));
    const diagnostics: unknown[] = [];
    let now = 1_000;
    const controller = new ImageTranslationController({
      openSource,
      createPixelCoordinator: () => ({ acquire }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize,
        clear: vi.fn(),
        advanceResetEpoch: vi.fn(() => true),
      }) as unknown as ImageRecognitionCoordinator,
      resolveAnchor: (identity) => {
        const replica = replicas.get(identity.documentId);
        const image = replica?.document.querySelector('img') as
          | HTMLImageElement
          | null;
        return replica && image
          ? {
              document: identity,
              replayLease: 1,
              image,
              iframe: { contentDocument: replica.document } as HTMLIFrameElement,
            }
          : undefined;
      },
      translationProvider: {
        availability: async () => 'available',
        createSession,
      },
      translationMemory: new TranslationMemory({ now: () => now }),
      now: () => now,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      setTimer: (callback) => {
        queueMicrotask(callback);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: vi.fn(),
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      methodOrder: ['tesseract', 'accessibility-text'],
      disabledMethodIds: [],
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      translationIdle: true,
      resetEpoch: 0,
    });

    controller.setTopPageOrigin('https://news.example.test/first');
    controller.activateReplica(firstRequest, 3, 1);
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(translate).toHaveBeenCalledOnce());
    const selectionsBeforeReuse = diagnostics.filter((diagnostic) =>
      typeof diagnostic === 'object' && diagnostic !== null &&
      'stage' in diagnostic && diagnostic.stage === 'evidence-selection'
    ).length;

    controller.releaseReplica();
    activeDocumentId = secondRequest.documentId;
    controller.setTopPageOrigin('https://news.example.test/second');
    controller.activateReplica(secondRequest, 3, 1);
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(diagnostics).toContainEqual(
      expect.objectContaining({
        stage: 'image-final-cache',
        access: 'hit',
      }),
    ));
    expect(recognize).toHaveBeenCalledOnce();
    expect(translate).toHaveBeenCalledOnce();
    expect(createSession).toHaveBeenCalledOnce();
    expect(diagnostics.filter((diagnostic) =>
      typeof diagnostic === 'object' && diagnostic !== null &&
      'stage' in diagnostic && diagnostic.stage === 'evidence-selection'
    )).toHaveLength(selectionsBeforeReuse);

    controller.releaseReplica();
    activeDocumentId = thirdRequest.documentId;
    now += 15 * 60 * 1_000 + 1;
    controller.setTopPageOrigin('https://news.example.test/third');
    controller.activateReplica(thirdRequest, 3, 1);
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(2));
    expect(acquire).toHaveBeenCalledTimes(3);

    controller.releaseReplica();
    activeDocumentId = fourthRequest.documentId;
    controller.setTopPageOrigin('https://other.example.test/fourth');
    controller.activateReplica(fourthRequest, 3, 1);
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(3));
    expect(acquire).toHaveBeenCalledTimes(4);
    expect(callbacks.size).toBe(4);
    controller.dispose();
  });

  it('tries later providers when reused origin OCR cannot be translated', async () => {
    let activeDocumentId = 'fallback-origin-1';
    const makeRequest = (documentId: string, pageEpoch: number) => ({
      sessionId: 'fallback-origin-session',
      pageEpoch,
      generation: pageEpoch,
      documentId,
      frameId: 0,
      tabId: 4,
      isCurrent: () => activeDocumentId === documentId,
    }) satisfies ReplicaCaptureRequest;
    const firstRequest = makeRequest('fallback-origin-1', 41);
    const secondRequest = makeRequest('fallback-origin-2', 42);
    const replicas = new Map([
      [firstRequest.documentId, parseHTML('<html><body><img></body></html>')],
      [secondRequest.documentId, parseHTML('<html><body><img></body></html>')],
    ]);
    const acquire = vi.fn(async (current: SourceImageDescriptor) => ({
      status: 'ready' as const,
      pixels: {
        ...autoProbePixels(current, '95'.repeat(32)),
        nearestElementLanguage: 'en' as const,
      },
    }));
    const recognize = vi.fn(async (
      _pixels: AcquiredImagePixels,
      route: { readonly providerOrder: readonly string[] },
    ): Promise<ImageRecognitionResult> => {
      const providerId = route.providerOrder[0] === 'chrome-text-detector'
        ? 'chrome-text-detector' as const
        : 'tesseract' as const;
      const transcript = providerId === 'tesseract'
        ? 'cached provider text'
        : 'later provider text';
      return {
        status: 'complete',
        cacheHit: false,
        selectedQuality: acceptedQualitySummary(),
        result: {
          providerId,
          bitmapWidth: 200,
          bitmapHeight: 100,
          transcript,
          transcriptConfidence: 0.98,
          regions: [{
            text: transcript,
            confidence: 0.98,
            boundingBox: { x: 10, y: 10, width: 180, height: 40 },
          }],
        },
      };
    });
    const translated: string[] = [];
    const diagnostics: unknown[] = [];
    const controller = new ImageTranslationController({
      openSource: async (current, onChange) => {
        const currentDocument = {
          sessionId: current.sessionId,
          pageEpoch: current.pageEpoch,
          generation: current.generation,
          documentId: current.documentId,
          frameId: current.frameId,
        };
        queueMicrotask(() => onChange({
          kind: 'upsert',
          descriptor: { ...descriptor, document: currentDocument },
        }));
        return { measure: vi.fn(), dispose: vi.fn() };
      },
      createPixelCoordinator: () => ({ acquire }) as unknown as
        PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize,
        clear: vi.fn(),
        advanceResetEpoch: vi.fn(() => true),
      }) as unknown as ImageRecognitionCoordinator,
      resolveAnchor: (identity) => {
        const replica = replicas.get(identity.documentId);
        const image = replica?.document.querySelector('img') as
          | HTMLImageElement
          | null;
        return replica && image
          ? {
              document: identity,
              replayLease: 1,
              image,
              iframe: { contentDocument: replica.document } as HTMLIFrameElement,
            }
          : undefined;
      },
      translationProvider: {
        availability: async () => 'available',
        createSession: async (pair) => ({
          translate: async (text: string) => {
            if (
              pair.targetLanguage === 'fr' &&
              text === 'cached provider text'
            ) throw new Error('cached candidate cannot be translated');
            translated.push(text);
            return `translated:${text}`;
          },
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
      providerOrder: ['tesseract', 'chrome-text-detector'] as const,
      methodOrder: ['tesseract', 'chrome-text-detector'] as const,
      disabledMethodIds: [] as const,
      sourceLanguage: 'en' as const,
      targetLanguage: 'ja' as const,
      translationIdle: true,
      resetEpoch: 0,
    };
    controller.configure(configuration);
    controller.setTopPageOrigin('https://news.example.test/first');
    controller.activateReplica(firstRequest, 3, 1);
    await vi.waitFor(() => expect(diagnostics).toContain('projected'));
    await vi.waitFor(() => expect(controller.busy).toBe(false));

    controller.releaseReplica();
    controller.configure({ ...configuration, targetLanguage: 'fr' });
    activeDocumentId = secondRequest.documentId;
    controller.setTopPageOrigin('https://news.example.test/second');
    controller.activateReplica(secondRequest, 3, 1);
    await vi.waitFor(() => expect(
      diagnostics.filter((entry) => entry === 'projected'),
    ).toHaveLength(2));
    await vi.waitFor(() => expect(controller.busy).toBe(false));

    expect(recognize).toHaveBeenCalledTimes(2);
    expect(recognize.mock.calls[1]?.[1]).toMatchObject({
      providerOrder: ['chrome-text-detector'],
    });
    expect(translated).toContain('later provider text');
    expect(diagnostics).toContainEqual(expect.objectContaining({
      stage: 'image-evidence-cache',
      access: 'hit',
    }));
    controller.dispose();
  });

  it('revalidates current pixels before reusing OCR for a same-document carousel clone', async () => {
    const { document } = parseHTML(
      '<html><body><img data-node="12"><img data-node="13"></body></html>',
    );
    let onSourceChange: ((change: SourceImageChange) => void) | undefined;
    const acquire = vi.fn(async (current: SourceImageDescriptor) => ({
      status: 'ready' as const,
      pixels: {
        ...autoProbePixels(current, '92'.repeat(32)),
        nearestElementLanguage: 'en' as const,
      },
    }));
    const recognize = vi.fn(async (): Promise<ImageRecognitionResult> => ({
      status: 'complete',
      cacheHit: false,
      selectedQuality: acceptedQualitySummary(),
      result: {
        providerId: 'tesseract',
        bitmapWidth: 200,
        bitmapHeight: 100,
        transcript: 'Breaking news',
        transcriptConfidence: 0.98,
        regions: [{
          text: 'Breaking news',
          confidence: 0.98,
          boundingBox: { x: 10, y: 10, width: 160, height: 40 },
        }],
      },
    }));
    const translate = vi.fn(async () => 'ニュース速報');
    const diagnostics: unknown[] = [];
    const controller = new ImageTranslationController({
      openSource: async (_request, callback) => {
        onSourceChange = callback;
        queueMicrotask(() => callback({ kind: 'upsert', descriptor }));
        return { measure: vi.fn(), dispose: vi.fn() };
      },
      createPixelCoordinator: () => ({ acquire }) as unknown as
        PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize,
        clear: vi.fn(),
        advanceResetEpoch: vi.fn(() => true),
      }) as unknown as ImageRecognitionCoordinator,
      resolveAnchor: (_identity, nodeId) => {
        const image = document.querySelector<HTMLImageElement>(
          `[data-node="${nodeId}"]`,
        );
        return image
          ? {
              document: sourceDocument,
              replayLease: 1,
              image: image as unknown as HTMLImageElement,
              iframe: { contentDocument: document } as HTMLIFrameElement,
            }
          : undefined;
      },
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({ translate, destroy: vi.fn() }),
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      methodOrder: ['tesseract'],
      disabledMethodIds: [],
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.setTopPageOrigin('https://news.example.test/carousel');
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(translate).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(controller.busy).toBe(false));

    onSourceChange?.({
      kind: 'upsert',
      descriptor: { ...descriptor, nodeId: 13 },
    });
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(controller.busy).toBe(false));

    expect(recognize).toHaveBeenCalledOnce();
    expect(translate).toHaveBeenCalledOnce();
    expect(diagnostics).toContainEqual(expect.objectContaining({
      stage: 'image-final-cache',
      access: 'hit',
    }));
    controller.dispose();
  });

  it('rebinds an unchanged final analysis on an observation-only update', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const currentDescriptor = { ...descriptor, captureRevision: 1 };
    let emitChange: ((change: SourceImageChange) => void) | undefined;
    const acquire = vi.fn(async (current: SourceImageDescriptor) => ({
      status: 'ready' as const,
      pixels: {
        ...autoProbePixels(current, 'ce'.repeat(32)),
        nearestElementLanguage: 'en' as const,
      },
    }));
    const recognize = vi.fn(async () => ({
      ...autoProbeRecognition('Stable headline', 0.98),
      selectedQuality: acceptedQualitySummary(),
    }));
    const translate = vi.fn(async () => '安定した見出し');
    const diagnostics: unknown[] = [];
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        emitChange = onChange;
        queueMicrotask(() => onChange({
          kind: 'upsert',
          descriptor: currentDescriptor,
        }));
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
        image,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({ translate, destroy: vi.fn() }),
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      methodOrder: ['tesseract'],
      disabledMethodIds: [],
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(translate).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(controller.busy).toBe(false));
    const overlayBefore = document.querySelector(
      '[data-simul-image-overlay="12"]',
    );
    expect(overlayBefore).not.toBeNull();

    emitChange?.({
      kind: 'upsert',
      descriptor: {
        ...currentDescriptor,
        observationRevision: 2,
      },
    });
    expect(document.querySelector('[data-simul-image-overlay="12"]'))
      .toBe(overlayBefore);
    expect(controller.busy).toBe(false);
    await vi.waitFor(() => expect(diagnostics).toContainEqual(
      expect.objectContaining({
        stage: 'image-final-cache',
        access: 'rebind',
      }),
    ));
    await vi.waitFor(() => expect(controller.busy).toBe(false));

    expect(acquire).toHaveBeenCalledOnce();
    expect(recognize).toHaveBeenCalledOnce();
    expect(translate).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it('reprocesses only the image whose capture revision actually changed', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const currentDescriptor = { ...descriptor, captureRevision: 1 };
    let emitChange: ((change: SourceImageChange) => void) | undefined;
    const acquire = vi.fn(async (current: SourceImageDescriptor) => ({
      status: 'ready' as const,
      pixels: {
        ...autoProbePixels(
          current,
          current.captureRevision === 2 ? 'd2'.repeat(32) : 'd1'.repeat(32),
        ),
        nearestElementLanguage: 'en' as const,
      },
    }));
    const recognize = vi.fn(async (pixels: AcquiredImagePixels) => ({
      ...autoProbeRecognition(
        pixels.pixelHash === 'd2'.repeat(32) ? 'Updated headline' : 'Headline',
        0.98,
      ),
      selectedQuality: acceptedQualitySummary(),
    }));
    const translate = vi.fn(async (text: string) => `translated:${text}`);
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        emitChange = onChange;
        queueMicrotask(() => onChange({
          kind: 'upsert',
          descriptor: currentDescriptor,
        }));
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
        image,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({ translate, destroy: vi.fn() }),
      },
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      methodOrder: ['tesseract'],
      disabledMethodIds: [],
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(translate).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(controller.busy).toBe(false));

    emitChange?.({
      kind: 'upsert',
      descriptor: {
        ...currentDescriptor,
        captureRevision: 2,
        observationRevision: 2,
      },
    });
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(controller.busy).toBe(false));

    expect(acquire).toHaveBeenCalledTimes(2);
    expect(recognize).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('re-reads changed semantic labels while reusing capture-bound OCR', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const currentDescriptor = { ...descriptor, captureRevision: 1 };
    let emitChange: ((change: SourceImageChange) => void) | undefined;
    let semanticText = 'CDN Media';
    const readAccessibilityText = vi.fn(async (
      current: SourceImageDescriptor,
    ) => ({
      document: sourceDocument,
      nodeId: current.nodeId,
      contentRevision: current.contentRevision,
      observationRevision: current.observationRevision,
      text: semanticText,
      source: 'alt' as const,
      nearestElementLanguage: 'en' as const,
    }));
    const acquire = vi.fn(async (current: SourceImageDescriptor) => ({
      status: 'ready' as const,
      pixels: {
        ...autoProbePixels(current, 'e1'.repeat(32)),
        nearestElementLanguage: 'en' as const,
      },
    }));
    const recognize = vi.fn(async () => ({
      ...autoProbeRecognition('Mainichi Newspaper', 0.98),
      selectedQuality: acceptedQualitySummary(),
    }));
    const translate = vi.fn(async (text: string) => `translated:${text}`);
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        emitChange = onChange;
        queueMicrotask(() => onChange({
          kind: 'upsert',
          descriptor: currentDescriptor,
        }));
        return { measure: vi.fn(), readAccessibilityText, dispose: vi.fn() };
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
        image,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({ translate, destroy: vi.fn() }),
      },
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      methodOrder: ['accessibility-text', 'tesseract'],
      disabledMethodIds: [],
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(controller.busy).toBe(false));
    const ocrOverlayBefore = document.querySelector(
      '[data-simul-image-overlay="12"]',
    );
    expect(ocrOverlayBefore).not.toBeNull();

    semanticText =
      'Official Mainichi Newspaper subscriber information and account notice';
    emitChange?.({
      kind: 'upsert',
      descriptor: {
        ...currentDescriptor,
        contentRevision: 2,
        observationRevision: 2,
      },
    });
    expect(document.querySelector('[data-simul-image-overlay="12"]'))
      .toBe(ocrOverlayBefore);
    await vi.waitFor(() => expect(readAccessibilityText).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(controller.busy).toBe(false));

    expect(acquire).toHaveBeenCalledOnce();
    expect(recognize).toHaveBeenCalledOnce();
    expect(translate).toHaveBeenCalledWith(semanticText, expect.anything());
    controller.dispose();
  });

  it('revalidates staged OCR in place and settles after only capture revision changes', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const currentDescriptor = { ...descriptor, captureRevision: 1 };
    let emitChange: ((change: SourceImageChange) => void) | undefined;
    const acquire = vi.fn(async (current: SourceImageDescriptor) => ({
      status: 'ready' as const,
      pixels: autoProbePixels(
        current,
        (current.captureRevision === 2 ? 'f2' : 'f1').repeat(32),
      ),
    }));
    let invalidationObserved = false;
    const recognize = vi.fn(async (pixels: { pixelHash: string }) => {
      if (pixels.pixelHash === 'f2'.repeat(32)) {
        expect(invalidationObserved).toBe(true);
      }
      return {
        ...autoProbeRecognition('お知らせ', 0.98),
        selectedQuality: acceptedQualitySummary(),
      };
    });
    const diagnostics: unknown[] = [];
    const detected: string[] = [];
    const invalidated: typeof sourceDocument[] = [];
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        emitChange = onChange;
        queueMicrotask(() => onChange({
          kind: 'upsert',
          descriptor: currentDescriptor,
        }));
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
        image,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({
          translate: async () => 'Important corporate-number notice',
          destroy: vi.fn(),
        }),
      },
      onAutoLanguageDetected: (language) => detected.push(language),
      onAutoLanguageInvalidated: (document) => {
        invalidationObserved = true;
        invalidated.push(document);
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      methodOrder: ['tesseract'],
      disabledMethodIds: [],
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(detected).toEqual(['ja']));
    await vi.waitFor(() => expect(controller.busy).toBe(false));
    expect(diagnostics.filter((entry) => entry === 'projected')).toHaveLength(1);

    emitChange?.({
      kind: 'upsert',
      descriptor: {
        ...currentDescriptor,
        captureRevision: 2,
        observationRevision: 2,
      },
    });
    await vi.waitFor(() => expect(diagnostics).toContain(
      'auto-language-probe-reopened',
    ));
    expect(invalidated).toEqual([sourceDocument]);
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(4));
    await vi.waitFor(() => expect(controller.busy).toBe(false));

    expect(acquire).toHaveBeenCalledTimes(3);
    expect(detected).toEqual(['ja', 'ja']);
    expect(diagnostics.filter((entry) => entry === 'projected')).toHaveLength(2);
    expect(diagnostics.filter((entry) =>
      typeof entry === 'object' && entry !== null &&
      'stage' in entry && entry.stage === 'auto-language-probe-resolved'
    )).toHaveLength(2);

    emitChange?.({
      kind: 'upsert',
      descriptor: {
        ...currentDescriptor,
        captureRevision: 2,
        observationRevision: 3,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(acquire).toHaveBeenCalledTimes(3);
    expect(recognize).toHaveBeenCalledTimes(4);
    controller.dispose();
  });

  it('projects and settles semantic evidence after same-language Auto revalidation', async () => {
    const { document } = parseHTML('<html><body><img><img></body></html>');
    const images = [...document.querySelectorAll('img')] as unknown as
      HTMLImageElement[];
    const firstDescriptor = { ...descriptor, captureRevision: 1 };
    const secondDescriptor = {
      ...descriptor,
      nodeId: descriptor.nodeId + 1,
      captureRevision: 1,
    };
    const firstText = '法人番号に関する重要なお知らせ';
    const revisedFirstText = '更新された法人番号に関する重要なお知らせ';
    const secondText = '行政手続きに関する最新の公開情報';
    let emitChange: ((change: SourceImageChange) => void) | undefined;
    const readAccessibilityText = vi.fn(async (
      current: SourceImageDescriptor,
    ) => ({
      document: sourceDocument,
      nodeId: current.nodeId,
      contentRevision: current.contentRevision,
      observationRevision: current.observationRevision,
      text: current.nodeId === secondDescriptor.nodeId
        ? secondText
        : current.contentRevision === firstDescriptor.contentRevision
          ? firstText
          : revisedFirstText,
      source: 'alt' as const,
      nearestElementLanguage: 'ja' as const,
    }));
    const translate = vi.fn(async (text: string) => `translated:${text}`);
    const detected: string[] = [];
    const invalidated: typeof sourceDocument[] = [];
    const diagnostics: unknown[] = [];
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
        image: images[nodeId - descriptor.nodeId]!,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({ translate, destroy: vi.fn() }),
      },
      detectLanguage: async () => ({
        isReliable: true,
        languages: [{ language: 'ja', percentage: 99 }],
      }),
      onAutoLanguageDetected: (language) => detected.push(language),
      onAutoLanguageInvalidated: (current) => invalidated.push(current),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: [],
      methodOrder: ['accessibility-text'],
      disabledMethodIds: [],
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(emitChange).toBeTypeOf('function'));
    emitChange?.({ kind: 'upsert', descriptor: firstDescriptor });
    emitChange?.({ kind: 'upsert', descriptor: secondDescriptor });
    await vi.waitFor(() => expect(detected).toEqual(['ja']));
    await vi.waitFor(() => expect(controller.busy).toBe(false));
    await vi.waitFor(() => expect(document.querySelectorAll(
      '[data-simul-image-method="accessibility-text"]',
    )).toHaveLength(2));
    const projectedBefore = diagnostics.filter((entry) => entry === 'projected')
      .length;

    emitChange?.({
      kind: 'upsert',
      descriptor: {
        ...firstDescriptor,
        contentRevision: 2,
        captureRevision: 2,
        observationRevision: 2,
      },
    });
    await vi.waitFor(() => expect(invalidated).toEqual([sourceDocument]));
    await vi.waitFor(() => expect(detected).toEqual(['ja', 'ja']));
    await vi.waitFor(() => expect(document.querySelector(
      `[data-simul-image-overlay="${firstDescriptor.nodeId}"]` +
        '[data-simul-image-method="accessibility-text"]',
    )?.textContent).toBe(`translated:${revisedFirstText}`));
    await vi.waitFor(() => expect(controller.busy).toBe(false));
    expect(diagnostics.filter((entry) => entry === 'projected').length)
      .toBeGreaterThan(projectedBefore);
    const readsAfterRevalidation = readAccessibilityText.mock.calls.length;
    const translationsAfterRevalidation = translate.mock.calls.length;

    emitChange?.({
      kind: 'upsert',
      descriptor: {
        ...firstDescriptor,
        contentRevision: 2,
        captureRevision: 2,
        observationRevision: 3,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readAccessibilityText).toHaveBeenCalledTimes(readsAfterRevalidation);
    expect(translate).toHaveBeenCalledTimes(translationsAfterRevalidation);
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
      'accessibility-text',
      'ocr:chrome-text-detector',
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

  it('tries the next adjacent OCR provider after translation throws', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const routes: string[][] = [];
    const providerAttempts: string[] = [];
    const pixels = autoProbePixels(descriptor, '1b'.repeat(32));
    const afterChrome = Object.freeze({
      kind: 'simul:image-recognition-continuation' as const,
    }) satisfies ImageRecognitionContinuation;
    const candidate = (
      provider: 'chrome-text-detector' | 'tesseract',
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
        'tesseract',
      ],
      methodOrder: [
        'chrome-text-detector',
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
      'tesseract',
    ]]);
    expect(providerAttempts).toEqual([
      'chrome-text-detector',
      'tesseract',
    ]);
    expect(continueRecognition).toHaveBeenCalledOnce();
    expect(translationAttempt).toBe(2);
    expect(document.querySelector(
      '[data-simul-image-method="tesseract"]',
    )?.textContent).toBe('ニュース');
    controller.dispose();
  });

  it.each([
    ['permission'],
    ['too-small-visible'],
  ] as const)('continues to accessibility text after pixel deferral: %s', async (
    reason,
  ) => {
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
          reason,
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
      reason,
    }));
    expect(readAccessibilityText).toHaveBeenCalledOnce();
    expect(recognize).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('keeps the source open for priority reorder and reopens for read-policy changes', async () => {
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
    await Promise.resolve();
    expect(openSource).toHaveBeenCalledTimes(1);
    controller.configure({
      ...base,
      methodOrder: ['accessibility-text', 'tesseract'],
      disabledMethodIds: [],
    });
    await vi.waitFor(() => expect(openSource).toHaveBeenCalledTimes(2));
    controller.configure({
      ...base,
      methodOrder: ['accessibility-text', 'tesseract'],
      disabledMethodIds: [],
      policyFingerprint: 'read-v1-110000',
      controlImages: true,
    });
    await vi.waitFor(() => expect(openSource).toHaveBeenCalledTimes(3));

    expect(disposals.slice(0, 2).every((dispose) =>
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
      methodOrder: ['tesseract', 'accessibility-text'] as const,
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
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(memory.size).toBeGreaterThan(0));
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(sourceCallbacks).toHaveLength(1);

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

  it('does not restart settled capture retries for replay-lease-only updates', async () => {
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
    await Promise.resolve();
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(controller.notifyReplicaCommit(sourceDocument, 3)).toBe(true);
    await Promise.resolve();
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(diagnostics.filter((diagnostic) =>
      typeof diagnostic === 'object' && diagnostic !== null &&
      'stage' in diagnostic && diagnostic.stage === 'job-progress' &&
      'status' in diagnostic && diagnostic.status === 'capture-retry'
    )).toHaveLength(1);
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

  it('rebinds a completed nonempty result without rerunning blank confirmation', async () => {
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
    await Promise.resolve();

    expect(recognize).toHaveBeenCalledTimes(2);
    expect(diagnostics.filter((diagnostic) =>
      typeof diagnostic === 'object' && diagnostic !== null &&
      'stage' in diagnostic && diagnostic.stage === 'job-progress' &&
      'status' in diagnostic && diagnostic.status === 'no-text-retry'
    )).toHaveLength(1);
    expect(document.querySelector('[data-simul-image-overlay="12"]')).not.toBeNull();
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
    const acquire = vi.fn(async (current: SourceImageDescriptor) => ({
      status: 'ready' as const,
      pixels: {
        ...autoProbePixels(
          current,
          ({ 4: 'de', 5: 'ef', 6: 'fa' } as Record<number, string>)[
            current.contentRevision
          ]?.repeat(32) ?? 'cd'.repeat(32),
        ),
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
        expirations: 0,
        purges: 0,
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
    await Promise.resolve();
    expect(recognize).toHaveBeenCalledOnce();
    expect(diagnostics.filter((diagnostic) => diagnostic === 'projected'))
      .toHaveLength(1);
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
    ).toHaveLength(2));
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
      ordinal: 3,
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
      ordinal: 4,
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
      ordinal: 5,
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

  it('translates the selected OCR transcript with its own detected language', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const pixels = autoProbePixels(descriptor, '7a'.repeat(32));
    const createSession = vi.fn(async () => ({
      translate: async (text: string) => `translated:${text}`,
      destroy: vi.fn(),
    }));
    const recognize = vi.fn(async (
      _pixels: unknown,
      route: { sourceLanguage: string; minimumConfidence?: number },
    ): Promise<ImageRecognitionResult> => {
      if (route.minimumConfidence === 0.8) {
        return route.sourceLanguage === 'en'
          ? autoProbeRecognition('Aviso publico importante', 0.96)
          : autoProbeRecognition();
      }
      return autoProbeRecognition(
        'Important public registration notice',
        0.96,
      );
    });
    const timers = controlledProbeTimers();
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return {
          measure: vi.fn(),
          readAccessibilityText: async () => ({
            document: sourceDocument,
            nodeId: descriptor.nodeId,
            contentRevision: descriptor.contentRevision,
            observationRevision: descriptor.observationRevision,
            text: 'CDN Media',
            source: 'alt' as const,
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
        createSession,
      },
      detectLanguage: async (text) => ({
        isReliable: true,
        languages: [{
          language: text.startsWith('Aviso') ? 'es' : 'en',
          percentage: 99,
        }],
      }),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      methodOrder: ['tesseract', 'accessibility-text'],
      disabledMethodIds: [],
      sourceLanguage: 'auto',
      targetLanguage: 'fr',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);

    await vi.waitFor(() => expect(createSession).toHaveBeenCalled());
    expect(recognize.mock.calls.map((call) =>
      (call[1] as { sourceLanguage: string }).sourceLanguage
    )).toEqual(['ja', 'en', 'es']);
    expect(createSession).toHaveBeenCalledWith(
      { sourceLanguage: 'en', targetLanguage: 'fr' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    controller.dispose();
  });

  it('admits an Auto vote from the OCR continuation that survives ranked fallbacks', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const pixels = autoProbePixels(descriptor, '7b'.repeat(32));
    const primaryText = '法人番号に関する重要なお知らせです';
    const semanticText = '画像情報';
    const continuationText = 'おしらせはこちらです';
    const continuation = Object.freeze({
      kind: 'simul:image-recognition-continuation' as const,
    }) satisfies ImageRecognitionContinuation;
    const recognize = vi.fn(async (): Promise<ImageRecognitionResult> => {
      const result = autoProbeRecognition(primaryText, 0.96);
      if (result.status !== 'complete') throw new Error('Expected OCR result.');
      return {
        ...result,
        continuation,
        selectedQuality: acceptedQualitySummary(),
      };
    });
    const continueRecognition = vi.fn(async () =>
      autoProbeRecognition(continuationText, 0.96)
    );
    let requestCurrent = true;
    const detected: string[] = [];
    const diagnostics: unknown[] = [];
    const translate = vi.fn(async (text: string) => {
      if (text === continuationText) return `translated:${text}`;
      throw new Error('selected evidence translation unavailable');
    });
    const timers = controlledProbeTimers();
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return {
          measure: vi.fn(),
          readAccessibilityText: async () => ({
            document: sourceDocument,
            nodeId: descriptor.nodeId,
            contentRevision: descriptor.contentRevision,
            observationRevision: descriptor.observationRevision,
            text: semanticText,
            source: 'alt' as const,
          }),
          dispose: vi.fn(),
        };
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
        image,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({ translate, destroy: vi.fn() }),
      },
      detectLanguage: async () => ({
        isReliable: true,
        languages: [{ language: 'ja', percentage: 99 }],
      }),
      onAutoLanguageDetected: (language) => {
        detected.push(language);
        requestCurrent = false;
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
      methodOrder: ['tesseract', 'accessibility-text'],
      disabledMethodIds: [],
      sourceLanguage: 'auto',
      targetLanguage: 'fr',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica({
      ...request,
      isCurrent: () => requestCurrent,
    }, 3, 1);

    await vi.waitFor(() => expect(translate).toHaveBeenCalled());
    await vi.waitFor(() => expect(controller.busy).toBe(false));
    expect(detected).toEqual(['ja']);
    expect(translate.mock.calls.map(([text]) => text)).toEqual([
      primaryText,
      semanticText,
      continuationText,
    ]);
    expect(continueRecognition).toHaveBeenCalledOnce();
    expect(diagnostics).toContainEqual({
      stage: 'evidence-selection',
      selected: 'ocr',
      reason: 'ocr-fallback',
    });
    controller.dispose();
  });

  it('translates a validated OCR continuation after the Auto vote deadline', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const pixels = autoProbePixels(descriptor, '7e'.repeat(32));
    const primaryText = '法人番号に関する重要なお知らせです';
    const semanticText = '画像情報';
    const continuationText = 'おしらせはこちらです';
    const continuation = Object.freeze({
      kind: 'simul:image-recognition-continuation' as const,
    }) satisfies ImageRecognitionContinuation;
    const recognize = vi.fn(async (): Promise<ImageRecognitionResult> => {
      const result = autoProbeRecognition(primaryText, 0.96);
      if (result.status !== 'complete') throw new Error('Expected OCR result.');
      return {
        ...result,
        continuation,
        selectedQuality: acceptedQualitySummary(),
      };
    });
    const continueRecognition = vi.fn(async () =>
      autoProbeRecognition(continuationText, 0.96)
    );
    const timers = controlledProbeTimers();
    const detected: string[] = [];
    const diagnostics: unknown[] = [];
    const translate = vi.fn(async (text: string) => {
      if (text === semanticText) timers.deadlineCallbacks[0]?.();
      if (text === continuationText) return `translated:${text}`;
      throw new Error('selected evidence translation unavailable');
    });
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return {
          measure: vi.fn(),
          readAccessibilityText: async () => ({
            document: sourceDocument,
            nodeId: descriptor.nodeId,
            contentRevision: descriptor.contentRevision,
            observationRevision: descriptor.observationRevision,
            text: semanticText,
            source: 'alt' as const,
          }),
          dispose: vi.fn(),
        };
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
        image,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({ translate, destroy: vi.fn() }),
      },
      detectLanguage: async () => ({
        isReliable: true,
        languages: [{ language: 'ja', percentage: 99 }],
      }),
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
      providerOrder: ['tesseract'],
      methodOrder: ['tesseract', 'accessibility-text'],
      disabledMethodIds: [],
      sourceLanguage: 'auto',
      targetLanguage: 'fr',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);

    await vi.waitFor(() => expect(diagnostics).toContain('projected'));
    expect(translate.mock.calls.map(([text]) => text)).toEqual([
      primaryText,
      semanticText,
      continuationText,
    ]);
    expect(detected).toEqual([]);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      stage: 'auto-language-probe-inconclusive',
      reason: 'deadline',
    }));
    controller.dispose();
  });

  it('rolls back staged OCR when semantic selection is aborted', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const ocrText = 'お知らせ';
    const semanticText = '法人番号に関する重要なお知らせと登録情報';
    const diagnostics: unknown[] = [];
    let emitChange: ((change: SourceImageChange) => void) | undefined;
    let replayLease = 1;
    const recognize = vi.fn(async (): Promise<ImageRecognitionResult> => {
      const result = autoProbeRecognition(ocrText, 0.95);
      if (result.status !== 'complete') throw new Error('Expected OCR result.');
      return { ...result, selectedQuality: acceptedQualitySummary() };
    });
    const translate = vi.fn((text: string, signal?: AbortSignal) => {
      if (translate.mock.calls.length > 1) {
        return Promise.resolve(`translated:${text}`);
      }
      return new Promise<string>((_resolve, reject) => {
        const rejectFromAbort = () => reject(
          signal?.reason ?? new DOMException('Translation aborted.', 'AbortError'),
        );
        if (signal?.aborted) rejectFromAbort();
        else signal?.addEventListener('abort', rejectFromAbort, { once: true });
      });
    });
    const timers = controlledProbeTimers();
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        emitChange = onChange;
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return {
          measure: vi.fn(),
          readAccessibilityText: async (current) => ({
            document: sourceDocument,
            nodeId: current.nodeId,
            contentRevision: current.contentRevision,
            observationRevision: current.observationRevision,
            text: semanticText,
            source: 'alt' as const,
            nearestElementLanguage: 'ja' as const,
          }),
          dispose: vi.fn(),
        };
      },
      createPixelCoordinator: () => ({
        acquire: async (current: SourceImageDescriptor) => ({
          status: 'ready',
          pixels: autoProbePixels(current, '7c'.repeat(32)),
        }),
      }) as unknown as PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize,
        clear: vi.fn(),
        advanceResetEpoch: vi.fn(() => true),
      }) as unknown as ImageRecognitionCoordinator,
      resolveAnchor: () => ({
        document: sourceDocument,
        replayLease,
        image,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({ translate, destroy: vi.fn() }),
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
      methodOrder: ['tesseract', 'accessibility-text'],
      disabledMethodIds: [],
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, replayLease);

    await vi.waitFor(() => expect(translate).toHaveBeenCalledOnce());
    expect(controller.cancelCurrent()).toBe(true);
    await vi.waitFor(() => expect(controller.busy).toBe(false));
    emitChange?.({
      kind: 'upsert',
      descriptor: { ...descriptor, observationRevision: 2 },
    });
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(diagnostics).toContain(
      'accessibility-text-complete',
    ));

    expect(recognize).toHaveBeenCalledTimes(2);
    expect(diagnostics.filter((diagnostic) =>
      typeof diagnostic === 'object' && diagnostic !== null &&
      'stage' in diagnostic && diagnostic.stage === 'auto-language-probe-attempt' &&
      'candidateLanguage' in diagnostic && diagnostic.candidateLanguage === 'ja'
    )).toEqual([
      expect.objectContaining({ attempt: 1, sample: 1 }),
    ]);
    controller.dispose();
  });

  it('re-probes after an OCR group throws with provisional Auto language', async () => {
    const pixels = autoProbePixels(descriptor, '7d'.repeat(32));
    const events: string[] = [];
    const detected: string[] = [];
    let requestCurrent = true;
    const timers = controlledProbeTimers();
    const recognize = vi.fn(async (
      _pixels: unknown,
      route: {
        providerOrder?: readonly string[];
        sourceLanguage: string;
        minimumConfidence: number;
      },
    ): Promise<ImageRecognitionResult> => {
      const provider = route.providerOrder?.[0] ?? 'none';
      events.push(`${provider}:${route.sourceLanguage}:${route.minimumConfidence}`);
      if (provider === 'chrome-text-detector' && route.minimumConfidence < 0.8) {
        throw new Error('provider group failed');
      }
      return autoProbeRecognition('おしらせはこちらです', 0.95);
    });
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return {
          measure: vi.fn(),
          readAccessibilityText: async () => undefined,
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
        image: { isConnected: true } as HTMLImageElement,
        iframe: {} as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: vi.fn(),
      },
      onAutoLanguageDetected: (language) => {
        detected.push(language);
        requestCurrent = false;
      },
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
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica({
      ...request,
      isCurrent: () => requestCurrent,
    }, 3, 1);

    await vi.waitFor(() => expect(detected).toEqual(['ja']));
    expect(events).toEqual([
      'chrome-text-detector:ja:0.8',
      'chrome-text-detector:ja:0.65',
      'tesseract:ja:0.8',
    ]);
    controller.dispose();
  });

  it('re-probes after a held provisional OCR continuation throws', async () => {
    const pixels = autoProbePixels(descriptor, '7f'.repeat(32));
    const continuation = Object.freeze({
      kind: 'simul:image-recognition-continuation' as const,
    }) satisfies ImageRecognitionContinuation;
    const events: string[] = [];
    const detected: string[] = [];
    let requestCurrent = true;
    const timers = controlledProbeTimers();
    const recognize = vi.fn(async (
      _pixels: unknown,
      route: {
        providerOrder?: readonly string[];
        sourceLanguage: string;
        minimumConfidence: number;
      },
    ): Promise<ImageRecognitionResult> => {
      const provider = route.providerOrder?.[0] ?? 'none';
      events.push(`${provider}:${route.sourceLanguage}:${route.minimumConfidence}`);
      const result = autoProbeRecognition('おしらせはこちらです', 0.95);
      if (result.status !== 'complete') throw new Error('Expected OCR result.');
      return provider === 'chrome-text-detector' &&
          route.minimumConfidence < 0.8
        ? { ...result, continuation, selectedQuality: acceptedQualitySummary() }
        : result;
    });
    const continueRecognition = vi.fn(async () => {
      throw new Error('continuation provider failed');
    });
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return {
          measure: vi.fn(),
          readAccessibilityText: async () => undefined,
          dispose: vi.fn(),
        };
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
          translate: async () => {
            throw new Error('primary OCR translation unavailable');
          },
          destroy: vi.fn(),
        }),
      },
      onAutoLanguageDetected: (language) => {
        detected.push(language);
        requestCurrent = false;
      },
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
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica({
      ...request,
      isCurrent: () => requestCurrent,
    }, 3, 1);

    await vi.waitFor(() => expect(detected).toEqual(['ja']));
    expect(events).toEqual([
      'chrome-text-detector:ja:0.8',
      'chrome-text-detector:ja:0.65',
      'tesseract:ja:0.8',
    ]);
    expect(continueRecognition).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it('re-probes after a semantic winner throws with provisional OCR staged', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    image.getBoundingClientRect = () => {
      throw new Error('semantic projection failed');
    };
    const pixels = autoProbePixels(descriptor, '80'.repeat(32));
    const events: string[] = [];
    const detected: string[] = [];
    let requestCurrent = true;
    const timers = controlledProbeTimers();
    const recognize = vi.fn(async (
      _pixels: unknown,
      route: {
        providerOrder?: readonly string[];
        sourceLanguage: string;
        minimumConfidence: number;
      },
    ): Promise<ImageRecognitionResult> => {
      const provider = route.providerOrder?.[0] ?? 'none';
      events.push(`${provider}:${route.sourceLanguage}:${route.minimumConfidence}`);
      const result = autoProbeRecognition('お知らせ', 0.95);
      if (result.status !== 'complete') throw new Error('Expected OCR result.');
      return route.minimumConfidence < 0.8
        ? { ...result, selectedQuality: acceptedQualitySummary() }
        : result;
    });
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return {
          measure: vi.fn(),
          readAccessibilityText: async () => ({
            document: sourceDocument,
            nodeId: descriptor.nodeId,
            contentRevision: descriptor.contentRevision,
            observationRevision: descriptor.observationRevision,
            text: '法人番号に関する重要なお知らせと登録情報',
            source: 'alt' as const,
            nearestElementLanguage: 'ja' as const,
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
          translate: async (text: string) => `translated:${text}`,
          destroy: vi.fn(),
        }),
      },
      onAutoLanguageDetected: (language) => {
        detected.push(language);
        requestCurrent = false;
      },
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
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica({
      ...request,
      isCurrent: () => requestCurrent,
    }, 3, 1);

    await vi.waitFor(() => expect(detected).toEqual(['ja']));
    expect(events).toEqual([
      'chrome-text-detector:ja:0.8',
      'chrome-text-detector:ja:0.65',
    ]);
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
      'accessibility-text',
      'chrome-text-detector:ja',
      'chrome-text-detector:en',
      'chrome-text-detector:zh',
      'chrome-text-detector:zh-Hant',
      'chrome-text-detector:ko',
      'chrome-text-detector:ru',
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

  it('clears OCR probe votes and starts a fresh deadline across a same-document reconnect', async () => {
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
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(12));
    // A reconnect is a hard evidence boundary. The revised image receives a
    // fresh sample identity, route budget, and deadline.
    expect(detected).toEqual([]);

    sourceChanges[1]?.({ kind: 'upsert', descriptor: secondDescriptor });
    await vi.waitFor(() => expect(detected).toEqual([
      ['ja', 'distinct-images'],
    ]));
    expect(timers.deadlineCallbacks).toHaveLength(2);
    expect(timers.clearTimer).toHaveBeenCalled();
    controller.dispose();
  });

  it('keeps Auto probe evidence across priority-only provider reordering', async () => {
    const pixels = autoProbePixels(descriptor, '8a'.repeat(32));
    let emitChange: ((change: SourceImageChange) => void) | undefined;
    const diagnostics: unknown[] = [];
    const timers = controlledProbeTimers();
    const recognize = vi.fn(async () => autoProbeRecognition());
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
    const configuration = {
      enabled: true,
      scanPolicy: 'visible-only' as const,
      skipSmallImages: false,
      providerOrder: ['tesseract', 'chrome-text-detector'] as const,
      methodOrder: ['tesseract', 'chrome-text-detector'] as const,
      disabledMethodIds: [] as const,
      policyFingerprint: 'read-v1-100000',
      controlImages: false,
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
    await vi.waitFor(() => expect(
      diagnostics.filter((diagnostic) => diagnostic === 'unsupported-language'),
    ).toHaveLength(1));
    expect(timers.deadlineCallbacks).toHaveLength(1);
    expect(timers.clearTimer).not.toHaveBeenCalled();

    controller.configure({
      ...configuration,
      providerOrder: ['chrome-text-detector', 'tesseract'],
      methodOrder: ['chrome-text-detector', 'tesseract'],
    });
    await Promise.resolve();
    expect(diagnostics.filter((diagnostic) =>
      diagnostic === 'unsupported-language'
    )).toHaveLength(1);

    expect(recognize).toHaveBeenCalledTimes(6);
    expect(timers.deadlineCallbacks).toHaveLength(1);
    expect(timers.clearTimer).not.toHaveBeenCalled();

    controller.configure({
      ...configuration,
      providerOrder: ['tesseract'],
      methodOrder: ['tesseract'],
    });
    expect(timers.clearTimer).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(12));
    expect(timers.deadlineCallbacks).toHaveLength(2);
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

  it('does not preview a generic accessibility label before OCR-first work finishes', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    let finishRecognition!: (result: ImageRecognitionResult) => void;
    const recognition = new Promise<ImageRecognitionResult>((resolve) => {
      finishRecognition = resolve;
    });
    const recognize = vi.fn(() => recognition);
    const translate = vi.fn(async (text: string) => `translated:${text}`);
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return {
          measure: vi.fn(),
          readAccessibilityText: async () => ({
            document: sourceDocument,
            nodeId: descriptor.nodeId,
            contentRevision: descriptor.contentRevision,
            observationRevision: descriptor.observationRevision,
            text: 'CDN Media',
            source: 'alt' as const,
            nearestElementLanguage: 'ja' as const,
          }),
          dispose: vi.fn(),
        };
      },
      createPixelCoordinator: () => ({
        acquire: async () => ({
          status: 'ready',
          pixels: {
            ...autoProbePixels(descriptor, 'a1'.repeat(32)),
            nearestElementLanguage: 'ja' as const,
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
          translate,
          destroy: vi.fn(),
        }),
      },
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      methodOrder: ['tesseract', 'accessibility-text'],
      disabledMethodIds: [],
      sourceLanguage: 'ja',
      targetLanguage: 'en',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.activateReplica(request, 3, 1);

    const completedRecognition = {
      ...autoProbeRecognition('毎日新聞ニュース', 0.98),
      selectedQuality: acceptedQualitySummary(),
    } as ImageRecognitionResult;
    try {
      await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce());
      expect(document.querySelector(
        '[data-simul-image-method="accessibility-text"]',
      )).toBeNull();
      expect(translate).not.toHaveBeenCalled();

      finishRecognition(completedRecognition);
      await vi.waitFor(() => expect(controller.busy).toBe(false));
    } finally {
      finishRecognition(completedRecognition);
      controller.dispose();
    }
  });

  it('preserves active and settled image work across the same effective Auto pair', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    let finishTranslation!: (value: string) => void;
    const translation = new Promise<string>((resolve) => {
      finishTranslation = resolve;
    });
    const translationAborted = vi.fn();
    const acquire = vi.fn(async () => ({
      status: 'ready' as const,
      pixels: autoProbePixels(descriptor, 'af'.repeat(32)),
    }));
    const recognize = vi.fn(async () => ({
      ...autoProbeRecognition('毎日新聞', 0.97),
      selectedQuality: acceptedQualitySummary(),
    }) as ImageRecognitionResult);
    const translate = vi.fn((_text: string, signal?: AbortSignal) => {
      signal?.addEventListener('abort', translationAborted, { once: true });
      return translation;
    });
    const openSource = vi.fn(async (_request, onChange) => {
      queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
      return { measure: vi.fn(), dispose: vi.fn() };
    });
    const controller = new ImageTranslationController({
      openSource,
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
        image,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({ translate, destroy: vi.fn() }),
      },
      projector: testProjectorEnvironment(),
    });
    const autoConfiguration = {
      enabled: true,
      scanPolicy: 'visible-only' as const,
      skipSmallImages: false,
      providerOrder: ['tesseract'] as const,
      methodOrder: ['tesseract'] as const,
      disabledMethodIds: [] as const,
      sourceLanguage: 'auto' as const,
      detectedSourceLanguage: 'ja' as const,
      targetLanguage: 'en' as const,
      translationIdle: true,
      resetEpoch: 0,
    };
    controller.configure(autoConfiguration);
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(translate).toHaveBeenCalledOnce());

    controller.configure({
      ...autoConfiguration,
      sourceLanguage: 'ja',
      detectedSourceLanguage: undefined,
      pageLanguageResolutionPending: true,
    });
    controller.configure({
      ...autoConfiguration,
      pageLanguageResolutionPending: true,
    });
    controller.configure(autoConfiguration);
    expect(translationAborted).not.toHaveBeenCalled();

    finishTranslation('Daily News');
    await vi.waitFor(() => expect(document.querySelector(
      '[data-simul-image-method="tesseract"]',
    )?.textContent).toBe('Daily News'));
    const settledOverlay = document.querySelector('[data-simul-image-overlay]');

    controller.configure({
      ...autoConfiguration,
      sourceLanguage: 'ja',
      detectedSourceLanguage: undefined,
      pageLanguageResolutionPending: true,
    });
    controller.configure({
      ...autoConfiguration,
      pageLanguageResolutionPending: true,
    });
    controller.configure(autoConfiguration);
    await Promise.resolve();

    expect(document.querySelector('[data-simul-image-overlay]'))
      .toBe(settledOverlay);
    expect(openSource).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenCalledOnce();
    expect(recognize).toHaveBeenCalledOnce();
    expect(translate).toHaveBeenCalledOnce();
    expect(translationAborted).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('retires a disconnected paused source and reconnects when translation resumes', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const sourceChanges: Array<(change: SourceImageChange) => void> = [];
    const unavailable: Array<(error: ImageSourceUnavailableError) => void> = [];
    const sourceDisposals: ReturnType<typeof vi.fn>[] = [];
    const openSource = vi.fn(async (_request, onChange) => {
      sourceChanges.push(onChange);
      const dispose = vi.fn();
      sourceDisposals.push(dispose);
      return {
        unavailable: new Promise<ImageSourceUnavailableError>((resolve) => {
          unavailable.push(resolve);
        }),
        measure: vi.fn(),
        dispose,
      };
    });
    const acquire = vi.fn(async (current: SourceImageDescriptor) => ({
      status: 'ready' as const,
      pixels: {
        ...autoProbePixels(current, 'b0'.repeat(32)),
        nearestElementLanguage: 'en' as const,
      },
    }));
    const recognize = vi.fn(async () => ({
      ...autoProbeRecognition('Public notice', 0.97),
      selectedQuality: acceptedQualitySummary(),
    }) as ImageRecognitionResult);
    const diagnostics: unknown[] = [];
    const controller = new ImageTranslationController({
      openSource,
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
        image,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({
          translate: async () => 'Avis public',
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
      disabledMethodIds: [] as const,
      sourceLanguage: 'en' as const,
      targetLanguage: 'ja' as const,
      translationIdle: true,
      resetEpoch: 0,
    };
    controller.configure(configuration);
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(openSource).toHaveBeenCalledOnce());

    controller.configure({ ...configuration, targetLanguage: 'en' });
    unavailable[0]?.(new ImageSourceUnavailableError('paused disconnect'));
    await vi.waitFor(() => expect(sourceDisposals[0]).toHaveBeenCalledOnce());
    expect(openSource).toHaveBeenCalledOnce();
    expect(diagnostics).toContain('source-unavailable');

    controller.configure({ ...configuration, targetLanguage: 'fr' });
    await vi.waitFor(() => expect(openSource).toHaveBeenCalledTimes(2));
    sourceChanges[1]?.({ kind: 'upsert', descriptor });
    await vi.waitFor(() => expect(diagnostics).toContain('projected'));
    await vi.waitFor(() => expect(controller.busy).toBe(false));
    expect(acquire).toHaveBeenCalledOnce();
    expect(recognize).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-simul-image-overlay="12"]')?.textContent)
      .toBe('Avis public');
    controller.dispose();
  });

  it('retranslates retained OCR after a same-language pause without rereading the source', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const diagnostics: unknown[] = [];
    const readAccessibilityText = vi.fn(async () => undefined);
    const acquire = vi.fn(async () => ({
      status: 'ready' as const,
      pixels: {
        ...autoProbePixels(descriptor, 'a2'.repeat(32)),
        nearestElementLanguage: 'ja' as const,
      },
    }));
    const recognize = vi.fn(async () => ({
      ...autoProbeRecognition('毎日新聞', 0.97),
      selectedQuality: acceptedQualitySummary(),
    }) as ImageRecognitionResult);
    const translate = vi.fn(async (target: string, text: string) =>
      `${target}:${text}`
    );
    const disposeSource = vi.fn();
    const openSource = vi.fn(async (_request, onChange) => {
      queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
      return { measure: vi.fn(), readAccessibilityText, dispose: disposeSource };
    });
    const createSession = vi.fn(async (pair: { targetLanguage: string }) => ({
      translate: async (text: string) => translate(pair.targetLanguage, text),
      destroy: vi.fn(),
    }));
    const controller = new ImageTranslationController({
      openSource,
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
        image,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      translationProvider: { availability: async () => 'available', createSession },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      projector: testProjectorEnvironment(),
    });
    const configuration = {
      enabled: true,
      scanPolicy: 'visible-only' as const,
      skipSmallImages: false,
      providerOrder: ['chrome-text-detector', 'tesseract'] as const,
      methodOrder: [
        'chrome-text-detector',
        'tesseract',
        'accessibility-text',
      ] as const,
      disabledMethodIds: [] as const,
      sourceLanguage: 'ja' as const,
      targetLanguage: 'en' as const,
      translationIdle: true,
      resetEpoch: 0,
    };
    controller.configure(configuration);
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(document.querySelector(
      '[data-simul-image-method="tesseract"]',
    )?.textContent).toBe('en:毎日新聞'));

    controller.configure({ ...configuration, targetLanguage: 'ja' });
    expect(document.querySelector('[data-simul-image-overlay]')).toBeNull();
    expect(diagnostics).toContainEqual(expect.objectContaining({
      stage: 'configuration',
      status: 'disabled',
      reason: 'same-language',
    }));

    controller.configure({ ...configuration, targetLanguage: 'fr' });
    await vi.waitFor(() => expect(document.querySelector(
      '[data-simul-image-method="tesseract"]',
    )?.textContent).toBe('fr:毎日新聞'));

    expect(readAccessibilityText).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenCalledOnce();
    expect(recognize).toHaveBeenCalledOnce();
    expect(openSource).toHaveBeenCalledOnce();
    expect(disposeSource).not.toHaveBeenCalled();
    expect(translate.mock.calls).toEqual([
      ['en', '毎日新聞'],
      ['fr', '毎日新聞'],
    ]);
    expect(diagnostics.filter((entry) => entry === 'projected')).toHaveLength(2);
    controller.dispose();
    expect(disposeSource).toHaveBeenCalledOnce();
  });

  it('moves authoritative OCR earlier while reusing enabled corroboration', async () => {
    const run = async (corroboratedRegions: number): Promise<{
      acquireCalls: number;
      recognizeCalls: number;
    }> => {
      const { document } = parseHTML('<html><body><img></body></html>');
      const image = document.querySelector('img') as unknown as HTMLImageElement;
      const diagnostics: unknown[] = [];
      const acquire = vi.fn(async () => ({
        status: 'ready' as const,
        pixels: {
          ...autoProbePixels(descriptor, `a${3 + corroboratedRegions}`.repeat(32)),
          nearestElementLanguage: 'en' as const,
        },
      }));
      const recognize = vi.fn(async (): Promise<ImageRecognitionResult> => ({
        status: 'complete',
        cacheHit: false,
        selectedQuality: {
          ...acceptedQualitySummary(),
          corroboratedRegions,
        },
        result: {
          providerId: 'tesseract',
          bitmapWidth: 200,
          bitmapHeight: 100,
          transcript: 'Official news',
          transcriptConfidence: 0.97,
          regions: [{
            text: 'Official news',
            confidence: 0.97,
            boundingBox: { x: 5, y: 5, width: 150, height: 30 },
          }],
        },
      }));
      const controller = new ImageTranslationController({
        openSource: async (_request, onChange) => {
          queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
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
      const initial = {
        enabled: true,
        scanPolicy: 'visible-only' as const,
        skipSmallImages: false,
        providerOrder: ['chrome-text-detector', 'tesseract'] as const,
        methodOrder: ['chrome-text-detector', 'tesseract'] as const,
        disabledMethodIds: [] as const,
        sourceLanguage: 'en' as const,
        targetLanguage: 'ja' as const,
        translationIdle: true,
        resetEpoch: 0,
      };
      controller.configure(initial);
      controller.activateReplica(request, 3, 1);
      await vi.waitFor(() => expect(
        diagnostics.filter((entry) => entry === 'projected'),
      ).toHaveLength(1));
      controller.configure({
        ...initial,
        providerOrder: ['tesseract', 'chrome-text-detector'],
        methodOrder: ['tesseract', 'chrome-text-detector'],
      });
      await vi.waitFor(() => expect(
        diagnostics.filter((entry) => entry === 'projected'),
      ).toHaveLength(2));
      const result = {
        acquireCalls: acquire.mock.calls.length,
        recognizeCalls: recognize.mock.calls.length,
      };
      controller.dispose();
      return result;
    };

    await expect(run(0)).resolves.toEqual({ acquireCalls: 1, recognizeCalls: 1 });
    await expect(run(1)).resolves.toEqual({ acquireCalls: 1, recognizeCalls: 1 });
  });

  it('retries a retained provider-unavailable OCR route beside semantic evidence', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const readAccessibilityText = vi.fn(async () => ({
      document: sourceDocument,
      nodeId: descriptor.nodeId,
      contentRevision: descriptor.contentRevision,
      observationRevision: descriptor.observationRevision,
      text: 'Official corporate registration news',
      source: 'alt' as const,
      nearestElementLanguage: 'en' as const,
    }));
    const acquire = vi.fn(async () => ({
      status: 'ready' as const,
      pixels: {
        ...autoProbePixels(descriptor, 'a7'.repeat(32)),
        nearestElementLanguage: 'en' as const,
      },
    }));
    const recognize = vi.fn(async (): Promise<ImageRecognitionResult> => ({
      status: 'failed',
      code: 'provider-unavailable',
    }));
    const targets: string[] = [];
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
        return { measure: vi.fn(), readAccessibilityText, dispose: vi.fn() };
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
        image,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: async (pair) => ({
          translate: async () => {
            targets.push(pair.targetLanguage);
            return `${pair.targetLanguage}:News`;
          },
          destroy: vi.fn(),
        }),
      },
      projector: testProjectorEnvironment(),
    });
    const initial = {
      enabled: true,
      scanPolicy: 'visible-only' as const,
      skipSmallImages: false,
      providerOrder: ['tesseract'] as const,
      methodOrder: ['tesseract', 'accessibility-text'] as const,
      disabledMethodIds: [] as const,
      sourceLanguage: 'en' as const,
      targetLanguage: 'ja' as const,
      translationIdle: true,
      resetEpoch: 0,
    };
    controller.configure(initial);
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(targets).toEqual(['ja']));
    await vi.waitFor(() => expect(controller.busy).toBe(false));

    controller.configure({ ...initial, targetLanguage: 'fr' });
    await vi.waitFor(() => expect(targets).toEqual(['ja', 'fr']));
    expect(readAccessibilityText).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(recognize).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('requeues an active OCR job with no retained evidence after priority reorder', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    let finishFirst!: (result: ImageRecognitionResult) => void;
    const first = new Promise<ImageRecognitionResult>((resolve) => {
      finishFirst = resolve;
    });
    const recognize = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValue({
        ...autoProbeRecognition('News', 0.97),
        selectedQuality: acceptedQualitySummary(),
      });
    const acquire = vi.fn(async () => ({
      status: 'ready' as const,
      pixels: {
        ...autoProbePixels(descriptor, 'a5'.repeat(32)),
        nearestElementLanguage: 'en' as const,
      },
    }));
    const diagnostics: unknown[] = [];
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
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
    const initial = {
      enabled: true,
      scanPolicy: 'visible-only' as const,
      skipSmallImages: false,
      providerOrder: ['tesseract', 'chrome-text-detector'] as const,
      methodOrder: ['tesseract', 'chrome-text-detector'] as const,
      disabledMethodIds: [] as const,
      sourceLanguage: 'en' as const,
      targetLanguage: 'ja' as const,
      translationIdle: true,
      resetEpoch: 0,
    };
    controller.configure(initial);
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce());

    controller.configure({
      ...initial,
      providerOrder: ['chrome-text-detector', 'tesseract'],
      methodOrder: ['chrome-text-detector', 'tesseract'],
    });
    finishFirst(autoProbeRecognition('stale', 0.97));

    await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(diagnostics).toContain('projected'));
    expect(acquire).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('reprocesses a settled image when retained evidence expired before priority reorder', async () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    let now = 1_000;
    const recognize = vi.fn(async () => ({
      ...autoProbeRecognition('News', 0.97),
      selectedQuality: acceptedQualitySummary(),
    }));
    const acquire = vi.fn(async () => ({
      status: 'ready' as const,
      pixels: {
        ...autoProbePixels(descriptor, 'a6'.repeat(32)),
        nearestElementLanguage: 'en' as const,
      },
    }));
    const diagnostics: unknown[] = [];
    const controller = new ImageTranslationController({
      openSource: async (_request, onChange) => {
        queueMicrotask(() => onChange({ kind: 'upsert', descriptor }));
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
      now: () => now,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      projector: testProjectorEnvironment(),
    });
    const initial = {
      enabled: true,
      scanPolicy: 'visible-only' as const,
      skipSmallImages: false,
      providerOrder: ['tesseract', 'chrome-text-detector'] as const,
      methodOrder: ['tesseract', 'chrome-text-detector'] as const,
      disabledMethodIds: [] as const,
      sourceLanguage: 'en' as const,
      targetLanguage: 'ja' as const,
      translationIdle: true,
      resetEpoch: 0,
    };
    controller.configure(initial);
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(diagnostics).toContain('projected'));
    await vi.waitFor(() => expect(controller.busy).toBe(false));
    expect(recognize).toHaveBeenCalledOnce();

    now += 15 * 60 * 1_000 + 1;
    controller.configure({
      ...initial,
      providerOrder: ['chrome-text-detector', 'tesseract'],
      methodOrder: ['chrome-text-detector', 'tesseract'],
    });

    await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(controller.busy).toBe(false));
    expect(acquire).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('reuses pixel-confirmed Auto OCR after same-document and same-origin reloads', async () => {
    let activeDocumentId = 'auto-origin-1';
    const makeRequest = (documentId: string, epoch: number) => ({
      sessionId: 'auto-origin-session',
      pageEpoch: epoch,
      generation: epoch,
      documentId,
      frameId: 0,
      tabId: 4,
      isCurrent: () => activeDocumentId === documentId,
    }) satisfies ReplicaCaptureRequest;
    const firstRequest = makeRequest('auto-origin-1', 21);
    const secondRequest = makeRequest('auto-origin-2', 22);
    const replicas = new Map([
      [firstRequest.documentId, parseHTML('<html><body><img></body></html>')],
      [secondRequest.documentId, parseHTML('<html><body><img></body></html>')],
    ]);
    const acquire = vi.fn(async (current: SourceImageDescriptor) => ({
      status: 'ready' as const,
      pixels: autoProbePixels(current, 'a6'.repeat(32)),
    }));
    const recognize = vi.fn(async () => ({
      ...autoProbeRecognition('お知らせはこちらです', 0.97),
      selectedQuality: acceptedQualitySummary(),
    }) as ImageRecognitionResult);
    const detected: string[] = [];
    const timers = controlledProbeTimers();
    const controller = new ImageTranslationController({
      openSource: async (current, onChange) => {
        const currentDocument = {
          sessionId: current.sessionId,
          pageEpoch: current.pageEpoch,
          generation: current.generation,
          documentId: current.documentId,
          frameId: current.frameId,
        };
        queueMicrotask(() => onChange({
          kind: 'upsert',
          descriptor: { ...descriptor, document: currentDocument },
        }));
        return { measure: vi.fn(), dispose: vi.fn() };
      },
      createPixelCoordinator: () => ({ acquire }) as unknown as
        PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize,
        clear: vi.fn(),
        advanceResetEpoch: vi.fn(() => true),
      }) as unknown as ImageRecognitionCoordinator,
      resolveAnchor: (identity) => {
        const replica = replicas.get(identity.documentId);
        const image = replica?.document.querySelector('img') as
          | HTMLImageElement
          | null;
        return replica && image
          ? {
              document: identity,
              replayLease: 1,
              image,
              iframe: { contentDocument: replica.document } as HTMLIFrameElement,
            }
          : undefined;
      },
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({
          translate: async () => 'News',
          destroy: vi.fn(),
        }),
      },
      onAutoLanguageDetected: (language) => detected.push(language),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      methodOrder: ['tesseract'],
      disabledMethodIds: [],
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.setTopPageOrigin('https://news.example.test/first');
    controller.activateReplica(firstRequest, 3, 1);
    await vi.waitFor(() => expect(detected).toEqual(['ja']));
    await vi.waitFor(() => expect(controller.busy).toBe(false));

    controller.releaseReplica();
    controller.activateReplica(firstRequest, 3, 1);
    await vi.waitFor(() => expect(detected).toEqual(['ja', 'ja']));
    await vi.waitFor(() => expect(controller.busy).toBe(false));

    controller.releaseReplica();
    activeDocumentId = secondRequest.documentId;
    controller.setTopPageOrigin('https://news.example.test/second');
    controller.activateReplica(secondRequest, 3, 1);
    await vi.waitFor(() => expect(detected).toEqual(['ja', 'ja', 'ja']));
    await vi.waitFor(() => expect(controller.busy).toBe(false));

    expect(acquire).toHaveBeenCalledTimes(6);
    expect(recognize).toHaveBeenCalledTimes(2);
    expect(timers.deadlineCallbacks).toHaveLength(1);
    controller.dispose();
  });

  it('requires two current images before restoring a cached distinct-image quorum', async () => {
    let activeDocumentId = 'auto-quorum-1';
    const makeRequest = (documentId: string, epoch: number) => ({
      sessionId: 'auto-quorum-session',
      pageEpoch: epoch,
      generation: epoch,
      documentId,
      frameId: 0,
      tabId: 4,
      isCurrent: () => activeDocumentId === documentId,
    }) satisfies ReplicaCaptureRequest;
    const firstRequest = makeRequest('auto-quorum-1', 41);
    const secondRequest = makeRequest('auto-quorum-2', 42);
    const replicas = new Map([
      [firstRequest.documentId, parseHTML('<html><body><img><img></body></html>')],
      [secondRequest.documentId, parseHTML('<html><body><img><img></body></html>')],
    ]);
    let emitCurrentChange: ((change: SourceImageChange) => void) | undefined;
    const documentFor = (current: ReplicaCaptureRequest) => ({
      sessionId: current.sessionId,
      pageEpoch: current.pageEpoch,
      generation: current.generation,
      documentId: current.documentId,
      frameId: current.frameId,
    });
    const descriptorFor = (current: ReplicaCaptureRequest, nodeId: number) => ({
      ...descriptor,
      document: documentFor(current),
      nodeId,
    });
    const acquire = vi.fn(async (current: SourceImageDescriptor) => ({
      status: 'ready' as const,
      pixels: autoProbePixels(current, 'b7'.repeat(32)),
    }));
    const recognize = vi.fn(async (
      _pixels: unknown,
      route: { sourceLanguage: string },
    ) => route.sourceLanguage === 'ja'
      ? {
          ...autoProbeRecognition('お知らせはこちらです', 0.89),
          selectedQuality: acceptedQualitySummary(),
        } as ImageRecognitionResult
      : autoProbeRecognition());
    const detectedDocuments: string[] = [];
    const controller = new ImageTranslationController({
      openSource: async (current, onChange) => {
        emitCurrentChange = onChange;
        queueMicrotask(() => {
          onChange({
            kind: 'upsert',
            descriptor: descriptorFor(current, descriptor.nodeId),
          });
          if (current.documentId === firstRequest.documentId) {
            onChange({
              kind: 'upsert',
              descriptor: descriptorFor(current, descriptor.nodeId + 1),
            });
          }
        });
        return { measure: vi.fn(), dispose: vi.fn() };
      },
      createPixelCoordinator: () => ({ acquire }) as unknown as
        PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize,
        clear: vi.fn(),
        advanceResetEpoch: vi.fn(() => true),
      }) as unknown as ImageRecognitionCoordinator,
      resolveAnchor: (identity, nodeId) => {
        const replica = replicas.get(identity.documentId);
        const image = replica?.document.querySelectorAll('img')
          .item(nodeId - descriptor.nodeId) as HTMLImageElement | null;
        return replica && image
          ? {
              document: identity,
              replayLease: 1,
              image,
              iframe: { contentDocument: replica.document } as HTMLIFrameElement,
            }
          : undefined;
      },
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({
          translate: async () => 'News',
          destroy: vi.fn(),
        }),
      },
      onAutoLanguageDetected: (_language, _evidence, document) => {
        detectedDocuments.push(document.documentId);
      },
      projector: testProjectorEnvironment(),
    });
    controller.configure({
      enabled: true,
      scanPolicy: 'visible-only',
      skipSmallImages: false,
      providerOrder: ['tesseract'],
      methodOrder: ['tesseract'],
      disabledMethodIds: [],
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      translationIdle: true,
      resetEpoch: 0,
    });
    controller.setTopPageOrigin('https://news.example.test/first');
    controller.activateReplica(firstRequest, 3, 1);
    await vi.waitFor(() => expect(detectedDocuments).toEqual([
      firstRequest.documentId,
    ]));
    await vi.waitFor(() => expect(controller.busy).toBe(false));
    const recognitionCallsAfterOriginalQuorum = recognize.mock.calls.length;

    controller.releaseReplica();
    activeDocumentId = secondRequest.documentId;
    controller.setTopPageOrigin('https://news.example.test/second');
    controller.activateReplica(secondRequest, 3, 1);
    await vi.waitFor(() => expect(acquire.mock.calls.some(([current]) =>
      current.document.documentId === secondRequest.documentId
    )).toBe(true));
    await vi.waitFor(() => expect(controller.busy).toBe(false));
    expect(detectedDocuments).toEqual([firstRequest.documentId]);
    expect(recognize).toHaveBeenCalledTimes(recognitionCallsAfterOriginalQuorum);

    emitCurrentChange?.({
      kind: 'upsert',
      descriptor: descriptorFor(secondRequest, descriptor.nodeId + 1),
    });
    await vi.waitFor(() => expect(detectedDocuments).toEqual([
      firstRequest.documentId,
      secondRequest.documentId,
    ]));
    await vi.waitFor(() => expect(controller.busy).toBe(false));
    expect(recognize).toHaveBeenCalledTimes(recognitionCallsAfterOriginalQuorum);
    controller.dispose();
  });

  it('does not reuse an Auto-language origin marker across OCR confidence policies', async () => {
    let activeDocumentId = 'auto-quality-1';
    const makeRequest = (documentId: string, epoch: number) => ({
      sessionId: 'auto-quality-session',
      pageEpoch: epoch,
      generation: epoch,
      documentId,
      frameId: 0,
      tabId: 4,
      isCurrent: () => activeDocumentId === documentId,
    }) satisfies ReplicaCaptureRequest;
    const firstRequest = makeRequest('auto-quality-1', 31);
    const secondRequest = makeRequest('auto-quality-2', 32);
    const replicas = new Map([
      [firstRequest.documentId, parseHTML('<html><body><img></body></html>')],
      [secondRequest.documentId, parseHTML('<html><body><img></body></html>')],
    ]);
    const acquire = vi.fn(async (current: SourceImageDescriptor) => ({
      status: 'ready' as const,
      pixels: autoProbePixels(current, 'b6'.repeat(32)),
    }));
    const recognize = vi.fn(async () => ({
      ...autoProbeRecognition('お知らせはこちらです', 0.97),
      selectedQuality: acceptedQualitySummary(),
    }) as ImageRecognitionResult);
    const detected: string[] = [];
    const timers = controlledProbeTimers();
    const controller = new ImageTranslationController({
      openSource: async (current, onChange) => {
        const currentDocument = {
          sessionId: current.sessionId,
          pageEpoch: current.pageEpoch,
          generation: current.generation,
          documentId: current.documentId,
          frameId: current.frameId,
        };
        queueMicrotask(() => onChange({
          kind: 'upsert',
          descriptor: { ...descriptor, document: currentDocument },
        }));
        return { measure: vi.fn(), dispose: vi.fn() };
      },
      createPixelCoordinator: () => ({ acquire }) as unknown as
        PixelAcquisitionCoordinator,
      createRecognitionCoordinator: () => ({
        recognize,
        clear: vi.fn(),
        advanceResetEpoch: vi.fn(() => true),
      }) as unknown as ImageRecognitionCoordinator,
      resolveAnchor: (identity) => {
        const replica = replicas.get(identity.documentId);
        const image = replica?.document.querySelector('img') as
          | HTMLImageElement
          | null;
        return replica && image
          ? {
              document: identity,
              replayLease: 1,
              image,
              iframe: { contentDocument: replica.document } as HTMLIFrameElement,
            }
          : undefined;
      },
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({
          translate: async () => 'News',
          destroy: vi.fn(),
        }),
      },
      onAutoLanguageDetected: (language) => detected.push(language),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      projector: testProjectorEnvironment(),
    });
    const configuration = {
      enabled: true,
      scanPolicy: 'visible-only' as const,
      skipSmallImages: false,
      providerOrder: ['tesseract'] as const,
      methodOrder: ['tesseract'] as const,
      disabledMethodIds: [] as const,
      ocrMinimumConfidence: 0.65 as const,
      sourceLanguage: 'auto' as const,
      targetLanguage: 'en' as const,
      translationIdle: true,
      resetEpoch: 0,
    };
    controller.configure(configuration);
    controller.setTopPageOrigin('https://news.example.test/first');
    controller.activateReplica(firstRequest, 3, 1);
    await vi.waitFor(() => expect(detected).toEqual(['ja']));
    await vi.waitFor(() => expect(controller.busy).toBe(false));

    controller.releaseReplica();
    activeDocumentId = secondRequest.documentId;
    controller.setTopPageOrigin('https://news.example.test/second');
    controller.configure({ ...configuration, ocrMinimumConfidence: 0.8 });
    controller.activateReplica(secondRequest, 3, 1);
    await vi.waitFor(() => expect(detected).toEqual(['ja', 'ja']));
    await vi.waitFor(() => expect(controller.busy).toBe(false));

    expect(acquire).toHaveBeenCalledTimes(3);
    expect(recognize).toHaveBeenCalledTimes(3);
    expect(timers.deadlineCallbacks).toHaveLength(2);
    controller.dispose();
  });

  it('bounds aggregate exact-document evidence and releases weight on removal', async () => {
    const { document } = parseHTML(
      '<html><body><img><img><img></body></html>',
    );
    const images = [...document.querySelectorAll('img')] as unknown as
      HTMLImageElement[];
    const descriptors = [
      descriptor,
      { ...descriptor, nodeId: 13 },
      { ...descriptor, nodeId: 14 },
    ];
    let emitChange: ((change: SourceImageChange) => void) | undefined;
    const diagnostics: unknown[] = [];
    const largeText = 'A'.repeat(150_000);
    const acquire = vi.fn(async (current: SourceImageDescriptor) => ({
      status: 'ready' as const,
      pixels: {
        ...autoProbePixels(
          current,
          current.nodeId.toString(16).padStart(2, '0').repeat(32),
        ),
        nearestElementLanguage: 'en' as const,
      },
    }));
    const recognize = vi.fn(async (): Promise<ImageRecognitionResult> => ({
      status: 'complete',
      cacheHit: false,
      selectedQuality: acceptedQualitySummary(),
      result: {
        providerId: 'tesseract',
        bitmapWidth: 200,
        bitmapHeight: 100,
        transcript: largeText,
        transcriptConfidence: 0.99,
        regions: [{
          text: largeText,
          confidence: 0.99,
          boundingBox: { x: 0, y: 0, width: 200, height: 100 },
        }],
      },
    }));
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
      resolveAnchor: (_identity, nodeId) => ({
        document: sourceDocument,
        replayLease: 1,
        image: images[nodeId - descriptor.nodeId]!,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      translationProvider: {
        availability: async () => 'available',
        createSession: async () => ({
          translate: async () => 'translated',
          destroy: vi.fn(),
        }),
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      projector: testProjectorEnvironment(),
    });
    const initial = {
      enabled: true,
      scanPolicy: 'visible-only' as const,
      skipSmallImages: false,
      providerOrder: [
        'tesseract',
        'chrome-text-detector',
      ] as const,
      methodOrder: [
        'tesseract',
        'chrome-text-detector',
      ] as const,
      disabledMethodIds: [] as const,
      sourceLanguage: 'en' as const,
      targetLanguage: 'ja' as const,
      translationIdle: true,
      resetEpoch: 0,
    };
    controller.configure(initial);
    controller.activateReplica(request, 3, 1);
    await vi.waitFor(() => expect(emitChange).toBeTypeOf('function'));

    emitChange?.({ kind: 'upsert', descriptor: descriptors[0]! });
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(
      diagnostics.filter((entry) => entry === 'projected'),
    ).toHaveLength(1));
    emitChange?.({ kind: 'upsert', descriptor: descriptors[1]! });
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(
      diagnostics.filter((entry) => entry === 'projected'),
    ).toHaveLength(2));

    emitChange?.({
      kind: 'remove',
      document: sourceDocument,
      nodeId: descriptors[1]!.nodeId,
      contentRevision: descriptors[1]!.contentRevision,
      observationRevision: descriptors[1]!.observationRevision + 1,
    });
    emitChange?.({ kind: 'upsert', descriptor: descriptors[2]! });
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(
      diagnostics.filter((entry) => entry === 'projected'),
    ).toHaveLength(3));

    controller.configure({
      ...initial,
      providerOrder: [
        'chrome-text-detector',
        'tesseract',
      ],
      methodOrder: [
        'chrome-text-detector',
        'tesseract',
      ],
    });
    await vi.waitFor(() => expect(
      diagnostics.filter((entry) => entry === 'projected'),
    ).toHaveLength(6));
    expect(acquire).toHaveBeenCalledTimes(6);
    expect(recognize).toHaveBeenCalledTimes(6);
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

function acceptedQualitySummary() {
  return Object.freeze({
    candidateRegions: 1,
    acceptedRegions: 1,
    corroboratedRegions: 0,
    uncertainRegions: 0,
    rejectedBlankRegions: 0,
    rejectedPunctuationRegions: 0,
    rejectedLowConfidenceRegions: 0,
    rejectedUncorroboratedRegions: 0,
  });
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
