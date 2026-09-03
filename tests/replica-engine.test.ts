import { describe, expect, it } from 'vitest';

import {
  emptyReplicaDiagnostics,
  type ReplicaCaptureRequest,
} from '../lib/replica/contracts';
import {
  ReplicaEngineController,
  isTransientReplicaFailure,
} from '../lib/replica/engine-selection';
import { FakeReplicaEngine } from '../lib/replica/fakes';

const request: ReplicaCaptureRequest = {
  sessionId: 'session-engine',
  pageEpoch: 3,
  generation: 3,
  tabId: 12,
  frameId: 0,
  documentId: 'document-engine',
  isCurrent: () => true,
};

describe('replica engine controller', () => {
  it('disables a failed engine and notifies fallback at most once', async () => {
    const legacy = new FakeReplicaEngine('legacy-v1', {
      status: 'skipped',
      diagnostics: emptyReplicaDiagnostics('legacy-v1', 'legacy_selected'),
    });
    const isolated = new FakeReplicaEngine('isolated-html-v1', {
      status: 'failed',
      diagnostics: emptyReplicaDiagnostics('isolated-html-v1', 'replay_failed'),
    });
    const fallbackCodes: string[] = [];
    const controller = new ReplicaEngineController({
      legacy,
      isolated,
      onFallback: (code) => fallbackCodes.push(code),
    });

    await controller.run(request);
    await controller.run(request);
    await controller.run(request);

    expect(isolated.requests).toHaveLength(1);
    expect(fallbackCodes).toEqual(['replay_failed']);
    expect(controller.fallbackNotified).toBe(true);
    expect(controller.selectedAvailable).toBe(false);
    expect(controller.selectedEngine).toBeUndefined();
    expect(isolated.presentationReleases).toBe(1);
    expect(isolated.lastFallbackLabel).toBe(true);
    // Later runs go to the legacy view: one acknowledgement plus two runs.
    expect(legacy.requests).toHaveLength(3);
  });

  it('disables a live-failed engine and releases its presentation exactly once', async () => {
    const legacy = new FakeReplicaEngine('legacy-v1');
    const isolated = new FakeReplicaEngine('isolated-html-v1');
    const fallbackCodes: string[] = [];
    const controller = new ReplicaEngineController({
      legacy,
      isolated,
      onFallback: (code) => fallbackCodes.push(code),
    });

    expect(controller.selectedAvailable).toBe(true);
    controller.disableSelected('stream_failed');
    controller.disableSelected('stream_overflow');
    await controller.run(request);

    expect(fallbackCodes).toEqual(['stream_failed']);
    expect(controller.selectedAvailable).toBe(false);
    expect(isolated.presentationReleases).toBe(1);
    expect(legacy.requests).toHaveLength(1);
  });

  it('does not poison the engine after expected stale cancellation', async () => {
    const legacy = new FakeReplicaEngine('legacy-v1');
    const isolated = new FakeReplicaEngine('isolated-html-v1', {
      status: 'skipped',
      diagnostics: emptyReplicaDiagnostics('isolated-html-v1', 'stale_identity'),
    });
    const fallbackCodes: string[] = [];
    const controller = new ReplicaEngineController({
      legacy,
      isolated,
      onFallback: (code) => fallbackCodes.push(code),
    });

    await controller.run(request);
    await controller.run(request);

    expect(isolated.requests).toHaveLength(2);
    expect(controller.selectedAvailable).toBe(true);
    expect(fallbackCodes).toEqual([]);
    expect(controller.fallbackNotified).toBe(false);
  });

  it('treats an explicit retry as re-enabling a failed engine', async () => {
    const legacy = new FakeReplicaEngine('legacy-v1');
    const isolated = new FakeReplicaEngine('isolated-html-v1', {
      status: 'failed',
      diagnostics: emptyReplicaDiagnostics('isolated-html-v1', 'stream_failed'),
    });
    const controller = new ReplicaEngineController({ legacy, isolated });
    await controller.run(request);
    expect(controller.selectedAvailable).toBe(false);

    controller.retrySelected();

    expect(controller.selectedAvailable).toBe(true);
    expect(controller.fallbackNotified).toBe(false);
  });

  it('disposes both engines', () => {
    const legacy = new FakeReplicaEngine('legacy-v1');
    const isolated = new FakeReplicaEngine('isolated-html-v1');
    new ReplicaEngineController({ legacy, isolated }).dispose();
    expect(legacy.disposed).toBe(true);
    expect(isolated.disposed).toBe(true);
  });
});

describe('transient replica failures', () => {
  it('keeps the engine enabled after a capacity or timing failure', async () => {
    const legacy = new FakeReplicaEngine('legacy-v1', {
      status: 'skipped',
      diagnostics: emptyReplicaDiagnostics('legacy-v1', 'legacy_selected'),
    });
    const isolated = new FakeReplicaEngine('isolated-html-v1', {
      status: 'failed',
      diagnostics: emptyReplicaDiagnostics('isolated-html-v1', 'stream_overflow'),
    });
    const fallbackCodes: string[] = [];
    const controller = new ReplicaEngineController({
      legacy,
      isolated,
      onFallback: (code) => fallbackCodes.push(code),
    });

    await controller.run(request);
    expect(fallbackCodes).toEqual(['stream_overflow']);
    expect(controller.selectedAvailable).toBe(true);

    // The next page (or attempt) still runs through the selected engine.
    await controller.run(request);
    expect(isolated.requests).toHaveLength(2);
    expect(isTransientReplicaFailure('stream_overflow')).toBe(true);
    expect(isTransientReplicaFailure('checkpoint_too_large')).toBe(true);
    expect(isTransientReplicaFailure('replay_failed')).toBe(false);
    expect(isTransientReplicaFailure('privacy_rejected')).toBe(false);
  });
});
