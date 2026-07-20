import { parseHTML } from 'linkedom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReplicaCaptureRequest } from '../lib/replica/contracts';
import type {
  HtmlMirrorStreamLease,
  HtmlMirrorStreamObserver,
} from '../lib/replica/html-mirror-client';
import {
  createHtmlMirrorCheckpoint,
  createHtmlMirrorPatch,
  type HtmlMirrorCheckpoint,
} from '../lib/replica/html-mirror-protocol';
import {
  ISOLATED_HTML_SHELL,
  IsolatedHtmlReplicaEngine,
  isTrustedIsolatedShellDocument,
} from '../lib/replica/isolated-html-engine';
import { createReplicaIdentity } from '../lib/replica/protocol-v2';
import type {
  ReplayPresentationHost,
  VisibleReplayCandidateLease,
} from '../lib/replica/visible-replay-host';

describe('IsolatedHtmlReplicaEngine', () => {
  beforeEach(() => {
    const { window } = parseHTML('<html><body></body></html>');
    Object.assign(globalThis, {
      Node: window.Node,
      Element: window.Element,
      Text: window.Text,
      HTMLImageElement: window.HTMLImageElement,
    });
  });

  it('rejects the initial about:blank document and accepts only the marked srcdoc shell', () => {
    const blank = parseHTML('<html><head></head><body></body></html>').document;
    expect(isTrustedIsolatedShellDocument(blank)).toBe(false);

    const shell = parseHTML(ISOLATED_HTML_SHELL).document;
    expect(isTrustedIsolatedShellDocument(shell)).toBe(true);
    Object.defineProperty(shell, 'location', {
      configurable: true,
      value: { href: 'about:blank' },
    });
    expect(isTrustedIsolatedShellDocument(shell)).toBe(false);
  });

  it('commits an inert real DOM, projects text, and applies a contiguous patch', async () => {
    const checkpoint = makeCheckpoint('hello', 0);
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const commits: string[] = [];
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => stream,
      initializeIframe: async (iframe, shell) => {
        const { document } = parseHTML(shell);
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        return document;
      },
      onSourceCommit: (commit) => commits.push(commit.reason),
    });

    const result = await engine.run(request);
    expect(result.status).toBe('complete');
    expect(host.iframe?.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(host.iframe?.getAttribute('sandbox')).not.toContain('allow-scripts');
    expect(host.iframe?.contentDocument?.querySelector('script')).toBeNull();
    expect(host.iframe?.contentDocument?.body.textContent).toBe('hello');
    const snapshot = engine.snapshot();
    expect(snapshot?.records.map(({ source }) => source)).toEqual(['hello']);
    engine.beginProjection({ translationEpoch: 1, pairKey: 'en\0ja' });
    expect(engine.project({
      document: snapshot!.document,
      replayLease: snapshot!.replayLease,
      nodeId: 4,
      nodeType: 3,
      sourceRevision: 1,
      source: 'hello',
      translationEpoch: 1,
      pairKey: 'en\0ja',
      translated: 'こんにちは',
    })).toBe(true);
    expect(host.iframe?.contentDocument?.body.textContent).toBe('こんにちは');

    const patchIdentity = createReplicaIdentity({
      ...identityParts,
      sequence: 1,
    });
    stream.observer?.onPatch(createHtmlMirrorPatch(
      patchIdentity,
      1,
      1,
      [{
        kind: 'text',
        nodeId: 4,
        node: { kind: 'text', id: 4, text: 'world', translatable: true },
      }],
    )!);
    expect(host.iframe?.contentDocument?.body.textContent).toBe('world');
    expect(stream.acknowledged).toContain(1);
    expect(commits).toEqual(['checkpoint', 'batch']);
  });

  it('retains translated projections across a same-document recovery checkpoint', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('hello', 0));
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);
    await engine.run(request);

    const snapshot = engine.snapshot()!;
    engine.beginProjection({ translationEpoch: 1, pairKey: 'en\0ja' });
    expect(engine.project({
      document: snapshot.document,
      replayLease: snapshot.replayLease,
      nodeId: 4,
      nodeType: 3,
      sourceRevision: 1,
      source: 'hello',
      translationEpoch: 1,
      pairKey: 'en\0ja',
      translated: 'こんにちは',
    })).toBe(true);

    stream.observer?.onFailure('stream_overflow');
    stream.observer?.onCheckpoint(makeCheckpoint('hello', 0));

    await vi.waitFor(() => {
      expect(host.iframe?.contentDocument?.body.textContent).toBe('こんにちは');
    });
  });

  it('does not retain records or translated projections across source documents', async () => {
    const nextIdentityParts = {
      ...identityParts,
      pageEpoch: 2,
      generation: 2,
      documentId: 'next-document',
    };
    const first = new FakeHtmlStream(makeCheckpoint('hello', 0));
    const second = new FakeHtmlStream(
      makeCheckpoint('world', 0, nextIdentityParts),
    );
    const streams = [first, second];
    const host = new FakePresentationHost();
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => streams.shift()!,
      initializeIframe: async (iframe, shell) => {
        const { document } = parseHTML(shell);
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        return document;
      },
    });
    await engine.run(request);

    first.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'text', nodeId: 4,
        node: { kind: 'text', id: 4, text: 'world', translatable: true },
      }],
    )!);
    const firstSnapshot = engine.snapshot()!;
    expect(firstSnapshot.records[0]?.revision).toBe(2);
    engine.beginProjection({ translationEpoch: 1, pairKey: 'en\0ja' });
    expect(engine.project({
      document: firstSnapshot.document,
      replayLease: firstSnapshot.replayLease,
      nodeId: 4,
      nodeType: 3,
      sourceRevision: 2,
      source: 'world',
      translationEpoch: 1,
      pairKey: 'en\0ja',
      translated: '世界',
    })).toBe(true);
    expect(host.iframe?.contentDocument?.body.textContent).toBe('世界');

    const nextRequest: ReplicaCaptureRequest = {
      ...nextIdentityParts,
      tabId: 1,
      isCurrent: () => true,
    };
    await engine.run(nextRequest);

    expect(host.iframe?.contentDocument?.body.textContent).toBe('world');
    expect(engine.snapshot()).toMatchObject({
      document: nextIdentityParts,
      records: [{ source: 'world', revision: 1 }],
    });
  });

  it('keeps last-good visible on a sequence gap and requests a checkpoint', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('last good', 0));
    const host = new FakePresentationHost();
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => stream,
      initializeIframe: async (iframe, shell) => {
        const { document } = parseHTML(shell);
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        return document;
      },
    });
    await engine.run(request);
    const gapIdentity = createReplicaIdentity({ ...identityParts, sequence: 2 });
    stream.observer?.onPatch(createHtmlMirrorPatch(
      gapIdentity,
      2,
      2,
      [{
        kind: 'text',
        nodeId: 4,
        node: { kind: 'text', id: 4, text: 'must not apply', translatable: true },
      }],
    )!);
    expect(host.iframe?.contentDocument?.body.textContent).toBe('last good');
    expect(stream.requested).toEqual([0]);
  });

  it('does not report complete when a queued terminal failure drains on observer setup', async () => {
    const stream = new FakeHtmlStream(
      makeCheckpoint('briefly visible', 0),
      (observer) => observer.onFailure('stream_failed'),
    );
    const host = new FakePresentationHost();
    const infoCodes: Array<string | undefined> = [];
    const engine = makeEngine(
      stream,
      host,
      (info) => infoCodes.push(info.code),
    );

    await expect(engine.run(request)).resolves.toMatchObject({
      status: 'failed',
      diagnostics: { code: 'stream_failed' },
    });
    expect(stream.acknowledged).toEqual([]);
    expect(stream.dispose).toHaveBeenCalledOnce();
    expect(infoCodes).toContain('stream_failed');
  });

  it('releases an iframe lease immediately when presentation ends during staging', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('never committed', 0));
    const host = new FakePresentationHost();
    let finishInitialization!: (document: Document) => void;
    const initialization = new Promise<Document>((resolve) => {
      finishInitialization = resolve;
    });
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => stream,
      initializeIframe: async () => initialization,
    });

    const run = engine.run(request);
    await vi.waitFor(() => expect(host.releases).toHaveLength(1));
    engine.releasePresentation(false);

    expect(host.releases[0]).toHaveBeenCalledOnce();
    finishInitialization(parseHTML(ISOLATED_HTML_SHELL).document);
    await expect(run).resolves.toMatchObject({
      status: 'skipped',
      diagnostics: { code: 'stale_identity' },
    });
    expect(host.iframe).toBeUndefined();
  });

  it('prevalidates a whole batch so a bad later operation cannot partially mutate', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('last good', 0));
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);
    await engine.run(request);

    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [
        {
          kind: 'text',
          nodeId: 4,
          node: { kind: 'text', id: 4, text: 'partial leak', translatable: true },
        },
        { kind: 'attributes', nodeId: 999, tagName: 'div', attributes: [] },
      ],
    )!);

    expect(host.iframe?.contentDocument?.body.textContent).toBe('last good');
    expect(stream.requested).toEqual([0]);
  });

  it('allows privacy attributes and replacement children on one target atomically', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('public value', 0));
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);
    await engine.run(request);

    const patch = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [
        {
          kind: 'attributes',
          nodeId: 3,
          tagName: 'body',
          attributes: [['role', 'textbox']],
        },
        {
          kind: 'children',
          nodeId: 3,
          children: [{
            kind: 'text', id: 4, text: '', translatable: false,
          }],
        },
      ],
    );
    expect(patch).toBeDefined();
    stream.observer?.onPatch(patch!);

    expect(host.iframe?.contentDocument?.body.getAttribute('role')).toBe('textbox');
    expect(host.iframe?.contentDocument?.body.textContent).toBe('');
    expect(stream.acknowledged).toContain(1);
  });

  it('preserves the owned CSP shell while replacing mirrored head children', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('hello', 0));
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);
    await engine.run(request);

    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'children',
        nodeId: 2,
        children: [{
          kind: 'element', id: 10, namespace: 'html', tagName: 'style',
          attributes: [], children: [{
            kind: 'text', id: 11, text: '.hero{color:red}', translatable: false,
          }],
        }],
      }],
    )!);

    const head = host.iframe?.contentDocument?.head;
    expect(head?.querySelector('[data-simul-owned-shell="csp"]')).not.toBeNull();
    expect(head?.querySelector('[data-simul-owned-shell="inert"]')).not.toBeNull();
    expect(head?.textContent).toContain('.hero{color:red}');
  });

  it('reconstructs accessible open shadow roots without definitions or scripts', async () => {
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
            { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [{
              kind: 'element', id: 4, namespace: 'html', tagName: 'x-site-card',
              attributes: [], children: [], shadowRoot: {
                id: 5, mode: 'open', children: [{
                  kind: 'text', id: 6, text: 'shadow text', translatable: true,
                }],
                adoptedStyleSheets: [':host{display:block}.card{display:grid}'],
              },
            }] },
          ],
        },
        adoptedStyleSheets: ['body{display:block}.page{display:flex}'],
        captureMs: 1,
        viewportWidth: 800,
        viewportHeight: 600,
        documentWidth: 800,
        documentHeight: 1000,
      },
    )!;
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);

    await expect(engine.run(request)).resolves.toMatchObject({ status: 'complete' });
    const card = host.iframe?.contentDocument?.querySelector('x-site-card');
    expect(card?.shadowRoot?.firstChild?.nodeValue).toBe('shadow text');
    expect(card?.shadowRoot?.lastChild).toMatchObject({
      localName: 'style',
      textContent: ':host{display:block}.card{display:grid}',
    });
    expect(
      (card?.shadowRoot?.lastChild as Element | undefined)?.getAttribute(
        'data-simul-adopted-style',
      ),
    ).toBe('shadow');
    const body = host.iframe?.contentDocument?.body;
    expect(body?.lastElementChild).toMatchObject({
      localName: 'style',
      textContent: 'body{display:block}.page{display:flex}',
    });
    expect(body?.lastElementChild?.getAttribute('data-simul-adopted-style'))
      .toBe('document');
    expect(engine.snapshot()?.records.map(({ source }) => source)).toEqual([
      'shadow text',
    ]);

    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'children',
        nodeId: 5,
        children: [{
          kind: 'text', id: 7, text: 'updated shadow', translatable: true,
        }],
      }],
    )!);
    expect(card?.shadowRoot?.firstChild?.nodeValue).toBe('updated shadow');
    expect(
      (card?.shadowRoot?.lastChild as Element | undefined)?.getAttribute(
        'data-simul-adopted-style',
      ),
    ).toBe('shadow');

    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 2 }),
      2,
      2,
      [{
        kind: 'children',
        nodeId: 3,
        children: [{
          kind: 'element', id: 8, namespace: 'html', tagName: 'main',
          attributes: [['class', 'page']], children: [{
            kind: 'text', id: 9, text: 'new page', translatable: true,
          }],
        }],
      }],
    )!);
    expect(body?.firstElementChild?.localName).toBe('main');
    expect(body?.lastElementChild?.getAttribute('data-simul-adopted-style'))
      .toBe('document');
  });

  it('buffers live patches until a recovery checkpoint commits and is acknowledged', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('last good', 0));
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);
    await engine.run(request);
    stream.observer?.onFailure('stream_overflow');
    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'text', nodeId: 4,
        node: { kind: 'text', id: 4, text: 'retained later change', translatable: true },
      }],
    )!);
    expect(host.iframe?.contentDocument?.body.textContent).toBe('last good');

    stream.observer?.onCheckpoint(makeCheckpoint('checkpoint base', 0));
    await vi.waitFor(() => {
      expect(host.iframe?.contentDocument?.body.textContent)
        .toBe('retained later change');
    });
    expect(stream.acknowledged).toEqual(expect.arrayContaining([0, 1]));
  });

  it('never lets a stale recovery replace a newer successful run', async () => {
    const first = new FakeHtmlStream(makeCheckpoint('first', 0));
    const second = new FakeHtmlStream(makeCheckpoint('new current run', 0));
    const streams = [first, second];
    const host = new FakePresentationHost();
    let initializeCount = 0;
    let finishStaleRecovery!: () => void;
    const staleRecoveryGate = new Promise<void>((resolve) => {
      finishStaleRecovery = resolve;
    });
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => streams.shift()!,
      initializeIframe: async (iframe, shell) => {
        initializeCount += 1;
        const { document } = parseHTML(shell);
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        if (initializeCount === 2) await staleRecoveryGate;
        return document;
      },
    });
    await engine.run(request);
    first.observer?.onFailure('stream_overflow');
    first.observer?.onCheckpoint(makeCheckpoint('stale recovery', 0));
    await vi.waitFor(() => expect(initializeCount).toBe(2));

    await engine.run(request);
    expect(host.iframe?.contentDocument?.body.textContent).toBe('new current run');
    finishStaleRecovery();
    await Promise.resolve();
    await Promise.resolve();

    expect(host.iframe?.contentDocument?.body.textContent).toBe('new current run');
  });
});

const identityParts = {
  sessionId: 'session',
  pageEpoch: 1,
  generation: 1,
  documentId: 'document',
  frameId: 0,
};

const request: ReplicaCaptureRequest = {
  ...identityParts,
  tabId: 1,
  isCurrent: () => true,
};

function makeCheckpoint(
  text: string,
  sequence: number,
  parts: typeof identityParts = identityParts,
): HtmlMirrorCheckpoint {
  const checkpoint = createHtmlMirrorCheckpoint(
    createReplicaIdentity({ ...parts, sequence }),
    {
      root: {
        kind: 'element', id: 1, namespace: 'html', tagName: 'html', attributes: [['lang', 'en']], children: [
          { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
          { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [
            { kind: 'text', id: 4, text, translatable: true },
          ] },
        ],
      },
      adoptedStyleSheets: [],
      captureMs: 1,
      viewportWidth: 800,
      viewportHeight: 600,
      documentWidth: 800,
      documentHeight: 1000,
    },
  );
  if (!checkpoint) throw new Error('Fixture checkpoint rejected.');
  return checkpoint;
}

class FakeHtmlStream implements HtmlMirrorStreamLease {
  readonly acknowledged: number[] = [];
  readonly requested: number[] = [];
  readonly initialCheckpoint: Promise<HtmlMirrorCheckpoint>;
  observer?: HtmlMirrorStreamObserver;

  constructor(
    checkpoint: HtmlMirrorCheckpoint,
    private readonly onObserve?: (observer: HtmlMirrorStreamObserver) => void,
  ) {
    this.initialCheckpoint = Promise.resolve(checkpoint);
  }

  setObserver(observer: HtmlMirrorStreamObserver): void {
    this.observer = observer;
    this.onObserve?.(observer);
  }

  acknowledge(sequence: number): void {
    this.acknowledged.push(sequence);
  }

  requestCheckpoint(sequence: number): void {
    this.requested.push(sequence);
  }

  dispose = vi.fn();
}

class FakePresentationHost implements ReplayPresentationHost {
  readonly document = parseHTML('<html><body></body></html>').document;
  readonly releases: Array<ReturnType<typeof vi.fn>> = [];
  iframe?: HTMLIFrameElement;

  createCandidate(): VisibleReplayCandidateLease {
    const mount = this.document.createElement('div') as unknown as HTMLElement;
    const release = vi.fn();
    this.releases.push(release);
    return {
      mount,
      commit: (iframe) => {
        this.iframe = iframe;
      },
      release,
    };
  }

  markLive = vi.fn();
  refreshExtent = vi.fn();
  refreshDimensions = vi.fn();
  showLegacy = vi.fn();
  dispose = vi.fn();
}

function makeEngine(
  stream: FakeHtmlStream,
  host: FakePresentationHost,
  onInfo?: ConstructorParameters<typeof IsolatedHtmlReplicaEngine>[0]['onInfo'],
): IsolatedHtmlReplicaEngine {
  return new IsolatedHtmlReplicaEngine({
    presentationHost: host,
    openStream: async () => stream,
    initializeIframe: async (iframe, shell) => {
      const { document } = parseHTML(shell);
      Object.defineProperty(iframe, 'contentDocument', { value: document });
      return document;
    },
    ...(onInfo ? { onInfo } : {}),
  });
}
