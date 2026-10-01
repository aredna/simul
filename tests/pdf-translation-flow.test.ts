import { describe, expect, it, vi } from 'vitest';

import { CapturePipeline } from '../entrypoints/sidepanel/capture-pipeline';
import { CompanionState, type CaptureRequest } from '../entrypoints/sidepanel/companion-state';
import { Currency } from '../entrypoints/sidepanel/currency';
import { PdfController } from '../entrypoints/sidepanel/pdf-controller';
import type { PdfViewSurface } from '../entrypoints/sidepanel/pdf-view';
import {
  TranslationDriver,
  type PendingAutoImageLanguageEvidence,
} from '../entrypoints/sidepanel/translation-driver';
import { LatestWorkCoordinator } from '../lib/companion-lifecycle';
import { UI_STRINGS } from '../lib/companion-ui-strings';
import { AutoLanguageEvidencePrecedence } from '../lib/language-detection';
import { NavigationRefreshGate } from '../lib/navigation-refresh-gate';
import { PdfFetchError } from '../lib/pdf/pdf-fetch';
import type { PdfReadingPosition } from '../lib/pdf/pdf-layout';
import { PdfTextSurface } from '../lib/pdf/pdf-text-surface';
import type { PdfDocumentHandle, PdfTextContent } from '../lib/pdf/pdfjs-runtime';
import { withViewSettings } from '../lib/preferences';
import { IsolatedReplicaFailureRecoveryGate } from '../lib/replica/replica-recovery';
import { ReplicaSurfaceRouter } from '../lib/replica/replica-surface-router';
import type {
  ImageRecognitionResult,
  ImageRecognitionRoute,
} from '../lib/ocr/image-analysis-coordinator';
import type { ImageTextProviderId } from '../lib/ocr/known-provider-ids';
import type { AcquiredImagePixels } from '../lib/ocr/pixel-acquisition';
import type { SourceLanguagePreference } from '../lib/preferences';
import type { SupportedLanguage, TranslationSession } from '../lib/translation-provider';
import { ReplicaTranslationCoordinator } from '../lib/translation/replica-translation-coordinator';
import { TranslationMemory } from '../lib/translation/translation-memory';
import { englishUiText } from '../lib/ui-text';

/**
 * The PDF translation path end to end, with the real pipeline, driver,
 * coordinator, router, controller and surface; only pdf.js, the view and
 * Chrome's Translator are stand-ins.
 */

const IDENTITY = { tabId: 4, windowId: 1, url: 'https://example.com/report.pdf' };
const PAGES = 4;

/** Two blocks per page, far apart: "P<n> first." and "P<n> second." */
function pageText(page: number): PdfTextContent {
  const line = (str: string, y: number) => ({
    str,
    dir: 'ltr',
    transform: [10, 0, 0, 10, 72, y],
    width: 80,
    height: 10,
    fontName: 'f1',
    hasEOL: true,
  });
  return {
    items: [line(`P${page} first.`, 700), line(`P${page} second.`, 500)],
    styles: { f1: { fontFamily: 'serif', ascent: 0.8, descent: -0.2, vertical: false } },
    lang: null,
  };
}

/** A typed header over a scan: "H<n> header.", at the top of the page. */
function stampedText(page: number): PdfTextContent {
  return { ...pageText(page), items: [{ ...pageText(page).items[0]!, str: `H${page} header.`, transform: [10, 0, 0, 10, 72, 770] }] };
}

function fakeDocument(
  getTextContent: (page: number) => Promise<PdfTextContent> = async (page) => pageText(page),
  scanned: readonly number[] = [],
  stamped: readonly number[] = [],
): PdfDocumentHandle {
  return {
    pageCount: PAGES,
    getPageSize: async () => ({ width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] }),
    getTextContent: async (page) =>
      scanned.includes(page)
        ? { items: [], styles: {}, lang: null }
        : stamped.includes(page)
          ? stampedText(page)
          : getTextContent(page),
    hasImages: async (page) => scanned.includes(page) || stamped.includes(page),
    // A scan covers its page; the text pages here have no pictures.
    imageCoverage: async (page) => (scanned.includes(page) || stamped.includes(page) ? 1 : 0),
    render: async (_page, canvas, scale) => {
      canvas.width = Math.floor(612 * scale);
      canvas.height = Math.floor(792 * scale);
      return scale;
    },
    fontFaces: async () => ({}),
    releasePage: async () => undefined,
    destroy: async () => undefined,
  };
}

function setup(options: {
  fetchPdf?: () => Promise<Uint8Array>;
  /** Reads a PDF chosen on this computer. */
  readFile?: (file: Blob) => Promise<Uint8Array>;
  openDocument?: () => Promise<PdfDocumentHandle>;
  /** Pages (1-based) that are scanned: no text layer, one image. */
  scanned?: readonly number[];
  /** Pages (1-based) that are scans under a typed header, "H<n> header.". */
  stamped?: readonly number[];
  /** What Chrome's Language Detector says of the PDF's text; by default nothing. */
  detectLanguage?: SupportedLanguage;
  /** What OCR reads on a scanned page; by default one line, "S<page> scanned.". */
  ocrText?: (page: number, route: ImageRecognitionRoute) => string | undefined;
  providerOrder?: readonly ImageTextProviderId[];
  /** Pages (1-based) OCR cannot read. */
  ocrFails?: readonly number[];
  sourceLanguage?: SourceLanguagePreference;
  targetLanguage?: SupportedLanguage;
  automatic?: boolean;
  /** Source texts Chrome's Translator fails on. */
  translateFails?: readonly string[];
} = {}) {
  const state = new CompanionState({ isDetachedWindow: false });
  state.preferences = {
    ...withViewSettings(state.preferences, {
      sourceLanguage: options.sourceLanguage ?? 'fr',
      targetLanguage: options.targetLanguage ?? 'en',
    }),
    autoTranslateAllSites: options.automatic ?? true,
    // OCR On also asks for automatic translation, so "not automatic" turns it off.
    ...(options.automatic === false ? { imageTranslationEnabled: false } : {}),
  };
  const currency = new Currency();
  const captureCoordinator = new LatestWorkCoordinator<CaptureRequest>();
  // Every read of the source tab; a PDF chosen on this computer reads none.
  const getTab = vi.fn(async () => ({ ...IDENTITY, id: IDENTITY.tabId, active: true }));
  const readDocument = vi.fn(async () => ({ documentId: 'DOC', contentType: 'application/pdf' }));
  const fetchPdf = vi.fn(
    options.fetchPdf ?? (async () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])),
  );
  const readFile = vi.fn(
    options.readFile ?? (async () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])),
  );
  const errors: string[] = [];
  const statuses: string[] = [];
  const detected: string[] = [];

  // Chrome's Translator: every call is recorded; while `hold` is on, each
  // waits until the test releases it.
  const calls: string[] = [];
  const waiting: Array<() => void> = [];
  const translator = { hold: false };
  const session: TranslationSession = {
    translate: async (text, signal) => {
      calls.push(text);
      if (options.translateFails?.includes(text)) throw new Error('The Translator failed.');
      if (translator.hold) {
        await new Promise<void>((resolve, reject) => {
          waiting.push(resolve);
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return `EN:${text}`;
    },
    destroy: () => undefined,
  };
  const createSession = vi.fn(async () => session);
  const provider = { availability: async () => 'available' as const, createSession };

  // The view: the surface shows translations here, in order.
  const shown: string[] = [];
  const surface = new PdfTextSurface({
    setPageText: () => undefined,
    showTranslation: (_id, text) => {
      shown.push(text);
    },
    hideTranslations: () => undefined,
  });
  const reading: { position: PdfReadingPosition | undefined } = { position: undefined };
  const view: PdfViewSurface = {
    mount: () => undefined,
    readingPosition: () => reading.position,
    clear: () => undefined,
    updateLayout: () => undefined,
  };
  const router = new ReplicaSurfaceRouter();
  const coordinator = new ReplicaTranslationCoordinator(provider, router, {
    memory: new TranslationMemory(),
  });

  // Local OCR: every page read is recorded; while `hold` is on, each waits
  // until the test releases it.
  const ocrCalls: number[] = [];
  const ocrWaiting: Array<() => void> = [];
  const ocr = { hold: false };
  const scanned = options.scanned ?? [];
  const recognize = async (
    pixels: AcquiredImagePixels,
    route: ImageRecognitionRoute,
    signal: AbortSignal,
  ): Promise<ImageRecognitionResult> => {
    const page = pixels.descriptor.nodeId;
    ocrCalls.push(page);
    if (ocr.hold) {
      await new Promise<void>((resolve, reject) => {
        ocrWaiting.push(resolve);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    if (options.ocrFails?.includes(page)) return { status: 'failed', code: 'recognition-failed' };
    const text = options.ocrText ? options.ocrText(page, route) : `S${page} scanned.`;
    return {
      status: 'complete',
      cacheHit: false,
      result: {
        providerId: 'tesseract',
        bitmapWidth: pixels.bitmapWidth,
        bitmapHeight: pixels.bitmapHeight,
        transcript: text ?? '',
        transcriptConfidence: 0.95,
        regions: text
          ? [{ text, confidence: 0.95, boundingBox: { x: 100, y: 100, width: 600, height: 40 } }]
          : [],
      },
    };
  };
  const viewerFollower = { start: vi.fn(), stop: vi.fn() };
  const controller = new PdfController({
    fetchPdf,
    readFile,
    viewerFollower,
    openDocument: options.openDocument ??
      (async () => fakeDocument(undefined, scanned, options.stamped)),
    view,
    surface,
    onPriorityChange: () => coordinator.reprioritize(),
    priorityDelayMs: 0,
    now: () => 0,
    ocr: {
      environment: {
        createCanvas: () => ({ width: 0, height: 0 }),
        render: {
          createSurface: () => ({
            getContext: () => ({ drawImage: () => undefined }),
            convertToBlob: async () => new Blob([crypto.randomUUID()]),
          }),
          digest: (bytes) => crypto.subtle.digest('SHA-256', bytes),
        },
        recognize,
        wait: async () => undefined,
      },
      providerOrder: () => options.providerOrder ?? ['tesseract'],
      minimumConfidence: () => 0.65,
    },
  });
  const driver = new TranslationDriver({
    state,
    currency,
    provider,
    coordinator,
    captureCoordinator,
    evidence: new AutoLanguageEvidencePrecedence<PendingAutoImageLanguageEvidence>(),
    detectLanguage: async () => (options.detectLanguage
      ? { isReliable: true, languages: [{ language: options.detectLanguage, percentage: 100 }] }
      : { isReliable: false, languages: [] }),
    getTab,
    autoImageLanguageConfigurationKey: () => 'configuration',
    configureImageTranslation: () => undefined,
    setStatus: (message) => statuses.push(englishUiText(message)),
    localizeUi: (english) => english,
    localizeTemplate: (frame) => frame,
    localizeLanguageName: (language) => language,
    updateControls: () => undefined,
    showProgress: () => undefined,
    hideProgress: () => undefined,
    renderDetectedLanguage: (text) => {
      detected.push(text);
    },
    invalidateComposer: () => undefined,
    syncComposerPanel: () => undefined,
    onPairPrepared: () => undefined,
    // As in main.ts: reading stops with the run, and the published snapshot
    // takes the pages it read.
    onTranslationSettled: () => {
      controller.stopScannedReading();
      pipeline.adoptReadPdfText();
    },
    isPdfShown: () => controller.shown,
    hasUnreadText: () =>
      controller.shown &&
      controller.scannedPagesState(state.selectedPair()?.sourceLanguage) === 'readable',
    beginTranslationRun: (pair, signal) => {
      if (!controller.shown) return;
      void controller.readScannedPages(pair.sourceLanguage, signal).catch(() => undefined);
    },
    scannedPagesNote: () => (controller.shown ? controller.scannedPagesNote() : undefined),
    probeScannedLanguage: () => pipeline.probePdfLanguage(new AbortController().signal),
  });
  const mirror = {
    beginProjection: () => undefined,
    snapshot: () => undefined,
    project: () => false,
    resolveImageAnchor: () => undefined,
  };
  const pipeline = new CapturePipeline({
    state,
    currency,
    captureCoordinator,
    navigationRefreshGate: new NavigationRefreshGate(),
    recoveryGate: new IsolatedReplicaFailureRecoveryGate(),
    engine: {
      run: async () => {
        throw new Error('The mirror never runs for a PDF.');
      },
      releasePresentation: () => undefined,
    },
    surface: router,
    presentation: { hasCommittedReplica: false, resetSourceScroll: () => undefined },
    pdf: controller,
    coordinator,
    imageController: {
      setTopPageOrigin: () => undefined,
      releaseReplica: () => undefined,
      activateReplica: () => false,
      notifyReplicaCommit: () => undefined,
    },
    translationDriver: driver,
    evidence: { invalidate: () => undefined },
    mirrorSessionId: 'session',
    captureTimeoutMs: 1_000,
    readDocument,
    readZoom: async () => 1,
    getTab,
    reconcileAutomaticAccess: async () => false,
    cancelNavigationRefresh: () => undefined,
    invalidateComposer: () => undefined,
    setStatus: (message) => statuses.push(englishUiText(message)),
    updateControls: () => undefined,
    renderLoading: () => undefined,
    renderError: (message) => {
      errors.push(englishUiText(message));
    },
    hideReplicaStatus: () => undefined,
    clearCaptureNotes: () => undefined,
    updateMirrorLayout: () => undefined,
    selectSurface: (kind) => router.select(kind === 'pdf' ? surface : mirror),
    logImageDiagnostic: () => undefined,
  });
  return {
    state, pipeline, coordinator, surface, controller, createSession, driver,
    calls, waiting, translator, shown, statuses, reading,
    ocr, ocrCalls, ocrWaiting, captureCoordinator, detected,
    getTab, readDocument, fetchPdf, readFile, errors, viewerFollower,
  };
}

const ALL = Array.from({ length: PAGES }, (_, index) => [
  `EN:P${index + 1} first.`,
  `EN:P${index + 1} second.`,
]).flat();

describe('PDF translation, end to end', () => {
  it('reads every page, then translates the whole PDF in one run, reading page first', async () => {
    const harness = setup();

    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });

    await vi.waitFor(() => expect(harness.shown).toHaveLength(PAGES * 2));
    expect(harness.shown).toEqual(ALL);
    // A PDF has no live updates to promise.
    await vi.waitFor(() => expect(harness.statuses.at(-1)).toBe('The PDF is translated.'));
    expect(harness.state.translationComplete).toBe(true);
    expect(harness.createSession).toHaveBeenCalledOnce();
    // The view follows the tab's own PDF viewer (D108).
    expect(harness.viewerFollower.start).toHaveBeenCalledOnce();
    expect(harness.viewerFollower.start.mock.calls[0]?.[0]).toEqual({
      tabId: IDENTITY.tabId,
      documentId: expect.any(String),
    });
  });

  it('stops every later block when Cancel is pressed mid-document', async () => {
    const harness = setup();
    harness.translator.hold = true;
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    // Let three blocks through, then press Cancel while the fourth waits.
    for (let released = 0; released < 3; released += 1) {
      await vi.waitFor(() => expect(harness.waiting).toHaveLength(1));
      harness.waiting.shift()!();
    }
    await vi.waitFor(() => expect(harness.waiting).toHaveLength(1));
    harness.state.activeAbortController!.abort();

    await vi.waitFor(() => expect(harness.state.translationInFlight).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.shown).toEqual(ALL.slice(0, 3));
    expect(harness.calls).toHaveLength(4);
    expect(harness.statuses.at(-1)).toBe('Translation cancelled. Existing translated text was kept.');
    expect(harness.state.translationComplete).toBe(false);
  });

  it('translates the page on screen first again after a Refresh, from memory', async () => {
    const harness = setup();
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await vi.waitFor(() => expect(harness.shown).toHaveLength(PAGES * 2));
    await vi.waitFor(() => expect(harness.state.translationInFlight).toBe(false));
    harness.shown.length = 0;
    const calls = harness.calls.length;

    // The reader is on page 3 and chooses Refresh.
    harness.reading.position = { index: 2, fraction: 0.1 };
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'manual' });

    await vi.waitFor(() => expect(harness.shown).toHaveLength(PAGES * 2));
    expect(harness.shown).toEqual([
      'EN:P3 first.', 'EN:P3 second.',
      'EN:P4 first.', 'EN:P4 second.',
      'EN:P2 first.', 'EN:P2 second.',
      'EN:P1 first.', 'EN:P1 second.',
    ]);
    expect(harness.calls).toHaveLength(calls);
    // The same pair keeps its session.
    expect(harness.createSession).toHaveBeenCalledOnce();
  });

  it('moves the next blocks to the page the reader jumps to', async () => {
    const harness = setup();
    harness.translator.hold = true;
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await vi.waitFor(() => expect(harness.waiting).toHaveLength(1));

    harness.controller.handleReadingPage(3);
    // The reordering waits for the reader to stay on the page.
    await new Promise((resolve) => setTimeout(resolve, 10));
    harness.translator.hold = false;
    harness.waiting.shift()!();

    await vi.waitFor(() => expect(harness.shown).toHaveLength(PAGES * 2));
    expect(harness.shown.slice(0, 3)).toEqual(['EN:P1 first.', 'EN:P4 first.', 'EN:P4 second.']);
  });

  it('never publishes a half-read PDF when a rebuild after an aborted read fails', async () => {
    let downloads = 0;
    let stall = true;
    const harness = setup({
      fetchPdf: async () => {
        downloads += 1;
        if (downloads === 3) throw new Error('Network down');
        return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
      },
      // The second document's page 3 never answers while `stall` holds.
      openDocument: async () => fakeDocument(async (page) => {
        if (downloads === 2 && page === 3 && stall) await new Promise<never>(() => undefined);
        return pageText(page);
      }),
    });
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await vi.waitFor(() => expect(harness.shown).toHaveLength(PAGES * 2));
    await vi.waitFor(() => expect(harness.state.translationInFlight).toBe(false));

    // A Refresh shows a new copy whose text is half read ...
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'manual' });
    await vi.waitFor(() => expect(downloads).toBe(2));
    await vi.waitFor(() => expect(harness.state.captureInFlight).toBe(false));
    expect(harness.state.snapshot).toBeUndefined();
    // ... then another Refresh aborts that read and fails to download.
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'manual' });
    await vi.waitFor(() => expect(harness.state.captureInFlight).toBe(false));
    stall = false;

    expect(downloads).toBe(3);
    expect(harness.surface.snapshot()).toBeUndefined();
    expect(harness.state.snapshot).toBeUndefined();
    expect(harness.statuses.at(-1)).toMatch(/could not be downloaded/u);
  });
});

describe('Scanned PDF pages, end to end', () => {
  const ALL_SCANNED = [1, 2, 3, 4];

  it('reads and translates a scanned PDF in one run, page by page', async () => {
    const harness = setup({ scanned: ALL_SCANNED });

    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });

    await vi.waitFor(() => expect(harness.statuses.at(-1)).toBe('The PDF is translated.'));
    expect(harness.ocrCalls).toEqual([1, 2, 3, 4]);
    expect(harness.shown).toEqual([
      'EN:S1 scanned.', 'EN:S2 scanned.', 'EN:S3 scanned.', 'EN:S4 scanned.',
    ]);
    expect(harness.state.translationComplete).toBe(true);
    // The published snapshot now holds the text the run read.
    expect(harness.state.snapshot?.records).toHaveLength(4);
    expect(harness.createSession).toHaveBeenCalledOnce();
  });

  it('translates text pages while scanned pages are still being read', async () => {
    const harness = setup({ scanned: [2, 4] });
    harness.ocr.hold = true;
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });

    await vi.waitFor(() => expect(harness.shown).toEqual([
      'EN:P1 first.', 'EN:P1 second.', 'EN:P3 first.', 'EN:P3 second.',
    ]));
    await vi.waitFor(() => expect(harness.ocrWaiting).toHaveLength(1));
    expect(harness.statuses).not.toContain('The PDF is translated.');
    expect(harness.state.translationInFlight).toBe(true);

    harness.ocr.hold = false;
    harness.ocrWaiting.shift()!();
    await vi.waitFor(() => expect(harness.statuses.at(-1)).toBe('The PDF is translated.'));
    expect(harness.shown.slice(4)).toEqual(['EN:S2 scanned.', 'EN:S4 scanned.']);
  });

  it('reads nothing until Translate page when translation is not automatic', async () => {
    const harness = setup({ scanned: ALL_SCANNED, automatic: false });
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await vi.waitFor(() => expect(harness.statuses.at(-1)).toMatch(/^Ready to translate/u));
    expect(harness.ocrCalls).toEqual([]);
    expect(harness.driver.currentTranslationFieldCount()).toBe(1);

    await harness.driver.startTranslation(false, harness.captureCoordinator.generation);

    expect(harness.ocrCalls).toEqual([1, 2, 3, 4]);
    expect(harness.statuses.at(-1)).toBe('The PDF is translated.');
  });

  it('stops reading and translating at Cancel, and reads only unread pages next time', async () => {
    const harness = setup({ scanned: ALL_SCANNED, automatic: false });
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await vi.waitFor(() => expect(harness.statuses.at(-1)).toMatch(/^Ready to translate/u));
    harness.ocr.hold = true;
    const run = harness.driver.startTranslation(false, harness.captureCoordinator.generation);
    await vi.waitFor(() => expect(harness.ocrWaiting).toHaveLength(1));
    harness.ocrWaiting.shift()!();
    await vi.waitFor(() => expect(harness.ocrWaiting).toHaveLength(1));
    harness.state.activeAbortController!.abort();
    await run;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(harness.ocrCalls).toEqual([1, 2]);
    expect(harness.shown).toEqual(['EN:S1 scanned.']);
    expect(harness.statuses.at(-1)).toBe('Translation cancelled. Existing translated text was kept.');
    expect(harness.state.translationComplete).toBe(false);

    harness.ocr.hold = false;
    await harness.driver.startTranslation(false, harness.captureCoordinator.generation);
    expect(harness.ocrCalls).toEqual([1, 2, 2, 3, 4]);
    expect(harness.statuses.at(-1)).toBe('The PDF is translated.');
  });

  it('reads the page on screen first again after a Refresh', async () => {
    const harness = setup({ scanned: ALL_SCANNED });
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await vi.waitFor(() => expect(harness.statuses.at(-1)).toBe('The PDF is translated.'));
    harness.ocrCalls.length = 0;
    harness.shown.length = 0;

    harness.reading.position = { index: 2, fraction: 0.1 };
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'manual' });

    await vi.waitFor(() => expect(harness.shown).toHaveLength(4));
    expect(harness.ocrCalls).toEqual([3, 4, 2, 1]);
    expect(harness.shown[0]).toBe('EN:S3 scanned.');
  });

  it('never reads scanned pages in Live source only or when From and To match', async () => {
    const sourceOnly = setup({ scanned: ALL_SCANNED });
    sourceOnly.state.preferences = { ...sourceOnly.state.preferences, replicaViewMode: 'source-only' };
    sourceOnly.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await vi.waitFor(() => expect(sourceOnly.statuses.at(-1))
      .toBe('Live source only is active. The PDF is shown without translation.'));

    const same = setup({ scanned: ALL_SCANNED, sourceLanguage: 'en', targetLanguage: 'en' });
    same.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await vi.waitFor(() => expect(same.state.translationComplete).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sourceOnly.ocrCalls).toEqual([]);
    expect(same.ocrCalls).toEqual([]);
  });

  it('says scanned pages were not read when no image reading method is on', async () => {
    const scanned = setup({ scanned: ALL_SCANNED, providerOrder: [] });
    scanned.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await vi.waitFor(() => expect(scanned.statuses.at(-1))
      .toBe(englishUiText(UI_STRINGS.statusPdfScannedNoMethod)));

    const mixed = setup({ scanned: [2, 4], providerOrder: [] });
    mixed.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await vi.waitFor(() => expect(mixed.statuses.at(-1))
      .toBe(englishUiText(UI_STRINGS.statusPdfScannedNoMethod)));
    expect(mixed.shown).toHaveLength(4);
    expect(mixed.ocrCalls).toEqual([]);
  });

  it('says Simul cannot read a language without an OCR model', async () => {
    const scanned = setup({ scanned: ALL_SCANNED, sourceLanguage: 'th' });
    scanned.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await vi.waitFor(() => expect(scanned.statuses.at(-1))
      .toBe('Scanned pages were not read: Simul has no OCR model for Thai.'));

    const mixed = setup({ scanned: [2, 4], sourceLanguage: 'th' });
    mixed.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await vi.waitFor(() => expect(mixed.statuses.at(-1))
      .toBe('Scanned pages were not read: Simul has no OCR model for Thai.'));
    expect(mixed.shown).toHaveLength(4);
    expect(scanned.ocrCalls).toEqual([]);
    expect(mixed.ocrCalls).toEqual([]);
  });

  it('says when OCR finds no text anywhere, and counts pages it could not read', async () => {
    const empty = setup({ scanned: ALL_SCANNED, ocrText: () => undefined });
    empty.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await vi.waitFor(() => expect(empty.statuses.at(-1)).toBe('No text was found in this PDF.'));
    expect(empty.ocrCalls).toEqual([1, 2, 3, 4]);

    const failing = setup({ scanned: ALL_SCANNED, ocrFails: [3] });
    failing.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await vi.waitFor(() => expect(failing.statuses.at(-1))
      .toBe('Scanned pages that could not be read: 1.'));
    expect(failing.shown).toHaveLength(3);
    // Translate page stays on to read that page again.
    expect(failing.state.translationComplete).toBe(false);
    expect(failing.driver.currentTranslationFieldCount()).toBe(1);
  });

  it('finds the language of a scanned PDF with From = Auto', async () => {
    const harness = setup({
      scanned: ALL_SCANNED,
      sourceLanguage: 'auto',
      ocrText: (_page, route) => route.sourceLanguage === 'ja'
        ? 'これはにほんごのぶんしょうです'
        : undefined,
    });
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });

    await vi.waitFor(() => expect(harness.statuses.at(-1)).toBe('The PDF is translated.'));
    expect(harness.state.resolvedSourceLanguage).toBe('ja');
    expect(harness.shown).toHaveLength(4);
    expect(harness.shown[0]).toBe('EN:これはにほんごのぶんしょうです');
    expect(harness.detected.at(-1)).toBe(UI_STRINGS.statusDetectedFromScannedPages);
  });

  it('probes when From becomes Auto on a scanned PDF', async () => {
    const harness = setup({
      scanned: ALL_SCANNED,
      automatic: false,
      ocrText: (_page, route) => route.sourceLanguage === 'ja'
        ? 'これはにほんごのぶんしょうです'
        : undefined,
    });
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await vi.waitFor(() => expect(harness.statuses.at(-1)).toMatch(/Ready to translate/u));
    expect(harness.ocrCalls).toEqual([]);

    harness.state.preferences = { ...harness.state.preferences, sourceLanguage: 'auto' };
    await harness.driver.applyLanguagePreferences(true);
    expect(harness.state.resolvedSourceLanguage).toBe('ja');
    expect(harness.ocrCalls.length).toBeGreaterThan(0);
    // Asked again, the probe reads nothing more.
    const calls = harness.ocrCalls.length;
    await harness.driver.applyLanguagePreferences(false);
    expect(harness.ocrCalls).toHaveLength(calls);
  });

  it('probes when Translated mode resumes from Live source only', async () => {
    const harness = setup({
      scanned: ALL_SCANNED,
      sourceLanguage: 'auto',
      automatic: false,
      ocrText: (_page, route) => route.sourceLanguage === 'ja'
        ? 'これはにほんごのぶんしょうです'
        : undefined,
    });
    harness.state.preferences = { ...harness.state.preferences, replicaViewMode: 'source-only' };
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await vi.waitFor(() => expect(harness.statuses.at(-1))
      .toBe('Live source only is active. The PDF is shown without translation.'));
    expect(harness.ocrCalls).toEqual([]);

    harness.state.preferences = { ...harness.state.preferences, replicaViewMode: 'translated' };
    harness.driver.applyReplicaViewMode('source-only');
    await vi.waitFor(() => expect(harness.state.resolvedSourceLanguage).toBe('ja'));
  });

  describe('with a typed header over each scan', () => {
    const sources = (harness: ReturnType<typeof setup>) =>
      harness.state.snapshot?.records.map((record) => record.source);

    it('reads the scan as well, and translates the header once', async () => {
      const harness = setup({ stamped: ALL_SCANNED });

      harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });

      await vi.waitFor(() => expect(harness.statuses.at(-1)).toBe('The PDF is translated.'));
      expect(harness.ocrCalls).toEqual([1, 2, 3, 4]);
      // Each page: its header, then what the scan says below it.
      expect(sources(harness)).toEqual([
        'H1 header.', 'S1 scanned.', 'H2 header.', 'S2 scanned.',
        'H3 header.', 'S3 scanned.', 'H4 header.', 'S4 scanned.',
      ]);
      expect([...harness.shown].sort()).toEqual([
        'EN:H1 header.', 'EN:H2 header.', 'EN:H3 header.', 'EN:H4 header.',
        'EN:S1 scanned.', 'EN:S2 scanned.', 'EN:S3 scanned.', 'EN:S4 scanned.',
      ]);
      // Reading a page does not send its header to the Translator again.
      expect(harness.calls.filter((text) => text === 'H1 header.')).toHaveLength(1);
      expect(harness.state.translationComplete).toBe(true);
    });

    it('translates the headers without a reading method, and says nothing of the scans', async () => {
      // The pictures are looked at only when a page can be read.
      const harness = setup({ stamped: ALL_SCANNED, providerOrder: [] });
      harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
      await vi.waitFor(() => expect(harness.statuses.at(-1)).toBe('The PDF is translated.'));
      expect(harness.shown).toHaveLength(4);
      expect(harness.ocrCalls).toEqual([]);
      expect(harness.state.translationComplete).toBe(true);
    });

    it('lets sparse text name the language with From = Auto when no page is a scan', async () => {
      const harness = setup({ sourceLanguage: 'auto', targetLanguage: 'es', detectLanguage: 'en' });
      harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
      await vi.waitFor(() => expect(harness.statuses.at(-1)).toBe('The PDF is translated.'));
      expect(harness.state.resolvedSourceLanguage).toBe('en');
      expect(harness.detected.at(-1)).toBe(UI_STRINGS.statusDetectedFromVisibleText);
      expect(harness.ocrCalls).toEqual([]);
      // The probe looked at the pictures: they are text pages from then on.
      expect(harness.surface.unreadScannedPages()).toEqual([]);
    });

    it('asks the scans for the language with From = Auto, not the stamps', async () => {
      const harness = setup({
        stamped: ALL_SCANNED,
        sourceLanguage: 'auto',
        // The headers alone read as English; the scans are Japanese.
        detectLanguage: 'en',
        ocrText: (_page, route) => route.sourceLanguage === 'ja'
          ? 'これはにほんごのぶんしょうです'
          : undefined,
      });
      harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });

      await vi.waitFor(() => expect(harness.statuses.at(-1)).toBe('The PDF is translated.'));
      expect(harness.state.resolvedSourceLanguage).toBe('ja');
      expect(harness.detected.at(-1)).toBe(UI_STRINGS.statusDetectedFromScannedPages);
      expect(harness.shown).toContain('EN:これはにほんごのぶんしょうです');
      expect(harness.shown).toContain('EN:H1 header.');
    });

    it('lets the text pages name the language when the PDF has some', async () => {
      // Pages of body text beside one stamped scan.
      const body = (page: number): PdfTextContent => ({
        ...pageText(page),
        items: Array.from({ length: 40 }, (_, line) => ({
          ...pageText(page).items[0]!,
          str: `P${page} line ${line + 1} of the body text.`,
          transform: [12, 0, 0, 12, 72, 740 - line * 16],
          width: 440,
          height: 12,
        })),
      });
      const harness = setup({
        openDocument: async () => fakeDocument(async (page) => body(page), [], [2]),
        sourceLanguage: 'auto',
        targetLanguage: 'es',
        detectLanguage: 'en',
      });
      harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });

      await vi.waitFor(() => expect(harness.statuses.at(-1)).toBe('The PDF is translated.'));
      expect(harness.state.resolvedSourceLanguage).toBe('en');
      expect(harness.detected.at(-1)).toBe(UI_STRINGS.statusDetectedFromVisibleText);
      // Read once, by the run, in English: the probe was never asked.
      expect(harness.ocrCalls).toEqual([2]);
      expect(sources(harness)).toContain('S2 scanned.');
    });

    it('translates a text PDF with little text on each page without reading anything', async () => {
      // Tesseract on: each page is looked at, none is a scan.
      const harness = setup({});
      harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
      await vi.waitFor(() => expect(harness.statuses.at(-1)).toBe('The PDF is translated.'));
      expect(harness.ocrCalls).toEqual([]);
      expect(harness.shown).toEqual(ALL);
      expect(harness.surface.unreadScannedPages()).toEqual([]);
      expect(harness.state.translationComplete).toBe(true);

      // No reading method: nothing is looked at, nothing is said, and the
      // translation is complete all the same.
      const off = setup({ providerOrder: [] });
      off.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
      await vi.waitFor(() => expect(off.statuses.at(-1)).toBe('The PDF is translated.'));
      expect(off.shown).toEqual(ALL);
      expect(off.state.translationComplete).toBe(true);
      expect(off.driver.currentTranslationFieldCount()).toBe(1);
    });
  });

  it('reports failed translations before a scanned-page note', async () => {
    const harness = setup({
      scanned: [2, 4],
      ocrFails: [4],
      translateFails: ['P1 first.'],
    });
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await vi.waitFor(() => expect(harness.statuses.at(-1)).toMatch(/^Translation remains partial/u));
    expect(harness.statuses.at(-1)).not.toMatch(/Scanned pages/u);
  });
});

describe('PDFs chosen on this computer, end to end', () => {
  const FILE = new Blob(['%PDF-']);

  it('shows and translates a chosen file like a web PDF, without reading any tab', async () => {
    const harness = setup();

    harness.pipeline.openLocalPdf(FILE);

    await vi.waitFor(() => expect(harness.statuses.at(-1)).toBe('The PDF is translated.'));
    expect(harness.shown).toEqual(ALL);
    expect(harness.readFile).toHaveBeenCalledWith(FILE, expect.anything());
    expect(harness.fetchPdf).not.toHaveBeenCalled();
    expect(harness.readDocument).not.toHaveBeenCalled();
    expect(harness.getTab).not.toHaveBeenCalled();
    expect(harness.state.localPdf?.file).toBe(FILE);
    expect(harness.state.localPdf?.key).toMatch(/^local-file:/u);
    expect(harness.state.capturedPageIdentity).toBeUndefined();
    expect(harness.state.followedPageIdentity).toBeUndefined();
    // No tab, so no viewer to follow.
    expect(harness.viewerFollower.start).not.toHaveBeenCalled();
  });

  it('reads and translates scanned pages of a chosen file too', async () => {
    const harness = setup({ scanned: [1, 2, 3, 4] });

    harness.pipeline.openLocalPdf(FILE);

    await vi.waitFor(() => expect(harness.statuses.at(-1)).toBe('The PDF is translated.'));
    expect(harness.ocrCalls).toEqual([1, 2, 3, 4]);
    expect(harness.shown).toHaveLength(4);
  });

  it('opens the same file again on Refresh, reading page first, translations from memory', async () => {
    const harness = setup();
    harness.pipeline.openLocalPdf(FILE);
    await vi.waitFor(() => expect(harness.shown).toHaveLength(PAGES * 2));
    await vi.waitFor(() => expect(harness.state.translationInFlight).toBe(false));
    const chosen = harness.state.localPdf;
    harness.shown.length = 0;
    const calls = harness.calls.length;

    harness.reading.position = { index: 2, fraction: 0.1 };
    harness.pipeline.reopenLocalPdf('manual');

    await vi.waitFor(() => expect(harness.shown).toHaveLength(PAGES * 2));
    expect(harness.shown.slice(0, 2)).toEqual(['EN:P3 first.', 'EN:P3 second.']);
    expect(harness.calls).toHaveLength(calls);
    expect(harness.readFile).toHaveBeenCalledTimes(2);
    expect(harness.state.localPdf).toBe(chosen);
    expect(harness.getTab).not.toHaveBeenCalled();
  });

  it("waits for the reader's click when nothing asks for automatic translation", async () => {
    const harness = setup({ automatic: false });
    harness.pipeline.openLocalPdf(FILE);
    await vi.waitFor(() => expect(harness.state.availability).toBe('available'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.calls).toEqual([]);

    // Translate page, as main.ts does.
    harness.state.translationDesired = true;
    await harness.driver.startTranslation(false, harness.captureCoordinator.generation);

    expect(harness.shown).toEqual(ALL);
    expect(harness.getTab).not.toHaveBeenCalled();
  });

  it("gives way to a tab's page, and forgets the file", async () => {
    const harness = setup();
    harness.pipeline.openLocalPdf(FILE);
    await vi.waitFor(() => expect(harness.statuses.at(-1)).toBe('The PDF is translated.'));

    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'authorized' });

    await vi.waitFor(() => expect(harness.state.capturedPageIdentity).toEqual(IDENTITY));
    expect(harness.state.localPdf).toBeUndefined();
    expect(harness.fetchPdf).toHaveBeenCalledOnce();
    // A Refresh now rebuilds the tab, never the forgotten file.
    harness.pipeline.reopenLocalPdf('manual');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.readFile).toHaveBeenCalledOnce();
  });

  it("replaces a tab's PDF and forgets that tab", async () => {
    const harness = setup();
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await vi.waitFor(() => expect(harness.statuses.at(-1)).toBe('The PDF is translated.'));

    harness.pipeline.openLocalPdf(FILE);

    await vi.waitFor(() => expect(harness.state.localPdf?.file).toBe(FILE));
    await vi.waitFor(() => expect(harness.state.snapshot?.document.documentId)
      .toBe(harness.state.localPdf?.key));
    expect(harness.state.capturedPageIdentity).toBeUndefined();
    expect(harness.state.followedPageIdentity).toBeUndefined();
  });

  it('forgets the file when the panel follows a page it cannot read', async () => {
    const harness = setup();
    harness.pipeline.openLocalPdf(FILE);
    await vi.waitFor(() => expect(harness.controller.shown).toBe(true));

    harness.pipeline.invalidateCompanion(UI_STRINGS.statusActiveTabNotWebPage);

    expect(harness.state.localPdf).toBeUndefined();
    expect(harness.controller.shown).toBe(false);
  });

  it('says why a file could not be read, shows nothing, and forgets it', async () => {
    const harness = setup({
      readFile: async () => {
        throw new PdfFetchError('failed', 'The PDF file could not be read.');
      },
    });

    harness.pipeline.openLocalPdf(FILE);

    await vi.waitFor(() => expect(harness.state.captureInFlight).toBe(false));
    expect(harness.statuses.at(-1)).toBe(UI_STRINGS.statusPdfFileReadFailed);
    expect(harness.errors).toEqual([UI_STRINGS.statusPdfFileReadFailed]);
    expect(harness.controller.shown).toBe(false);
    expect(harness.state.localPdf).toBeUndefined();
  });

  it('closes and forgets a file a Refresh cannot read again, so the picker shows', async () => {
    let reads = 0;
    const harness = setup({
      readFile: async () => {
        reads += 1;
        if (reads > 1) throw new PdfFetchError('failed', 'The PDF file could not be read.');
        return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
      },
    });
    harness.pipeline.openLocalPdf(FILE);
    await vi.waitFor(() => expect(harness.statuses.at(-1)).toBe('The PDF is translated.'));
    const chosen = harness.state.localPdf;

    harness.pipeline.reopenLocalPdf('manual');

    await vi.waitFor(() => expect(harness.statuses.at(-1)).toBe(UI_STRINGS.statusPdfFileReadFailed));
    expect(chosen).toBeDefined();
    expect(harness.controller.shown).toBe(false);
    expect(harness.state.localPdf).toBeUndefined();
    // The error panel, which offers the picker again.
    expect(harness.errors).toEqual([UI_STRINGS.statusPdfFileReadFailed]);
  });
});
