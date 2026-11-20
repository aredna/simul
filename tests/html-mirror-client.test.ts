import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HTML_MIRROR_INITIAL_CHECKPOINT_TIMEOUT_MS,
  openChromeHtmlMirrorStream,
  type HtmlMirrorStreamObserver,
} from '../lib/replica/html-mirror-client';
import {
  createHtmlMirrorCheckpoint,
  createHtmlMirrorCheckpointPart,
  createHtmlMirrorError,
  createHtmlMirrorPatch,
  createHtmlMirrorScrollUpdate,
} from '../lib/replica/html-mirror-protocol';
import type { ReplicaCaptureRequest } from '../lib/replica/contracts';
import { createHtmlMirrorRepresentabilityCollector } from '../lib/replica/html-mirror-sanitizer';
import { createReplicaIdentity } from '../lib/replica/replica-identity';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Chrome HTML mirror client', () => {
  it('sends the selected fidelity policy in the immutable start handshake', async () => {
    const port = new FakePort();
    installBrowser(port);

    const lease = await openChromeHtmlMirrorStream(request, 'passive');

    expect(port.posts[0]).toMatchObject({
      kind: 'simul:html-mirror-v2:start',
      identity,
      fidelityPolicy: 'passive',
    });
    port.emitMessage(checkpoint());
    await lease.initialCheckpoint;
    lease.dispose();
  });

  it('queues a disconnect that occurs after checkpoint but before observer setup', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(checkpoint());
    await expect(lease.initialCheckpoint).resolves.toMatchObject({
      kind: 'simul:html-mirror-v2:checkpoint',
    });
    port.emitDisconnect();
    const observer = fakeObserver();

    lease.setObserver(observer);

    expect(observer.onFailure).toHaveBeenCalledWith(
      'stream_failed',
      expect.objectContaining({ capacityOmissionCount: 0 }),
    );
  });

  it('suppresses a queued disconnect after the lease is explicitly disposed', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(checkpoint());
    await lease.initialCheckpoint;
    port.emitDisconnect();
    lease.dispose();
    const observer = fakeObserver();

    lease.setObserver(observer);

    expect(observer.onFailure).not.toHaveBeenCalled();
  });

  it('fails a live stream when an observer cannot apply its message', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(checkpoint());
    await lease.initialCheckpoint;
    const observer = fakeObserver();
    observer.onCheckpoint.mockImplementation(() => {
      throw new Error('replica apply failed');
    });
    lease.setObserver(observer);

    expect(() => port.emitMessage(checkpoint())).not.toThrow();

    expect(observer.onFailure).toHaveBeenCalledWith(
      'stream_failed',
      expect.objectContaining({ capacityOmissionCount: 0 }),
    );
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  it('fails safely when a queued message cannot be applied on attachment', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(checkpoint());
    await lease.initialCheckpoint;
    port.emitMessage(checkpoint());
    const observer = fakeObserver();
    observer.onCheckpoint.mockImplementation(() => {
      throw new Error('queued replica apply failed');
    });

    expect(() => lease.setObserver(observer)).not.toThrow();

    expect(observer.onFailure).toHaveBeenCalledWith(
      'stream_failed',
      expect.objectContaining({ capacityOmissionCount: 0 }),
    );
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  it('hands on every scroll update with the last pane list the page sent (D122)', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(checkpoint());
    await lease.initialCheckpoint;
    // Before the observer is set only the latest update is kept: the one
    // with the list is replaced by one without, which must not lose it.
    port.emitMessage(paneScrollUpdate(0, [{ nodeId: 7, scrollX: 300 }], 7));
    port.emitMessage(paneScrollUpdate(120));
    const observer = fakeObserver();
    lease.setObserver(observer);
    expect(observer.onScroll).toHaveBeenCalledOnce();
    const whole = {
      scrollX: 0, scrollY: 120, maxScrollX: 0, maxScrollY: 900,
      panes: [{ nodeId: 7, scrollX: 300, scrollY: 0, maxScrollX: 4_000, maxScrollY: 0 }],
      primaryPaneId: 7,
    };
    expect(observer.onScroll.mock.lastCall?.[0].scroll).toEqual(whole);

    // Live: the page scrolls on, the list stays; a new list replaces it,
    // and an empty one says that no pane is scrolled any more.
    port.emitMessage(paneScrollUpdate(240));
    expect(observer.onScroll.mock.lastCall?.[0].scroll).toEqual({
      ...whole, scrollY: 240,
    });
    port.emitMessage(paneScrollUpdate(240, [{ nodeId: 9, scrollX: 50 }]));
    port.emitMessage(paneScrollUpdate(360));
    expect(observer.onScroll.mock.lastCall?.[0].scroll).toEqual({
      scrollX: 0, scrollY: 360, maxScrollX: 0, maxScrollY: 900,
      panes: [{ nodeId: 9, scrollX: 50, scrollY: 0, maxScrollX: 4_000, maxScrollY: 0 }],
    });
    port.emitMessage(paneScrollUpdate(360, []));
    port.emitMessage(paneScrollUpdate(480));
    expect(observer.onScroll.mock.lastCall?.[0].scroll).toEqual({
      scrollX: 0, scrollY: 480, maxScrollX: 0, maxScrollY: 900, panes: [],
    });
    expect(observer.onFailure).not.toHaveBeenCalled();
  });

  it('keeps the panes that moved while only the latest scroll update is queued', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(checkpoint());
    await lease.initialCheckpoint;
    const pane = (nodeId: number, scrollX: number, alsoNodeIds?: number[]) => ({
      nodeId, scrollX, scrollY: 0, maxScrollX: 4_000, maxScrollY: 0,
      ...(alsoNodeIds ? { alsoNodeIds } : {}),
    });
    const moved = (scrollY: number, movedPanes: object[], primaryPaneId?: number) =>
      createHtmlMirrorScrollUpdate(identity, {
        scrollX: 0, scrollY, maxScrollX: 0, maxScrollY: 900,
        movedPanes: movedPanes as never,
        ...(primaryPaneId !== undefined ? { primaryPaneId } : {}),
      })!;
    // The whole list, then two messages that each name what moved, then one
    // that names nothing: before the observer is set only the last is kept,
    // and it carries all of it.
    port.emitMessage(paneScrollUpdate(0, [{ nodeId: 7, scrollX: 300 }], 7));
    port.emitMessage(moved(0, [pane(8, 500, [9, 10])], 7));
    port.emitMessage(moved(0, [pane(9, 620)], 7));
    port.emitMessage(paneScrollUpdate(120));
    const observer = fakeObserver();
    lease.setObserver(observer);
    expect(observer.onScroll).toHaveBeenCalledOnce();
    expect(observer.onScroll.mock.lastCall?.[0].scroll).toEqual({
      scrollX: 0, scrollY: 120, maxScrollX: 0, maxScrollY: 900,
      panes: [pane(7, 300), pane(8, 500), pane(10, 500), pane(9, 620)],
      primaryPaneId: 7,
    });

    // Live: a pane goes back to its start, and no pane is named any more.
    port.emitMessage(moved(120, [
      { nodeId: 7, scrollX: 0, scrollY: 0, maxScrollX: 0, maxScrollY: 0 },
    ]));
    expect(observer.onScroll.mock.lastCall?.[0].scroll).toEqual({
      scrollX: 0, scrollY: 120, maxScrollX: 0, maxScrollY: 900,
      panes: [pane(8, 500), pane(10, 500), pane(9, 620)],
    });
    // A page scroll hands on the very list of the update before it.
    const before = observer.onScroll.mock.lastCall?.[0].scroll.panes;
    port.emitMessage(paneScrollUpdate(240));
    expect(observer.onScroll.mock.lastCall?.[0].scroll.panes).toBe(before);
    // A message that names a pane in both lists is not a message.
    port.emitMessage({
      ...moved(240, [pane(8, 10)]),
      scroll: {
        scrollX: 0, scrollY: 240, maxScrollX: 0, maxScrollY: 900,
        panes: [pane(8, 10)], movedPanes: [pane(8, 10)],
      },
    });
    expect(observer.onFailure).toHaveBeenCalledWith(
      'stream_failed',
      expect.anything(),
    );
  });

  it('queues a typed scroll update that arrives before observer setup', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(checkpoint());
    await lease.initialCheckpoint;
    const update = createHtmlMirrorScrollUpdate(identity, {
      scrollX: 0,
      scrollY: 320,
      maxScrollX: 0,
      maxScrollY: 900,
    })!;
    port.emitMessage(update);
    const observer = fakeObserver();

    lease.setObserver(observer);

    expect(observer.onScroll).toHaveBeenCalledOnce();
    expect(observer.onScroll).toHaveBeenCalledWith(update);
  });

  it('coalesces scroll bursts after checkpoint without consuming structural capacity', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(checkpoint());
    await lease.initialCheckpoint;
    for (let index = 1; index <= 12; index += 1) {
      port.emitMessage(scrollUpdate(index * 10));
    }
    port.emitMessage(checkpoint());
    const latest = scrollUpdate(700);
    port.emitMessage(latest);
    const observer = fakeObserver();

    lease.setObserver(observer);

    expect(observer.onFailure).not.toHaveBeenCalled();
    expect(observer.onCheckpoint).toHaveBeenCalledOnce();
    expect(observer.onScroll).toHaveBeenCalledOnce();
    expect(observer.onScroll).toHaveBeenCalledWith(latest);
    expect(observer.onCheckpoint.mock.invocationCallOrder[0])
      .toBeLessThan(observer.onScroll.mock.invocationCallOrder[0]!);
    expect(port.disconnect).not.toHaveBeenCalled();
    lease.dispose();
  });

  it('coalesces scroll bursts that precede the initial checkpoint', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    for (let index = 1; index <= 12; index += 1) {
      port.emitMessage(scrollUpdate(index * 10));
    }
    const latest = scrollUpdate(700);
    port.emitMessage(latest);
    port.emitMessage(checkpoint());
    await expect(lease.initialCheckpoint).resolves.toMatchObject({
      kind: 'simul:html-mirror-v2:checkpoint',
    });
    const observer = fakeObserver();

    lease.setObserver(observer);

    expect(observer.onFailure).not.toHaveBeenCalled();
    expect(observer.onScroll).toHaveBeenCalledOnce();
    expect(observer.onScroll).toHaveBeenCalledWith(latest);
    expect(port.disconnect).not.toHaveBeenCalled();
    lease.dispose();
  });

  it('still fails closed when the structural pre-observer backlog exceeds its bound', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(checkpoint());
    await lease.initialCheckpoint;
    for (let index = 0; index < 8; index += 1) {
      port.emitMessage(checkpoint());
      port.emitMessage(scrollUpdate(index * 10));
    }

    port.emitMessage(checkpoint());
    const observer = fakeObserver();
    lease.setObserver(observer);

    expect(observer.onCheckpoint).not.toHaveBeenCalled();
    expect(observer.onScroll).not.toHaveBeenCalled();
    expect(observer.onFailure).toHaveBeenCalledOnce();
    expect(observer.onFailure).toHaveBeenCalledWith(
      'stream_failed',
      expect.objectContaining({ capacityOmissionCount: 0 }),
    );
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  it('queues a recoverable early failure instead of silently dropping it', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(checkpoint());
    await lease.initialCheckpoint;
    const representability = createHtmlMirrorRepresentabilityCollector();
    representability.capacityOmissionCount = 1;
    port.emitMessage(createHtmlMirrorError(
      identity,
      'stream_overflow',
      representability,
    ));
    const observer = fakeObserver();

    lease.setObserver(observer);

    expect(observer.onFailure).toHaveBeenCalledWith(
      'stream_overflow',
      expect.objectContaining({ capacityOmissionCount: 1 }),
    );
    lease.requestCheckpoint(0);
    expect(port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v2:checkpoint-request',
    });
  });

  it('preserves capacity diagnostics when the initial checkpoint fails', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    const representability = createHtmlMirrorRepresentabilityCollector();
    representability.capacityOmissionCount = 2;

    port.emitMessage(createHtmlMirrorError(
      identity,
      'stream_overflow',
      representability,
    ));

    await expect(lease.initialCheckpoint).rejects.toMatchObject({
      code: 'stream_overflow',
      representability: expect.objectContaining({ capacityOmissionCount: 2 }),
    });
  });

  it('rejects a missing initial source checkpoint on a bounded deadline', async () => {
    vi.useFakeTimers();
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    const rejected = expect(lease.initialCheckpoint).rejects.toThrow(
      'initial checkpoint timed out',
    );

    await vi.advanceTimersByTimeAsync(HTML_MIRROR_INITIAL_CHECKPOINT_TIMEOUT_MS);

    await rejected;
    expect(port.disconnect).toHaveBeenCalledTimes(1);
  });

  it('rejects when exact-document injection finds no matching source session', async () => {
    const port = new FakePort();
    installBrowser(port, []);

    await expect(openChromeHtmlMirrorStream(request)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('a checkpoint read in parts and a preview (D163)', () => {
  it('assembles the parts into the checkpoint a read in one task sends', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(part(0, 0, [sectionFill('one')]));
    port.emitMessage(part(0, 1, [asideFill('two')]));
    port.emitMessage(shellCheckpoint(0, 2));

    const received = await lease.initialCheckpoint;
    expect(received).toEqual(wholeCheckpoint(0, 'one', 'two'));
    expect(received.payload).not.toHaveProperty('partCount');
    lease.dispose();
  });

  it('assembles parts that come in another order', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(part(0, 1, [asideFill('two')]));
    port.emitMessage(part(0, 0, [sectionFill('one')]));
    port.emitMessage(shellCheckpoint(0, 2));
    await expect(lease.initialCheckpoint).resolves.toEqual(wholeCheckpoint(0, 'one', 'two'));
    lease.dispose();
  });

  it('drops the parts of a read the page started again at a later sequence', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(part(0, 0, [sectionFill('stale')]));
    port.emitMessage(part(1, 0, [sectionFill('one')]));
    port.emitMessage(part(1, 1, [asideFill('two')]));
    port.emitMessage(shellCheckpoint(1, 2));
    await expect(lease.initialCheckpoint).resolves.toEqual(wholeCheckpoint(1, 'one', 'two'));
    lease.dispose();
  });

  it.each([
    ['a part that fails its own check', () => [
      { ...part(0, 0, [sectionFill('one')]), byteLength: 1 },
    ]],
    ['a part of an earlier sequence than the parts kept', () => [
      part(1, 0, [sectionFill('one')]),
      part(0, 1, [asideFill('two')]),
    ]],
    ['a second part of an index', () => [
      part(0, 0, [sectionFill('one')]),
      part(0, 0, [asideFill('two')]),
    ]],
    ['a part missing', () => [
      part(0, 0, [sectionFill('one')]),
      shellCheckpoint(0, 2),
    ]],
    ['a part too many', () => [
      part(0, 0, [sectionFill('one')]),
      part(0, 1, [asideFill('two')]),
      part(0, 2, [{ nodeId: 99, children: [] }]),
      shellCheckpoint(0, 2),
    ]],
    ['a part that fills what no shell is', () => [
      part(0, 0, [sectionFill('one')]),
      part(0, 1, [{ nodeId: 99, children: [] }]),
      shellCheckpoint(0, 2),
    ]],
    ['parts of another sequence than the checkpoint', () => [
      part(0, 0, [sectionFill('one')]),
      part(0, 1, [asideFill('two')]),
      shellCheckpoint(1, 2),
    ]],
  ])('fails the stream at %s, as at a broken checkpoint', async (_, messages) => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    for (const message of messages()) port.emitMessage(message);
    await expect(lease.initialCheckpoint).rejects.toThrow();
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  it('fails the live stream at a broken part, as at a broken checkpoint', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(checkpoint());
    await lease.initialCheckpoint;
    const observer = fakeObserver();
    lease.setObserver(observer);
    port.emitMessage(part(0, 0, [sectionFill('one')]));
    port.emitMessage(shellCheckpoint(0, 2));
    expect(observer.onCheckpoint).not.toHaveBeenCalled();
    expect(observer.onFailure).toHaveBeenCalledWith('stream_failed', expect.anything());
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  it('hands on a recovery checkpoint read in parts, and tells the observer of each part', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(checkpoint());
    await lease.initialCheckpoint;
    const observer = fakeObserver();
    lease.setObserver(observer);
    // A recovery read at the sequence of the last checkpoint.
    port.emitMessage(part(0, 0, [sectionFill('one')]));
    port.emitMessage(part(0, 1, [asideFill('two')]));
    expect(observer.onProgress).toHaveBeenCalledTimes(2);
    port.emitMessage(shellCheckpoint(0, 2));
    expect(observer.onCheckpoint).toHaveBeenCalledWith(wholeCheckpoint(0, 'one', 'two'));
    expect(observer.onFailure).not.toHaveBeenCalled();
  });

  it('resolves with the preview, then hands on its full copy and the patches after it', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(previewCheckpoint(0));
    port.emitMessage(scrollUpdate(40));
    const preview = await lease.initialCheckpoint;
    expect(preview.payload.preview).toBe(true);
    // The copy's parts come while the panel builds the preview.
    port.emitMessage(part(1, 0, [sectionFill('one')]));
    port.emitMessage(part(1, 1, [asideFill('two')]));
    port.emitMessage(shellCheckpoint(1, 2));
    const observer = fakeObserver();
    lease.setObserver(observer);
    expect(observer.onCheckpoint).toHaveBeenCalledWith(wholeCheckpoint(1, 'one', 'two'));
    port.emitMessage(textPatch(2));
    expect(observer.onPatch).toHaveBeenCalledOnce();
    expect(observer.onFailure).not.toHaveBeenCalled();
    lease.dispose();
  });

  it('refuses a preview after the first checkpoint', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(checkpoint());
    await lease.initialCheckpoint;
    const observer = fakeObserver();
    lease.setObserver(observer);
    port.emitMessage(previewCheckpoint(1));
    expect(observer.onCheckpoint).not.toHaveBeenCalled();
    expect(observer.onFailure).toHaveBeenCalledWith('stream_failed', expect.anything());
  });

  it('waits for a first checkpoint as long as parts come, and times out on a stall', async () => {
    vi.useFakeTimers();
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    let rejected: unknown;
    void (async () => {
      try {
        await lease.initialCheckpoint;
      } catch (error) {
        rejected = error;
      }
    })();
    for (let index = 0; index < 3; index += 1) {
      await vi.advanceTimersByTimeAsync(HTML_MIRROR_INITIAL_CHECKPOINT_TIMEOUT_MS - 100);
      port.emitMessage(part(0, index, [index === 0 ? sectionFill('one') : asideFill(`n${index}`)]));
    }
    expect(rejected).toBeUndefined();
    await vi.advanceTimersByTimeAsync(HTML_MIRROR_INITIAL_CHECKPOINT_TIMEOUT_MS);
    expect(String(rejected)).toContain('initial checkpoint timed out');
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  it('waits for a preview\'s full copy as long as parts come, and fails the stream on a stall', async () => {
    vi.useFakeTimers();
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(previewCheckpoint(0));
    await lease.initialCheckpoint;
    const observer = fakeObserver();
    lease.setObserver(observer);
    await vi.advanceTimersByTimeAsync(HTML_MIRROR_INITIAL_CHECKPOINT_TIMEOUT_MS - 100);
    port.emitMessage(part(1, 0, [sectionFill('one')]));
    await vi.advanceTimersByTimeAsync(HTML_MIRROR_INITIAL_CHECKPOINT_TIMEOUT_MS - 100);
    expect(observer.onFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(observer.onFailure).toHaveBeenCalledWith('stream_failed', expect.anything());
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  it('stops the full copy\'s deadline once the copy has come', async () => {
    vi.useFakeTimers();
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeHtmlMirrorStream(request);
    port.emitMessage(previewCheckpoint(0));
    await lease.initialCheckpoint;
    const observer = fakeObserver();
    lease.setObserver(observer);
    port.emitMessage(part(1, 0, [sectionFill('one')]));
    port.emitMessage(part(1, 1, [asideFill('two')]));
    port.emitMessage(shellCheckpoint(1, 2));
    await vi.advanceTimersByTimeAsync(HTML_MIRROR_INITIAL_CHECKPOINT_TIMEOUT_MS * 3);
    expect(observer.onFailure).not.toHaveBeenCalled();
    expect(port.disconnect).not.toHaveBeenCalled();
    lease.dispose();
  });
});

type RawNode = Record<string, unknown>;

const rawText = (id: number, text: string): RawNode => ({
  kind: 'text', id, text, translatable: true,
});

const rawElement = (
  id: number,
  tagName: string,
  children: RawNode[] = [],
  extra: RawNode = {},
): RawNode => ({
  kind: 'element', id, namespace: 'html', tagName, attributes: [], children, ...extra,
});

const pageValues = {
  adoptedStyleSheets: [] as string[],
  captureMs: 1,
  viewportWidth: 800,
  viewportHeight: 600,
  documentWidth: 800,
  documentHeight: 2_000,
};

function at(sequence: number) {
  return { ...identity, sequence };
}

/** The page's root with its section and aside left for parts. */
function shellCheckpoint(sequence: number, partCount: number) {
  return createHtmlMirrorCheckpoint(at(sequence), {
    ...pageValues,
    root: rawElement(1, 'html', [rawElement(2, 'head'), rawElement(3, 'body', [
      rawElement(4, 'section', [], { childrenFollow: true }),
      rawElement(5, 'aside', [], { childrenFollow: true }),
    ])]) as never,
    partCount,
  })!;
}

function wholeCheckpoint(sequence: number, first: string, second: string) {
  return createHtmlMirrorCheckpoint(at(sequence), {
    ...pageValues,
    root: rawElement(1, 'html', [rawElement(2, 'head'), rawElement(3, 'body', [
      rawElement(4, 'section', [rawElement(6, 'p', [rawText(7, first)])]),
      rawElement(5, 'aside', [rawText(8, second)]),
    ])]) as never,
  })!;
}

function previewCheckpoint(sequence: number) {
  return createHtmlMirrorCheckpoint(at(sequence), {
    ...pageValues,
    root: rawElement(1, 'html', [rawElement(2, 'head'), rawElement(3, 'body', [
      rawElement(4, 'section', [], { placeholder: { height: 900 } }),
      rawElement(5, 'aside', [], { placeholder: { height: 400 } }),
    ])]) as never,
    preview: true,
  })!;
}

const sectionFill = (text: string) => ({
  nodeId: 4, children: [rawElement(6, 'p', [rawText(7, text)])],
});

const asideFill = (text: string) => ({ nodeId: 5, children: [rawText(8, text)] });

function part(sequence: number, index: number, fills: readonly unknown[]) {
  return createHtmlMirrorCheckpointPart(at(sequence), index, fills as never)!;
}

function textPatch(sequence: number) {
  return createHtmlMirrorPatch(at(sequence), sequence, sequence, [{
    kind: 'text', nodeId: 8, node: { kind: 'text', id: 8, text: 'later', translatable: true },
  }])!;
}

const request: ReplicaCaptureRequest = {
  sessionId: 'client-session',
  pageEpoch: 1,
  generation: 1,
  tabId: 7,
  frameId: 0,
  documentId: 'client-document',
  isCurrent: () => true,
};

const identity = createReplicaIdentity({
  sessionId: request.sessionId,
  pageEpoch: request.pageEpoch,
  generation: request.generation,
  documentId: request.documentId,
  frameId: request.frameId,
  sequence: 0,
});

function checkpoint() {
  return createHtmlMirrorCheckpoint(identity, {
    root: {
      kind: 'element', id: 1, namespace: 'html', tagName: 'html',
      attributes: [], children: [
        { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
        { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [] },
      ],
    },
    adoptedStyleSheets: [],
    captureMs: 1,
    viewportWidth: 800,
    viewportHeight: 600,
    documentWidth: 800,
    documentHeight: 900,
  })!;
}

function paneScrollUpdate(
  scrollY: number,
  panes?: Array<{ nodeId: number; scrollX: number }>,
  primaryPaneId?: number,
) {
  return createHtmlMirrorScrollUpdate(identity, {
    scrollX: 0,
    scrollY,
    maxScrollX: 0,
    maxScrollY: 900,
    ...(panes
      ? {
          panes: panes.map((pane) => ({
            ...pane, scrollY: 0, maxScrollX: 4_000, maxScrollY: 0,
          })),
        }
      : {}),
    ...(primaryPaneId !== undefined ? { primaryPaneId } : {}),
  })!;
}

function scrollUpdate(scrollY: number) {
  return createHtmlMirrorScrollUpdate(identity, {
    scrollX: 0,
    scrollY,
    maxScrollX: 0,
    maxScrollY: 900,
  })!;
}

function fakeObserver() {
  return {
    onPatch: vi.fn<HtmlMirrorStreamObserver['onPatch']>(),
    onCheckpoint: vi.fn<HtmlMirrorStreamObserver['onCheckpoint']>(),
    onScroll: vi.fn<HtmlMirrorStreamObserver['onScroll']>(),
    onFailure: vi.fn<HtmlMirrorStreamObserver['onFailure']>(),
    onProgress: vi.fn<NonNullable<HtmlMirrorStreamObserver['onProgress']>>(),
  };
}

function installBrowser(
  port: FakePort,
  injections: unknown[] = [{ frameId: 0, documentId: request.documentId }],
): void {
  vi.stubGlobal('browser', {
    scripting: { executeScript: vi.fn(async () => injections) },
    tabs: { connect: vi.fn(() => port) },
  });
}

class FakePort {
  readonly onMessage = new FakeEvent<(message: unknown) => void>();
  readonly onDisconnect = new FakeEvent<() => void>();
  readonly posts: unknown[] = [];
  readonly disconnect = vi.fn();

  postMessage(message: unknown): void {
    this.posts.push(message);
  }

  emitMessage(message: unknown): void {
    this.onMessage.emit(message);
  }

  emitDisconnect(): void {
    this.onDisconnect.emit();
  }
}

class FakeEvent<T extends (...arguments_: never[]) => void> {
  readonly #listeners = new Set<T>();

  addListener(listener: T): void {
    this.#listeners.add(listener);
  }

  removeListener(listener: T): void {
    this.#listeners.delete(listener);
  }

  emit(...arguments_: Parameters<T>): void {
    for (const listener of this.#listeners) listener(...arguments_);
  }
}
