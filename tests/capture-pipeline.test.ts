import { describe, expect, it, vi } from 'vitest';

import { CapturePipeline } from '../entrypoints/sidepanel/capture-pipeline';
import { CompanionState } from '../entrypoints/sidepanel/companion-state';
import { Currency } from '../entrypoints/sidepanel/currency';
import { LatestWorkCoordinator } from '../lib/companion-lifecycle';
import { NavigationRefreshGate } from '../lib/navigation-refresh-gate';
import type { ReplicaCaptureRequest, ReplicaRunResult } from '../lib/replica/contracts';
import { IsolatedReplicaFailureRecoveryGate } from '../lib/replica/replica-recovery';
import type { ReplicaSourceDocumentIdentity } from '../lib/replica/source-identity';
import type {
  ReplicaSourceCommit,
  ReplicaTranslationSnapshot,
} from '../lib/translation/replica-translation-coordinator';

const IDENTITY = { tabId: 4, windowId: 1, url: 'https://example.com/a' };
const OTHER = { tabId: 4, windowId: 1, url: 'https://example.com/b' };

function documentFor(generation: number): ReplicaSourceDocumentIdentity {
  return { sessionId: 'session', pageEpoch: generation, generation, documentId: 'doc-1', frameId: 0 };
}

function snapshotFor(generation: number, text = 'Hello'): ReplicaTranslationSnapshot {
  return { document: documentFor(generation), replayLease: 1, records: [{ source: text }] as never };
}

function setup(options: {
  run?: (request: ReplicaCaptureRequest) => Promise<ReplicaRunResult>;
  readDocumentId?: () => Promise<string | undefined>;
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
    coordinator,
    imageController,
    translationDriver,
    evidence: { invalidate: () => events.push('evidence-invalidated') },
    mirrorSessionId: 'session',
    captureTimeoutMs: 50,
    readDocumentId: vi.fn(options.readDocumentId ?? (async () => 'doc-1')),
    getTab: vi.fn(async (tabId: number) => ({ id: tabId, windowId: 1, url: state.followedPageIdentity?.url, active: true })),
    reconcileAutomaticAccess: vi.fn(async () => options.accessRevoked ?? false),
    cancelNavigationRefresh: () => events.push('refresh-cancelled'),
    invalidateComposer: () => events.push('composer-invalidated'),
    setStatus: (message, tone) => statuses.push([message, tone]),
    updateControls: () => events.push('controls'),
    renderLoading: () => events.push('loading'),
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
    imageController, translationDriver, statuses, events, diagnostics, settled,
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
    const missing = setup({ readDocumentId: async () => undefined });
    missing.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    await missing.settled();
    expect(missing.statuses.at(-1)?.[0]).toContain('did not expose a current document boundary');
    expect(missing.engine.run).not.toHaveBeenCalled();

    const slow = setup({ readDocumentId: () => new Promise(() => undefined) });
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
    let releaseFirst!: (value: string) => void;
    const harness = setup({
      readDocumentId: vi.fn()
        .mockImplementationOnce(() => new Promise<string>((resolve) => {
          releaseFirst = resolve;
        }))
        .mockImplementation(async () => 'doc-1'),
    });
    harness.pipeline.queueCapture({ identity: IDENTITY, reason: 'initial' });
    harness.pipeline.queueCapture({ identity: OTHER, reason: 'navigation' });
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'));
    releaseFirst('doc-1');
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
