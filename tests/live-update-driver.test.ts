import { describe, expect, it, vi } from 'vitest';

import { CompanionState } from '../entrypoints/sidepanel/companion-state';
import { LiveUpdateDriver } from '../entrypoints/sidepanel/live-update-driver';
import { LatestWorkCoordinator } from '../lib/companion-lifecycle';
import { captureLivePageDelta } from '../lib/live-page-mirror';
import { withViewSettings } from '../lib/preferences';
import { LegacyTransitionGate } from '../lib/replica/legacy-transition-gate';
import {
  PAGE_IDENTITY,
  PAGE_URL,
  mountMirrorView,
  visualSnapshot,
} from './helpers/sidepanel-fixtures';

const SESSION_ID = 'session-1234567890';
const SENDER_TAB = { id: PAGE_IDENTITY.tabId, windowId: PAGE_IDENTITY.windowId };

function dirtyMessage(sequence: number, nodeIds = ['n1']) {
  return {
    type: 'simul:page-dirty',
    version: 1,
    generation: 1,
    sessionId: SESSION_ID,
    sequence,
    url: PAGE_URL,
    nodeIds,
  };
}

function delta(sequence: number, desynchronized = false) {
  return {
    version: 1,
    generation: 1,
    sequence,
    url: PAGE_URL,
    documentWidth: 900,
    documentHeight: 1_800,
    desynchronized,
    replacements: [],
  };
}

function setup(options: { captured?: boolean; delta?: unknown } = {}) {
  const state = new CompanionState({ isDetachedWindow: false });
  state.preferences = withViewSettings(state.preferences, { syncScroll: true, targetLanguage: 'en' });
  const captureCoordinator = new LatestWorkCoordinator<never>();
  captureCoordinator.invalidate(); // generation 1
  const mirror = mountMirrorView(() => state.preferences);
  mirror.view.renderSnapshot(visualSnapshot());
  state.snapshot = visualSnapshot();
  state.followedPageIdentity = PAGE_IDENTITY;
  if (options.captured) state.capturedPageIdentity = PAGE_IDENTITY;
  state.resolvedSourceLanguage = 'ja';
  const legacyTransitionGate = new LegacyTransitionGate();
  const statuses: string[] = [];
  const runFunction = vi.fn(async () => [{ result: options.delta ?? delta(6) }]);
  const translation = {
    resolveSelectedSourceLanguage: vi.fn(async () => true),
    checkAvailability: vi.fn(async () => undefined),
    maybeTranslateAutomatically: vi.fn(async () => undefined),
    translateCached: vi.fn(async (_pair: unknown, _session: unknown, source: string) => `[${source}]`),
    currentTranslationFieldCount: vi.fn(() => 0),
  };
  const environment = {
    queueCapture: vi.fn(),
    releaseReplicaPresentationForLegacyWork: vi.fn(() => false),
    invalidateComposer: vi.fn(),
    updateControls: vi.fn(),
  };
  const driver = new LiveUpdateDriver({
    state,
    captureCoordinator,
    liveSessionId: SESSION_ID,
    scripting: { runFile: vi.fn(), runFunction },
    captureTimeoutMs: 1_000,
    mirrorView: mirror.view,
    legacyTransitionGate,
    provider: { createSession: vi.fn() },
    translation,
    setStatus: (message) => statuses.push(message),
    ...environment,
  });
  return { driver, state, mirror, legacyTransitionGate, statuses, runFunction, translation, ...environment };
}

describe('LiveUpdateDriver message routing', () => {
  it('accepts dirty notices only from the followed tab, session and generation', () => {
    const harness = setup();
    harness.driver.initializeSequenceBaseline(1, 5);
    expect(harness.driver.handleRuntimeMessage(dirtyMessage(6), SENDER_TAB)).toBe(true);
    expect(harness.state.pendingLiveUpdate?.sequence).toBe(6);
    expect(harness.state.pendingLiveUpdate?.nodeIds.has('n1')).toBe(true);

    expect(harness.driver.handleRuntimeMessage(
      { ...dirtyMessage(7), sessionId: 'other-session-1234' },
      SENDER_TAB,
    )).toBe(false);
    expect(harness.driver.handleRuntimeMessage(dirtyMessage(7), { id: 9, windowId: 1 })).toBe(false);
    expect(harness.driver.handleRuntimeMessage(
      { ...dirtyMessage(7), generation: 0 },
      SENDER_TAB,
    )).toBe(false);
    expect(harness.driver.handleRuntimeMessage({ type: 'unrelated' }, SENDER_TAB)).toBe(false);
  });

  it('follows source scroll messages when scroll sync is on', () => {
    const harness = setup();
    const scroll = {
      type: 'simul:page-scroll',
      version: 1,
      generation: 1,
      sessionId: SESSION_ID,
      url: PAGE_URL,
      scrollTarget: 'document',
      scrollX: 0,
      scrollY: 120,
      maxScrollX: 0,
      maxScrollY: 2_400,
      documentScrollX: 0,
      documentScrollY: 120,
      documentMaxScrollX: 0,
      documentMaxScrollY: 2_400,
    };
    expect(harness.driver.handleRuntimeMessage(scroll, SENDER_TAB)).toBe(true);
    expect(harness.state.lastSourceScroll?.scrollY).toBe(120);
    expect(harness.state.acceptedScrollMessageCount).toBe(1);
    expect(harness.mirror.replayHost.followSourceScroll).toHaveBeenCalled();
  });
});

describe('LiveUpdateDriver sequencing', () => {
  it('coalesces dirty notices, ignores stale ones, and rebuilds on a gap', () => {
    const harness = setup();
    harness.driver.initializeSequenceBaseline(1, 5);
    harness.driver.queueUpdate(dirtyMessage(6, ['n1']) as never);
    harness.driver.queueUpdate(dirtyMessage(7, ['n2']) as never);
    harness.driver.queueUpdate(dirtyMessage(5, ['n0']) as never);
    expect(harness.state.pendingLiveUpdate).toMatchObject({ firstSequence: 6, sequence: 7 });
    expect([...harness.state.pendingLiveUpdate?.nodeIds ?? []]).toEqual(['n1', 'n2']);

    harness.driver.queueUpdate(dirtyMessage(9, ['n9']) as never);
    expect(harness.queueCapture).toHaveBeenCalledWith({ identity: PAGE_IDENTITY, reason: 'desynchronized' });
    expect(harness.statuses.at(-1)).toContain('A live update was missed');
  });

  it('only records dirtiness while the isolated replica owns the page', () => {
    const harness = setup();
    harness.driver.initializeSequenceBaseline(1, 5);
    harness.legacyTransitionGate.beginShadowOwnership();
    harness.driver.queueUpdate(dirtyMessage(6) as never);
    expect(harness.state.pendingLiveUpdate).toBeUndefined();
    expect(harness.legacyTransitionGate.release()).toBe(true);
  });

  it('reconciles a pending update against the observer baseline', () => {
    const covered = setup();
    covered.state.pendingLiveUpdate = { generation: 1, firstSequence: 3, sequence: 4, nodeIds: new Set(['n1']) };
    covered.driver.initializeSequenceBaseline(1, 5);
    expect(covered.state.pendingLiveUpdate).toBeUndefined();
    expect(covered.state.latestLiveSequence).toBe(5);

    const gap = setup();
    gap.state.pendingLiveUpdate = { generation: 1, firstSequence: 8, sequence: 9, nodeIds: new Set(['n1']) };
    gap.driver.initializeSequenceBaseline(1, 5);
    expect(gap.state.pendingLiveUpdate).toBeUndefined();
    expect(gap.queueCapture).toHaveBeenCalledWith({ identity: PAGE_IDENTITY, reason: 'desynchronized' });

    const contiguous = setup();
    contiguous.state.pendingLiveUpdate = { generation: 1, firstSequence: 6, sequence: 7, nodeIds: new Set(['n1']) };
    contiguous.driver.initializeSequenceBaseline(1, 5);
    expect(contiguous.state.highestReceivedLiveSequence).toBe(7);
  });

  it('re-queues an interrupted update before aborting it', () => {
    const harness = setup();
    harness.state.latestLiveSequence = 5;
    harness.state.activeLiveUpdate = { generation: 1, firstSequence: 6, sequence: 7, nodeIds: new Set(['n2']) };
    harness.state.pendingLiveUpdate = { generation: 1, firstSequence: 8, sequence: 8, nodeIds: new Set(['n3']) };
    const controller = new AbortController();
    harness.state.liveDeltaAbortController = controller;
    harness.driver.abortAndRequeue();
    expect(harness.state.pendingLiveUpdate).toMatchObject({ firstSequence: 6, sequence: 8 });
    expect([...harness.state.pendingLiveUpdate?.nodeIds ?? []].sort()).toEqual(['n2', 'n3']);
    expect(controller.signal.aborted).toBe(true);
  });
});

describe('LiveUpdateDriver delta application', () => {
  it('reads the delta from the page and applies it to the legacy mirror', async () => {
    const harness = setup({ captured: true });
    harness.driver.initializeSequenceBaseline(1, 5);
    const rootBefore = harness.mirror.view.root;
    harness.driver.queueUpdate(dirtyMessage(6, ['n1']) as never);
    await vi.waitFor(() => expect(harness.state.liveDeltaInFlight).toBe(false));
    expect(harness.runFunction).toHaveBeenCalledWith(
      PAGE_IDENTITY.tabId,
      captureLivePageDelta,
      [SESSION_ID, 1, 6, ['n1']],
    );
    expect(harness.translation.resolveSelectedSourceLanguage).toHaveBeenCalled();
    expect(harness.translation.checkAvailability).toHaveBeenCalledWith(1);
    expect(harness.state.latestLiveSequence).toBe(6);
    expect(harness.mirror.view.root).toBe(rootBefore);
    expect(harness.queueCapture).not.toHaveBeenCalled();
    expect(harness.state.pendingLiveUpdate).toBeUndefined();
  });

  it('rebuilds once when the page reports it lost synchronization', async () => {
    const harness = setup({ captured: true, delta: delta(6, true) });
    harness.driver.initializeSequenceBaseline(1, 5);
    harness.driver.queueUpdate(dirtyMessage(6) as never);
    await vi.waitFor(() => expect(harness.state.liveDeltaInFlight).toBe(false));
    expect(harness.queueCapture).toHaveBeenCalledWith({ identity: PAGE_IDENTITY, reason: 'desynchronized' });
  });

  it('rebuilds and reports when the delta cannot be applied', async () => {
    const harness = setup({ captured: true, delta: { version: 2 } });
    harness.driver.initializeSequenceBaseline(1, 5);
    harness.driver.queueUpdate(dirtyMessage(6) as never);
    await vi.waitFor(() => expect(harness.state.liveDeltaInFlight).toBe(false));
    expect(harness.statuses.at(-1)).toContain('A live update could not be applied');
    expect(harness.queueCapture).toHaveBeenCalledWith({ identity: PAGE_IDENTITY, reason: 'desynchronized' });
  });
});
