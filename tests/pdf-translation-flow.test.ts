import { describe, expect, it, vi } from 'vitest';

import { CapturePipeline } from '../entrypoints/sidepanel/capture-pipeline';
import { CompanionState } from '../entrypoints/sidepanel/companion-state';
import { Currency } from '../entrypoints/sidepanel/currency';
import { PdfController } from '../entrypoints/sidepanel/pdf-controller';
import type { PdfViewSurface } from '../entrypoints/sidepanel/pdf-view';
import {
  TranslationDriver,
  type PendingAutoImageLanguageEvidence,
} from '../entrypoints/sidepanel/translation-driver';
import { LatestWorkCoordinator } from '../lib/companion-lifecycle';
import { AutoLanguageEvidencePrecedence } from '../lib/language-detection';
import { NavigationRefreshGate } from '../lib/navigation-refresh-gate';
import type { PdfReadingPosition } from '../lib/pdf/pdf-layout';
import { PdfTextSurface } from '../lib/pdf/pdf-text-surface';
import type { PdfDocumentHandle, PdfTextContent } from '../lib/pdf/pdfjs-runtime';
import { withViewSettings } from '../lib/preferences';
import { IsolatedReplicaFailureRecoveryGate } from '../lib/replica/replica-recovery';
import { ReplicaSurfaceRouter } from '../lib/replica/replica-surface-router';
import type { TranslationSession } from '../lib/translation-provider';
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

function fakeDocument(
  getTextContent: (page: number) => Promise<PdfTextContent> = async (page) => pageText(page),
): PdfDocumentHandle {
  return {
    pageCount: PAGES,
    getPageSize: async () => ({ width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] }),
    getTextContent,
    hasImages: async () => false,
    render: async () => 1,
    fontFaces: async () => ({}),
    releasePage: async () => undefined,
    destroy: async () => undefined,
  };
}

function setup(options: {
  fetchPdf?: () => Promise<Uint8Array>;
  openDocument?: () => Promise<PdfDocumentHandle>;
} = {}) {
  const state = new CompanionState({ isDetachedWindow: false });
  state.preferences = {
    ...withViewSettings(state.preferences, { sourceLanguage: 'fr', targetLanguage: 'en' }),
    autoTranslateAllSites: true,
  };
  const currency = new Currency();
  const captureCoordinator = new LatestWorkCoordinator<{
    identity: typeof IDENTITY;
    reason: 'initial' | 'manual' | 'navigation' | 'authorized' | 'preference' | 'desynchronized';
  }>();
  const statuses: string[] = [];

  // Chrome's Translator: every call is recorded; while `hold` is on, each
  // waits until the test releases it.
  const calls: string[] = [];
  const waiting: Array<() => void> = [];
  const translator = { hold: false };
  const session: TranslationSession = {
    translate: async (text, signal) => {
      calls.push(text);
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
  const controller = new PdfController({
    fetchPdf: options.fetchPdf ?? (async () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])),
    openDocument: options.openDocument ?? (async () => fakeDocument()),
    view,
    surface,
    onPriorityChange: () => coordinator.reprioritize(),
    priorityDelayMs: 0,
    now: () => 0,
  });
  const driver = new TranslationDriver({
    state,
    currency,
    provider,
    coordinator,
    captureCoordinator,
    evidence: new AutoLanguageEvidencePrecedence<PendingAutoImageLanguageEvidence>(),
    detectLanguage: async () => ({ isReliable: false, languages: [] }),
    getTab: async () => ({ ...IDENTITY, id: IDENTITY.tabId, active: true }),
    autoImageLanguageConfigurationKey: () => 'configuration',
    configureImageTranslation: () => undefined,
    setStatus: (message) => statuses.push(englishUiText(message)),
    localizeUi: (english) => english,
    localizeTemplate: (frame) => frame,
    localizeLanguageName: (language) => language,
    updateControls: () => undefined,
    showProgress: () => undefined,
    hideProgress: () => undefined,
    renderDetectedLanguage: () => undefined,
    invalidateComposer: () => undefined,
    syncComposerPanel: () => undefined,
    onPairPrepared: () => undefined,
    onTranslationSettled: () => undefined,
    isPdfShown: () => controller.shown,
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
    readDocument: async () => ({ documentId: 'DOC', contentType: 'application/pdf' }),
    readZoom: async () => 1,
    getTab: async () => ({ ...IDENTITY, id: IDENTITY.tabId, active: true }),
    reconcileAutomaticAccess: async () => false,
    cancelNavigationRefresh: () => undefined,
    invalidateComposer: () => undefined,
    setStatus: (message) => statuses.push(englishUiText(message)),
    updateControls: () => undefined,
    renderLoading: () => undefined,
    renderError: () => undefined,
    hideReplicaStatus: () => undefined,
    clearCaptureNotes: () => undefined,
    updateMirrorLayout: () => undefined,
    selectSurface: (kind) => router.select(kind === 'pdf' ? surface : mirror),
    logImageDiagnostic: () => undefined,
  });
  return {
    state, pipeline, coordinator, surface, controller, createSession,
    calls, waiting, translator, shown, statuses, reading,
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
