import { ImageSourceSession } from '../ocr/image-source-session';
import { readImageSourcePortSessionId } from '../ocr/image-source-protocol';
import { SourceImageObserver } from '../ocr/source-image-observer';
import type { ReplicaDocumentIdentity } from './contracts';
import {
  HTML_MIRROR_PORT_PREFIX,
  MAX_HTML_MIRROR_UNACKED_BATCHES,
  createHtmlMirrorCheckpoint,
  createHtmlMirrorError,
  createHtmlMirrorPatch,
  readHtmlMirrorControllerMessage,
  readHtmlMirrorPortSessionId,
  type HtmlMirrorPatchOperation,
} from './html-mirror-protocol';
import {
  MAX_HTML_MIRROR_NODES,
  createHtmlMirrorStyleWorkBudget,
  sanitizeSourceAdoptedStyleSheets,
  sanitizeSourceAttributes,
  sanitizeSourceChildren,
  sanitizeSourceDocument,
  sanitizeSourceElementHints,
  sanitizeSourceSubtree,
  type HtmlMirrorIdRegistry,
} from './html-mirror-sanitizer';
import { createReplicaIdentity } from './protocol-v2';

export class WeakNodeIdRegistry implements HtmlMirrorIdRegistry {
  readonly #ids = new WeakMap<Node, number>();
  readonly #nodes = new Map<number, WeakRef<Node>>();
  #nextId = 1;
  #allocationsSincePrune = 0;

  static readonly MAX_TRACKED_NODES = 200_000;
  static readonly PRUNE_INTERVAL = 256;

  getId(node: Node): number {
    const existing = this.#ids.get(node);
    if (existing) return existing;
    if (this.#nodes.size >= WeakNodeIdRegistry.MAX_TRACKED_NODES) {
      this.prune();
      if (this.#nodes.size >= WeakNodeIdRegistry.MAX_TRACKED_NODES) {
        throw new Error('HTML mirror node registry capacity exceeded.');
      }
    }
    const id = this.#nextId++;
    if (!Number.isSafeInteger(id)) throw new Error('HTML mirror node ID exhausted.');
    this.#ids.set(node, id);
    this.#nodes.set(id, new WeakRef(node));
    this.#allocationsSincePrune += 1;
    if (
      this.#allocationsSincePrune >= WeakNodeIdRegistry.PRUNE_INTERVAL ||
      this.#nodes.size > WeakNodeIdRegistry.MAX_TRACKED_NODES
    ) this.prune();
    return id;
  }

  peekId(node: Node): number | undefined {
    return this.#ids.get(node);
  }

  getNode(id: number): Node | undefined {
    const node = this.#nodes.get(id)?.deref();
    if (!node) this.#nodes.delete(id);
    return node;
  }

  prune(): void {
    this.#allocationsSincePrune = 0;
    for (const [id, reference] of this.#nodes) {
      if (!reference.deref()) this.#nodes.delete(id);
    }
  }

  get trackedNodeCount(): number {
    return this.#nodes.size;
  }
}

export interface HtmlMirrorSourceBridgeEnvironment {
  readonly global?: typeof globalThis & {
    __simulHtmlMirrorV1Installed?: boolean;
  };
  readonly runtime?: Pick<typeof browser.runtime, 'onConnect'>;
  readonly document?: Document;
  readonly window?: Window;
  readonly now?: () => number;
  readonly createMutationObserver?: (
    callback: MutationCallback,
  ) => Pick<MutationObserver, 'observe' | 'disconnect'>;
  readonly scheduleFrame?: (callback: () => void) => unknown;
  readonly cancelFrame?: (handle: unknown) => void;
  readonly setTimer?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly createResizeObserver?: (
    callback: ResizeObserverCallback,
  ) => Pick<ResizeObserver, 'observe' | 'disconnect'>;
  readonly registry?: WeakNodeIdRegistry;
}

/** Installs a page-owned, rrweb-independent HTML and image identity bridge. */
export function installHtmlMirrorSourceBridge(
  environment: HtmlMirrorSourceBridgeEnvironment = {},
): void {
  const isolatedGlobal = (environment.global ?? globalThis) as typeof globalThis & {
    __simulHtmlMirrorV1Installed?: boolean;
  };
  if (isolatedGlobal.__simulHtmlMirrorV1Installed) return;
  isolatedGlobal.__simulHtmlMirrorV1Installed = true;
  const runtime = environment.runtime ?? browser.runtime;
  const sourceDocument = environment.document ?? document;
  const sourceWindow = environment.window ?? window;
  const registry = environment.registry ?? new WeakNodeIdRegistry();

  runtime.onConnect.addListener((port) => {
    if (readHtmlMirrorPortSessionId(port.name)) {
      new HtmlMirrorSourceSession({
        port,
        document: sourceDocument,
        window: sourceWindow,
        registry,
        now: environment.now ?? (() => performance.now()),
        createMutationObserver: environment.createMutationObserver ??
          ((callback) => new MutationObserver(callback)),
        scheduleFrame: environment.scheduleFrame ??
          ((callback) => requestAnimationFrame(callback)),
        cancelFrame: environment.cancelFrame ??
          ((handle) => cancelAnimationFrame(Number(handle))),
        setTimer: environment.setTimer ??
          ((callback, milliseconds) => setTimeout(callback, milliseconds)),
        clearTimer: environment.clearTimer ??
          ((handle) => clearTimeout(Number(handle))),
        createResizeObserver: environment.createResizeObserver ??
          (typeof ResizeObserver === 'function'
            ? ((callback) => new ResizeObserver(callback))
            : undefined),
      });
      return;
    }
    if (!readImageSourcePortSessionId(port.name, 'isolated-html')) return;
    new ImageSourceSession({
      port,
      document: sourceDocument,
      window: sourceWindow,
      resolveNode: (nodeId) => registry.getNode(nodeId) ?? null,
      getNodeId: (image) => registry.getId(image),
      createObserver: (observerEnvironment) =>
        new SourceImageObserver(observerEnvironment),
    });
  });
}

interface HtmlMirrorSourceSessionEnvironment {
  readonly port: Browser.runtime.Port;
  readonly document: Document;
  readonly window: Window;
  readonly registry: WeakNodeIdRegistry;
  readonly now: () => number;
  readonly createMutationObserver: (
    callback: MutationCallback,
  ) => Pick<MutationObserver, 'observe' | 'disconnect'>;
  readonly scheduleFrame: (callback: () => void) => unknown;
  readonly cancelFrame: (handle: unknown) => void;
  readonly setTimer: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly createResizeObserver?: (
    callback: ResizeObserverCallback,
  ) => Pick<ResizeObserver, 'observe' | 'disconnect'>;
}

const MAX_HTML_MIRROR_PENDING_TARGETS = 4_000;
const SHADOW_DISCOVERY_INTERVAL_MS = 500;
const MAX_SHADOW_HOSTS_PER_TICK = 1_000;
const MAX_STYLE_SHEETS_PER_TICK = 512;
const MAX_STYLE_RULES_PER_TICK = 25_000;
const MAX_STYLE_CHARACTERS_PER_TICK = 1024 * 1024;
const MAX_MIRRORED_IMAGE_CANDIDATES = 4_000;
const MAX_IMAGE_EVENT_ROOTS = 4_000;

export class HtmlMirrorSourceSession {
  readonly #sessionId: string;
  #identity: ReplicaDocumentIdentity | undefined;
  #observer: Pick<MutationObserver, 'observe' | 'disconnect'> | undefined;
  #resizeObserver: Pick<ResizeObserver, 'observe' | 'disconnect'> | undefined;
  #pendingChildren = new Set<Node>();
  #pendingAttributes = new Set<Element>();
  #pendingText = new Set<Text>();
  #pendingDimensions = false;
  #pendingOverflow = false;
  #mirroredNodes = new WeakSet<Node>();
  #mirroredImageCandidates: Element[] = [];
  #knownMirroredImageCandidates = new WeakSet<Element>();
  #selectedImageSources = new WeakMap<Element, string>();
  #imageRefreshRequested = false;
  readonly #imageEventRoots = new Set<Document | ShadowRoot>();
  readonly #observedShadowRoots = new WeakSet<ShadowRoot>();
  #shadowHostCandidates: Element[] = [];
  #knownShadowHostCandidates = new WeakSet<Element>();
  #shadowDiscoveryCursor = 0;
  #adoptedStyleSignatures = new WeakMap<object, string>();
  #shadowDiscoveryTimer: unknown;
  #frame: unknown;
  #sequence = 0;
  #acknowledged = 0;
  #paused = false;
  #recoveryCheckpointSequence: number | undefined;
  #shadowReconciliationPending = false;
  #disposed = false;

  constructor(private readonly environment: HtmlMirrorSourceSessionEnvironment) {
    const sessionId = readHtmlMirrorPortSessionId(environment.port.name);
    if (!sessionId) throw new Error('Invalid HTML mirror Port.');
    this.#sessionId = sessionId;
    environment.port.onMessage.addListener(this.#onMessage);
    environment.port.onDisconnect.addListener(this.#onDisconnect);
  }

  dispose(disconnect = false): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.environment.port.onMessage.removeListener(this.#onMessage);
    this.environment.port.onDisconnect.removeListener(this.#onDisconnect);
    this.#observer?.disconnect();
    this.#observer = undefined;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = undefined;
    this.environment.window.removeEventListener('resize', this.#onLayoutChange);
    for (const root of this.#imageEventRoots) {
      root.removeEventListener('load', this.#onCapturedResourceLoad, true);
      root.removeEventListener('error', this.#onCapturedResourceError, true);
    }
    this.#imageEventRoots.clear();
    this.environment.document.fonts?.removeEventListener?.(
      'loadingdone',
      this.#onFontLoadingDone,
    );
    if (this.#frame !== undefined) this.environment.cancelFrame(this.#frame);
    this.#frame = undefined;
    if (this.#shadowDiscoveryTimer !== undefined) {
      this.environment.clearTimer(this.#shadowDiscoveryTimer);
    }
    this.#shadowDiscoveryTimer = undefined;
    this.#shadowHostCandidates = [];
    this.#knownShadowHostCandidates = new WeakSet<Element>();
    this.#shadowDiscoveryCursor = 0;
    this.#mirroredImageCandidates = [];
    this.#knownMirroredImageCandidates = new WeakSet<Element>();
    this.#selectedImageSources = new WeakMap<Element, string>();
    this.#imageRefreshRequested = false;
    this.#adoptedStyleSignatures = new WeakMap<object, string>();
    this.#clearPending();
    if (disconnect) {
      try {
        this.environment.port.disconnect();
      } catch {
        // The exact document may already be gone.
      }
    }
  }

  readonly #onMessage = (input: unknown): void => {
    if (this.#disposed) return;
    const message = readHtmlMirrorControllerMessage(
      input,
      this.#sessionId,
      this.#identity,
    );
    if (!message) {
      this.dispose(true);
      return;
    }
    if (message.kind === 'simul:html-mirror-v1:start') {
      if (this.#identity || message.identity.frameId !== 0) {
        this.dispose(true);
        return;
      }
      this.#start(message.identity);
      return;
    }
    if (!this.#identity) {
      this.dispose(true);
      return;
    }
    if (message.kind === 'simul:html-mirror-v1:ack') {
      if (
        message.identity.sequence < this.#acknowledged ||
        message.identity.sequence > this.#sequence
      ) {
        this.#post(createHtmlMirrorError(
          this.#identityAt(this.#sequence),
          'stream_gap',
        ));
        return;
      }
      this.#acknowledged = message.identity.sequence;
      if (
        this.#recoveryCheckpointSequence !== undefined &&
        message.identity.sequence >= this.#recoveryCheckpointSequence
      ) {
        this.#recoveryCheckpointSequence = undefined;
        if (this.#pendingOverflow) {
          this.#pendingOverflow = false;
          this.#post(createHtmlMirrorError(
            this.#identityAt(this.#sequence),
            'stream_overflow',
          ));
          return;
        }
        this.#paused = false;
        if (this.#shadowReconciliationPending) {
          this.#signalShadowReconciliation();
          return;
        }
        this.#scheduleFlush();
      }
      return;
    }
    if (
      message.identity.sequence < this.#acknowledged ||
      message.identity.sequence > this.#sequence
    ) {
      this.#post(createHtmlMirrorError(
        this.#identityAt(this.#sequence),
        'stream_gap',
      ));
      return;
    }
    this.#acknowledged = message.identity.sequence;
    this.#paused = true;
    this.#recoveryCheckpointSequence = this.#sequence;
    this.#pendingOverflow = false;
    if (this.#frame !== undefined) this.environment.cancelFrame(this.#frame);
    this.#frame = undefined;
    this.#clearPending();
    this.#postCheckpoint();
  };

  readonly #onDisconnect = (): void => this.dispose(false);

  #start(identity: ReplicaDocumentIdentity): void {
    if (this.environment.window.top !== this.environment.window) {
      this.#post(createHtmlMirrorError(identity, 'stream_failed'));
      this.dispose(true);
      return;
    }
    this.#identity = identity;
    try {
      this.#observer = this.environment.createMutationObserver(
        (records) => this.#onMutations(records),
      );
      this.#observer.observe(this.environment.document.documentElement, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      this.environment.window.addEventListener('resize', this.#onLayoutChange);
      this.#observeImageEvents(this.environment.document);
      this.environment.document.fonts?.addEventListener?.(
        'loadingdone',
        this.#onFontLoadingDone,
      );
      if (this.environment.createResizeObserver) {
        this.#resizeObserver = this.environment.createResizeObserver(
          () => this.#onLayoutChange(),
        );
        this.#resizeObserver.observe(this.environment.document.documentElement);
        if (this.environment.document.body) {
          this.#resizeObserver.observe(this.environment.document.body);
        }
      }
      // The extension must construct and validate its inert iframe before it
      // can consume live patches. Hold mutations behind the initial
      // checkpoint ACK so dynamic pages coalesce startup work instead of
      // overflowing the client's bounded pre-observer queue.
      this.#paused = true;
      this.#recoveryCheckpointSequence = this.#sequence;
      this.#postCheckpoint();
    } catch {
      this.#post(createHtmlMirrorError(identity, 'stream_failed'));
      this.dispose(true);
    }
  }

  #postCheckpoint(): void {
    const identity = this.#identity;
    if (!identity || this.#disposed) return;
    const startedAt = this.environment.now();
    try {
      const graph = sanitizeSourceDocument(
        this.environment.document,
        this.environment.window,
        this.environment.registry,
      );
      const checkpoint = graph && createHtmlMirrorCheckpoint(
        this.#identityAt(this.#sequence),
        {
          root: graph.root,
          adoptedStyleSheets: graph.adoptedStyleSheets,
          captureMs: Math.max(0, this.environment.now() - startedAt),
          viewportWidth: graph.viewportWidth,
          viewportHeight: graph.viewportHeight,
          documentWidth: graph.documentWidth,
          documentHeight: graph.documentHeight,
        },
      );
      if (!checkpoint) {
        this.#post(createHtmlMirrorError(
          this.#identityAt(this.#sequence),
          'privacy_rejected',
        ));
        return;
      }
      this.#mirroredNodes = new WeakSet<Node>();
      this.#shadowHostCandidates = [];
      this.#knownShadowHostCandidates = new WeakSet<Element>();
      this.#shadowDiscoveryCursor = 0;
      this.#mirroredImageCandidates = [];
      this.#knownMirroredImageCandidates = new WeakSet<Element>();
      this.#selectedImageSources = new WeakMap<Element, string>();
      this.#imageRefreshRequested = false;
      this.#adoptedStyleSignatures = new WeakMap<object, string>();
      this.#adoptedStyleSignatures.set(
        this.environment.document,
        adoptedStyleSignature(checkpoint.payload.adoptedStyleSheets),
      );
      this.#markMirroredGraph(checkpoint.payload.root);
      this.#observeOpenShadowRoots(this.environment.document.documentElement);
      this.#shadowReconciliationPending = false;
      this.#post(checkpoint);
      this.#scheduleShadowDiscovery();
    } catch {
      this.#post(createHtmlMirrorError(
        this.#identityAt(this.#sequence),
        'privacy_rejected',
      ));
    }
  }

  #onMutations(records: MutationRecord[]): void {
    if (this.#disposed || !this.#identity) return;
    let accepted = false;
    for (const record of records) {
      // The top-document observer must never turn a same-origin embedded
      // browsing context into an accidental second mirror surface. This is a
      // defensive boundary for synthetic/polyfilled observers as well as the
      // normal browser observer, which does not cross Document boundaries.
      if (!belongsToSourceDocument(record.target, this.environment.document)) {
        continue;
      }
      accepted = true;
      this.#observeOpenShadowRoots(record.target);
      if (record.type === 'childList') {
        this.#queuePending(this.#pendingChildren, record.target);
        for (const added of record.addedNodes) this.#observeOpenShadowRoots(added);
      } else if (record.type === 'attributes' && record.target instanceof Element) {
        this.#queuePending(this.#pendingAttributes, record.target);
        if (
          record.attributeName === 'role' ||
          record.attributeName === 'contenteditable'
        ) {
          // A children patch can re-sanitize a host's light DOM, but it cannot
          // replace that host's already-mirrored ShadowRoot. Rebuild the whole
          // graph whenever the host's privacy context can change.
          if (record.target.shadowRoot?.mode === 'open') {
            this.#shadowReconciliationPending = true;
            this.#signalShadowReconciliation();
            return;
          }
          this.#queuePending(this.#pendingChildren, record.target);
        }
      } else if (record.type === 'characterData' && record.target instanceof Text) {
        this.#queuePending(this.#pendingText, record.target);
      }
    }
    if (!accepted) return;
    this.#pendingDimensions = true;
    this.#scheduleFlush();
  }

  #flush(): void {
    if (this.#disposed || !this.#identity || this.#paused) return;
    if (
      this.#sequence - this.#acknowledged >=
      MAX_HTML_MIRROR_UNACKED_BATCHES
    ) {
      this.#paused = true;
      this.#post(createHtmlMirrorError(
        this.#identityAt(this.#sequence),
        'stream_overflow',
      ));
      return;
    }
    if (this.#imageRefreshRequested) {
      this.#imageRefreshRequested = false;
      this.#refreshChangedImageSources();
      if (this.#paused) return;
    }
    const childrenTargets = minimizeTargets(this.#pendingChildren);
    const covered = (node: Node): boolean =>
      childrenTargets.some((target) => target !== node && target.contains(node));
    const operations: HtmlMirrorPatchOperation[] = [];
    try {
      for (const target of childrenTargets) {
        if (!target.isConnected || !this.#mirroredNodes.has(target)) continue;
        const children = sanitizeSourceChildren(
          target,
          this.environment.registry,
          this.environment.document.baseURI,
        );
        if (!children) throw new Error('Unsafe children patch.');
        operations.push(Object.freeze({
          kind: 'children',
          nodeId: this.environment.registry.peekId(target) as number,
          children,
        }));
      }
      for (const target of this.#pendingAttributes) {
        if (
          !target.isConnected || covered(target) ||
          !this.#mirroredNodes.has(target)
        ) continue;
        const attributes = sanitizeSourceAttributes(
          target,
          this.environment.document.baseURI,
        );
        if (!attributes) throw new Error('Unsafe attributes patch.');
        const hints = sanitizeSourceElementHints(
          target,
          this.environment.document.baseURI,
        );
        if (target.localName.toLowerCase() === 'img') {
          this.#selectedImageSources.set(
            target,
            hints.selectedImageSource ?? '',
          );
        }
        operations.push(Object.freeze({
          kind: 'attributes',
          nodeId: this.environment.registry.peekId(target) as number,
          tagName: target.localName.toLowerCase(),
          attributes,
          ...hints,
        }));
      }
      for (const target of this.#pendingText) {
        if (
          !target.isConnected || covered(target) ||
          !this.#mirroredNodes.has(target)
        ) continue;
        const node = sanitizeSourceSubtree(
          target,
          this.environment.registry,
          this.environment.document.baseURI,
        );
        if (!node || node.kind !== 'text') throw new Error('Unsafe text patch.');
        operations.push(Object.freeze({
          kind: 'text',
          nodeId: node.id,
          node,
        }));
      }
      if (this.#pendingDimensions) {
        operations.push(Object.freeze({
          kind: 'dimensions',
          ...readSourceDimensions(this.environment.document, this.environment.window),
        }));
      }
      if (operations.length === 0) {
        this.#clearPending();
        return;
      }
      const sequence = this.#sequence + 1;
      const batch = createHtmlMirrorPatch(
        this.#identityAt(sequence),
        sequence,
        sequence,
        operations,
      );
      if (!batch) throw new Error('Invalid HTML mirror batch.');
      for (const operation of batch.operations) {
        if (operation.kind === 'children') {
          for (const child of operation.children) this.#markMirroredGraph(child);
        }
      }
      this.#clearPending();
      this.#sequence = sequence;
      this.#post(batch);
    } catch {
      this.#clearPending();
      this.#paused = true;
      this.#post(createHtmlMirrorError(
        this.#identityAt(this.#sequence),
        'privacy_rejected',
      ));
    }
  }

  #identityAt(sequence: number): ReplicaDocumentIdentity {
    const identity = this.#identity;
    if (!identity) throw new Error('HTML mirror session has no identity.');
    return createReplicaIdentity({
      sessionId: identity.sessionId,
      pageEpoch: identity.pageEpoch,
      generation: identity.generation,
      documentId: identity.documentId,
      frameId: identity.frameId,
      sequence,
    });
  }

  #post(message: unknown): void {
    if (this.#disposed) return;
    try {
      this.environment.port.postMessage(message);
    } catch {
      this.dispose(false);
    }
  }

  #clearPending(): void {
    this.#pendingChildren.clear();
    this.#pendingAttributes.clear();
    this.#pendingText.clear();
    this.#pendingDimensions = false;
  }

  readonly #onLayoutChange = (): void => {
    if (this.#disposed || !this.#identity) return;
    this.#observeOpenShadowRoots(this.environment.document.documentElement);
    this.#imageRefreshRequested = true;
    this.#pendingDimensions = true;
    this.#scheduleFlush();
  };

  readonly #onFontLoadingDone = (): void => this.#onLayoutChange();

  readonly #onCapturedResourceLoad = (event: Event): void => {
    this.#onLayoutChange();
    this.#queueCapturedImageAttributeRefresh(event);
  };

  readonly #onCapturedResourceError = (event: Event): void => {
    this.#onLayoutChange();
    this.#queueCapturedImageAttributeRefresh(event);
  };

  #scheduleFlush(): void {
    if (this.#paused || this.#frame !== undefined || this.#disposed) return;
    if (
      this.#pendingChildren.size === 0 &&
      this.#pendingAttributes.size === 0 &&
      this.#pendingText.size === 0 &&
      !this.#pendingDimensions
    ) return;
    this.#frame = this.environment.scheduleFrame(() => {
      this.#frame = undefined;
      this.#flush();
    });
  }

  #queuePending<T extends Node>(targets: Set<T>, target: T): void {
    if (this.#pendingOverflow) return;
    if (targets.has(target)) return;
    const size = this.#pendingChildren.size +
      this.#pendingAttributes.size + this.#pendingText.size;
    if (size >= MAX_HTML_MIRROR_PENDING_TARGETS) {
      this.#clearPending();
      this.#pendingOverflow = true;
      this.#paused = true;
      this.#post(createHtmlMirrorError(
        this.#identityAt(this.#sequence),
        'stream_overflow',
      ));
      return;
    }
    targets.add(target);
  }

  #markMirroredGraph(node: import('./html-mirror-sanitizer').HtmlMirrorNode): void {
    const source = this.environment.registry.getNode(node.id);
    if (source) {
      this.#mirroredNodes.add(source);
      if (source instanceof Element) {
        this.#registerShadowHostCandidate(source);
        if (node.kind === 'element' && node.tagName === 'img') {
          this.#registerMirroredImageCandidate(
            source,
            node.selectedImageSource ?? '',
          );
        }
      }
    }
    if (node.kind === 'text') return;
    if (node.shadowRoot) {
      const shadow = this.environment.registry.getNode(node.shadowRoot.id);
      if (shadow) {
        this.#mirroredNodes.add(shadow);
        this.#adoptedStyleSignatures.set(
          shadow,
          adoptedStyleSignature(node.shadowRoot.adoptedStyleSheets),
        );
      }
      for (const child of node.shadowRoot.children) this.#markMirroredGraph(child);
    }
    for (const child of node.children) this.#markMirroredGraph(child);
  }

  #registerShadowHostCandidate(element: Element): void {
    if (this.#knownShadowHostCandidates.has(element)) return;
    if (this.#shadowHostCandidates.length >= MAX_HTML_MIRROR_NODES) {
      this.#compactShadowHostCandidates();
    }
    if (this.#shadowHostCandidates.length >= MAX_HTML_MIRROR_NODES) return;
    this.#knownShadowHostCandidates.add(element);
    this.#shadowHostCandidates.push(element);
  }

  #registerMirroredImageCandidate(element: Element, selectedSource: string): void {
    this.#selectedImageSources.set(element, selectedSource);
    if (this.#knownMirroredImageCandidates.has(element)) return;
    if (
      this.#mirroredImageCandidates.length >= MAX_MIRRORED_IMAGE_CANDIDATES
    ) this.#compactMirroredImageCandidates();
    if (
      this.#mirroredImageCandidates.length >= MAX_MIRRORED_IMAGE_CANDIDATES
    ) return;
    this.#knownMirroredImageCandidates.add(element);
    this.#mirroredImageCandidates.push(element);
  }

  #compactMirroredImageCandidates(): void {
    const retained = this.#mirroredImageCandidates.filter(
      (element) => element.isConnected && this.#mirroredNodes.has(element),
    );
    this.#mirroredImageCandidates = retained;
    this.#knownMirroredImageCandidates = new WeakSet(retained);
  }

  #refreshChangedImageSources(): void {
    this.#compactMirroredImageCandidates();
    for (const image of this.#mirroredImageCandidates) {
      let selectedSource: string;
      try {
        selectedSource = sanitizeSourceElementHints(
          image,
          this.environment.document.baseURI,
        ).selectedImageSource ?? '';
      } catch {
        continue;
      }
      if (selectedSource === this.#selectedImageSources.get(image)) continue;
      this.#queuePending(this.#pendingAttributes, image);
      if (this.#pendingOverflow) return;
    }
  }

  #queueCapturedImageAttributeRefresh(event: Event): void {
    const target = event.target;
    if (
      !(target instanceof Element) ||
      target.localName.toLowerCase() !== 'img' ||
      !belongsToSourceDocument(target, this.environment.document) ||
      !target.isConnected ||
      !this.#mirroredNodes.has(target)
    ) return;
    this.#queuePending(this.#pendingAttributes, target);
    this.#pendingDimensions = true;
    this.#scheduleFlush();
  }

  #observeImageEvents(root: Document | ShadowRoot): void {
    if (this.#imageEventRoots.has(root)) return;
    if (this.#imageEventRoots.size >= MAX_IMAGE_EVENT_ROOTS) {
      this.#compactImageEventRoots();
    }
    if (this.#imageEventRoots.size >= MAX_IMAGE_EVENT_ROOTS) return;
    this.#imageEventRoots.add(root);
    root.addEventListener('load', this.#onCapturedResourceLoad, true);
    root.addEventListener('error', this.#onCapturedResourceError, true);
  }

  #compactImageEventRoots(): void {
    for (const root of this.#imageEventRoots) {
      if (root === this.environment.document || ('host' in root && root.host.isConnected)) {
        continue;
      }
      root.removeEventListener('load', this.#onCapturedResourceLoad, true);
      root.removeEventListener('error', this.#onCapturedResourceError, true);
      this.#imageEventRoots.delete(root);
    }
  }

  #compactShadowHostCandidates(): void {
    const retained = this.#shadowHostCandidates.filter(
      (element) => element.isConnected && this.#mirroredNodes.has(element),
    );
    this.#shadowHostCandidates = retained;
    this.#knownShadowHostCandidates = new WeakSet(retained);
    this.#shadowDiscoveryCursor = retained.length === 0
      ? 0
      : this.#shadowDiscoveryCursor % retained.length;
  }

  #scheduleShadowDiscovery(): void {
    if (this.#disposed || this.#shadowDiscoveryTimer !== undefined) return;
    this.#shadowDiscoveryTimer = this.environment.setTimer(() => {
      this.#shadowDiscoveryTimer = undefined;
      this.#discoverNewOpenShadowRoots();
      this.#scheduleShadowDiscovery();
    }, SHADOW_DISCOVERY_INTERVAL_MS);
  }

  #discoverNewOpenShadowRoots(): void {
    const candidateCount = this.#shadowHostCandidates.length;
    if (this.#shadowReconciliationPending) return;
    const documentWork = createHtmlMirrorStyleWorkBudget({
      maxSheets: MAX_STYLE_SHEETS_PER_TICK,
      maxRules: MAX_STYLE_RULES_PER_TICK,
      maxCharacters: MAX_STYLE_CHARACTERS_PER_TICK,
    });
    if (this.#adoptedStylesChanged(this.environment.document, documentWork)) {
      this.#shadowReconciliationPending = true;
      this.#signalShadowReconciliation();
      return;
    }
    if (candidateCount === 0) return;
    const styleWork = createHtmlMirrorStyleWorkBudget({
      maxSheets: MAX_STYLE_SHEETS_PER_TICK,
      maxRules: MAX_STYLE_RULES_PER_TICK,
      maxCharacters: MAX_STYLE_CHARACTERS_PER_TICK,
    });
    const scanCount = Math.min(candidateCount, MAX_SHADOW_HOSTS_PER_TICK);
    let processed = 0;
    for (let offset = 0; offset < scanCount; offset += 1) {
      const index = (this.#shadowDiscoveryCursor + offset) % candidateCount;
      const element = this.#shadowHostCandidates[index];
      if (!element?.isConnected || !this.#mirroredNodes.has(element)) {
        processed += 1;
        continue;
      }
      const shadow = element.shadowRoot;
      if (shadow?.mode === 'open') {
        this.#observeOpenShadowRoot(shadow);
        if (this.#shadowReconciliationPending) return;
        if (this.#adoptedStylesChanged(shadow, styleWork)) {
          this.#shadowReconciliationPending = true;
          this.#signalShadowReconciliation();
          return;
        }
        if (styleWork.exhausted) break;
      }
      processed += 1;
    }
    this.#shadowDiscoveryCursor =
      (this.#shadowDiscoveryCursor + processed) % candidateCount;
  }

  #adoptedStylesChanged(
    owner: Document | ShadowRoot,
    work: ReturnType<typeof createHtmlMirrorStyleWorkBudget>,
  ): boolean {
    const styles = sanitizeSourceAdoptedStyleSheets(
      owner,
      this.environment.document.baseURI,
      work,
    );
    if (!styles) return false;
    const signature = adoptedStyleSignature(styles);
    const previous = this.#adoptedStyleSignatures.get(owner);
    if (previous === undefined) {
      this.#adoptedStyleSignatures.set(owner, signature);
      return false;
    }
    return signature !== previous;
  }

  #observeOpenShadowRoots(root: Node): void {
    const directShadow = readOpenShadowRoot(root);
    if (directShadow) this.#observeOpenShadowRoot(directShadow);
    if (root.nodeType === Node.ELEMENT_NODE) {
      const element = root as Element;
      const shadow = element.shadowRoot;
      if (shadow && shadow.mode === 'open') this.#observeOpenShadowRoot(shadow);
      if (shadow) {
        for (const child of [...shadow.childNodes]) this.#observeOpenShadowRoots(child);
      }
    }
    for (const child of [...root.childNodes]) this.#observeOpenShadowRoots(child);
  }

  #observeOpenShadowRoot(shadow: ShadowRoot): void {
    this.#observeImageEvents(shadow);
    if (!this.#observedShadowRoots.has(shadow)) {
      this.#observedShadowRoots.add(shadow);
      this.#observer?.observe(shadow, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
    }
    if (!this.#mirroredNodes.has(shadow)) {
      this.#shadowReconciliationPending = true;
      this.#signalShadowReconciliation();
    }
  }

  #signalShadowReconciliation(): void {
    if (
      this.#disposed ||
      !this.#identity ||
      !this.#shadowReconciliationPending ||
      this.#paused
    ) return;
    this.#paused = true;
    if (this.#frame !== undefined) this.environment.cancelFrame(this.#frame);
    this.#frame = undefined;
    this.#clearPending();
    // A checkpoint is the bounded, already-validated reconciliation path for
    // adding a ShadowRoot to an existing host graph. The client requests it
    // after this recoverable signal and keeps the last-good replica visible.
    this.#post(createHtmlMirrorError(
      this.#identityAt(this.#sequence),
      'stream_gap',
    ));
  }
}

function readOpenShadowRoot(node: Node): ShadowRoot | undefined {
  if (node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return undefined;
  const candidate = node as ShadowRoot;
  return candidate.mode === 'open' && candidate.host?.nodeType === Node.ELEMENT_NODE
    ? candidate
    : undefined;
}

function adoptedStyleSignature(styles: readonly string[]): string {
  let fnv = 0x811c9dc5;
  let djb = 5381;
  let characters = 0;
  for (let sheetIndex = 0; sheetIndex < styles.length; sheetIndex += 1) {
    const cssText = styles[sheetIndex] as string;
    for (let index = 0; index < cssText.length; index += 1) {
      const code = cssText.charCodeAt(index);
      fnv = Math.imul(fnv ^ code, 0x01000193) >>> 0;
      djb = (Math.imul(djb, 33) ^ code) >>> 0;
    }
    characters += cssText.length;
    fnv = Math.imul(fnv ^ (sheetIndex + 1), 0x01000193) >>> 0;
    djb = (Math.imul(djb, 33) ^ (sheetIndex + 1)) >>> 0;
  }
  return `${styles.length}:${characters}:${fnv}:${djb}`;
}

function minimizeTargets(targets: Set<Node>): Node[] {
  const connected = [...targets].filter((node) => node.isConnected);
  return connected.filter(
    (candidate) => !connected.some(
      (other) => other !== candidate && other.contains(candidate),
    ),
  );
}

function belongsToSourceDocument(node: Node, sourceDocument: Document): boolean {
  return node === sourceDocument || node.ownerDocument === sourceDocument;
}

function readSourceDimensions(document: Document, window: Window): {
  viewportWidth: number;
  viewportHeight: number;
  documentWidth: number;
  documentHeight: number;
} {
  const html = document.documentElement;
  const body = document.body;
  const viewportWidth = Math.max(1, Math.round(window.innerWidth || html?.clientWidth || 1));
  const viewportHeight = Math.max(1, Math.round(window.innerHeight || html?.clientHeight || 1));
  return {
    viewportWidth,
    viewportHeight,
    documentWidth: Math.max(
      viewportWidth,
      html?.scrollWidth ?? 0,
      body?.scrollWidth ?? 0,
    ),
    documentHeight: Math.max(
      viewportHeight,
      html?.scrollHeight ?? 0,
      body?.scrollHeight ?? 0,
    ),
  };
}

// Kept in the emitted bundle as an artifact marker even after minification.
export const HTML_MIRROR_RUNTIME_MARKER = HTML_MIRROR_PORT_PREFIX;
