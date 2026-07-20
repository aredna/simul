import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import type { ReplicaDocumentIdentity } from '../lib/replica/contracts';
import { MAX_REPLICA_LIVE_EVENT_BYTES } from '../lib/replica/live-protocol';
import {
  LiveRecorderSession,
  rewriteLiveCheckpointStyleSheets,
  rewriteLiveIncrementalStyleSheets,
} from '../lib/replica/live-recorder-session';
import type { RecorderOptions } from '../lib/replica/page-recorder';
import { createReplicaIdentity } from '../lib/replica/protocol-v2';

describe('shared live recorder session', () => {
  it('preserves one source CSSRule position when rrweb flattened an import', () => {
    const events = checkpointEventsForStyle(
      'p { color: red; } r { color: blue; } q { display: block; }',
    );
    const importedSheet = {
      cssRules: [
        { type: 1, cssText: 'p { background-image: url("https://images.example/p.png"); }' },
        { type: 1, cssText: 'r { color: blue; }' },
      ],
    };
    const sourceSheet = {
      cssRules: [
        {
          type: 3,
          cssText: '@import url("https://styles.example/base.css");',
          styleSheet: importedSheet,
          media: { mediaText: 'all' },
        },
        { type: 1, cssText: 'q { display: block; }' },
      ],
    };

    const rewritten = rewriteLiveCheckpointStyleSheets(
      events,
      (id) => id === 3 ? { sheet: sourceSheet } as unknown as Node : null,
    );
    expect(rewritten).toBeDefined();
    const cssText = readCheckpointStyleText(rewritten);
    expect(cssText).toContain('@media all, (simul-inlined-import)');
    expect(cssText).toContain('url("about:blank")');
    expect(cssText).not.toContain('styles.example');
    expect(cssText).not.toContain('images.example');

    const { document } = parseHTML('<html><head></head></html>');
    const style = document.createElement('style');
    style.textContent = cssText;
    document.head.append(style);
    expect(style.sheet?.cssRules).toHaveLength(2);
    expect((style.sheet?.cssRules[0] as CSSMediaRule | undefined)?.cssRules)
      .toHaveLength(2);

    const incremental = rewriteLiveIncrementalStyleSheets({
      type: 3,
      data: {
        source: 0,
        texts: [],
        attributes: [],
        removes: [],
        adds: [{
          parentId: 2,
          nextId: null,
          node: {
            type: 2,
            id: 3,
            tagName: 'style',
            attributes: {
              _cssText: 'p { color: red; } r { color: blue; } q { display: block; }',
            },
            childNodes: [],
          },
        }],
      },
      timestamp: 3,
    }, (id) => id === 3 ? { sheet: sourceSheet } as unknown as Node : null);
    expect(JSON.stringify(incremental)).toContain('simul-inlined-import');
    expect(JSON.stringify(incremental)).not.toContain('styles.example');
  });

  it('retains the stripped serialized node when source cssRules are inaccessible', () => {
    const events = checkpointEventsForStyle('p { color: red; }');
    const inaccessibleSheet = Object.defineProperty({}, 'cssRules', {
      get(): never {
        throw new DOMException('Cross-origin stylesheet', 'SecurityError');
      },
    });

    const rewritten = rewriteLiveCheckpointStyleSheets(
      events,
      (id) => id === 3
        ? { sheet: inaccessibleSheet } as unknown as Node
        : null,
    );

    expect(rewritten).toBeDefined();
    expect(readCheckpointStyleText(rewritten)).toBe('p { color: red; }');
  });

  it('fails closed when import rewriting would invalidate a namespace prelude', () => {
    const events = checkpointEventsForStyle(
      'p {} @namespace svg "urn:source"; svg|q { color: red; }',
    );
    const sourceSheet = {
      cssRules: [
        {
          type: 3,
          cssText: '@import url("https://styles.example/base.css");',
          styleSheet: { cssRules: [{ type: 1, cssText: 'p {}' }] },
          media: { mediaText: 'all' },
        },
        { type: 10, cssText: '@namespace svg url("urn:source");' },
        { type: 1, cssText: 'svg|q { color: red; }' },
      ],
    };

    expect(rewriteLiveCheckpointStyleSheets(
      events,
      (id) => id === 3 ? { sheet: sourceSheet } as unknown as Node : null,
    )).toBeUndefined();
    expect(rewriteLiveIncrementalStyleSheets({
      data: {
        source: 0,
        adds: [{
          node: {
            type: 2,
            id: 3,
            tagName: 'style',
            attributes: { _cssText: 'p {}' },
            childNodes: [],
          },
        }],
      },
    }, (id) => id === 3
      ? { sheet: sourceSheet } as unknown as Node
      : null)).toBeUndefined();
  });

  it('starts one recorder for multiple viewers and stops it exactly once', () => {
    const harness = createHarness();
    const first: unknown[] = [];
    const second: unknown[] = [];

    expect(harness.session.addSubscriber(identity('first'), (message) => first.push(message))).toBe('subscribed');
    expect(harness.session.addSubscriber(identity('second'), (message) => second.push(message))).toBe('subscribed');

    expect(harness.startCount()).toBe(1);
    expect(kinds(first)).toEqual(['simul:replica-v2:checkpoint']);
    expect(kinds(second)).toEqual(['simul:replica-v2:checkpoint']);
    expect(harness.stopCount()).toBe(0);

    harness.session.removeSubscriber(identity('first'));
    expect(harness.stopCount()).toBe(0);
    harness.session.removeSubscriber(identity('second'));
    harness.session.dispose();
    expect(harness.stopCount()).toBe(1);
  });

  it('replaces one stable session only for a higher exact-document generation', () => {
    const harness = createHarness();
    const firstIdentity = identity('stable-viewer');
    const replacementIdentity = identity('stable-viewer', 2);
    const first: unknown[] = [];
    const replacement: unknown[] = [];

    expect(harness.session.addSubscriber(
      firstIdentity,
      (message) => first.push(message),
    )).toBe('subscribed');
    harness.session.acknowledgeCheckpoint(firstIdentity, 0);
    harness.emit(scrollEvent(1));
    harness.runFrame();

    expect(harness.session.addSubscriber(
      replacementIdentity,
      (message) => replacement.push(message),
    )).toBe('subscribed');
    expect(harness.session.addSubscriber(
      replacementIdentity,
      () => undefined,
    )).toBe('rejected');
    expect(harness.session.addSubscriber(
      identity('stable-viewer', 3, 'different-document'),
      () => undefined,
    )).toBe('rejected');
    expect(kinds(replacement)).toEqual(['simul:replica-v2:checkpoint']);
    harness.session.acknowledgeCheckpoint(replacementIdentity, 0);
    expect(kinds(replacement)).toEqual([
      'simul:replica-v2:checkpoint',
      'simul:replica-v2:batch',
    ]);

    const checkoutCount = harness.checkoutCount();
    harness.session.acknowledgeCheckpoint(firstIdentity, 0);
    harness.session.acknowledge(firstIdentity, 1);
    harness.session.requestCheckpoint(firstIdentity);
    harness.session.removeSubscriber(firstIdentity);

    expect(harness.checkoutCount()).toBe(checkoutCount);
    expect(harness.session.subscriberCount).toBe(1);
    expect(harness.stopCount()).toBe(0);

    const firstMessageCount = first.length;
    harness.emit(scrollEvent(2));
    harness.runFrame();

    expect(first).toHaveLength(firstMessageCount);
    expect(lastIdentitySequence(replacement, 'simul:replica-v2:batch')).toBe(2);
    expect([...replacement].reverse().find(isBatch)?.identity.generation).toBe(2);

    harness.session.removeSubscriber(replacementIdentity);
    expect(harness.stopCount()).toBe(1);
  });

  it('batches in frame order, ACKs viewers independently, and resyncs only a lagger', () => {
    const harness = createHarness();
    const fast: unknown[] = [];
    const slow: unknown[] = [];
    harness.session.addSubscriber(identity('fast'), (message) => fast.push(message));
    harness.session.addSubscriber(identity('slow'), (message) => slow.push(message));
    harness.session.acknowledgeCheckpoint(identity('fast'), 0);
    harness.session.acknowledgeCheckpoint(identity('slow'), 0);
    fast.length = 0;
    slow.length = 0;

    for (let sequence = 1; sequence <= 5; sequence += 1) {
      harness.emit(scrollEvent(sequence));
      harness.runFrame();
      const latestFast = [...fast].reverse().find(isBatch);
      if (latestFast) {
        harness.session.acknowledge(identity('fast'), latestFast.identity.sequence);
      }
    }

    expect(harness.session.sequence).toBe(5);
    expect(kinds(fast)).toEqual([
      'simul:replica-v2:batch',
      'simul:replica-v2:batch',
      'simul:replica-v2:batch',
      'simul:replica-v2:batch',
      'simul:replica-v2:batch',
    ]);
    expect(kinds(slow)).toEqual([
      'simul:replica-v2:batch',
      'simul:replica-v2:batch',
      'simul:replica-v2:batch',
      'simul:replica-v2:batch',
      'simul:replica-v2:stream-error',
      'simul:replica-v2:checkpoint',
    ]);
    expect(harness.checkoutCount()).toBe(1);
    expect(lastIdentitySequence(slow, 'simul:replica-v2:checkpoint')).toBe(5);
    expect(kinds(fast)).not.toContain('simul:replica-v2:checkpoint');

    harness.session.acknowledgeCheckpoint(identity('slow'), 5);
    harness.emit(scrollEvent(6));
    harness.runFrame();
    expect(lastIdentitySequence(fast, 'simul:replica-v2:batch')).toBe(6);
    expect(lastIdentitySequence(slow, 'simul:replica-v2:batch')).toBe(6);
  });

  it('promotes a targeted checkout after constructed stylesheet identity is live', () => {
    const harness = createHarness();
    const fast: unknown[] = [];
    const recovering: unknown[] = [];
    harness.session.addSubscriber(identity('constructed-fast'), (message) => fast.push(message));
    harness.session.addSubscriber(identity('constructed-recovery'), (message) => recovering.push(message));
    harness.session.acknowledgeCheckpoint(identity('constructed-fast'), 0);
    harness.session.acknowledgeCheckpoint(identity('constructed-recovery'), 0);

    harness.emit(adoptedStyleEvent(3));
    harness.runFrame();
    harness.session.acknowledge(identity('constructed-fast'), 1);
    harness.session.acknowledge(identity('constructed-recovery'), 1);
    fast.length = 0;
    recovering.length = 0;

    harness.session.requestCheckpoint(identity('constructed-recovery'));

    expect(harness.checkoutCount()).toBe(1);
    expect(kinds(fast)).toContain('simul:replica-v2:checkpoint');
    expect(kinds(recovering)).toContain('simul:replica-v2:checkpoint');
  });

  it('waits for every pending checkpoint before resetting constructed style IDs', () => {
    const harness = createHarness();
    const ready: unknown[] = [];
    const pending: unknown[] = [];
    harness.session.addSubscriber(identity('constructed-ready'), (message) => ready.push(message));
    harness.session.addSubscriber(identity('constructed-pending'), (message) => pending.push(message));
    harness.session.acknowledgeCheckpoint(identity('constructed-ready'), 0);
    harness.emit(adoptedStyleEvent(3));
    harness.runFrame();
    ready.length = 0;
    pending.length = 0;

    harness.session.requestCheckpoint(identity('constructed-ready'));
    expect(harness.checkoutCount()).toBe(0);

    harness.session.acknowledgeCheckpoint(identity('constructed-pending'), 0);
    expect(harness.checkoutCount()).toBe(1);
    expect(kinds(ready)).toContain('simul:replica-v2:checkpoint');
    expect(kinds(pending)).toContain('simul:replica-v2:checkpoint');
  });

  it('unblocks a constructed-style checkout when a pending viewer disconnects', () => {
    const harness = createHarness();
    const ready: unknown[] = [];
    harness.session.addSubscriber(identity('constructed-stayer'), (message) => ready.push(message));
    harness.session.addSubscriber(identity('constructed-leaver'), () => undefined);
    harness.session.acknowledgeCheckpoint(identity('constructed-stayer'), 0);
    harness.emit(adoptedStyleEvent(3));
    harness.runFrame();
    ready.length = 0;

    harness.session.requestCheckpoint(identity('constructed-stayer'));
    expect(harness.checkoutCount()).toBe(0);

    harness.session.removeSubscriber(identity('constructed-leaver'));
    expect(harness.checkoutCount()).toBe(1);
    expect(kinds(ready)).toContain('simul:replica-v2:checkpoint');
  });

  it('does not sequence private/nonvisual tails and checkpoints on viewport resize', () => {
    const harness = createHarness();
    const messages: unknown[] = [];
    harness.session.addSubscriber(identity('viewer'), (message) => messages.push(message));
    harness.session.acknowledgeCheckpoint(identity('viewer'), 0);
    messages.length = 0;

    harness.emit({
      type: 3,
      data: { source: 5, id: 2, text: 'PRIVATE-INPUT-CANARY', isChecked: false },
      timestamp: 4,
    });
    harness.runFrame();
    expect(harness.session.sequence).toBe(0);
    expect(messages).toEqual([]);

    harness.emit({
      type: 3,
      data: { source: 4, width: 900, height: 700 },
      timestamp: 5,
    });
    expect(harness.checkoutCount()).toBe(1);
    expect(kinds(messages)).toEqual(['simul:replica-v2:checkpoint']);
    expect(JSON.stringify(messages)).not.toContain('PRIVATE-INPUT-CANARY');
  });

  it('preflights before rrweb allocation and fails closed when the page is too large', () => {
    const harness = createHarness('checkpoint_too_large');
    const messages: unknown[] = [];
    expect(harness.session.addSubscriber(
      identity('oversized'),
      (message) => messages.push(message),
    )).toBe('failed');

    expect(harness.startCount()).toBe(0);
    expect(harness.session.subscriberCount).toBe(0);
    expect(kinds(messages)).toEqual(['simul:replica-v2:stream-error']);
    expect(messages).toMatchObject([
      { payload: { code: 'stream_overflow' } },
    ]);
  });

  it('checkpoints instead of sequencing one oversized admitted event', () => {
    const harness = createHarness();
    const messages: unknown[] = [];
    harness.session.addSubscriber(identity('oversized-event'), (message) => {
      messages.push(message);
    });
    harness.session.acknowledgeCheckpoint(identity('oversized-event'), 0);
    messages.length = 0;

    harness.emit({
      type: 3,
      data: {
        source: 8,
        id: 2,
        replace: 'x'.repeat(MAX_REPLICA_LIVE_EVENT_BYTES + 1),
      },
      timestamp: 7,
    });

    expect(harness.session.sequence).toBe(0);
    expect(harness.checkoutCount()).toBe(1);
    expect(kinds(messages)).toEqual(['simul:replica-v2:checkpoint']);
  });

  it('coalesces multiple lagging viewers into one shared checkout', () => {
    const harness = createHarness();
    const first: unknown[] = [];
    const second: unknown[] = [];
    harness.session.addSubscriber(identity('first-lagger'), (message) => first.push(message));
    harness.session.addSubscriber(identity('second-lagger'), (message) => second.push(message));
    harness.session.acknowledgeCheckpoint(identity('first-lagger'), 0);
    harness.session.acknowledgeCheckpoint(identity('second-lagger'), 0);
    first.length = 0;
    second.length = 0;

    for (let sequence = 1; sequence <= 5; sequence += 1) {
      harness.emit(scrollEvent(sequence));
      harness.runFrame();
    }

    expect(harness.checkoutCount()).toBe(1);
    expect(kinds(first).filter((kind) => kind === 'simul:replica-v2:checkpoint')).toHaveLength(1);
    expect(kinds(second).filter((kind) => kind === 'simul:replica-v2:checkpoint')).toHaveLength(1);
  });

  it('does not replace a delivered checkpoint until its explicit commit ACK', () => {
    const harness = createHarness();
    const messages: unknown[] = [];
    harness.session.addSubscriber(identity('checkpoint-proof'), (message) => {
      messages.push(message);
    });
    harness.session.acknowledgeCheckpoint(identity('checkpoint-proof'), 0);
    messages.length = 0;
    harness.emit(scrollEvent(1));
    harness.runFrame();
    harness.emit(viewportResizeEvent(20));
    expect(harness.checkoutCount()).toBe(1);

    // This is the delayed ACK for batch 1, not proof that checkpoint 1 was
    // committed. A second resize must remain deferred.
    harness.session.acknowledge(identity('checkpoint-proof'), 1);
    harness.emit(viewportResizeEvent(21));
    expect(harness.checkoutCount()).toBe(1);

    harness.session.acknowledgeCheckpoint(identity('checkpoint-proof'), 1);
    expect(harness.checkoutCount()).toBe(2);
    expect(kinds(messages).filter((kind) => kind === 'simul:replica-v2:checkpoint')).toHaveLength(2);
  });

  it('bounds mutation traffic while a recovery checkpoint remains unACKed', () => {
    const harness = createHarness();
    const messages: unknown[] = [];
    harness.session.addSubscriber(identity('stalled-recovery'), (message) => {
      messages.push(message);
    });
    harness.session.acknowledgeCheckpoint(identity('stalled-recovery'), 0);
    messages.length = 0;

    for (let sequence = 1; sequence <= 10; sequence += 1) {
      harness.emit(scrollEvent(sequence));
      harness.runFrame();
    }

    expect(harness.checkoutCount()).toBe(1);
    expect(kinds(messages).filter((kind) => kind === 'simul:replica-v2:checkpoint')).toHaveLength(1);
    expect(kinds(messages).filter((kind) => kind === 'simul:replica-v2:stream-error')).toHaveLength(1);
  });

  it('advances an unsolicited checkpoint over mutations queued before resize', () => {
    const harness = createHarness();
    const messages: unknown[] = [];
    harness.session.addSubscriber(identity('forward-checkpoint'), (message) => {
      messages.push(message);
    });
    harness.session.acknowledgeCheckpoint(identity('forward-checkpoint'), 0);
    messages.length = 0;

    harness.emit(scrollEvent(1));
    harness.emit(viewportResizeEvent(20));

    expect(harness.session.sequence).toBe(1);
    expect(harness.checkoutCount()).toBe(1);
    expect(kinds(messages)).toEqual(['simul:replica-v2:checkpoint']);
    expect(lastIdentitySequence(messages, 'simul:replica-v2:checkpoint')).toBe(1);
  });

  it('pauses post-checkpoint traffic until ACK and rolls excess history forward', () => {
    const harness = createHarness();
    const messages: unknown[] = [];
    const viewer = identity('active-recovery');
    harness.session.addSubscriber(viewer, (message) => messages.push(message));
    harness.session.acknowledgeCheckpoint(viewer, 0);
    messages.length = 0;

    harness.session.requestCheckpoint(viewer);
    for (let sequence = 1; sequence <= 10; sequence += 1) {
      harness.emit(scrollEvent(sequence));
      harness.runFrame();
    }

    expect(kinds(messages)).toEqual(['simul:replica-v2:checkpoint']);
    expect(lastIdentitySequence(messages, 'simul:replica-v2:checkpoint')).toBe(0);

    harness.session.acknowledgeCheckpoint(viewer, 0);

    expect(harness.checkoutCount()).toBe(2);
    expect(kinds(messages)).toEqual([
      'simul:replica-v2:checkpoint',
      'simul:replica-v2:checkpoint',
    ]);
    expect(lastIdentitySequence(messages, 'simul:replica-v2:checkpoint')).toBe(10);

    harness.session.acknowledgeCheckpoint(viewer, 10);
    harness.emit(scrollEvent(11));
    harness.runFrame();

    expect(lastIdentitySequence(messages, 'simul:replica-v2:batch')).toBe(11);
  });

  it('fails instead of hanging when checkout emits Meta without a FullSnapshot', () => {
    const harness = createHarness(undefined, 'meta-only');
    const messages: unknown[] = [];
    harness.session.addSubscriber(identity('incomplete-checkout'), (message) => {
      messages.push(message);
    });
    harness.session.acknowledgeCheckpoint(identity('incomplete-checkout'), 0);
    messages.length = 0;

    harness.emit(viewportResizeEvent(20));

    expect(harness.checkoutCount()).toBe(1);
    expect(harness.session.subscriberCount).toBe(0);
    expect(messages).toMatchObject([
      { kind: 'simul:replica-v2:stream-error', payload: { code: 'stream_failed' } },
    ]);
  });
});

function createHarness(
  preflightError?: 'checkpoint_too_large' | 'capture_failed',
  checkoutMode: 'complete' | 'meta-only' = 'complete',
): {
  session: LiveRecorderSession;
  emit(event: unknown, checkout?: boolean): void;
  runFrame(): void;
  startCount(): number;
  stopCount(): number;
  checkoutCount(): number;
} {
  const { document } = parseHTML('<html><body><p>fixture</p></body></html>');
  const sourceWindow = {
    innerWidth: 800,
    innerHeight: 600,
  } as unknown as Window;
  Object.defineProperty(sourceWindow, 'top', { value: sourceWindow });
  let options: RecorderOptions | undefined;
  let starts = 0;
  let stops = 0;
  let checkouts = 0;
  const frames: Array<() => void> = [];
  const emitCheckpoint = (checkout = false): void => {
    options?.emit(checkpointEvents()[0], checkout);
    options?.emit(checkpointEvents()[1], checkout);
  };
  const session = new LiveRecorderSession({
    document,
    window: sourceWindow,
    now: () => 10,
    preflight: () => preflightError,
    start: (nextOptions) => {
      starts += 1;
      options = nextOptions;
      emitCheckpoint(false);
      return () => {
        stops += 1;
      };
    },
    takeFullSnapshot: () => {
      checkouts += 1;
      if (checkoutMode === 'meta-only') options?.emit(checkpointEvents()[0], true);
      else emitCheckpoint(true);
    },
    scheduleFrame: (callback) => {
      frames.push(callback);
      return callback;
    },
    cancelFrame: (handle) => {
      const index = frames.indexOf(handle as () => void);
      if (index >= 0) frames.splice(index, 1);
    },
  });
  return {
    session,
    emit: (event, checkout = false) => options?.emit(event, checkout),
    runFrame: () => frames.shift()?.(),
    startCount: () => starts,
    stopCount: () => stops,
    checkoutCount: () => checkouts,
  };
}

function identity(
  sessionId: string,
  generation = 1,
  documentId = 'document-recorder-session',
): ReplicaDocumentIdentity {
  return createReplicaIdentity({
    sessionId,
    pageEpoch: generation,
    generation,
    documentId,
    frameId: 0,
    sequence: 0,
  });
}

function checkpointEvents(): readonly [Record<string, unknown>, Record<string, unknown>] {
  return [
    {
      type: 4,
      data: { href: 'https://example.test/', width: 800, height: 600 },
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
  ];
}

function checkpointEventsForStyle(cssText: string): readonly unknown[] {
  return [
    checkpointEvents()[0],
    {
      type: 2,
      data: {
        node: {
          type: 0,
          id: 1,
          childNodes: [{
            type: 2,
            id: 2,
            tagName: 'html',
            attributes: {},
            childNodes: [{
              type: 2,
              id: 3,
              tagName: 'style',
              attributes: { _cssText: cssText },
              childNodes: [],
            }],
          }],
        },
        initialOffset: { top: 0, left: 0 },
      },
      timestamp: 2,
    },
  ];
}

function readCheckpointStyleText(events: readonly unknown[] | undefined): string {
  const snapshot = events?.[1];
  if (!isRecord(snapshot) || !isRecord(snapshot.data) || !isRecord(snapshot.data.node)) {
    throw new Error('Missing rewritten checkpoint snapshot.');
  }
  const html = Array.isArray(snapshot.data.node.childNodes)
    ? snapshot.data.node.childNodes[0]
    : undefined;
  const style = isRecord(html) && Array.isArray(html.childNodes)
    ? html.childNodes[0]
    : undefined;
  const attributes = isRecord(style) && isRecord(style.attributes)
    ? style.attributes
    : undefined;
  if (!attributes || typeof attributes._cssText !== 'string') {
    throw new Error('Missing rewritten style text.');
  }
  return attributes._cssText;
}

function scrollEvent(timestamp: number): Record<string, unknown> {
  return {
    type: 3,
    data: { source: 3, id: 2, x: timestamp, y: timestamp * 2 },
    timestamp: 10 + timestamp,
  };
}

function adoptedStyleEvent(timestamp: number): Record<string, unknown> {
  return {
    type: 3,
    data: {
      source: 15,
      id: 1,
      styleIds: [20],
      styles: [{ styleId: 20, rules: [] }],
    },
    timestamp,
  };
}

function viewportResizeEvent(timestamp: number): Record<string, unknown> {
  return {
    type: 3,
    data: { source: 4, width: 900, height: 700 },
    timestamp,
  };
}

function kinds(messages: readonly unknown[]): string[] {
  return messages.flatMap((message) =>
    isRecord(message) && typeof message.kind === 'string' ? [message.kind] : [],
  );
}

function isBatch(message: unknown): message is {
  kind: 'simul:replica-v2:batch';
  identity: ReplicaDocumentIdentity;
} {
  return isRecord(message) &&
    message.kind === 'simul:replica-v2:batch' &&
    isRecord(message.identity);
}

function lastIdentitySequence(messages: readonly unknown[], kind: string): number | undefined {
  const message = [...messages].reverse().find(
    (entry) => isRecord(entry) && entry.kind === kind,
  );
  return isRecord(message) && isRecord(message.identity) &&
    typeof message.identity.sequence === 'number'
    ? message.identity.sequence
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
