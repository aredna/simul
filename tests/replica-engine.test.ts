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
});

describe('rrweb shadow engine', () => {
  it('replays in hidden inert source-sized staging and returns content-free diagnostics', async () => {
    const { document } = parseHTML('<html><body><main id="visible">legacy</main></body></html>');
    const initialChildren = document.body.children.length;
    let iframe: HTMLIFrameElement | undefined;
    let disabled = false;
    let destroyed = false;
    const replayDocument = parseHTML('<html><body></body></html>').document;
    defineDimension(replayDocument.documentElement, 'scrollWidth', 1_250);
    defineDimension(replayDocument.documentElement, 'scrollHeight', 2_450);
    const engine = new RrwebShadowReplicaEngine({
      hostDocument: document,
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
    expect(disabled).toBe(true);
    expect(destroyed).toBe(true);
    expect(document.body.children.length).toBe(initialChildren);
    expect(document.querySelector('#visible')?.textContent).toBe('legacy');
  });

  it('rejects stale work before capture or replay', async () => {
    let captures = 0;
    const { document } = parseHTML('<html><body><p>legacy</p></body></html>');
    const engine = new RrwebShadowReplicaEngine({
      hostDocument: document,
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
    expect(document.querySelector('[data-simul-replica-shadow]')).toBeNull();
  });

  it('treats overlapping recorder work as transient instead of poisoning fallback', async () => {
    const { document } = parseHTML('<html><body><p>legacy</p></body></html>');
    const engine = new RrwebShadowReplicaEngine({
      hostDocument: document,
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

  it('times out once, removes staging, and retains the legacy document', async () => {
    const { document } = parseHTML('<html><body><p id="legacy">usable</p></body></html>');
    let destroyed = false;
    const engine = new RrwebShadowReplicaEngine({
      hostDocument: document,
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
    expect(document.querySelector('[data-simul-replica-shadow]')).toBeNull();
    expect(document.querySelector('#legacy')?.textContent).toBe('usable');
  });
});

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

function sequenceClock(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

function defineDimension(element: Element, key: string, value: number): void {
  Object.defineProperty(element, key, { configurable: true, value });
}
