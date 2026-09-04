import { describe, expect, it, vi } from 'vitest';

import { CapturePipeline } from '../entrypoints/sidepanel/capture-pipeline';
import { CompanionState } from '../entrypoints/sidepanel/companion-state';
import { Currency } from '../entrypoints/sidepanel/currency';
import { LatestWorkCoordinator } from '../lib/companion-lifecycle';
import {
  invokeLivePageObserverBridge,
  invokeLivePageObserverUnregisterBridge,
} from '../lib/live-page-mirror';
import { capturePageSnapshot } from '../lib/page-snapshot';
import {
  LegacyTransitionGate,
  LiveReplicaFailureRecoveryGate,
} from '../lib/replica/legacy-transition-gate';
import type { ReplicaSourceCommit } from '../lib/translation/replica-translation-coordinator';
import {
  PAGE_IDENTITY,
  PAGE_URL,
  flatSnapshotInput,
  mountMirrorView,
  visualSnapshotInput,
} from './helpers/sidepanel-fixtures';

const SESSION_ID = 'session-1234567890';

function setup(options: {
  snapshot?: Record<string, unknown>;
  documentId?: string;
  tabActive?: boolean;
  fieldCount?: number;
  committed?: boolean;
} = {}) {
  const state = new CompanionState({ isDetachedWindow: false });
  const currency = new Currency();
  const captureCoordinator = new LatestWorkCoordinator<never>();
  const mirror = mountMirrorView(() => state.preferences);
  const statuses: string[] = [];
  const runFunction = vi.fn(async (_tabId: number, func: unknown, args: unknown[]) => {
    if (func === invokeLivePageObserverBridge) {
      return [{ result: { installed: true, generation: args[1], sequence: 5 } }];
    }
    if (func === capturePageSnapshot) {
      return [{ result: options.snapshot ?? flatSnapshotInput(), documentId: options.documentId }];
    }
    return [];
  });
  const replayHost = { hasCommittedReplica: options.committed ?? false, resetSourceScroll: vi.fn() };
  const engineController = {
    selectedAvailable: false,
    run: vi.fn(),
    releasePresentation: vi.fn(),
    disableSelected: vi.fn(),
  };
  const replicaTranslation = { selectPair: vi.fn(), handleSourceCommit: vi.fn() };
  const imageTranslation = {
    releaseReplica: vi.fn(),
    activateReplica: vi.fn(() => true),
    notifyReplicaCommit: vi.fn(),
  };
  const translation = {
    resolveSelectedSourceLanguage: vi.fn(async () => true),
    currentTranslationFieldCount: vi.fn(() => options.fieldCount ?? 0),
    checkAvailability: vi.fn(async () => undefined),
    maybeTranslateAutomatically: vi.fn(async () => undefined),
    reconcileReplicaTranslationAfterCommit: vi.fn(async () => undefined),
  };
  const liveUpdates = {
    initializeSequenceBaseline: vi.fn(),
    processPending: vi.fn(async () => undefined),
  };
  const environment = {
    reconcileAutomaticAccess: vi.fn(async () => false),
    invalidateComposer: vi.fn(),
    renderCaptureNotes: vi.fn(),
    updateControls: vi.fn(),
  };
  const legacyTransitionGate = new LegacyTransitionGate();
  const failureRecoveryGate = new LiveReplicaFailureRecoveryGate();
  const pipeline = new CapturePipeline({
    state,
    currency,
    captureCoordinator: captureCoordinator as LatestWorkCoordinator<never>,
    liveSessionId: SESSION_ID,
    scripting: { runFile: vi.fn(async () => [{ result: undefined }]), runFunction },
    captureTimeoutMs: 1_000,
    getTab: async () => ({ ...PAGE_IDENTITY, id: PAGE_IDENTITY.tabId, active: options.tabActive ?? true }),
    mirrorView: mirror.view,
    replayHost,
    engineController,
    replicaSurface: { snapshot: () => undefined },
    replicaTranslation,
    imageTranslation,
    legacyTransitionGate,
    failureRecoveryGate,
    translation,
    liveUpdates,
    setStatus: (message) => statuses.push(message),
    ...environment,
  });
  return {
    pipeline,
    state,
    currency,
    captureCoordinator,
    mirror,
    statuses,
    runFunction,
    replayHost,
    engineController,
    replicaTranslation,
    imageTranslation,
    translation,
    liveUpdates,
    legacyTransitionGate,
    failureRecoveryGate,
    ...environment,
  };
}

async function settled(harness: ReturnType<typeof setup>): Promise<void> {
  await vi.waitFor(() => {
    expect(harness.state.captureInFlight).toBe(false);
    expect(harness.captureCoordinator.hasRunningWork).toBe(false);
  });
}

describe('CapturePipeline capture', () => {
  it('installs the observer, reads the snapshot and waits for page text', async () => {
    const harness = setup();
    harness.pipeline.queueCapture({ identity: PAGE_IDENTITY, reason: 'initial' });
    expect(harness.state.captureInFlight).toBe(true);
    expect(harness.mirror.container.textContent).toContain('Preparing the live read-only mirror');
    await settled(harness);
    expect(harness.runFunction).toHaveBeenCalledWith(
      PAGE_IDENTITY.tabId,
      invokeLivePageObserverBridge,
      [SESSION_ID, 1],
    );
    expect(harness.liveUpdates.initializeSequenceBaseline).toHaveBeenCalledWith(1, 5);
    expect(harness.state.snapshot?.title).toBe('Flat page');
    expect(harness.state.capturedPageIdentity).toEqual(PAGE_IDENTITY);
    expect(harness.state.liveObservationAvailable).toBe(true);
    // No document id means no isolated replica: the legacy view is authoritative.
    expect(harness.engineController.releasePresentation).toHaveBeenCalledWith(true);
    expect(harness.translation.resolveSelectedSourceLanguage).toHaveBeenCalled();
    expect(harness.reconcileAutomaticAccess).toHaveBeenCalledWith(PAGE_URL);
    expect(harness.statuses.at(-1)).toContain('will prepare translation when visible text arrives');
    expect(harness.liveUpdates.processPending).toHaveBeenCalled();
  });

  it('checks availability and hands over to automatic translation when text exists', async () => {
    const harness = setup({ snapshot: visualSnapshotInput(), fieldCount: 2 });
    harness.pipeline.queueCapture({ identity: PAGE_IDENTITY, reason: 'initial' });
    await settled(harness);
    expect(harness.translation.checkAvailability).toHaveBeenCalledWith(1);
    expect(harness.translation.maybeTranslateAutomatically).toHaveBeenCalledWith(1, PAGE_URL);
    expect(harness.renderCaptureNotes).toHaveBeenCalled();
    expect(harness.mirror.view.root).toBeDefined();
  });

  it('reports a page that is no longer the active tab', async () => {
    const harness = setup({ tabActive: false });
    harness.pipeline.queueCapture({ identity: PAGE_IDENTITY, reason: 'initial' });
    await settled(harness);
    expect(harness.state.snapshot).toBeUndefined();
    expect(harness.statuses.at(-1)).toContain('Select the extension on the source page');
    expect(harness.mirror.container.querySelector('.empty-state--error')).toBeTruthy();
  });

  it('releases the previous tab session and resets intent for a new page', async () => {
    const harness = setup();
    const previous = { tabId: 2, windowId: 1, url: 'https://old.example/' };
    harness.state.capturedPageIdentity = previous;
    harness.state.translationDesired = true;
    harness.state.latestLiveSequence = 9;
    harness.pipeline.queueCapture({ identity: PAGE_IDENTITY, reason: 'navigation' });
    expect(harness.runFunction).toHaveBeenCalledWith(2, invokeLivePageObserverUnregisterBridge, [SESSION_ID]);
    expect(harness.state.translationDesired).toBe(false);
    expect(harness.state.latestLiveSequence).toBe(0);
    expect(harness.replayHost.resetSourceScroll).toHaveBeenCalled();
    expect(harness.imageTranslation.releaseReplica).toHaveBeenCalled();
    await settled(harness);
  });

  it('keeps the translation intent for a manual rebuild of the same page', async () => {
    const harness = setup();
    harness.state.capturedPageIdentity = PAGE_IDENTITY;
    harness.state.translationDesired = true;
    harness.pipeline.queueCapture({ identity: PAGE_IDENTITY, reason: 'manual' });
    expect(harness.state.translationDesired).toBe(true);
    expect(harness.replicaTranslation.selectPair).not.toHaveBeenCalled();
    await settled(harness);
  });

  it('supersedes the running capture when a newer request arrives', async () => {
    const harness = setup();
    harness.pipeline.queueCapture({ identity: PAGE_IDENTITY, reason: 'initial' });
    harness.pipeline.queueCapture({ identity: PAGE_IDENTITY, reason: 'manual' });
    await settled(harness);
    expect(harness.runFunction).toHaveBeenCalledWith(
      PAGE_IDENTITY.tabId,
      invokeLivePageObserverBridge,
      [SESSION_ID, 2],
    );
    expect(harness.captureCoordinator.generation).toBe(2);
  });
});

describe('CapturePipeline invalidation and replica handling', () => {
  it('clears the page and every collaborator on invalidation', () => {
    const harness = setup();
    harness.state.capturedPageIdentity = PAGE_IDENTITY;
    harness.state.followedPageIdentity = PAGE_IDENTITY;
    const availability = harness.currency.begin('availability');
    harness.pipeline.invalidateCompanion('The source tab was closed.');
    expect(harness.runFunction).toHaveBeenCalledWith(
      PAGE_IDENTITY.tabId,
      invokeLivePageObserverUnregisterBridge,
      [SESSION_ID],
    );
    expect(harness.currency.isCurrent(availability)).toBe(false);
    expect(harness.state.followedPageIdentity).toBeUndefined();
    expect(harness.state.capturedPageIdentity).toBeUndefined();
    expect(harness.engineController.releasePresentation).toHaveBeenCalledWith(false);
    expect(harness.replicaTranslation.selectPair).toHaveBeenCalledWith(undefined);
    expect(harness.mirror.container.textContent).toBe('The source tab was closed.');
    expect(harness.statuses.at(-1)).toBe('The source tab was closed.');
  });

  it('rebuilds once after a live failure, then falls back', () => {
    const harness = setup({ committed: true });
    harness.state.followedPageIdentity = PAGE_IDENTITY;
    const queueCapture = vi.spyOn(harness.pipeline, 'queueCapture').mockImplementation(() => undefined);
    harness.pipeline.handleReplicaLiveFailure('stream_overflow');
    expect(harness.statuses.at(-1)).toContain('Rebuilding once');
    expect(queueCapture).toHaveBeenCalledWith({ identity: PAGE_IDENTITY, reason: 'desynchronized' });
    expect(harness.engineController.disableSelected).not.toHaveBeenCalled();

    harness.pipeline.handleReplicaLiveFailure('stream_overflow');
    expect(harness.engineController.disableSelected).toHaveBeenCalledWith('stream_overflow');
    expect(harness.imageTranslation.releaseReplica).toHaveBeenCalled();
    expect(harness.replicaTranslation.selectPair).toHaveBeenCalledWith(undefined);
    expect(queueCapture).toHaveBeenCalledTimes(2);
  });

  it('hands presentation back to the legacy view only when the replica does not project', () => {
    const projecting = setup({ committed: true });
    projecting.legacyTransitionGate.beginShadowOwnership();
    expect(projecting.pipeline.usesReplicaTranslationProjection()).toBe(true);
    expect(projecting.pipeline.releaseReplicaPresentationForLegacyWork()).toBe(false);
    expect(projecting.engineController.releasePresentation).not.toHaveBeenCalled();
    expect(projecting.pipeline.releaseReplicaPresentationForLegacyWork(true, false)).toBe(false);
    expect(projecting.engineController.releasePresentation).toHaveBeenCalledWith(false);

    const staging = setup();
    staging.legacyTransitionGate.beginShadowOwnership();
    staging.legacyTransitionGate.markDirty();
    staging.state.pendingLiveUpdate = { generation: 1, firstSequence: 1, sequence: 1, nodeIds: new Set() };
    expect(staging.pipeline.releaseReplicaPresentationForLegacyWork()).toBe(true);
    expect(staging.state.pendingLiveUpdate).toBeUndefined();
    expect(staging.engineController.releasePresentation).toHaveBeenCalledWith(true);
  });

  it('routes a replica commit to translation and refreshes the language when it changed', () => {
    const harness = setup();
    const commit: ReplicaSourceCommit = {
      document: { sessionId: SESSION_ID, pageEpoch: 1, generation: 1, documentId: 'doc', frameId: 0 },
      documentLanguage: 'ja',
      documentLanguageChanged: true,
      replayLease: 1,
      records: [],
      changes: [],
      reason: 'checkpoint',
    };
    harness.pipeline.handleReplicaSourceCommit(commit);
    expect(harness.replicaTranslation.handleSourceCommit).toHaveBeenCalledWith(commit);
    expect(harness.translation.reconcileReplicaTranslationAfterCommit).toHaveBeenCalledWith(
      commit,
      expect.objectContaining({ scope: 'language-refresh' }),
      true,
      false,
    );

    harness.state.preferences = { ...harness.state.preferences, replicaViewMode: 'source-only' };
    harness.replicaTranslation.handleSourceCommit.mockClear();
    harness.pipeline.handleReplicaSourceCommit(commit);
    expect(harness.replicaTranslation.handleSourceCommit).not.toHaveBeenCalled();
  });
});
