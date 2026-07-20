import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  emptyReplicaDiagnostics,
  type ReplicaCaptureRequest,
  type ReplicaCheckpointEnvelope,
} from '../lib/replica/contracts';
import {
  ReplicaEngineController,
  selectReplicaEngineMode,
} from '../lib/replica/engine-selection';
import { FakeReplicaEngine } from '../lib/replica/fakes';
import {
  createCheckpointEnvelope,
  createCheckpointError,
  createReplicaIdentity,
} from '../lib/replica/protocol-v2';
import { RrwebShadowReplicaEngine } from '../lib/replica/rrweb-shadow-engine';
import {
  LEGACY_FALLBACK_LABEL,
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
  it('keeps production and unrequested development builds on legacy', () => {
    expect(selectReplicaEngineMode({ DEV: false, WXT_SIMUL_RRWEB_SHADOW: '1' })).toBe('legacy');
    expect(selectReplicaEngineMode({ DEV: true })).toBe('legacy');
    expect(selectReplicaEngineMode({ DEV: true, WXT_SIMUL_RRWEB_SHADOW: '1' })).toBe('rrweb-shadow');
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
    expect(shadow.presentationReleases).toBe(1);
    expect(shadow.lastFallbackLabel).toBe(true);
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
                childNodes: [],
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
