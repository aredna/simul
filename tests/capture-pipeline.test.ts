import { describe, expect, it, vi } from 'vitest';
import { englishUiText } from '../lib/ui-text';

import {
  CapturePipeline,
  type SourceDocumentFacts,
} from '../entrypoints/sidepanel/capture-pipeline';
import { CompanionState } from '../entrypoints/sidepanel/companion-state';
import { Currency } from '../entrypoints/sidepanel/currency';
import { LatestWorkCoordinator } from '../lib/companion-lifecycle';
import { NavigationRefreshGate } from '../lib/navigation-refresh-gate';
import { PageAccessError } from '../lib/page-identity';
import type { ReplicaCaptureRequest, ReplicaRunResult } from '../lib/replica/contracts';
import { IsolatedReplicaFailureRecoveryGate } from '../lib/replica/replica-recovery';
import type { ReplicaSourceDocumentIdentity } from '../lib/replica/source-identity';
import type {
  ReplicaSourceCommit,
  ReplicaTranslationSnapshot,
} from '../lib/translation/replica-translation-coordinator';

const IDENTITY = { tabId: 4, windowId: 1, url: 'https://example.com/a' };
const OTHER = { tabId: 4, windowId: 1, url: 'https://example.com/b' };
const HTML_DOCUMENT: SourceDocumentFacts = { documentId: 'doc-1', contentType: 'text/html' };
const PDF_DOCUMENT: SourceDocumentFacts = { documentId: 'doc-1', contentType: 'application/pdf' };

function documentFor(generation: number): ReplicaSourceDocumentIdentity {
  return { sessionId: 'session', pageEpoch: generation, generation, documentId: 'doc-1', frameId: 0 };
}

function snapshotFor(generation: number, text = 'Hello'): ReplicaTranslationSnapshot {
  return { document: documentFor(generation), replayLease: 1, records: [{ source: text }] as never };
}

function setup(options: {
  run?: (request: ReplicaCaptureRequest) => Promise<ReplicaRunResult>;
  readDocument?: () => Promise<SourceDocumentFacts | undefined>;
  readZoom?: () => Promise<number>;
  showPdf?: (url: string, signal: AbortSignal) => Promise<{ pageCount: number }>;
  fieldCount?: number;
  accessRevoked?: boolean;
  maxRebuilds?: number;
} = {}) {
  const state = new CompanionState({ isDetachedWindow: false });
  const currency = new Currency();
  const presentation = { hasCommittedReplica: false, resetSourceScroll: vi.fn() };
  let published: ReplicaTranslationSnapshot | undefined;
  // The real engine reports its checkpoint commit before its run settles.
  let onSourceCommit: (commit: ReplicaSourceCommit) => void = () => undefined;
  const engine = {
    run: vi.fn(options.run ?? (async (request: ReplicaCaptureRequest) => {
      presentation.hasCommittedReplica = true;
      published = snapshotFor(request.generation);
      onSourceCommit({
        document: documentFor(request.generation),
        documentLanguageChanged: false,
        replayLease: 1,
        records: published.records,
        changes: [],
        reason: 'checkpoint',
      });
      return { status: 'complete', diagnostics: { engine: 'isolated-html-v1' } } as unknown as ReplicaRunResult;
    })),
    releasePresentation: vi.fn(() => {
      presentation.hasCommittedReplica = false;
      published = undefined;
    }),
  };
  const pdf = {
    shown: false,
    show: vi.fn(async (url: string, signal: AbortSignal) => {
      const shown = await (options.showPdf ?? (async () => ({ pageCount: 3 })))(url, signal);
      pdf.shown = true;
      return shown;
    }),
    close: vi.fn(() => {
      pdf.shown = false;
    }),
  };
  const coordinator = { selectPair: vi.fn(), handleSourceCommit: vi.fn() };
  const imageController = {
    setTopPageOrigin: vi.fn(),
    releaseReplica: vi.fn(),
    activateReplica: vi.fn(() => true),
    notifyReplicaCommit: vi.fn(),
  };
  const translationDriver = {
    resolveSelectedSourceLanguage: vi.fn(async () => true),
    currentReplicaLanguageContext: vi.fn(() => undefined),
    currentTranslationFieldCount: vi.fn(() => options.fieldCount ?? 1),
    checkAvailability: vi.fn(async () => undefined),
    maybeTranslateAutomatically: vi.fn(async () => undefined),
    clearAutoImageLanguageForDifferentDocument: vi.fn(),
    clearAutoImageLanguageResolution: vi.fn(),
    reconcileAfterCommit: vi.fn(async () => undefined),
  };
  const statuses: Array<[string, string | undefined]> = [];
  const events: string[] = [];
  const diagnostics: unknown[] = [];
  const captureCoordinator = new LatestWorkCoordinator<{ identity: typeof IDENTITY; reason: 'initial' | 'manual' | 'navigation' | 'authorized' | 'preference' | 'desynchronized' }>();
  const recoveryGate = new IsolatedReplicaFailureRecoveryGate({ maxRebuilds: options.maxRebuilds ?? 3 });
  const pipeline = new CapturePipeline({
    state,
    currency,
    captureCoordinator,
    navigationRefreshGate: new NavigationRefreshGate(),
    recoveryGate,
    engine,
    surface: { snapshot: () => published },
    presentation,
    pdf,
    coordinator,
    imageController,
    translationDriver,
    evidence: { invalidate: () => events.push('evidence-invalidated') },
    mirrorSessionId: 'session',
    captureTimeoutMs: 50,
    readDocument: vi.fn(options.readDocument ?? (async () => HTML_DOCUMENT)),
    readZoom: vi.fn(options.readZoom ?? (async () => 1)),
    getTab: vi.fn(async (tabId: number) => ({ id: tabId, windowId: 1, url: state.followedPageIdentity?.url, active: true })),
    reconcileAutomaticAccess: vi.fn(async () => options.accessRevoked ?? false),
    cancelNavigationRefresh: () => events.push('refresh-cancelled'),
    invalidateComposer: () => events.push('composer-invalidated'),
    setStatus: (message, tone) => statuses.push([englishUiText(message), tone]),
    updateControls: () => events.push('controls'),
    renderLoading: (message) =>
      events.push(message === undefined ? 'loading' : `loading:${englishUiText(message)}`),
    renderError: (message) => events.push(`error:${message}`),
    hideReplicaStatus: () => events.push('status-hidden'),
    clearCaptureNotes: () => events.push('notes-cleared'),
    updateMirrorLayout: () => events.push('layout'),
    logImageDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  onSourceCommit = (commit) => pipeline.handleReplicaSourceCommit(commit);
  const settled = async () => {
    await vi.waitFor(() => expect(state.captureInFlight).toBe(false));
  };
  return {
    pipeline, state, currency, captureCoordinator, presentation, engine, coordinator,
    imageController, translationDriver, statuses, events, diagnostics, settled, pdf,
    get published() {
      return published;
    },
  };
}

describe('CapturePipeline capture', () => {
  it('builds the replica, publishes the identity and prepares translation', async () => {
    const harness = setup();
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    expect(harness.state.followedPageIdentity).toEqual(IDENTITY);
    expect(harness.state.captureInFlight).toBe(true);
    expect(harness.events).toContain('loading');
    expect(harness.statuses[0]?.[0]).toBe('Building the initial live read-only mirror…');
    await harness.settled();

    expect(harness.engine.run).toHaveBeenCalledOnce();
    expect(harness.state.capturedPageIdentity).toEqual(IDENTITY);
    expect(harness.state.snapshot).toBeDefined();
    expect(harness.imageController.activateReplica).toHaveBeenCalledOnce();
    expect(harness.translationDriver.resolveSelectedSourceLanguage).toHaveBeenCalledOnce();
    expect(harness.translationDriver.checkAvailability).toHaveBeenCalledWith(1);
    expect(harness.translationDriver.maybeTranslateAutomatically).toHaveBeenCalledWith(1, IDENTITY.url);
    expect(harness.events).toContain('layout');
    expect(harness.diagnostics).toEqual([]);
  });

  it('waits for page text and reports a revoked automatic grant', async () => {
    const waiting = setup({ fieldCount: 0 });
    waiting.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await waiting.settled();
    expect(waiting.translationDriver.checkAvailability).not.toHaveBeenCalled();
    expect(waiting.statuses.at(-1)?.[0]).toContain('when visible text arrives');

    const revoked = setup({ accessRevoked: true });
    revoked.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await revoked.settled();
    expect(revoked.translationDriver.maybeTranslateAutomatically).not.toHaveBeenCalled();
    expect(revoked.statuses.at(-1)?.[0]).toContain('removed a saved automatic-access grant');
  });

  it('reports an engine failure and records why image work did not activate', async () => {
    const harness = setup({
      run: async () => ({ status: 'failed', diagnostics: { engine: 'isolated-html-v1' } } as unknown as ReplicaRunResult),
    });
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await harness.settled();
    expect(harness.state.capturedPageIdentity).toBeUndefined();
    expect(harness.statuses.at(-1)).toEqual([
      'The isolated replica could not be prepared. Retry the current page.',
      'error',
    ]);
    expect(harness.events.some((event) => event.startsWith('error:'))).toBe(true);
    expect(harness.diagnostics).toEqual([{ stage: 'replica-not-activated', reason: 'run-failed' }]);
  });

  it('fails a page that hides its document boundary or takes too long', async () => {
    const missing = setup({ readDocument: async () => undefined });
    missing.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await missing.settled();
    expect(missing.statuses.at(-1)?.[0]).toContain('did not expose a current document boundary');
    expect(missing.engine.run).not.toHaveBeenCalled();

    const slow = setup({ readDocument: () => new Promise(() => undefined) });
    slow.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await slow.settled();
    expect(slow.statuses.at(-1)?.[0]).toContain('took too long');
  });

  it('keeps the last good replica and the translation intent on a same-page rebuild', async () => {
    const harness = setup();
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await harness.settled();
    harness.state.translationDesired = true;
    harness.engine.releasePresentation.mockClear();

    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'manual' });
    await harness.settled();
    expect(harness.engine.releasePresentation).not.toHaveBeenCalled();
    expect(harness.state.translationDesired).toBe(true);
    expect(harness.presentation.resetSourceScroll).toHaveBeenCalledTimes(1);

    harness.pipeline.queueCapture({ identity: OTHER, reason: 'navigation' });
    await harness.settled();
    expect(harness.engine.releasePresentation).toHaveBeenCalledOnce();
    expect(harness.state.translationDesired).toBe(false);
    expect(harness.coordinator.selectPair).toHaveBeenCalledWith(undefined);
    expect(harness.state.capturedPageIdentity).toEqual(OTHER);
  });

  it('runs the newest queued capture and drops the superseded one', async () => {
    let releaseFirst!: (value: SourceDocumentFacts) => void;
    const harness = setup({
      readDocument: vi.fn()
        .mockImplementationOnce(() => new Promise<SourceDocumentFacts>((resolve) => {
          releaseFirst = resolve;
        }))
        .mockImplementation(async () => HTML_DOCUMENT),
    });
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    harness.pipeline.queueCapture({ identity: OTHER, reason: 'navigation' });
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'));
    releaseFirst(HTML_DOCUMENT);
    await harness.settled();
    expect(harness.engine.run).toHaveBeenCalledTimes(1);
    expect(harness.engine.run.mock.calls[0]?.[0]?.generation).toBe(2);
    expect(harness.state.capturedPageIdentity).toEqual(OTHER);
  });
});

describe('CapturePipeline commits and failures', () => {
  it('adopts a matching commit and hands live text to the translation driver', async () => {
    const harness = setup();
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await harness.settled();
    const commit: ReplicaSourceCommit = {
      document: documentFor(1),
      documentLanguageChanged: false,
      replayLease: 1,
      records: [{ source: 'More' }] as never,
      changes: [{ kind: 'upsert', record: { source: 'More' } }] as never,
      reason: 'batch',
    };
    harness.pipeline.handleReplicaSourceCommit(commit);
    expect(harness.events).toContain('status-hidden');
    expect(harness.imageController.notifyReplicaCommit).toHaveBeenCalledWith(commit.document, 1);
    expect(harness.coordinator.handleSourceCommit).toHaveBeenCalledWith(commit);
    expect(harness.translationDriver.reconcileAfterCommit).toHaveBeenCalledWith(
      commit,
      expect.objectContaining({ scope: 'language-refresh' }),
      true,
      true,
    );

    harness.translationDriver.reconcileAfterCommit.mockClear();
    harness.pipeline.handleReplicaSourceCommit({ ...commit, changes: [], reason: 'checkpoint' });
    expect(harness.translationDriver.reconcileAfterCommit).not.toHaveBeenCalled();
  });

  it('rebuilds once after a live failure and reports when the budget is spent', async () => {
    const harness = setup({ maxRebuilds: 1 });
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await harness.settled();

    harness.pipeline.handleReplicaLiveFailure('stream_failed');
    expect(harness.statuses.at(-2)?.[0]).toContain('Rebuilding once');
    expect(harness.statuses.at(-1)?.[0]).toContain('Rebuilding once while keeping the current mirror visible');
    await harness.settled();
    expect(harness.engine.run).toHaveBeenCalledTimes(2);

    harness.pipeline.handleReplicaLiveFailure('stream_failed');
    expect(harness.statuses.at(-1)).toEqual([
      'The live replica disconnected again. The last good replica is preserved; choose Refresh to retry.',
      'error',
    ]);
  });

  it('invalidates the companion as one unit and marks a source navigation', async () => {
    const harness = setup();
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await harness.settled();
    const availability = harness.currency.begin('availability');
    harness.state.resolvedSourceLanguageOrigin = 'image';

    harness.pipeline.beginSourceNavigation(OTHER);
    expect(harness.currency.isCurrent(availability)).toBe(false);
    expect(harness.captureCoordinator.isCurrent(1)).toBe(false);
    expect(harness.translationDriver.clearAutoImageLanguageResolution).toHaveBeenCalledOnce();
    expect(harness.imageController.setTopPageOrigin).toHaveBeenLastCalledWith(OTHER.url);
    expect(harness.events).toContain('composer-invalidated');

    harness.pipeline.invalidateCompanion('The source tab was closed.');
    expect(harness.state.followedPageIdentity).toBeUndefined();
    expect(harness.state.snapshot).toBeUndefined();
    expect(harness.engine.releasePresentation).toHaveBeenCalled();
    expect(harness.imageController.setTopPageOrigin).toHaveBeenLastCalledWith(undefined);
    expect(harness.events).toContain('error:The source tab was closed.');
    expect(harness.statuses.at(-1)).toEqual(['The source tab was closed.', 'warning']);
  });
});

describe('CapturePipeline PDFs', () => {
  it('shows a PDF tab without the replica engine and publishes its identity', async () => {
    const harness = setup({ readDocument: async () => PDF_DOCUMENT });
    harness.state.resolvedSourceLanguage = 'fr';
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await harness.settled();

    expect(harness.engine.run).not.toHaveBeenCalled();
    expect(harness.pdf.show).toHaveBeenCalledWith(IDENTITY.url, expect.any(AbortSignal));
    expect(harness.pdf.shown).toBe(true);
    expect(harness.state.capturedPageIdentity).toEqual(IDENTITY);
    expect(harness.state.followedPageIdentity).toEqual(IDENTITY);
    expect(harness.state.snapshot).toBeUndefined();
    expect(harness.state.availability).toBe('unavailable');
    expect(harness.state.pdfAbortController).toBeUndefined();
    expect(harness.translationDriver.resolveSelectedSourceLanguage).toHaveBeenCalledWith(undefined);
    expect(harness.translationDriver.checkAvailability).not.toHaveBeenCalled();
    expect(harness.translationDriver.maybeTranslateAutomatically).not.toHaveBeenCalled();
    expect(harness.events).toContain('loading:Reading the PDF…');
    expect(harness.events.indexOf('status-hidden'))
      .toBeGreaterThan(harness.events.indexOf('loading:Reading the PDF…'));
    expect(harness.statuses.map(([message]) => message)).toContain('Reading the PDF…');
    expect(harness.statuses.at(-1)).toEqual(['Showing the PDF. Pages: 3.', 'success']);
  });

  it('keeps a shown PDF through a same-page rebuild without the loading state', async () => {
    const harness = setup({ readDocument: async () => PDF_DOCUMENT });
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await harness.settled();
    harness.events.length = 0;

    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'manual' });
    await harness.settled();

    expect(harness.pdf.close).not.toHaveBeenCalled();
    expect(harness.pdf.show).toHaveBeenCalledTimes(2);
    expect(harness.events.some((event) => event.startsWith('loading'))).toBe(false);
    expect(harness.statuses.at(-1)).toEqual(['Showing the PDF. Pages: 3.', 'success']);
  });

  it('closes a shown PDF when the next capture is another page or a web page', async () => {
    let contentType = 'application/pdf';
    const harness = setup({
      readDocument: async () => ({ documentId: 'doc-1', contentType }),
    });
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await harness.settled();

    contentType = 'text/html; charset=utf-8';
    harness.events.length = 0;
    harness.pipeline.queueCapture({ identity: OTHER, reason: 'navigation' });
    await harness.settled();

    expect(harness.pdf.close).toHaveBeenCalled();
    expect(harness.pdf.shown).toBe(false);
    expect(harness.engine.run).toHaveBeenCalledOnce();
    expect(harness.state.capturedPageIdentity).toEqual(OTHER);
    expect(harness.state.snapshot).toBeDefined();
    // Closing the PDF leaves the loading state, not an empty panel.
    expect(harness.events.filter((event) => event === 'loading')).toHaveLength(1);
  });

  it('shows a failure in the panel only when no PDF is shown', async () => {
    let fail = true;
    const harness = setup({
      readDocument: async () => PDF_DOCUMENT,
      showPdf: async () => {
        if (fail) throw new PageAccessError('This PDF is password-protected. Simul cannot open it.');
        return { pageCount: 2 };
      },
    });
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await harness.settled();
    expect(harness.events).toContain('error:This PDF is password-protected. Simul cannot open it.');
    expect(harness.statuses.at(-1)).toEqual([
      'This PDF is password-protected. Simul cannot open it.',
      'error',
    ]);
    expect(harness.state.capturedPageIdentity).toBeUndefined();

    fail = false;
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'manual' });
    await harness.settled();
    expect(harness.statuses.at(-1)).toEqual(['Showing the PDF. Pages: 2.', 'success']);

    fail = true;
    harness.events.length = 0;
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'manual' });
    await harness.settled();
    expect(harness.pdf.shown).toBe(true);
    expect(harness.events.some((event) => event.startsWith('error:'))).toBe(false);
    expect(harness.statuses.at(-1)?.[1]).toBe('error');
  });

  it('drops a superseded PDF load silently', async () => {
    const signals: AbortSignal[] = [];
    let contentType = 'application/pdf';
    const harness = setup({
      readDocument: async () => ({ documentId: 'doc-1', contentType }),
      showPdf: (_url, signal) => {
        signals.push(signal);
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () =>
            reject(new DOMException('Loading the PDF was cancelled.', 'AbortError')));
        });
      },
    });
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await vi.waitFor(() => expect(signals).toHaveLength(1));

    harness.pipeline.beginSourceNavigation(OTHER);
    expect(signals[0]?.aborted).toBe(true);
    expect(harness.pdf.close).not.toHaveBeenCalled();

    contentType = 'text/html';
    harness.pipeline.queueCapture({ identity: OTHER, reason: 'navigation' });
    await harness.settled();

    expect(harness.statuses.some(([, tone]) => tone === 'error')).toBe(false);
    expect(harness.events.some((event) => event.startsWith('error:'))).toBe(false);
    expect(harness.state.capturedPageIdentity).toEqual(OTHER);
    expect(harness.state.pdfAbortController).toBeUndefined();
  });

  it('closes the PDF when the companion is invalidated', async () => {
    const harness = setup({ readDocument: async () => PDF_DOCUMENT });
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await harness.settled();

    harness.pipeline.invalidateCompanion('The source tab was closed.');

    expect(harness.pdf.close).toHaveBeenCalled();
    expect(harness.pdf.shown).toBe(false);
    expect(harness.events).toContain('error:The source tab was closed.');
  });
});

describe('CapturePipeline tab zoom', () => {
  it('reads the tab zoom at capture and lays out with it', async () => {
    const harness = setup({ readZoom: async () => 1.25 });
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await harness.settled();
    expect(harness.state.sourceZoomFactor).toBe(1.25);

    const unreadable = setup({ readZoom: async () => { throw new Error('No tab'); } });
    unreadable.state.sourceZoomFactor = 2;
    unreadable.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await unreadable.settled();
    expect(unreadable.state.sourceZoomFactor).toBe(1);
    expect(unreadable.state.capturedPageIdentity).toEqual(IDENTITY);
  });

  it('keeps a zoom change that arrives while the capture reads the zoom', async () => {
    let answer!: (zoom: number) => void;
    const harness = setup({
      readZoom: () => new Promise<number>((resolve) => {
        answer = resolve;
      }),
    });
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await vi.waitFor(() => expect(answer).toBeDefined());

    // Chrome answered 0.6 before the viewer re-fitted to 0.7.
    harness.pipeline.handleSourceZoomChange(IDENTITY.tabId, 0.7);
    answer(0.6);
    await harness.settled();

    expect(harness.state.sourceZoomFactor).toBe(0.7);
  });

  it('follows zoom changes of the followed tab only', async () => {
    const harness = setup();
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await harness.settled();
    harness.events.length = 0;

    harness.pipeline.handleSourceZoomChange(IDENTITY.tabId + 1, 2);
    expect(harness.state.sourceZoomFactor).toBe(1);
    expect(harness.events).not.toContain('layout');

    harness.pipeline.handleSourceZoomChange(IDENTITY.tabId, 1.5);
    expect(harness.state.sourceZoomFactor).toBe(1.5);
    expect(harness.events).toEqual(['layout']);

    harness.pipeline.handleSourceZoomChange(IDENTITY.tabId, Number.NaN);
    expect(harness.state.sourceZoomFactor).toBe(1);

    harness.pipeline.handleSourceZoomChange(IDENTITY.tabId, 3);
    harness.pipeline.invalidateCompanion('The source tab was closed.');
    expect(harness.state.sourceZoomFactor).toBe(1);
  });
});
