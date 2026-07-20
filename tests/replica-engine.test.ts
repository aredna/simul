import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

import {
  emptyReplicaDiagnostics,
  type ReplicaCaptureRequest,
  type ReplicaCheckpointEnvelope,
  type ReplicaCheckpointResponse,
  type ReplicaLiveBatch,
  type ReplicaLiveStreamLease,
  type ReplicaLiveStreamObserver,
} from '../lib/replica/contracts';
import {
  ReplicaEngineController,
  selectReplicaEngineMode,
  selectReplicaTranslationMode,
} from '../lib/replica/engine-selection';
import type { ReplicaTextProjection } from '../lib/translation/replica-translation-coordinator';
import { FakeReplicaEngine } from '../lib/replica/fakes';
import {
  createCheckpointEnvelope,
  createCheckpointError,
  createReplicaIdentity,
} from '../lib/replica/protocol-v2';
import { RrwebShadowReplicaEngine } from '../lib/replica/rrweb-shadow-engine';
import { RrwebStreamSanitizer } from '../lib/replica/rrweb-stream-sanitizer';
import {
  LEGACY_FALLBACK_LABEL,
  LIVE_REPLAY_LABEL,
  STATIC_REPLAY_LABEL,
  VisibleReplayHost,
} from '../lib/replica/visible-replay-host';

const request: ReplicaCaptureRequest = {
  sessionId: 'session-engine',
  pageEpoch: 3,
  generation: 3,
  tabId: 12,
  frameId: 0,
  documentId: 'document-engine',
  isCurrent: () => true,
};

describe('replica engine selection and fallback', () => {
  it('uses rrweb and source projections by default with an explicit rollback', () => {
    expect(selectReplicaEngineMode({ DEV: false })).toBe('rrweb-shadow');
    expect(selectReplicaEngineMode({ DEV: true })).toBe('rrweb-shadow');
    expect(selectReplicaEngineMode({ DEV: true, WXT_SIMUL_RRWEB_SHADOW: '1' })).toBe('rrweb-shadow');
    expect(selectReplicaEngineMode({ DEV: false, WXT_SIMUL_RRWEB_SHADOW: '0' })).toBe('legacy');
    expect(selectReplicaTranslationMode({
      DEV: false,
    })).toBe('rrweb-projection');
    expect(selectReplicaTranslationMode({
      DEV: false,
      WXT_SIMUL_RRWEB_TRANSLATION: '0',
    })).toBe('legacy');
    expect(selectReplicaTranslationMode(
      { DEV: false, WXT_SIMUL_RRWEB_TRANSLATION: '0' },
      'rrweb-shadow',
    )).toBe('legacy');
  });

  it('disables a failed shadow and notifies fallback at most once', async () => {
    const legacy = new FakeReplicaEngine('legacy-v1', {
      status: 'skipped',
      diagnostics: emptyReplicaDiagnostics('legacy-v1', 'legacy_selected'),
    });
    const shadow = new FakeReplicaEngine('rrweb-shadow-v2', {
      status: 'failed',
      diagnostics: emptyReplicaDiagnostics('rrweb-shadow-v2', 'replay_failed'),
    });
    const fallbackCodes: string[] = [];
    const controller = new ReplicaEngineController({
      mode: 'rrweb-shadow',
      legacy,
      shadow,
      onFallback: (code) => fallbackCodes.push(code),
    });

    await controller.run(request);
    await controller.run(request);
    await controller.run(request);

    expect(shadow.requests).toHaveLength(1);
    expect(fallbackCodes).toEqual(['replay_failed']);
    expect(controller.fallbackNotified).toBe(true);
    expect(controller.shadowAvailable).toBe(false);
    expect(shadow.presentationReleases).toBe(1);
    expect(shadow.lastFallbackLabel).toBe(true);
  });

  it('disables a live-failed shadow and releases its presentation exactly once', async () => {
    const legacy = new FakeReplicaEngine('legacy-v1');
    const shadow = new FakeReplicaEngine('rrweb-shadow-v2');
    const fallbackCodes: string[] = [];
    const controller = new ReplicaEngineController({
      mode: 'rrweb-shadow',
      legacy,
      shadow,
      onFallback: (code) => fallbackCodes.push(code),
    });

    expect(controller.shadowAvailable).toBe(true);
    controller.disableShadow('stream_failed');
    controller.disableShadow('stream_overflow');
    await controller.run(request);

    expect(fallbackCodes).toEqual(['stream_failed']);
    expect(controller.shadowAvailable).toBe(false);
    expect(shadow.presentationReleases).toBe(1);
    expect(legacy.requests).toHaveLength(1);
  });

  it('does not poison the shadow engine after expected stale cancellation', async () => {
    const legacy = new FakeReplicaEngine('legacy-v1');
    const shadow = new FakeReplicaEngine('rrweb-shadow-v2', {
      status: 'skipped',
      diagnostics: emptyReplicaDiagnostics('rrweb-shadow-v2', 'stale_identity'),
    });
    const fallbackCodes: string[] = [];
    const controller = new ReplicaEngineController({
      mode: 'rrweb-shadow',
      legacy,
      shadow,
      onFallback: (code) => fallbackCodes.push(code),
    });

    await controller.run(request);
    await controller.run(request);

    expect(shadow.requests).toHaveLength(2);
    expect(controller.shadowAvailable).toBe(true);
    expect(fallbackCodes).toEqual([]);
    expect(controller.fallbackNotified).toBe(false);
  });

  it('never touches presentation ownership in a legacy-only build', async () => {
    const legacy = new FakeReplicaEngine('legacy-v1');
    const shadow = new FakeReplicaEngine('rrweb-shadow-v2');
    const controller = new ReplicaEngineController({
      mode: 'legacy',
      legacy,
      shadow,
    });

    controller.releasePresentation();
    await controller.run(request);

    expect(controller.shadowAvailable).toBe(false);
    expect(shadow.presentationReleases).toBe(0);
    expect(shadow.requests).toHaveLength(0);
  });
});

describe('rrweb shadow engine', () => {
  it('atomically promotes a protected source-sized preview and retains it until release', async () => {
    const { document } = replicaDocument();
    const presentationHost = createPresentationHost(document);
    let iframe: HTMLIFrameElement | undefined;
    let disabled = false;
    let destroyed = false;
    const replayDocument = parseHTML('<html><body></body></html>').document;
    defineDimension(replayDocument.documentElement, 'scrollWidth', 1_250);
    defineDimension(replayDocument.documentElement, 'scrollHeight', 2_450);
    const engine = new RrwebShadowReplicaEngine({
      presentationHost,
      capture: async () => checkpoint(),
      now: sequenceClock([10, 25]),
      createReplayer: (_events, root) => {
        iframe = document.createElement('iframe');
        Object.defineProperty(iframe, 'contentDocument', {
          configurable: true,
          value: replayDocument,
        });
        root.append(iframe);
        let rebuilt: (() => void) | undefined;
        return {
          iframe,
          on: (_event, handler) => {
            rebuilt = handler;
          },
          play: () => rebuilt?.(),
          disableInteract: () => {
            disabled = true;
          },
          destroy: () => {
            destroyed = true;
          },
        };
      },
    });

    const result = await engine.run(request);

    expect(result).toMatchObject({
      status: 'complete',
      diagnostics: {
        engine: 'rrweb-shadow-v2',
        code: 'shadow_complete',
        eventCount: 2,
        sourceViewportWidth: 1_000,
        sourceViewportHeight: 700,
        sourceDocumentWidth: 1_300,
        sourceDocumentHeight: 2_600,
        replayDocumentWidth: 1_250,
        replayDocumentHeight: 2_450,
      },
    });
    expect(JSON.stringify(result)).not.toContain('visible');
    expect(iframe?.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(iframe?.getAttribute('sandbox')).not.toContain('allow-scripts');
    expect(iframe?.hasAttribute('inert')).toBe(true);
    expect(iframe?.style.border).toMatch(/^0(?:px)?$/u);
    expect(disabled).toBe(true);
    expect(destroyed).toBe(false);
    expect(document.querySelector('#legacy')?.hasAttribute('hidden')).toBe(true);
    expect(document.querySelector('#preview')?.hasAttribute('hidden')).toBe(false);
    expect(document.querySelector('#badge')?.textContent).toBe(STATIC_REPLAY_LABEL);
    expect(document.querySelectorAll('[data-simul-replica-viewport]')).toHaveLength(1);
    expect(document.querySelector('#visible')?.textContent).toBe('legacy');

    engine.releasePresentation();

    expect(destroyed).toBe(true);
    expect(document.querySelector('#legacy')?.hasAttribute('hidden')).toBe(false);
    expect(document.querySelector('#preview')?.hasAttribute('hidden')).toBe(true);
    expect(document.querySelector('#badge')?.textContent).toBe(LEGACY_FALLBACK_LABEL);
  });

  it('rejects stale work before capture or replay', async () => {
    let captures = 0;
    const { document } = replicaDocument();
    const engine = new RrwebShadowReplicaEngine({
      presentationHost: createPresentationHost(document),
      capture: async () => {
        captures += 1;
        return checkpoint();
      },
    });

    const result = await engine.run({ ...request, isCurrent: () => false });

    expect(result).toMatchObject({
      status: 'skipped',
      diagnostics: { code: 'stale_identity' },
    });
    expect(captures).toBe(0);
    expect(document.querySelector('[data-simul-replica-candidate]')).toBeNull();
  });

  it('projects only exact current identities after ACK and reapplies them on recovery', async () => {
    const { document } = replicaDocument();
    const stream = new FakeLiveStream(checkpointAt(0));
    const controls: FakeLiveReplayerControl[] = [];
    const commits: Array<{
      reason: string;
      replayLease: number;
      acknowledgements: number[];
    }> = [];
    const engine = new RrwebShadowReplicaEngine({
      presentationHost: createPresentationHost(document),
      capture: async () => checkpointAt(0),
      openStream: async () => stream,
      createReplayer: createFakeLiveReplayerFactory(document, controls, true),
      onSourceCommit: (commit) => commits.push({
        reason: commit.reason,
        replayLease: commit.replayLease,
        acknowledgements: [...stream.acknowledgements],
      }),
    });

    await engine.run(request);
    const initial = engine.snapshot();
    const source = initial?.records.find(({ nodeId }) => nodeId === 5);
    expect(source).toMatchObject({ revision: 1, source: 'initial' });
    expect(commits[0]).toEqual({
      reason: 'checkpoint',
      replayLease: 1,
      acknowledgements: [0],
    });

    engine.beginProjection({ translationEpoch: 1, pairKey: 'es>en' });
    expect(engine.project({
      document: source!.document,
      replayLease: initial!.replayLease,
      nodeId: 5,
      nodeType: 3,
      sourceRevision: source!.revision,
      source: source!.source,
      translationEpoch: 1,
      pairKey: 'es>en',
      translated: 'translated',
    })).toBe(true);
    expect(controls[0]?.textNode.textContent).toBe('translated');

    stream.emitCheckpoint(checkpointAt(0));
    await flushAsyncWork();

    expect(controls).toHaveLength(2);
    expect(controls[1]?.textNode.textContent).toBe('translated');
    expect(engine.snapshot()?.replayLease).toBe(2);
    expect(commits.at(-1)).toEqual({
      reason: 'recovery',
      replayLease: 2,
      acknowledgements: [0, 0],
    });

    const current = engine.snapshot();
    const currentSource = current?.records.find(({ nodeId }) => nodeId === 5);
    const projection: ReplicaTextProjection = {
      document: currentSource!.document,
      replayLease: current!.replayLease,
      nodeId: 5,
      nodeType: 3,
      sourceRevision: currentSource!.revision,
      source: currentSource!.source,
      translationEpoch: 1,
      pairKey: 'es>en',
      translated: 'stale',
    };
    const rejected = [
      {
        ...projection,
        document: { ...projection.document, documentId: 'stale-document' },
      },
      { ...projection, pairKey: 'ja>en' },
      { ...projection, translationEpoch: 2 },
      { ...projection, replayLease: current!.replayLease - 1 },
      { ...projection, nodeType: 1 } as unknown as ReplicaTextProjection,
    ];
    for (const staleProjection of rejected) {
      expect(engine.project(staleProjection)).toBe(false);
      expect(controls[1]?.textNode.textContent).toBe('translated');
    }
    engine.dispose();
  });

  it('coalesces extent refreshes and restores actual source text for an equal pair', async () => {
    const { document } = replicaDocument();
    const presentationHost = createPresentationHost(document);
    const refreshExtent = vi.spyOn(presentationHost, 'refreshExtent');
    const onLayoutChanged = vi.fn();
    const controls: FakeLiveReplayerControl[] = [];
    const engine = new RrwebShadowReplicaEngine({
      presentationHost,
      capture: async () => checkpointAt(0),
      createReplayer: createFakeLiveReplayerFactory(document, controls, true),
      onLayoutChanged,
    });
    await engine.run(request);
    const snapshot = engine.snapshot();
    const source = snapshot?.records.find(({ nodeId }) => nodeId === 5);
    const projection: ReplicaTextProjection = {
      document: source!.document,
      replayLease: snapshot!.replayLease,
      nodeId: source!.nodeId,
      nodeType: 3,
      sourceRevision: source!.revision,
      source: source!.source,
      translationEpoch: 1,
      pairKey: 'es>en',
      translated: 'translated once',
    };

    engine.beginProjection({ translationEpoch: 1, pairKey: 'es>en' });
    expect(engine.project(projection)).toBe(true);
    expect(engine.project({ ...projection, translated: 'translated twice' })).toBe(true);
    expect(controls[0]?.textNode.textContent).toBe('translated twice');
    expect(refreshExtent).not.toHaveBeenCalled();

    await flushAsyncWork();
    expect(refreshExtent).toHaveBeenCalledTimes(1);
    expect(onLayoutChanged).toHaveBeenCalledTimes(1);

    engine.beginProjection({ translationEpoch: 2, pairKey: undefined });
    expect(controls[0]?.textNode.textContent).toBe('initial');
    expect(refreshExtent).toHaveBeenCalledTimes(1);

    await flushAsyncWork();
    expect(refreshExtent).toHaveBeenCalledTimes(2);
    expect(onLayoutChanged).toHaveBeenCalledTimes(2);
    engine.dispose();
  });

  it('commits text revisions after event-cast and rejects the superseded projection', async () => {
    const { document } = replicaDocument();
    const stream = new FakeLiveStream(checkpointAt(0));
    const controls: FakeLiveReplayerControl[] = [];
    const commits: string[] = [];
    const engine = new RrwebShadowReplicaEngine({
      presentationHost: createPresentationHost(document),
      capture: async () => checkpointAt(0),
      openStream: async () => stream,
      createReplayer: createFakeLiveReplayerFactory(document, controls, false),
      onSourceCommit: (commit) => commits.push(
        `${commit.reason}:${stream.acknowledgements.join(',')}`,
      ),
    });
    await engine.run(request);
    const original = engine.snapshot()?.records.find(({ nodeId }) => nodeId === 5);
    engine.beginProjection({ translationEpoch: 1, pairKey: 'es>en' });

    stream.emitBatch(liveBatchFromEvents(1, [{
      type: 3,
      data: {
        source: 0,
        texts: [{ id: 5, value: 'changed' }],
        attributes: [],
        removes: [],
        adds: [],
      },
      timestamp: 11,
    }]));
    expect(engine.snapshot()?.records.find(({ nodeId }) => nodeId === 5)).toMatchObject({
      revision: 1,
      source: 'initial',
    });
    expect(stream.acknowledgements).toEqual([0]);

    controls[0]?.emit('event-cast', controls[0]?.addedEvents[0]);
    await flushAsyncWork();

    const changed = engine.snapshot()?.records.find(({ nodeId }) => nodeId === 5);
    expect(changed).toMatchObject({ revision: 2, source: 'changed' });
    expect(stream.acknowledgements).toEqual([0, 1]);
    expect(commits.at(-1)).toBe('batch:0,1');
    expect(engine.project({
      document: original!.document,
      replayLease: engine.snapshot()!.replayLease,
      nodeId: 5,
      nodeType: 3,
      sourceRevision: original!.revision,
      source: original!.source,
      translationEpoch: 1,
      pairKey: 'es>en',
      translated: 'stale',
    })).toBe(false);
    expect(engine.project({
      document: changed!.document,
      replayLease: engine.snapshot()!.replayLease,
      nodeId: 5,
      nodeType: 3,
      sourceRevision: changed!.revision,
      source: changed!.source,
      translationEpoch: 1,
      pairKey: 'es>en',
      translated: 'current',
    })).toBe(true);
    expect(controls[0]?.textNode.textContent).toBe('current');
    engine.dispose();
  });

  it('treats overlapping recorder work as transient instead of poisoning fallback', async () => {
    const { document } = replicaDocument();
    const engine = new RrwebShadowReplicaEngine({
      presentationHost: createPresentationHost(document),
      capture: async () => createCheckpointError(
        createReplicaIdentity({
          sessionId: request.sessionId,
          pageEpoch: request.pageEpoch,
          generation: request.generation,
          documentId: request.documentId,
          frameId: request.frameId,
          sequence: 0,
        }),
        'capture_busy',
      ),
    });

    await expect(engine.run(request)).resolves.toMatchObject({
      status: 'skipped',
      diagnostics: { code: 'capture_busy' },
    });
  });

  it('drops an older committed preview on capture_busy and remains retryable', async () => {
    const { document } = replicaDocument();
    const responses = [checkpoint(), busyCheckpoint(), checkpoint()];
    let captureIndex = 0;
    const destroyed = [0, 0];
    let replayerIndex = 0;
    const engine = new RrwebShadowReplicaEngine({
      presentationHost: createPresentationHost(document),
      capture: async () => responses[captureIndex++] ?? checkpoint(),
      createReplayer: (_events, root) => {
        const index = replayerIndex++;
        const iframe = document.createElement('iframe');
        Object.defineProperty(iframe, 'contentDocument', {
          configurable: true,
          value: parseHTML('<html><body></body></html>').document,
        });
        root.append(iframe);
        let rebuilt: (() => void) | undefined;
        return {
          iframe,
          on: (_event, handler) => {
            rebuilt = handler;
          },
          play: () => rebuilt?.(),
          disableInteract: () => undefined,
          destroy: () => {
            destroyed[index] = (destroyed[index] ?? 0) + 1;
          },
        };
      },
    });

    await expect(engine.run(request)).resolves.toMatchObject({ status: 'complete' });
    await expect(engine.run(request)).resolves.toMatchObject({
      status: 'skipped',
      diagnostics: { code: 'capture_busy' },
    });

    expect(destroyed).toEqual([1, 0]);
    expect(document.querySelector('#legacy')?.hasAttribute('hidden')).toBe(false);
    expect(document.querySelector('#preview')?.hasAttribute('hidden')).toBe(true);
    expect(document.querySelector('#badge')?.textContent).toBe(LEGACY_FALLBACK_LABEL);

    await expect(engine.run(request)).resolves.toMatchObject({ status: 'complete' });
    expect(document.querySelector('#preview')?.hasAttribute('hidden')).toBe(false);
    engine.dispose();
    expect(destroyed).toEqual([1, 1]);
  });

  it('times out once, removes staging, and retains the legacy document', async () => {
    const { document } = replicaDocument();
    let destroyed = false;
    const engine = new RrwebShadowReplicaEngine({
      presentationHost: createPresentationHost(document),
      capture: async () => checkpoint(),
      replayDeadlineMs: 1,
      createReplayer: (_events, root) => {
        const iframe = document.createElement('iframe');
        root.append(iframe);
        return {
          iframe,
          on: () => undefined,
          play: () => undefined,
          disableInteract: () => undefined,
          destroy: () => {
            destroyed = true;
          },
        };
      },
    });

    const result = await engine.run(request);

    expect(result).toMatchObject({
      status: 'failed',
      diagnostics: { code: 'replay_timeout' },
    });
    expect(destroyed).toBe(true);
    expect(document.querySelector('[data-simul-replica-candidate]')).toBeNull();
    expect(document.querySelector('#legacy')?.textContent).toContain('legacy');
  });

  it('aborts a timed-out stream open and disposes its lease if it resolves late', async () => {
    vi.useFakeTimers();
    try {
      const { document } = replicaDocument();
      const opening = deferred<ReplicaLiveStreamLease>();
      const lateStream = new FakeLiveStream(checkpointAt(0));
      let openSignal: AbortSignal | undefined;
      const engine = new RrwebShadowReplicaEngine({
        presentationHost: createPresentationHost(document),
        capture: async () => checkpointAt(0),
        captureDeadlineMs: 10,
        openStream: (_request, signal) => {
          openSignal = signal;
          return opening.promise;
        },
      });

      const run = engine.run(request);
      await vi.advanceTimersByTimeAsync(10);

      await expect(run).resolves.toMatchObject({
        status: 'failed',
        diagnostics: { code: 'capture_timeout' },
      });
      expect(openSignal?.aborted).toBe(true);

      opening.resolve(lateStream);
      await vi.runAllTimersAsync();
      await Promise.resolve();

      expect(lateStream.disposed).toBe(1);
      engine.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces and tears down retained Replayers exactly once', async () => {
    const { document } = replicaDocument();
    const destroyed = [0, 0];
    let created = 0;
    const engine = new RrwebShadowReplicaEngine({
      presentationHost: createPresentationHost(document),
      capture: async () => checkpoint(),
      createReplayer: (_events, root) => {
        const index = created++;
        const iframe = document.createElement('iframe');
        Object.defineProperty(iframe, 'contentDocument', {
          configurable: true,
          value: parseHTML('<html><body></body></html>').document,
        });
        root.append(iframe);
        let rebuilt: (() => void) | undefined;
        return {
          iframe,
          on: (_event, handler) => {
            rebuilt = handler;
          },
          play: () => rebuilt?.(),
          disableInteract: () => undefined,
          destroy: () => {
            destroyed[index] = (destroyed[index] ?? 0) + 1;
          },
        };
      },
    });

    await engine.run(request);
    await engine.run(request);

    expect(destroyed).toEqual([1, 0]);
    expect(document.querySelectorAll('[data-simul-replica-viewport]')).toHaveLength(1);

    engine.dispose();
    engine.dispose();

    expect(destroyed).toEqual([1, 1]);
    expect(document.querySelector('[data-simul-replica-viewport]')).toBeNull();
  });

  it('revokes a superseded in-flight candidate before replaying its replacement', async () => {
    const { document } = replicaDocument();
    const firstCapture = deferred<ReplicaCheckpointEnvelope>();
    const secondCapture = deferred<ReplicaCheckpointEnvelope>();
    const firstReplayerCreated = deferred<void>();
    const captures = [firstCapture.promise, secondCapture.promise];
    const destroyed = [0, 0];
    let captureIndex = 0;
    let replayerIndex = 0;
    const engine = new RrwebShadowReplicaEngine({
      presentationHost: createPresentationHost(document),
      capture: async () => captures[captureIndex++] ?? checkpoint(),
      createReplayer: (_events, root) => {
        const index = replayerIndex++;
        const iframe = document.createElement('iframe');
        Object.defineProperty(iframe, 'contentDocument', {
          configurable: true,
          value: parseHTML('<html><body></body></html>').document,
        });
        root.append(iframe);
        let rebuilt: (() => void) | undefined;
        if (index === 0) firstReplayerCreated.resolve();
        return {
          iframe,
          on: (_event, handler) => {
            rebuilt = handler;
          },
          play: () => {
            if (index > 0) rebuilt?.();
          },
          disableInteract: () => undefined,
          destroy: () => {
            destroyed[index] = (destroyed[index] ?? 0) + 1;
          },
        };
      },
    });
    const firstRun = engine.run(request);
    firstCapture.resolve(checkpoint());
    await firstReplayerCreated.promise;
    const secondRun = engine.run(request);
    secondCapture.resolve(checkpoint());

    await expect(secondRun).resolves.toMatchObject({ status: 'complete' });
    expect(destroyed).toEqual([1, 0]);
    expect(document.querySelectorAll('[data-simul-replica-viewport]')).toHaveLength(1);

    await expect(firstRun).resolves.toMatchObject({
      status: 'skipped',
      diagnostics: { code: 'stale_identity' },
    });
    expect(destroyed).toEqual([1, 0]);

    engine.dispose();
    expect(destroyed).toEqual([1, 1]);
  });

  it('does not let an older delayed capture supersede a newer completed run', async () => {
    const { document } = replicaDocument();
    const firstCapture = deferred<ReplicaCheckpointEnvelope>();
    const secondCapture = deferred<ReplicaCheckpointEnvelope>();
    const captures = [firstCapture.promise, secondCapture.promise];
    let captureIndex = 0;
    let replayersCreated = 0;
    const engine = new RrwebShadowReplicaEngine({
      presentationHost: createPresentationHost(document),
      capture: async () => captures[captureIndex++] ?? checkpoint(),
      createReplayer: (_events, root) => {
        replayersCreated += 1;
        const iframe = document.createElement('iframe');
        Object.defineProperty(iframe, 'contentDocument', {
          configurable: true,
          value: parseHTML('<html><body></body></html>').document,
        });
        root.append(iframe);
        let rebuilt: (() => void) | undefined;
        return {
          iframe,
          on: (_event, handler) => {
            rebuilt = handler;
          },
          play: () => rebuilt?.(),
          disableInteract: () => undefined,
          destroy: () => undefined,
        };
      },
    });

    const firstRun = engine.run(request);
    const secondRun = engine.run(request);
    secondCapture.resolve(checkpoint());
    await expect(secondRun).resolves.toMatchObject({ status: 'complete' });
    const committedRoot = document.querySelector('[data-simul-replica-viewport]');

    firstCapture.resolve(checkpoint());
    await expect(firstRun).resolves.toMatchObject({
      status: 'skipped',
      diagnostics: { code: 'stale_identity' },
    });

    expect(replayersCreated).toBe(1);
    expect(document.querySelector('[data-simul-replica-viewport]')).toBe(committedRoot);
    engine.dispose();
  });

  it('disposes a stale stream that opens after a newer live run commits', async () => {
    const { document } = replicaDocument();
    const staleOpening = deferred<ReplicaLiveStreamLease>();
    const staleStream = new FakeLiveStream(checkpointAt(0));
    const currentStream = new FakeLiveStream(checkpointAt(0));
    const controls: FakeLiveReplayerControl[] = [];
    let opens = 0;
    const engine = new RrwebShadowReplicaEngine({
      presentationHost: createPresentationHost(document),
      capture: async () => checkpointAt(0),
      openStream: () => {
        opens += 1;
        return opens === 1 ? staleOpening.promise : Promise.resolve(currentStream);
      },
      createReplayer: createFakeLiveReplayerFactory(document, controls, true),
    });

    const staleRun = engine.run(request);
    const currentRun = engine.run(request);
    await expect(currentRun).resolves.toMatchObject({ status: 'complete' });

    staleOpening.resolve(staleStream);
    await expect(staleRun).resolves.toMatchObject({
      status: 'skipped',
      diagnostics: { code: 'stale_identity' },
    });
    expect(staleStream.disposed).toBe(1);
    expect(currentStream.disposed).toBe(0);

    currentStream.emitBatch(liveBatch(1));
    await flushAsyncWork();
    expect(currentStream.acknowledgements).toEqual([0, 1]);
    engine.dispose();
  });

  it('does not let superseded recovery cleanup revoke a newer staged run', async () => {
    const { document } = replicaDocument();
    const initialStream = new FakeLiveStream(checkpointAt(0));
    const replacementStream = new FakeLiveStream(checkpointAt(0));
    const streams = [initialStream, replacementStream];
    const controls: FakeLiveReplayerControl[] = [];
    const factory = createFakeLiveReplayerFactory(document, controls, true);
    const engine = new RrwebShadowReplicaEngine({
      presentationHost: createPresentationHost(document),
      capture: async () => checkpointAt(0),
      openStream: async () => streams.shift() ?? replacementStream,
      createReplayer: (events, root, live) => {
        const replayer = factory(events, root, live);
        const index = controls.length - 1;
        if (index === 1 || index === 2) controls[index]!.rebuildOnPlay = false;
        return replayer;
      },
    });
    await engine.run(request);

    initialStream.emitBatch(liveBatch(2));
    await flushAsyncWork();
    initialStream.emitCheckpoint(checkpointAt(2));
    await flushAsyncWork();
    expect(controls).toHaveLength(2);

    const replacementRun = engine.run(request);
    await flushAsyncWork();
    expect(controls).toHaveLength(3);
    expect(controls[1]?.destroyed).toBe(1);
    expect(controls[2]?.destroyed).toBe(0);
    expect(
      document.querySelectorAll('[data-simul-replica-candidate]'),
    ).toHaveLength(1);

    controls[2]?.emit('fullsnapshot-rebuilded');
    await expect(replacementRun).resolves.toMatchObject({ status: 'complete' });
    expect(controls[2]?.destroyed).toBe(0);
    expect(
      document.querySelectorAll('[data-simul-replica-viewport]'),
    ).toHaveLength(1);
    engine.dispose();
  });

  it('ACKs a live batch only after rrweb casts its final event', async () => {
    const { document } = replicaDocument();
    const stream = new FakeLiveStream(checkpointAt(0));
    const controls: FakeLiveReplayerControl[] = [];
    const engine = new RrwebShadowReplicaEngine({
      presentationHost: createPresentationHost(document),
      capture: async () => checkpointAt(0),
      openStream: async () => stream,
      createReplayer: createFakeLiveReplayerFactory(document, controls, false),
    });

    await expect(engine.run(request)).resolves.toMatchObject({ status: 'complete' });
    expect(stream.acknowledgements).toEqual([0]);
    expect(stream.checkpointAcknowledgements).toEqual([0]);
    expect(document.querySelector('#badge')?.textContent).toBe(LIVE_REPLAY_LABEL);

    stream.emitBatch(liveBatch(1, 2));
    expect(controls[0]?.addedEvents).toHaveLength(2);
    expect(stream.acknowledgements).toEqual([0]);

    controls[0]?.emit('event-cast', { unrelated: true });
    controls[0]?.emit('event-cast', controls[0]?.addedEvents[0]);
    await flushAsyncWork();
    expect(stream.acknowledgements).toEqual([0]);
    controls[0]?.emit('event-cast', controls[0]?.addedEvents[1]);
    await flushAsyncWork();
    expect(stream.acknowledgements).toEqual([0, 2]);
    expect(document.querySelector<HTMLElement>('#preview')?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('#legacy')?.hidden).toBe(true);
    engine.dispose();
  });

  it('delivers contiguous DOM, CSS, and scroll changes without rebuilding', async () => {
    const { document } = replicaDocument();
    const cssDocument = parseHTML('<html><head></head><body></body></html>').document;
    const stream = new FakeLiveStream(checkpointAt(0));
    const controls: FakeLiveReplayerControl[] = [];
    let appliedNotifications = 0;
    const engine = new RrwebShadowReplicaEngine({
      presentationHost: createPresentationHost(document),
      capture: async () => checkpointAt(0),
      openStream: async () => stream,
      createSanitizer: () => new RrwebStreamSanitizer(
        cssDocument as unknown as Document,
      ),
      onLiveApplied: () => {
        appliedNotifications += 1;
      },
      createReplayer: createFakeLiveReplayerFactory(document, controls, true),
    });
    await engine.run(request);

    stream.emitBatch(liveBatchFromEvents(1, [
      {
        type: 3,
        data: {
          source: 0,
          texts: [{ id: 5, value: 'updated' }],
          attributes: [],
          removes: [],
          adds: [],
        },
        timestamp: 11,
      },
      {
        type: 3,
        data: {
          source: 13,
          id: 6,
          index: [0],
          set: { property: 'color', value: 'red' },
        },
        timestamp: 12,
      },
      {
        type: 3,
        data: { source: 3, id: 3, x: 0, y: 120 },
        timestamp: 13,
      },
    ]));
    await flushAsyncWork();

    expect(controls).toHaveLength(1);
    expect(controls[0]?.addedEvents).toMatchObject([
      { data: { source: 0 } },
      { data: { source: 13 } },
      { data: { source: 3 } },
    ]);
    expect(stream.acknowledgements).toEqual([0, 3]);
    expect(stream.checkpointAcknowledgements).toEqual([0]);
    expect(appliedNotifications).toBe(1);
    engine.dispose();
  });

  it('queues new-document batches during initial staging without touching last-good', async () => {
    const { document } = replicaDocument();
    const initial = new FakeLiveStream(checkpointAt(0));
    const replacementCheckpoint = deferred<ReplicaCheckpointResponse>();
    const replacement = new FakeLiveStream(replacementCheckpoint.promise);
    const streams = [initial, replacement];
    const controls: FakeLiveReplayerControl[] = [];
    const engine = new RrwebShadowReplicaEngine({
      presentationHost: createPresentationHost(document),
      capture: async () => checkpointAt(0),
      openStream: async () => streams.shift() ?? replacement,
      createReplayer: createFakeLiveReplayerFactory(document, controls, true),
    });
    await engine.run(request);
    const firstRoot = document.querySelector('[data-simul-replica-viewport]');

    const replacementRun = engine.run(request);
    await flushAsyncWork();
    replacement.emitBatch(liveBatch(1));
    await flushAsyncWork();

    expect(controls[0]?.addedEvents).toEqual([]);
    expect(document.querySelector('[data-simul-replica-viewport]')).toBe(firstRoot);

    replacementCheckpoint.resolve(checkpointAt(0));
    await expect(replacementRun).resolves.toMatchObject({ status: 'complete' });
    await flushAsyncWork();

    expect(controls[0]?.addedEvents).toEqual([]);
    expect(controls[1]?.addedEvents).toHaveLength(1);
    expect(replacement.acknowledgements).toEqual([1]);
    engine.dispose();
  });

  it('applies a post-checkpoint batch after a checkpoint arrives during initial staging', async () => {
    const { document } = replicaDocument();
    const initialCheckpoint = deferred<ReplicaCheckpointResponse>();
    const stream = new FakeLiveStream(initialCheckpoint.promise);
    const controls: FakeLiveReplayerControl[] = [];
    const factory = createFakeLiveReplayerFactory(document, controls, true);
    const engine = new RrwebShadowReplicaEngine({
      presentationHost: createPresentationHost(document),
      capture: async () => checkpointAt(0),
      openStream: async () => stream,
      createReplayer: (events, root, live) => {
        const replayer = factory(events, root, live);
        if (controls.length === 1) controls[0]!.rebuildOnPlay = false;
        return replayer;
      },
    });

    const run = engine.run(request);
    initialCheckpoint.resolve(checkpointAt(0));
    await flushAsyncWork();
    expect(controls).toHaveLength(1);

    stream.emitCheckpoint(checkpointAt(2));
    stream.emitBatch(liveBatch(3));
    expect(controls[0]?.addedEvents).toEqual([]);

    controls[0]?.emit('fullsnapshot-rebuilded');
    await expect(run).resolves.toMatchObject({ status: 'complete' });
    await flushAsyncWork();

    expect(controls).toHaveLength(2);
    expect(controls[1]?.addedEvents).toHaveLength(1);
    expect(stream.checkpointAcknowledgements).toEqual([0, 2]);
    expect(stream.acknowledgements).toEqual([0, 3]);
    engine.dispose();
  });

  it('recovers a sequence gap in hidden staging and swaps only after rebuild', async () => {
    const { document } = replicaDocument();
    const stream = new FakeLiveStream(checkpointAt(0));
    const controls: FakeLiveReplayerControl[] = [];
    const engine = new RrwebShadowReplicaEngine({
      presentationHost: createPresentationHost(document),
      capture: async () => checkpointAt(0),
      openStream: async () => stream,
      createReplayer: createFakeLiveReplayerFactory(document, controls, true),
    });
    await engine.run(request);
    const firstRoot = document.querySelector('[data-simul-replica-viewport]');

    stream.emitBatch(liveBatch(2));
    await flushAsyncWork();
    expect(stream.checkpointRequests).toBe(1);
    expect(document.querySelector('[data-simul-replica-viewport]')).toBe(firstRoot);

    stream.emitCheckpoint(checkpointAt(2));
    await flushAsyncWork();
    expect(controls).toHaveLength(2);
    expect(controls[0]?.destroyed).toBe(1);
    expect(controls[1]?.destroyed).toBe(0);
    expect(document.querySelector('[data-simul-replica-viewport]')).not.toBe(firstRoot);
    expect(stream.acknowledgements.at(-1)).toBe(2);
    expect(stream.checkpointAcknowledgements).toEqual([0, 2]);
    engine.dispose();
  });

  it('fails a silent checkpoint recovery after one bounded deadline', async () => {
    const { document } = replicaDocument();
    const stream = new FakeLiveStream(checkpointAt(0));
    const controls: FakeLiveReplayerControl[] = [];
    const failures: string[] = [];
    const engine = new RrwebShadowReplicaEngine({
      presentationHost: createPresentationHost(document),
      capture: async () => checkpointAt(0),
      openStream: async () => stream,
      captureDeadlineMs: 1,
      onLiveFailure: (code) => failures.push(code),
      createReplayer: createFakeLiveReplayerFactory(document, controls, true),
    });
    await engine.run(request);
    const committed = document.querySelector('[data-simul-replica-viewport]');

    stream.emitBatch(liveBatch(2));
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(stream.checkpointRequests).toBe(1);
    expect(failures).toEqual(['stream_failed']);
    expect(stream.disposed).toBe(1);
    expect(document.querySelector('[data-simul-replica-viewport]')).toBe(committed);
    engine.dispose();
  });

  it('rotates a healthy long-lived replay through a bounded checkpoint', async () => {
    const { document } = replicaDocument();
    const stream = new FakeLiveStream(checkpointAt(0));
    const controls: FakeLiveReplayerControl[] = [];
    const engine = new RrwebShadowReplicaEngine({
      presentationHost: createPresentationHost(document),
      capture: async () => checkpointAt(0),
      openStream: async () => stream,
      maxAppliedBatchesBeforeCheckpoint: 2,
      createReplayer: createFakeLiveReplayerFactory(document, controls, true),
    });
    await engine.run(request);

    stream.emitBatch(liveBatch(1));
    await flushAsyncWork();
    stream.emitBatch(liveBatch(2));
    await flushAsyncWork();

    expect(stream.acknowledgements).toEqual([0, 1, 2]);
    expect(stream.checkpointRequests).toBe(1);
    stream.emitCheckpoint(checkpointAt(2));
    await flushAsyncWork();

    expect(controls).toHaveLength(2);
    expect(controls[0]?.destroyed).toBe(1);
    expect(stream.checkpointAcknowledgements).toEqual([0, 2]);
    engine.dispose();
  });

  it('ACKs but does not cast source scroll when scroll sync is disabled', async () => {
    const { document } = replicaDocument();
    const stream = new FakeLiveStream(checkpointAt(0));
    const controls: FakeLiveReplayerControl[] = [];
    const engine = new RrwebShadowReplicaEngine({
      presentationHost: createPresentationHost(document),
      capture: async () => checkpointAt(0),
      openStream: async () => stream,
      shouldReplayScroll: () => false,
      createReplayer: createFakeLiveReplayerFactory(document, controls, true),
    });
    await engine.run(request);

    stream.emitBatch(liveBatch(1));
    await flushAsyncWork();

    expect(controls[0]?.addedEvents).toEqual([]);
    expect(stream.acknowledgements).toEqual([0, 1]);
    engine.dispose();
  });

  it('hides a partially cast batch behind last-good legacy while recovering', async () => {
    const { document } = replicaDocument();
    const stream = new FakeLiveStream(checkpointAt(0));
    const controls: FakeLiveReplayerControl[] = [];
    const engine = new RrwebShadowReplicaEngine({
      presentationHost: createPresentationHost(document),
      capture: async () => checkpointAt(0),
      openStream: async () => stream,
      replayDeadlineMs: 1,
      createReplayer: createFakeLiveReplayerFactory(document, controls, false),
    });
    await engine.run(request);

    stream.emitBatch(liveBatch(1, 2));
    expect(document.querySelector<HTMLElement>('#legacy')?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('#preview')?.hidden).toBe(true);
    controls[0]?.emit('event-cast', controls[0]?.addedEvents[0]);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(stream.acknowledgements).toEqual([0]);
    expect(stream.checkpointRequests).toBe(1);
    expect(document.querySelector<HTMLElement>('#legacy')?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('#preview')?.hidden).toBe(true);
    expect(document.querySelector('#visible')?.textContent).toBe('legacy');
    engine.dispose();
  });

  it('keeps the committed replica when a recovery candidate times out', async () => {
    const { document } = replicaDocument();
    const stream = new FakeLiveStream(checkpointAt(0));
    const controls: FakeLiveReplayerControl[] = [];
    const failures: string[] = [];
    const factory = createFakeLiveReplayerFactory(document, controls, true);
    const engine = new RrwebShadowReplicaEngine({
      presentationHost: createPresentationHost(document),
      capture: async () => checkpointAt(0),
      openStream: async () => stream,
      replayDeadlineMs: 1,
      onLiveFailure: (code) => failures.push(code),
      createReplayer: (events, root, live) => {
        const replayer = factory(events, root, live);
        if (controls.length === 2) controls[1]!.rebuildOnPlay = false;
        return replayer;
      },
    });
    await engine.run(request);
    const committed = document.querySelector('[data-simul-replica-viewport]');

    stream.emitBatch(liveBatch(2));
    await flushAsyncWork();
    stream.emitCheckpoint(checkpointAt(2));
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(failures).toEqual(['stream_failed']);
    expect(document.querySelector('[data-simul-replica-viewport]')).toBe(committed);
    expect(controls[0]?.destroyed).toBe(0);
    expect(controls[1]?.destroyed).toBe(1);
    engine.dispose();
  });

  it('rejects late old-document batches before addEvent', async () => {
    let current = true;
    const liveRequest: ReplicaCaptureRequest = {
      ...request,
      isCurrent: () => current,
    };
    const { document } = replicaDocument();
    const stream = new FakeLiveStream(checkpointAt(0));
    const controls: FakeLiveReplayerControl[] = [];
    const engine = new RrwebShadowReplicaEngine({
      presentationHost: createPresentationHost(document),
      capture: async () => checkpointAt(0),
      openStream: async () => stream,
      createReplayer: createFakeLiveReplayerFactory(document, controls, true),
    });
    await engine.run(liveRequest);

    current = false;
    stream.emitBatch(liveBatch(1));
    await flushAsyncWork();
    expect(controls[0]?.addedEvents).toEqual([]);
    expect(stream.acknowledgements).toEqual([0]);
    engine.dispose();
  });

  it('fails one overlapping recovery without releasing the committed replica', async () => {
    const { document } = replicaDocument();
    const stream = new FakeLiveStream(checkpointAt(0));
    const controls: FakeLiveReplayerControl[] = [];
    const failures: string[] = [];
    const factory = createFakeLiveReplayerFactory(document, controls, true);
    const engine = new RrwebShadowReplicaEngine({
      presentationHost: createPresentationHost(document),
      capture: async () => checkpointAt(0),
      openStream: async () => stream,
      onLiveFailure: (code) => failures.push(code),
      createReplayer: (events, root, live) => {
        const replayer = factory(events, root, live);
        if (controls.length === 2) controls[1]!.rebuildOnPlay = false;
        return replayer;
      },
    });
    await engine.run(request);
    const committed = document.querySelector('[data-simul-replica-viewport]');
    stream.emitBatch(liveBatch(2));
    stream.emitCheckpoint(checkpointAt(2));
    await flushAsyncWork();
    expect(controls).toHaveLength(2);

    stream.emitCheckpoint(checkpointAt(2));
    await flushAsyncWork();

    expect(failures).toEqual(['stream_failed']);
    expect(stream.disposed).toBe(1);
    expect(controls[0]?.destroyed).toBe(0);
    expect(controls[1]?.destroyed).toBe(1);
    expect(document.querySelector('[data-simul-replica-viewport]')).toBe(committed);
    engine.dispose();
  });

  it('bounds catch-up overflow while a hidden recovery is rebuilding', async () => {
    const { document } = replicaDocument();
    const stream = new FakeLiveStream(checkpointAt(0));
    const controls: FakeLiveReplayerControl[] = [];
    const failures: string[] = [];
    const factory = createFakeLiveReplayerFactory(document, controls, true);
    const engine = new RrwebShadowReplicaEngine({
      presentationHost: createPresentationHost(document),
      capture: async () => checkpointAt(0),
      openStream: async () => stream,
      onLiveFailure: (code) => failures.push(code),
      createReplayer: (events, root, live) => {
        const replayer = factory(events, root, live);
        if (controls.length === 2) controls[1]!.rebuildOnPlay = false;
        return replayer;
      },
    });
    await engine.run(request);
    const committed = document.querySelector('[data-simul-replica-viewport]');
    stream.emitBatch(liveBatch(2));
    stream.emitCheckpoint(checkpointAt(2));
    await flushAsyncWork();

    for (let sequence = 3; sequence <= 7; sequence += 1) {
      stream.emitBatch(liveBatch(sequence));
    }
    await flushAsyncWork();

    expect(failures).toEqual(['stream_overflow']);
    expect(stream.disposed).toBe(1);
    expect(controls[1]?.destroyed).toBe(1);
    expect(document.querySelector('[data-simul-replica-viewport]')).toBe(committed);
    engine.dispose();
  });

  it('never ACKs an event whose cast settles after navigation', async () => {
    let current = true;
    const liveRequest: ReplicaCaptureRequest = {
      ...request,
      isCurrent: () => current,
    };
    const { document } = replicaDocument();
    const stream = new FakeLiveStream(checkpointAt(0));
    const controls: FakeLiveReplayerControl[] = [];
    const engine = new RrwebShadowReplicaEngine({
      presentationHost: createPresentationHost(document),
      capture: async () => checkpointAt(0),
      openStream: async () => stream,
      createReplayer: createFakeLiveReplayerFactory(document, controls, false),
    });
    await engine.run(liveRequest);
    stream.emitBatch(liveBatch(1));
    expect(controls[0]?.addedEvents).toHaveLength(1);

    current = false;
    controls[0]?.emit('event-cast', controls[0]?.addedEvents[0]);
    await flushAsyncWork();

    expect(stream.acknowledgements).toEqual([0]);
    engine.dispose();
  });

  it('requests recovery before addEvent for a decreasing timestamp', async () => {
    const { document } = replicaDocument();
    const stream = new FakeLiveStream(checkpointAt(0));
    const controls: FakeLiveReplayerControl[] = [];
    const engine = new RrwebShadowReplicaEngine({
      presentationHost: createPresentationHost(document),
      capture: async () => checkpointAt(0),
      openStream: async () => stream,
      createReplayer: createFakeLiveReplayerFactory(document, controls, true),
    });
    await engine.run(request);
    const invalid = liveBatch(1);
    stream.emitBatch({
      ...invalid,
      events: invalid.events.map((event) => ({
        ...(event as Record<string, unknown>),
        timestamp: 1,
      })),
    });
    await flushAsyncWork();

    expect(controls[0]?.addedEvents).toEqual([]);
    expect(stream.checkpointRequests).toBe(1);
    engine.dispose();
  });
});

function replicaDocument(): ReturnType<typeof parseHTML> {
  return parseHTML(
    '<html><body><section id="legacy"><main id="visible">legacy</main></section>' +
      '<section id="preview" hidden aria-hidden="true"></section>' +
      '<p id="badge" hidden></p></body></html>',
  );
}

function createPresentationHost(document: Document): VisibleReplayHost {
  const legacySurface = document.querySelector<HTMLElement>('#legacy');
  const previewSurface = document.querySelector<HTMLElement>('#preview');
  const badge = document.querySelector<HTMLElement>('#badge');
  if (!legacySurface || !previewSurface || !badge) {
    throw new Error('Missing replica presentation fixture surface.');
  }
  return new VisibleReplayHost({
    hostDocument: document,
    legacySurface,
    previewSurface,
    badge,
  });
}

function checkpoint(): ReplicaCheckpointEnvelope {
  const identity = createReplicaIdentity({
    sessionId: request.sessionId,
    pageEpoch: request.pageEpoch,
    generation: request.generation,
    documentId: 'document-engine',
    frameId: 0,
    sequence: 0,
  });
  const response = createCheckpointEnvelope(identity, {
    events: [
      {
        type: 4,
        data: { href: 'https://example.test/', width: 1_000, height: 700 },
        timestamp: 1,
      },
      {
        type: 2,
        data: {
          node: {
            type: 0,
            id: 1,
            childNodes: [
              {
                type: 2,
                id: 2,
                tagName: 'html',
                attributes: {},
                childNodes: [
                  {
                    type: 2,
                    id: 3,
                    tagName: 'body',
                    attributes: {},
                    childNodes: [
                      {
                        type: 2,
                        id: 4,
                        tagName: 'p',
                        attributes: {},
                        childNodes: [
                          { type: 3, id: 5, textContent: 'initial' },
                        ],
                      },
                      {
                        type: 2,
                        id: 6,
                        tagName: 'style',
                        attributes: {},
                        childNodes: [
                          {
                            type: 3,
                            id: 7,
                            textContent: 'p { color: black; }',
                            isStyle: true,
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          initialOffset: { top: 0, left: 0 },
        },
        timestamp: 2,
      },
    ],
    captureMs: 12,
    viewportWidth: 1_000,
    viewportHeight: 700,
    documentWidth: 1_300,
    documentHeight: 2_600,
  });
  if (response.kind !== 'simul:replica-v2:checkpoint') {
    throw new Error('Fixture checkpoint was unexpectedly rejected.');
  }
  return response;
}

function busyCheckpoint(): ReturnType<typeof createCheckpointError> {
  return createCheckpointError(
    createReplicaIdentity({
      sessionId: request.sessionId,
      pageEpoch: request.pageEpoch,
      generation: request.generation,
      documentId: request.documentId,
      frameId: request.frameId,
      sequence: 0,
    }),
    'capture_busy',
  );
}

function sequenceClock(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

function defineDimension(element: Element, key: string, value: number): void {
  Object.defineProperty(element, key, { configurable: true, value });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class FakeLiveStream implements ReplicaLiveStreamLease {
  readonly initialCheckpoint: Promise<ReplicaCheckpointResponse>;
  readonly acknowledgements: number[] = [];
  readonly checkpointAcknowledgements: number[] = [];
  checkpointRequests = 0;
  disposed = 0;
  #observer: ReplicaLiveStreamObserver | undefined;

  constructor(
    checkpointResponse: ReplicaCheckpointResponse | Promise<ReplicaCheckpointResponse>,
  ) {
    this.initialCheckpoint = Promise.resolve(checkpointResponse);
  }

  setObserver(observer: ReplicaLiveStreamObserver): void {
    this.#observer = observer;
  }

  acknowledge(sequence: number): void {
    this.acknowledgements.push(sequence);
  }

  acknowledgeCheckpoint(sequence: number): void {
    this.checkpointAcknowledgements.push(sequence);
  }

  requestCheckpoint(): void {
    this.checkpointRequests += 1;
  }

  dispose(): void {
    this.disposed += 1;
    this.#observer = undefined;
  }

  emitBatch(batch: ReplicaLiveBatch): void {
    this.#observer?.onBatch(batch);
  }

  emitCheckpoint(checkpointResponse: ReplicaCheckpointResponse): void {
    this.#observer?.onCheckpoint(checkpointResponse);
  }
}

interface FakeLiveReplayerControl {
  readonly addedEvents: unknown[];
  readonly handlers: Map<string, Set<(event?: unknown) => void>>;
  rebuildOnPlay: boolean;
  destroyed: number;
  readonly textNode: Text;
  emit(event: string, payload?: unknown): void;
}

function createFakeLiveReplayerFactory(
  hostDocument: Document,
  controls: FakeLiveReplayerControl[],
  autoCast: boolean,
): (
  events: readonly unknown[],
  root: HTMLElement,
  live: boolean,
) => {
  iframe: HTMLIFrameElement;
  on(event: string, handler: (event?: unknown) => void): void;
  off(event: string, handler: (event?: unknown) => void): void;
  play(): void;
  startLive(): void;
  addEvent(event: unknown): void;
  getMirror(): { getNode(id: number): Node | null };
  disableInteract(): void;
  destroy(): void;
} {
  return (_events, root) => {
    const iframe = hostDocument.createElement('iframe');
    const replayDocument = parseHTML(
      '<html><body><p>initial</p></body></html>',
    ).document;
    const textNode = replayDocument.querySelector('p')?.firstChild;
    if (!textNode || textNode.nodeType !== 3) {
      throw new Error('Missing fake rrweb text node.');
    }
    Object.defineProperty(iframe, 'contentDocument', {
      configurable: true,
      value: replayDocument,
    });
    root.append(iframe);
    const control: FakeLiveReplayerControl = {
      addedEvents: [],
      handlers: new Map(),
      rebuildOnPlay: true,
      destroyed: 0,
      textNode: textNode as Text,
      emit(event, payload) {
        for (const handler of this.handlers.get(event) ?? []) handler(payload);
      },
    };
    controls.push(control);
    return {
      iframe,
      on: (event, handler) => {
        const handlers = control.handlers.get(event) ?? new Set();
        handlers.add(handler);
        control.handlers.set(event, handlers);
      },
      off: (event, handler) => {
        control.handlers.get(event)?.delete(handler);
      },
      play: () => {
        if (control.rebuildOnPlay) control.emit('fullsnapshot-rebuilded');
      },
      startLive: () => undefined,
      addEvent: (event) => {
        control.addedEvents.push(event);
        applyFakeTextMutation(event, control.textNode);
        if (autoCast) queueMicrotask(() => control.emit('event-cast', event));
      },
      getMirror: () => ({
        getNode: (id) => id === 5 ? control.textNode : null,
      }),
      disableInteract: () => undefined,
      destroy: () => {
        control.destroyed += 1;
      },
    };
  };
}

function applyFakeTextMutation(event: unknown, textNode: Text): void {
  if (
    typeof event !== 'object' ||
    event === null ||
    !('type' in event) ||
    event.type !== 3 ||
    !('data' in event) ||
    typeof event.data !== 'object' ||
    event.data === null ||
    !('source' in event.data) ||
    event.data.source !== 0 ||
    !('texts' in event.data) ||
    !Array.isArray(event.data.texts)
  ) return;
  for (const entry of event.data.texts) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      'id' in entry &&
      entry.id === 5 &&
      'value' in entry &&
      typeof entry.value === 'string'
    ) textNode.textContent = entry.value;
  }
}

function checkpointAt(sequence: number): ReplicaCheckpointEnvelope {
  const base = checkpoint();
  const response = createCheckpointEnvelope(
    createReplicaIdentity({
      sessionId: request.sessionId,
      pageEpoch: request.pageEpoch,
      generation: request.generation,
      documentId: request.documentId,
      frameId: request.frameId,
      sequence,
    }),
    {
      events: base.payload.events,
      captureMs: base.payload.captureMs,
      viewportWidth: base.payload.viewportWidth,
      viewportHeight: base.payload.viewportHeight,
      documentWidth: base.payload.documentWidth,
      documentHeight: base.payload.documentHeight,
    },
  );
  if (response.kind !== 'simul:replica-v2:checkpoint') {
    throw new Error('Live checkpoint fixture was unexpectedly rejected.');
  }
  return response;
}

function liveBatch(firstSequence: number, count = 1): ReplicaLiveBatch {
  const events = Array.from({ length: count }, (_, offset) => {
    const sequence = firstSequence + offset;
    return {
      type: 3,
      data: { source: 3, id: 2, x: sequence, y: sequence * 2 },
      timestamp: 10 + sequence,
    };
  });
  return liveBatchFromEvents(firstSequence, events);
}

function liveBatchFromEvents(
  firstSequence: number,
  events: readonly unknown[],
): ReplicaLiveBatch {
  const lastSequence = firstSequence + events.length - 1;
  return {
    identity: checkpointAt(lastSequence).identity,
    firstSequence,
    lastSequence,
    events,
    byteLength: new TextEncoder().encode(JSON.stringify(events)).byteLength,
  };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
