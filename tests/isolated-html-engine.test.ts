import { parseHTML } from 'linkedom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReplicaCaptureRequest } from '../lib/replica/contracts';
import {
  HtmlMirrorClientError,
  type HtmlMirrorStreamLease,
  type HtmlMirrorStreamObserver,
} from '../lib/replica/html-mirror-client';
import {
  createHtmlMirrorCheckpoint,
  createHtmlMirrorPatch,
  type HtmlMirrorCheckpoint,
  type HtmlMirrorPatchOperation,
} from '../lib/replica/html-mirror-protocol';
import {
  ISOLATED_HTML_SHELL,
  IsolatedHtmlReplicaEngine,
  isTrustedIsolatedShellDocument,
  type IsolatedMirrorInfo,
} from '../lib/replica/isolated-html-engine';
import { createReplicaIdentity } from '../lib/replica/protocol-v2';
import { createHtmlMirrorRepresentabilityCollector } from '../lib/replica/html-mirror-sanitizer';
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

  it('restores source in place, rejects stale projections, and keeps live patches flowing', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('source label', 0));
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);
    await engine.run(request);

    const snapshot = engine.snapshot()!;
    engine.beginProjection({ translationEpoch: 1, pairKey: 'en\0ja' });
    const projection = {
      document: snapshot.document,
      replayLease: snapshot.replayLease,
      nodeId: 4,
      nodeType: 3 as const,
      sourceRevision: 1,
      source: 'source label',
      translationEpoch: 1,
      pairKey: 'en\0ja',
      translated: '翻訳済み',
    };
    expect(engine.project(projection)).toBe(true);
    expect(host.iframe?.contentDocument?.body.textContent).toBe('翻訳済み');

    engine.beginProjection({ translationEpoch: 2, pairKey: undefined });
    expect(host.iframe?.contentDocument?.body.textContent).toBe('source label');
    expect(engine.project(projection)).toBe(false);

    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'text',
        nodeId: 4,
        node: {
          kind: 'text', id: 4, text: 'live source update', translatable: true,
        },
      }],
    )!);
    expect(host.iframe?.contentDocument?.body.textContent).toBe('live source update');
    expect(engine.snapshot()?.records[0]).toMatchObject({
      source: 'live source update',
      revision: 2,
    });
    expect(stream.acknowledged).toContain(1);
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

  it('reports capacity diagnostics when the initial source checkpoint fails', async () => {
    const representability = createHtmlMirrorRepresentabilityCollector();
    representability.capacityOmissionCount = 2;
    const stream: HtmlMirrorStreamLease = {
      initialCheckpoint: Promise.reject(new HtmlMirrorClientError(
        'stream_overflow',
        representability,
      )),
      setObserver: vi.fn(),
      acknowledge: vi.fn(),
      requestCheckpoint: vi.fn(),
      dispose: vi.fn(),
    };
    const host = new FakePresentationHost();
    const infos: IsolatedMirrorInfo[] = [];
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => stream,
      onInfo: (info) => infos.push(info),
    });

    await expect(engine.run(request)).resolves.toMatchObject({
      status: 'failed',
      diagnostics: { code: 'stream_overflow' },
    });
    expect(infos.at(-1)).toMatchObject({
      stage: 'failed',
      code: 'stream_overflow',
      capacityOmissionCount: 0,
      eventRepresentability: { capacityOmissionCount: 2 },
    });
  });

  it('reports capacity diagnostics from a live source failure before recovery', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('last good', 0));
    const host = new FakePresentationHost();
    const infos: IsolatedMirrorInfo[] = [];
    const engine = makeEngine(stream, host, (info) => infos.push(info));
    await engine.run(request);
    const representability = createHtmlMirrorRepresentabilityCollector();
    representability.capacityOmissionCount = 3;

    stream.observer?.onFailure('stream_overflow', representability);

    expect(stream.requested).toEqual([0]);
    expect(infos.findLast(({ stage }) => stage === 'recovery')).toMatchObject({
      code: 'stream_overflow',
      capacityOmissionCount: 0,
      eventRepresentability: { capacityOmissionCount: 3 },
    });
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

  it('retains text image and open-shadow identity while reconciling final child order', async () => {
    const stream = new FakeHtmlStream(makeReconciliationCheckpoint());
    const host = new FakePresentationHost();
    const infos: IsolatedMirrorInfo[] = [];
    const commits: Array<Parameters<NonNullable<
      ConstructorParameters<typeof IsolatedHtmlReplicaEngine>[0]['onSourceCommit']
    >>[0]> = [];
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => stream,
      initializeIframe: async (iframe, shell) => {
        const { document } = parseHTML(shell);
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        return document;
      },
      onInfo: (info) => infos.push(info),
      onSourceCommit: (commit) => commits.push(commit),
    });
    await engine.run(request);

    const replica = host.iframe!.contentDocument!;
    const body = replica.body;
    const card = replica.querySelector('x-card')!;
    const paragraph = replica.querySelector('p')!;
    const translatedText = paragraph.firstChild!;
    const image = replica.querySelector('img')! as HTMLImageElement;
    const shadow = card.shadowRoot!;
    const slot = shadow.querySelector('slot')!;
    expect(slot.assignedNodes()).toEqual([image]);
    const shadowStyle = shadow.querySelector('[data-simul-adopted-style="shadow"]');
    const imageAnchor = engine.resolveImageAnchor(engine.snapshot()!.document, 5)!;
    const snapshot = engine.snapshot()!;
    const paragraphRecord = snapshot.records.find(({ nodeId }) => nodeId === 7)!;
    engine.beginProjection({ translationEpoch: 1, pairKey: 'en\0ja' });
    expect(engine.project({
      document: snapshot.document,
      replayLease: snapshot.replayLease,
      nodeId: 7,
      nodeType: 3,
      sourceRevision: paragraphRecord.revision,
      source: paragraphRecord.source,
      translationEpoch: 1,
      pairKey: 'en\0ja',
      translated: '翻訳を保持',
    })).toBe(true);

    const patch = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'reconcile-children',
        nodeId: 3,
        children: [
          { kind: 'retain', nodeId: 6 },
          { kind: 'retain', nodeId: 4 },
          {
            kind: 'graph',
            node: {
              kind: 'element', id: 10, namespace: 'html', tagName: 'aside',
              attributes: [], children: [{
                kind: 'text', id: 11, text: 'new content', translatable: true,
              }],
            },
          },
        ],
      }],
    );
    expect(patch).toBeDefined();
    stream.observer?.onPatch(patch!);

    expect(body.querySelector('p')).toBe(paragraph);
    expect(paragraph.firstChild).toBe(translatedText);
    expect(translatedText.nodeValue).toBe('翻訳を保持');
    expect(body.querySelector('x-card')).toBe(card);
    expect(card.shadowRoot).toBe(shadow);
    expect(shadow.querySelector('slot')).toBe(slot);
    expect(slot.assignedNodes()).toEqual([image]);
    expect(shadow.querySelector('[data-simul-adopted-style="shadow"]')).toBe(
      shadowStyle,
    );
    expect(body.querySelector('img')).toBe(image);
    expect(engine.resolveImageAnchor(engine.snapshot()!.document, 5)?.image).toBe(
      imageAnchor.image,
    );
    expect([...body.children].map(({ localName }) => localName)).toEqual([
      'p', 'x-card', 'aside', 'style',
    ]);
    expect(commits.at(-1)?.changes).toEqual([
      expect.objectContaining({
        kind: 'upsert',
        record: expect.objectContaining({ nodeId: 11 }),
      }),
    ]);
    expect(infos.findLast(({ stage }) => stage === 'patch')).toMatchObject({
      reconcileChildrenOperationCount: 1,
      childrenOperationCount: 0,
      retainedNodeCount: 6,
      insertedNodeCount: 2,
      movedNodeCount: 1,
      removedNodeCount: 0,
      replacementNodeCount: 0,
    });
  });

  it('rejects cross-parent retain references before changing the last-good DOM', async () => {
    const stream = new FakeHtmlStream(makeCrossParentCheckpoint());
    const host = new FakePresentationHost();
    const infos: IsolatedMirrorInfo[] = [];
    const engine = makeEngine(stream, host, (info) => infos.push(info));
    await engine.run(request);
    const body = host.iframe!.contentDocument!.body;
    const first = body.firstChild!;
    const secondParagraph = body.lastChild!.firstChild!;
    const eventRepresentability = createHtmlMirrorRepresentabilityCollector();
    eventRepresentability.capacityOmissionCount = 1;

    const patch = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'reconcile-children',
        nodeId: 4,
        children: [{ kind: 'retain', nodeId: 8 }],
      }],
      eventRepresentability,
    );
    expect(patch).toBeDefined();
    stream.observer?.onPatch(patch!);

    expect(body.firstChild).toBe(first);
    expect(body.lastChild!.firstChild).toBe(secondParagraph);
    expect(body.textContent).toBe('firstsecond');
    expect(stream.acknowledged).not.toContain(1);
    expect(stream.requested).toEqual([0]);
    expect(infos.findLast(({ stage }) => stage === 'recovery')).toMatchObject({
      code: 'stream_gap',
      reconciliationRejectedCount: 1,
      capacityOmissionCount: 0,
      eventRepresentability: { capacityOmissionCount: 1 },
    });
  });

  it.each(['reconcile-children', 'children'] as const)(
    'rejects a disconnected %s target before mutating its detached tree',
    async (kind) => {
      const stream = new FakeHtmlStream(makeCrossParentCheckpoint());
      const host = new FakePresentationHost();
      const infos: IsolatedMirrorInfo[] = [];
      const engine = makeEngine(stream, host, (info) => infos.push(info));
      await engine.run(request);
      const body = host.iframe!.contentDocument!.body;
      const detached = body.firstChild! as Element;
      const retained = detached.firstChild!;
      detached.remove();

      const operation: HtmlMirrorPatchOperation = kind === 'reconcile-children'
        ? {
            kind,
            nodeId: 4,
            children: [{ kind: 'retain', nodeId: 5 }],
          }
        : { kind, nodeId: 4, children: [] };
      const patch = createHtmlMirrorPatch(
        createReplicaIdentity({ ...identityParts, sequence: 1 }),
        1,
        1,
        [operation],
      );
      expect(patch).toBeDefined();
      stream.observer?.onPatch(patch!);

      expect(detached.firstChild).toBe(retained);
      expect(detached.textContent).toBe('first');
      expect(body.textContent).toBe('second');
      expect(stream.acknowledged).not.toContain(1);
      expect(stream.requested).toEqual([0]);
      expect(infos.findLast(({ stage }) => stage === 'recovery')).toMatchObject({
        reconciliationRejectedCount: kind === 'reconcile-children' ? 1 : 0,
      });
    },
  );

  it.each(['source-first', 'destination-first'] as const)(
    'applies cross-parent full replacements safely in %s order',
    async (operationOrder) => {
      const stream = new FakeHtmlStream(makeCrossParentCheckpoint());
      const host = new FakePresentationHost();
      const infos: IsolatedMirrorInfo[] = [];
      const commits: Array<Parameters<NonNullable<
        ConstructorParameters<typeof IsolatedHtmlReplicaEngine>[0]['onSourceCommit']
      >>[0]> = [];
      const engine = new IsolatedHtmlReplicaEngine({
        presentationHost: host,
        openStream: async () => stream,
        initializeIframe: async (iframe, shell) => {
          const { document } = parseHTML(shell);
          Object.defineProperty(iframe, 'contentDocument', { value: document });
          return document;
        },
        onSourceCommit: (commit) => commits.push(commit),
        onInfo: (info) => infos.push(info),
      });
      await engine.run(request);
      const originalImage = engine.resolveImageAnchor(
        engine.snapshot()!.document,
        10,
      )!.image;

      const sourceReplacement: HtmlMirrorPatchOperation = {
        kind: 'children',
        nodeId: 4,
        children: [],
      };
      const destinationReplacement: HtmlMirrorPatchOperation = {
        kind: 'children',
        nodeId: 7,
        children: [
          {
            kind: 'element',
            id: 8,
            namespace: 'html',
            tagName: 'p',
            attributes: [],
            children: [{
              kind: 'text',
              id: 9,
              text: 'second',
              translatable: true,
            }],
          },
          {
            kind: 'element',
            id: 5,
            namespace: 'html',
            tagName: 'p',
            attributes: [],
            children: [{
              kind: 'text',
              id: 6,
              text: 'first',
              translatable: true,
            }, {
              kind: 'element',
              id: 10,
              namespace: 'html',
              tagName: 'img',
              attributes: [['src', 'https://images.example.test/moved.jpg']],
              children: [],
            }],
          },
        ],
      };
      const operations = operationOrder === 'source-first'
        ? [sourceReplacement, destinationReplacement]
        : [destinationReplacement, sourceReplacement];
      const patch = createHtmlMirrorPatch(
        createReplicaIdentity({ ...identityParts, sequence: 1 }),
        1,
        1,
        operations,
      );
      expect(patch).toBeDefined();
      stream.observer?.onPatch(patch!);

      const sections = host.iframe!.contentDocument!.body.querySelectorAll('section');
      expect(sections[0]!.childNodes).toHaveLength(0);
      expect([...sections[1]!.children].map(({ textContent }) => textContent))
        .toEqual(['second', 'first']);
      const movedImage = engine.resolveImageAnchor(
        engine.snapshot()!.document,
        10,
      );
      expect(movedImage?.image).not.toBe(originalImage);
      expect(movedImage?.image.parentElement).toBe(sections[1]!.children[1]);
      expect(movedImage?.image.getAttribute('src')).toBe(
        'https://images.example.test/moved.jpg',
      );
      expect(stream.acknowledged).toContain(1);
      expect(stream.requested).toEqual([]);
      expect(infos.findLast(({ stage }) => stage === 'patch')).toMatchObject({
        childrenOperationCount: 2,
        removedNodeCount: 5,
      });
      expect(engine.snapshot()?.records).toHaveLength(2);
      expect(engine.snapshot()?.records).toEqual(expect.arrayContaining([
        expect.objectContaining({ nodeId: 9, source: 'second' }),
        expect.objectContaining({ nodeId: 6, source: 'first' }),
      ]));
      expect(commits.at(-1)?.changes).toHaveLength(2);
      expect(commits.at(-1)?.changes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'upsert',
          record: expect.objectContaining({ nodeId: 9, source: 'second' }),
        }),
        expect.objectContaining({
          kind: 'upsert',
          record: expect.objectContaining({ nodeId: 6, source: 'first' }),
        }),
      ]));

      const snapshot = engine.snapshot()!;
      engine.beginProjection({ translationEpoch: 1, pairKey: 'en\0ja' });
      for (const record of snapshot.records) {
        expect(engine.project({
          document: snapshot.document,
          replayLease: snapshot.replayLease,
          nodeId: record.nodeId,
          nodeType: 3,
          sourceRevision: record.revision,
          source: record.source,
          translationEpoch: 1,
          pairKey: 'en\0ja',
          translated: record.nodeId === 9 ? '二番' : '一番',
        })).toBe(true);
      }
      expect([...sections[1]!.children].map(({ textContent }) => textContent))
        .toEqual(['二番', '一番']);
    },
  );

  it('restores every independent rollback target after one restore operation throws', async () => {
    const stream = new FakeHtmlStream(makeCrossParentCheckpoint());
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);
    await engine.run(request);
    const body = host.iframe!.contentDocument!.body;
    const firstSection = body.children[0]!;
    const secondSection = body.children[1]!;
    const firstParagraph = firstSection.firstChild!;
    const secondText = secondSection.firstChild!.firstChild!;
    const originalInsertBefore = firstSection.insertBefore.bind(firstSection);
    const insert = vi.spyOn(firstSection, 'insertBefore').mockImplementationOnce(
      () => {
        throw new Error('synthetic commit failure');
      },
    );
    const replace = vi.spyOn(firstSection, 'replaceChildren').mockImplementationOnce(
      () => {
        throw new Error('synthetic rollback failure');
      },
    );

    const patch = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'attributes', nodeId: 7, tagName: 'section',
        attributes: [['class', 'changed']],
      }, {
        kind: 'text', nodeId: 9,
        node: { kind: 'text', id: 9, text: 'changed second', translatable: true },
      }, {
        kind: 'reconcile-children', nodeId: 4,
        children: [{
          kind: 'graph',
          node: {
            kind: 'element', id: 11, namespace: 'html', tagName: 'aside',
            attributes: [], children: [],
          },
        }, { kind: 'retain', nodeId: 5 }],
      }],
    );
    expect(patch).toBeDefined();
    stream.observer?.onPatch(patch!);
    insert.mockRestore();
    replace.mockRestore();
    firstSection.insertBefore = originalInsertBefore;

    expect(firstSection.firstChild).toBe(firstParagraph);
    expect(firstSection.textContent).toBe('first');
    expect(secondSection.hasAttribute('class')).toBe(false);
    expect(secondText.nodeValue).toBe('second');
    expect(engine.snapshot()?.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 6, source: 'first' }),
      expect.objectContaining({ nodeId: 9, source: 'second' }),
    ]));
    expect(stream.acknowledged).not.toContain(1);
    expect(stream.requested).toEqual([0]);
  });

  it('moves only the non-LIS retained child while preserving final order and styles', async () => {
    const stream = new FakeHtmlStream(makeThreeChildCheckpoint());
    const host = new FakePresentationHost();
    const infos: IsolatedMirrorInfo[] = [];
    const engine = makeEngine(stream, host, (info) => infos.push(info));
    await engine.run(request);
    const body = host.iframe!.contentDocument!.body;
    const [first, second, third] = [...body.children];
    const adoptedStyle = body.lastElementChild!;

    const patch = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'reconcile-children', nodeId: 3,
        children: [
          { kind: 'retain', nodeId: 8 },
          { kind: 'retain', nodeId: 4 },
          { kind: 'retain', nodeId: 6 },
        ],
      }],
    );
    expect(patch).toBeDefined();
    stream.observer?.onPatch(patch!);

    expect([...body.children]).toEqual([third, first, second, adoptedStyle]);
    expect(body.lastElementChild).toBe(adoptedStyle);
    expect(infos.findLast(({ stage }) => stage === 'patch')).toMatchObject({
      retainedNodeCount: 6,
      insertedNodeCount: 0,
      movedNodeCount: 1,
      removedNodeCount: 0,
    });
  });

  it('rolls back DOM maps and dimensions when reconciliation throws during commit', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('last good', 0));
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);
    await engine.run(request);
    const body = host.iframe!.contentDocument!.body;
    const originalText = body.firstChild!;
    const originalInsertBefore = body.insertBefore.bind(body);
    const insert = vi.spyOn(body, 'insertBefore').mockImplementationOnce(() => {
      throw new Error('synthetic apply failure');
    });

    const patch = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'reconcile-children',
        nodeId: 3,
        children: [{
          kind: 'graph',
          node: {
            kind: 'element', id: 5, namespace: 'html', tagName: 'p',
            attributes: [], children: [{
              kind: 'text', id: 6, text: 'partial', translatable: true,
            }],
          },
        }],
      }, {
        kind: 'dimensions',
        viewportWidth: 300,
        viewportHeight: 200,
        documentWidth: 400,
        documentHeight: 500,
      }],
    );
    expect(patch).toBeDefined();
    stream.observer?.onPatch(patch!);
    insert.mockRestore();
    body.insertBefore = originalInsertBefore;

    expect(body.firstChild).toBe(originalText);
    expect(body.textContent).toBe('last good');
    expect(engine.snapshot()?.records).toEqual([
      expect.objectContaining({ nodeId: 4, source: 'last good', revision: 1 }),
    ]);
    expect(stream.acknowledged).not.toContain(1);
    expect(stream.requested).toEqual([0]);
  });

  it('allows privacy attributes and replacement children on one target atomically', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('public value', 0));
    const host = new FakePresentationHost();
    const infos: IsolatedMirrorInfo[] = [];
    const engine = makeEngine(stream, host, (info) => infos.push(info));
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
    expect(infos.find(({ stage }) => stage === 'patch')).toMatchObject({
      operationCount: 2,
      attributeOperationCount: 1,
      childrenOperationCount: 1,
      textOperationCount: 0,
      dimensionOperationCount: 0,
      replacementNodeCount: 1,
      largestReplacementNodeCount: 1,
      fullReplacementFallbackCount: 1,
    });
  });

  it('reports outgoing replacement size when a children patch clears a subtree', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('removed value', 0));
    const host = new FakePresentationHost();
    const infos: IsolatedMirrorInfo[] = [];
    const engine = makeEngine(stream, host, (info) => infos.push(info));
    await engine.run(request);

    const patch = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{ kind: 'children', nodeId: 3, children: [] }],
    );
    expect(patch).toBeDefined();
    stream.observer?.onPatch(patch!);

    expect(host.iframe?.contentDocument?.body.textContent).toBe('');
    expect(infos.find(({ stage }) => stage === 'patch')).toMatchObject({
      operationCount: 1,
      childrenOperationCount: 1,
      replacementNodeCount: 1,
      largestReplacementNodeCount: 1,
    });
  });

  it('keeps checkpoint representability separate from patch-event counters', async () => {
    const base = makeCheckpoint('source', 0);
    const baseline = createHtmlMirrorRepresentabilityCollector();
    baseline.unsafeElementOmissionCount = 2;
    const checkpoint = createHtmlMirrorCheckpoint(base.identity, {
      root: base.payload.root,
      adoptedStyleSheets: base.payload.adoptedStyleSheets,
      captureMs: base.payload.captureMs,
      viewportWidth: base.payload.viewportWidth,
      viewportHeight: base.payload.viewportHeight,
      documentWidth: base.payload.documentWidth,
      documentHeight: base.payload.documentHeight,
      representability: baseline,
    })!;
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const infos: IsolatedMirrorInfo[] = [];
    const engine = makeEngine(stream, host, (info) => infos.push(info));
    await engine.run(request);

    const event = createHtmlMirrorRepresentabilityCollector();
    event.unsafeElementOmissionCount = 3;
    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'dimensions', viewportWidth: 800, viewportHeight: 600,
        documentWidth: 800, documentHeight: 1000,
      }],
      event,
    )!);
    expect(infos.findLast(({ stage }) => stage === 'patch')).toMatchObject({
      unsafeElementOmissionCount: 2,
      eventRepresentability: { unsafeElementOmissionCount: 3 },
    });

    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 2 }),
      2,
      2,
      [{
        kind: 'dimensions', viewportWidth: 801, viewportHeight: 600,
        documentWidth: 801, documentHeight: 1000,
      }],
    )!);
    expect(infos.findLast(({ stage }) => stage === 'patch')).toMatchObject({
      unsafeElementOmissionCount: 2,
      eventRepresentability: { unsafeElementOmissionCount: 0 },
    });
  });

  it('rejects an activation transition that does not re-sanitize descendants', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('public value', 0));
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);
    await engine.run(request);

    const patch = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'attributes',
        nodeId: 3,
        tagName: 'body',
        attributes: [['role', 'button']],
      }],
    );
    expect(patch).toBeDefined();
    stream.observer?.onPatch(patch!);

    expect(host.iframe?.contentDocument?.body.hasAttribute('role')).toBe(false);
    expect(host.iframe?.contentDocument?.body.textContent).toBe('public value');
    expect(stream.requested).toEqual([0]);
  });

  it('requires checkpoint recovery when a shadow host tightens privacy', async () => {
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
            { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [{
              kind: 'element', id: 4, namespace: 'html', tagName: 'div',
              attributes: [], children: [], shadowRoot: {
                id: 5,
                mode: 'open',
                adoptedStyleSheets: [],
                children: [{
                  kind: 'text', id: 6, text: 'public shadow text', translatable: true,
                }],
              },
            }] },
          ],
        },
        adoptedStyleSheets: [],
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
    await engine.run(request);

    const patch = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [
        {
          kind: 'attributes', nodeId: 4, tagName: 'div',
          attributes: [['role', 'textbox']],
        },
        { kind: 'children', nodeId: 4, children: [] },
      ],
    );
    expect(patch).toBeDefined();
    stream.observer?.onPatch(patch!);

    const replicaHost = host.iframe?.contentDocument?.querySelector('div');
    expect(replicaHost?.hasAttribute('role')).toBe(false);
    expect(replicaHost?.shadowRoot?.firstChild?.nodeValue).toBe(
      'public shadow text',
    );
    expect(stream.requested).toEqual([0]);
  });

  it('rejects private metadata patched onto an activation descendant', async () => {
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
            { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [{
              kind: 'element', id: 4, namespace: 'html', tagName: 'button',
              attributes: [], children: [{
                kind: 'element', id: 5, namespace: 'html', tagName: 'span',
                attributes: [], children: [{
                  kind: 'text', id: 6, text: 'public activation label', translatable: true,
                }],
              }],
            }],
          }],
        },
        adoptedStyleSheets: [],
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
    await engine.run(request);

    const patch = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'attributes',
        nodeId: 5,
        tagName: 'span',
        attributes: [['title', 'transported descendant secret']],
      }],
    );
    expect(patch).toBeDefined();
    stream.observer?.onPatch(patch!);

    const span = host.iframe?.contentDocument?.querySelector('button span');
    expect(span?.textContent).toBe('public activation label');
    expect(span?.hasAttribute('title')).toBe(false);
    expect(stream.requested).toEqual([0]);
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

  it('settles a Reddit-shaped three-column candidate and keeps accessibility labels hidden', async () => {
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [
              {
                kind: 'element', id: 4, namespace: 'html', tagName: 'link',
                attributes: [['rel', 'stylesheet'], ['href', 'https://static.example.test/shell.css']],
                children: [],
              },
              {
                kind: 'element', id: 14, namespace: 'html', tagName: 'link',
                attributes: [['rel', 'stylesheet'], ['href', 'https://static.example.test/failing.css']],
                children: [],
              },
            ] },
            { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [
              { kind: 'element', id: 5, namespace: 'html', tagName: 'aside', attributes: [], children: [
                { kind: 'text', id: 6, text: 'left rail', translatable: true },
              ] },
              { kind: 'element', id: 7, namespace: 'html', tagName: 'main', attributes: [], children: [
                { kind: 'text', id: 8, text: 'center content', translatable: true },
                { kind: 'element', id: 9, namespace: 'html', tagName: 'faceplate-screen-reader-content',
                  attributes: [], visuallyHidden: true, children: [], shadowRoot: {
                    id: 10, mode: 'open', children: [
                      {
                        kind: 'text', id: 11, text: 'Vote', translatable: true,
                      },
                      {
                        kind: 'element', id: 16, namespace: 'html', tagName: 'link',
                        attributes: [['rel', 'stylesheet'], ['href', 'https://static.example.test/shadow.css']],
                        children: [],
                      },
                    ], adoptedStyleSheets: [':host{display:block}'],
                  } },
                { kind: 'element', id: 15, namespace: 'html', tagName: 'img',
                  attributes: [['src', 'https://static.example.test/fallback.jpg'], ['srcset', 'https://static.example.test/fallback@2x.jpg 2x']],
                  selectedImageSource: 'https://static.example.test/selected.jpg', children: [] },
              ] },
              { kind: 'element', id: 12, namespace: 'html', tagName: 'aside', attributes: [], children: [] },
            ] },
          ],
        },
        adoptedStyleSheets: [],
        captureMs: 1,
        viewportWidth: 1200,
        viewportHeight: 800,
        documentWidth: 1200,
        documentHeight: 1600,
      },
    )!;
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const infos: IsolatedMirrorInfo[] = [];
    let replicaDocument: Document | undefined;
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => stream,
      styleSettleDeadlineMs: 1_000,
      initializeIframe: async (iframe, shell) => {
        const parsed = parseHTML(shell);
        replicaDocument = parsed.document;
        Object.defineProperty(iframe, 'contentDocument', { value: parsed.document });
        return parsed.document;
      },
      onInfo: (info) => infos.push(info),
    });

    const running = engine.run(request);
    await vi.waitFor(() => expect(
      replicaDocument?.querySelector('link[rel="stylesheet"]'),
    ).toBeTruthy());
    const links = [...replicaDocument!.querySelectorAll('link')];
    const loadEvent = replicaDocument!.createEvent('Event');
    loadEvent.initEvent('load', false, false);
    links[0]?.dispatchEvent(loadEvent);
    const errorEvent = replicaDocument!.createEvent('Event');
    errorEvent.initEvent('error', false, false);
    links[1]?.dispatchEvent(errorEvent);
    const shadowLink = replicaDocument!
      .querySelector('faceplate-screen-reader-content')
      ?.shadowRoot?.querySelector('link');
    shadowLink?.dispatchEvent(loadEvent);
    await expect(running).resolves.toMatchObject({ status: 'complete' });

    const body = host.iframe?.contentDocument?.body;
    expect(body?.textContent).toContain('left rail');
    expect(body?.textContent).toContain('center content');
    const hidden = body?.querySelector('faceplate-screen-reader-content') as
      HTMLElement | null;
    expect(hidden?.getAttribute('data-simul-visually-hidden')).toBe('v1');
    expect(hidden?.style.width).toBe('1px');
    expect(body?.querySelector('main')?.hasAttribute('data-simul-visually-hidden'))
      .toBe(false);
    const responsive = body?.querySelector('img');
    expect(responsive?.getAttribute('src'))
      .toBe('https://static.example.test/selected.jpg');
    expect(responsive?.hasAttribute('srcset')).toBe(false);
    expect(infos.find(({ stage }) => stage === 'checkpoint')).toMatchObject({
      openShadowRootCount: 1,
      adoptedStyleCount: 1,
      visuallyHiddenCount: 1,
      selectedImageSourceCount: 1,
      stylesheetLinkCount: 3,
      stylesheetLoadedCount: 2,
      stylesheetErrorCount: 1,
      stylesheetTimedOutCount: 0,
    });

    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{ kind: 'children', nodeId: 12, children: [{
        kind: 'text', id: 13, text: 'late right rail', translatable: true,
      }] }],
    )!);
    expect(body?.textContent).toContain('late right rail');
  });

  it('rechecks stylesheet readiness after installing load listeners', async () => {
    const stream = new FakeHtmlStream(makeStylesheetCheckpoint());
    const host = new FakePresentationHost();
    const infos: IsolatedMirrorInfo[] = [];
    let sheetReads = 0;
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => stream,
      styleSettleDeadlineMs: 100,
      initializeIframe: async (iframe, shell) => {
        const { document } = parseHTML(shell);
        const createElementNS = document.createElementNS.bind(document);
        Object.defineProperty(document, 'createElementNS', {
          configurable: true,
          value: (namespace: string, tagName: string) => {
            const element = createElementNS(namespace, tagName);
            if (tagName === 'link') {
              Object.defineProperty(element, 'sheet', {
                configurable: true,
                get: () => ++sheetReads >= 2 ? {} : null,
              });
            }
            return element;
          },
        });
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        return document;
      },
      onInfo: (info) => infos.push(info),
    });

    await expect(engine.run(request)).resolves.toMatchObject({ status: 'complete' });
    expect(sheetReads).toBe(2);
    expect(infos.find(({ stage }) => stage === 'checkpoint')).toMatchObject({
      stylesheetLinkCount: 1,
      stylesheetLoadedCount: 1,
      stylesheetErrorCount: 0,
      stylesheetTimedOutCount: 0,
    });
  });

  it('uses one absolute style deadline for both paint waits', async () => {
    vi.useFakeTimers();
    try {
      const stream = new FakeHtmlStream(makeStylesheetCheckpoint());
      const host = new FakePresentationHost();
      const infos: IsolatedMirrorInfo[] = [];
      let paintRequests = 0;
      const engine = new IsolatedHtmlReplicaEngine({
        presentationHost: host,
        openStream: async () => stream,
        styleSettleDeadlineMs: 20,
        initializeIframe: async (iframe, shell) => {
          const { document, window } = parseHTML(shell);
          Object.defineProperties(window, {
            requestAnimationFrame: {
              configurable: true,
              value: () => {
                paintRequests += 1;
                return paintRequests;
              },
            },
            cancelAnimationFrame: { configurable: true, value: () => undefined },
          });
          Object.defineProperty(iframe, 'contentDocument', { value: document });
          return document;
        },
        onInfo: (info) => infos.push(info),
      });
      let settled = false;
      const running = engine.run(request).then((result) => {
        settled = true;
        return result;
      });

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(20);
      expect(settled).toBe(true);
      expect(paintRequests).toBe(0);
      await expect(running).resolves.toMatchObject({ status: 'complete' });
      expect(infos.find(({ stage }) => stage === 'checkpoint')).toMatchObject({
        stylesheetLinkCount: 1,
        stylesheetTimedOutCount: 1,
      });
    } finally {
      vi.useRealTimers();
    }
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

  it('preserves passive image-only layout and resolves external SVG and JPEG anchors', async () => {
    const mediaCss = [
      '.viewer{display:flex;min-height:100vh;align-items:center;justify-content:center;',
      'scroll-behavior:smooth;overscroll-behavior-y:contain}',
      '.viewer img{display:block;max-width:100%;max-height:100vh;object-fit:contain}',
    ].join('');
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            {
              kind: 'element', id: 2, namespace: 'html', tagName: 'head',
              attributes: [], children: [{
                kind: 'element', id: 3, namespace: 'html', tagName: 'style',
                attributes: [], children: [{
                  kind: 'text', id: 4, text: mediaCss, translatable: false,
                }],
              }],
            },
            {
              kind: 'element', id: 5, namespace: 'html', tagName: 'body',
              attributes: [['class', 'viewer']], children: [
                {
                  kind: 'element', id: 6, namespace: 'html', tagName: 'img',
                  attributes: [
                    ['src', 'https://assets.example/header_logo.svg'],
                    ['width', '275'],
                    ['height', '30'],
                  ], children: [],
                },
                {
                  kind: 'element', id: 7, namespace: 'html', tagName: 'img',
                  attributes: [
                    ['src', 'https://images.example/media.jpeg'],
                    ['width', '1206'],
                    ['height', '761'],
                  ], children: [],
                },
              ],
            },
          ],
        },
        adoptedStyleSheets: [],
        captureMs: 1,
        viewportWidth: 1206,
        viewportHeight: 761,
        documentWidth: 1206,
        documentHeight: 761,
      },
    );
    expect(checkpoint).toBeDefined();
    const stream = new FakeHtmlStream(checkpoint!);
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);

    await expect(engine.run(request)).resolves.toMatchObject({
      status: 'complete',
    });
    const snapshot = engine.snapshot()!;
    const svgAnchor = engine.resolveImageAnchor(snapshot.document, 6);
    const jpegAnchor = engine.resolveImageAnchor(snapshot.document, 7);
    expect(svgAnchor?.image.getAttribute('src')).toBe(
      'https://assets.example/header_logo.svg',
    );
    expect(jpegAnchor?.image.getAttribute('src')).toBe(
      'https://images.example/media.jpeg',
    );
    expect(svgAnchor?.replayLease).toBe(snapshot.replayLease);
    expect(jpegAnchor?.replayLease).toBe(snapshot.replayLease);
    expect(host.iframe?.contentDocument?.head.textContent).toContain(mediaCss);
    expect(host.iframe?.contentDocument?.body.className).toBe('viewer');
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

function makeReconciliationCheckpoint(): HtmlMirrorCheckpoint {
  const checkpoint = createHtmlMirrorCheckpoint(
    createReplicaIdentity({ ...identityParts, sequence: 0 }),
    {
      root: {
        kind: 'element', id: 1, namespace: 'html', tagName: 'html',
        attributes: [['lang', 'en']], children: [
          {
            kind: 'element', id: 2, namespace: 'html', tagName: 'head',
            attributes: [], children: [],
          },
          {
            kind: 'element', id: 3, namespace: 'html', tagName: 'body',
            attributes: [], children: [
              {
                kind: 'element', id: 4, namespace: 'html', tagName: 'x-card',
                attributes: [], children: [{
                  kind: 'element', id: 5, namespace: 'html', tagName: 'img',
                  attributes: [
                    ['src', 'https://images.example.test/card.jpg'],
                    ['slot', 'media'],
                  ],
                  children: [],
                }],
                shadowRoot: {
                  id: 8, mode: 'open', adoptedStyleSheets: [
                    ':host{display:block}',
                  ],
                  children: [{
                    kind: 'element', id: 9, namespace: 'html', tagName: 'slot',
                    attributes: [['name', 'media']], children: [],
                  }],
                },
              },
              {
                kind: 'element', id: 6, namespace: 'html', tagName: 'p',
                attributes: [], children: [{
                  kind: 'text', id: 7, text: 'translated source',
                  translatable: true,
                }],
              },
            ],
          },
        ],
      },
      adoptedStyleSheets: ['body{display:block}'],
      captureMs: 1,
      viewportWidth: 800,
      viewportHeight: 600,
      documentWidth: 800,
      documentHeight: 1000,
    },
  );
  if (!checkpoint) throw new Error('Reconciliation fixture checkpoint rejected.');
  return checkpoint;
}

function makeCrossParentCheckpoint(): HtmlMirrorCheckpoint {
  const checkpoint = createHtmlMirrorCheckpoint(
    createReplicaIdentity({ ...identityParts, sequence: 0 }),
    {
      root: {
        kind: 'element', id: 1, namespace: 'html', tagName: 'html',
        attributes: [], children: [
          {
            kind: 'element', id: 2, namespace: 'html', tagName: 'head',
            attributes: [], children: [],
          },
          {
            kind: 'element', id: 3, namespace: 'html', tagName: 'body',
            attributes: [], children: [
              {
                kind: 'element', id: 4, namespace: 'html', tagName: 'section',
                attributes: [], children: [{
                  kind: 'element', id: 5, namespace: 'html', tagName: 'p',
                  attributes: [], children: [{
                    kind: 'text', id: 6, text: 'first', translatable: true,
                  }, {
                    kind: 'element', id: 10, namespace: 'html', tagName: 'img',
                    attributes: [['src', 'https://images.example.test/moved.jpg']],
                    children: [],
                  }],
                }],
              },
              {
                kind: 'element', id: 7, namespace: 'html', tagName: 'section',
                attributes: [], children: [{
                  kind: 'element', id: 8, namespace: 'html', tagName: 'p',
                  attributes: [], children: [{
                    kind: 'text', id: 9, text: 'second', translatable: true,
                  }],
                }],
              },
            ],
          },
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
  if (!checkpoint) throw new Error('Cross-parent fixture checkpoint rejected.');
  return checkpoint;
}

function makeThreeChildCheckpoint(): HtmlMirrorCheckpoint {
  const checkpoint = createHtmlMirrorCheckpoint(
    createReplicaIdentity({ ...identityParts, sequence: 0 }),
    {
      root: {
        kind: 'element', id: 1, namespace: 'html', tagName: 'html',
        attributes: [], children: [
          {
            kind: 'element', id: 2, namespace: 'html', tagName: 'head',
            attributes: [], children: [],
          },
          {
            kind: 'element', id: 3, namespace: 'html', tagName: 'body',
            attributes: [], children: [
              {
                kind: 'element', id: 4, namespace: 'html', tagName: 'p',
                attributes: [], children: [{
                  kind: 'text', id: 5, text: 'first', translatable: true,
                }],
              },
              {
                kind: 'element', id: 6, namespace: 'html', tagName: 'p',
                attributes: [], children: [{
                  kind: 'text', id: 7, text: 'second', translatable: true,
                }],
              },
              {
                kind: 'element', id: 8, namespace: 'html', tagName: 'p',
                attributes: [], children: [{
                  kind: 'text', id: 9, text: 'third', translatable: true,
                }],
              },
            ],
          },
        ],
      },
      adoptedStyleSheets: ['body{display:block}'],
      captureMs: 1,
      viewportWidth: 800,
      viewportHeight: 600,
      documentWidth: 800,
      documentHeight: 1000,
    },
  );
  if (!checkpoint) throw new Error('Three-child fixture checkpoint rejected.');
  return checkpoint;
}

function makeStylesheetCheckpoint(): HtmlMirrorCheckpoint {
  const checkpoint = createHtmlMirrorCheckpoint(
    createReplicaIdentity({ ...identityParts, sequence: 0 }),
    {
      root: {
        kind: 'element', id: 1, namespace: 'html', tagName: 'html', attributes: [], children: [
          { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [{
            kind: 'element', id: 5, namespace: 'html', tagName: 'link',
            attributes: [['rel', 'stylesheet'], ['href', 'https://static.example.test/race.css']],
            children: [],
          }] },
          { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [
            { kind: 'text', id: 4, text: 'styled content', translatable: true },
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
  if (!checkpoint) throw new Error('Stylesheet fixture checkpoint rejected.');
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
