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
  createHtmlMirrorScrollUpdate,
  readHtmlMirrorControllerMessage,
  readHtmlMirrorPortSessionId,
  type HtmlMirrorReconcileChild,
  type HtmlMirrorPatchOperation,
} from './html-mirror-protocol';
import {
  isDocumentScrollTarget,
  nestedScrollerOrdinal,
  readDocumentScrollSnapshot,
  readNestedScrollSnapshot,
} from '../primary-scroll';
import {
  MAX_HTML_MIRROR_STRING,
  MAX_HTML_MIRROR_NODES,
  MAX_HTML_MIRROR_DIAGNOSTIC_COUNT,
  HtmlMirrorCapacityError,
  createHtmlMirrorReadBudget,
  createHtmlMirrorRepresentabilityCollector,
  createHtmlMirrorStyleWorkBudget,
  isSourceSelectVisuallyHidden,
  readSourceSelectPresentationStyle,
  sanitizeSourceAdoptedStyleSheets,
  sanitizeSourceAttributes,
  sanitizeSourceChildren,
  sanitizeSourceDocument,
  sanitizeSourceElementHints,
  sanitizeSourceSubtree,
  sanitizeSourceSubtrees,
  snapshotHtmlMirrorRepresentability,
  type HtmlMirrorIdRegistry,
  type HtmlMirrorElementNode,
  type HtmlMirrorNamespace,
  type HtmlMirrorRepresentabilityCollector,
  type HtmlMirrorRepresentabilitySummary,
  type HtmlMirrorStyleWorkBudget,
} from './html-mirror-sanitizer';
import { createReplicaIdentity } from './replica-identity';
import { minimizeConnectedComposedTargets } from './composed-targets';
import { readSemanticSourcePortIdentity } from './semantic-source-protocol';
import {
  SemanticSourceSession,
  eagerlyClassifySourceDocumentSecrets,
  rememberSourceMutationSecrets,
} from './semantic-source-session';
import {
  sourceDocumentSecretClassifier,
  type StickySourceSecretClassifier,
} from './source-secret-classifier';
import {
  createSourceControlledContentPolicy,
  hasSourceCredentialSecretAncestor,
  sourceControlledContentBoundaryChanged,
  sourceControlledContentChangedTargets,
  sourceControlledContentLayoutMayChange,
  sourceControlledContentMutationsMayChange,
  type SourceControlledContentPolicy,
} from './source-privacy-policy';
import {
  SourceVisibilityBoundaryIndex,
  type SourceVisibilityBoundaryRefresh,
} from './source-visibility-boundary';
import type { SelectableReplicaFidelityPolicy } from './fidelity-policy';
import { StableSignatureTracker } from './stable-signature-tracker';
import { sourceMutationMayChangeCurrentValue } from './source-mutation-filter';

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
        throw new HtmlMirrorCapacityError();
      }
    }
    const id = this.#nextId++;
    if (!Number.isSafeInteger(id)) throw new HtmlMirrorCapacityError();
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
    __simulHtmlMirrorV2Installed?: boolean;
    __simulHtmlMirrorV2SecretObserver?: Pick<
      MutationObserver,
      'disconnect'
    >;
    __simulHtmlMirrorV1SecretObserver?: Pick<MutationObserver, 'disconnect'>;
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

/** Installs a page-owned HTML and image identity bridge. */
export function installHtmlMirrorSourceBridge(
  environment: HtmlMirrorSourceBridgeEnvironment = {},
): void {
  const isolatedGlobal = (environment.global ?? globalThis) as typeof globalThis & {
    __simulHtmlMirrorV2Installed?: boolean;
    __simulHtmlMirrorV2SecretObserver?: Pick<
      MutationObserver,
      'disconnect'
    >;
    __simulHtmlMirrorV1SecretObserver?: Pick<MutationObserver, 'disconnect'>;
  };
  if (isolatedGlobal.__simulHtmlMirrorV2Installed) return;
  isolatedGlobal.__simulHtmlMirrorV2Installed = true;
  isolatedGlobal.__simulHtmlMirrorV1SecretObserver?.disconnect();
  const runtime = environment.runtime ?? browser.runtime;
  const sourceDocument = environment.document ?? document;
  const sourceWindow = environment.window ?? window;
  const registry = environment.registry ?? new WeakNodeIdRegistry();
  const documentSecretClassifier = sourceDocumentSecretClassifier(sourceDocument);
  eagerlyClassifySourceDocumentSecrets(
    sourceDocument,
    sourceWindow,
    documentSecretClassifier,
  );
  try {
    const createSecretObserver = environment.createMutationObserver ??
      ((callback: MutationCallback) => new MutationObserver(callback));
    const secretObserver = createSecretObserver((records) => {
      rememberSourceMutationSecrets(
        records,
        sourceWindow,
        documentSecretClassifier,
      );
    });
    secretObserver.observe(sourceDocument, {
      attributes: true,
      attributeOldValue: true,
      characterData: true,
      characterDataOldValue: true,
      childList: true,
      subtree: true,
    });
    // Keep the observer alive for the isolated-world document lifetime so
    // newly created credential nodes remain sticky before and between mirror
    // Port connections.
    isolatedGlobal.__simulHtmlMirrorV2SecretObserver = secretObserver;
  } catch {
    const root = sourceDocument.documentElement;
    if (root) {
      documentSecretClassifier.classify(root, {
        tagName: root.localName,
        secretAncestor: true,
      });
    }
  }

  runtime.onConnect.addListener((port) => {
    if (readHtmlMirrorPortSessionId(port.name)) {
      new HtmlMirrorSourceSession({
        port,
        document: sourceDocument,
        window: sourceWindow,
        registry,
        secretClassifier: documentSecretClassifier,
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
    if (readImageSourcePortSessionId(port.name, 'isolated-html')) {
      new ImageSourceSession({
        port,
        document: sourceDocument,
        window: sourceWindow,
        resolveNode: (nodeId) => registry.getNode(nodeId) ?? null,
        getNodeId: (image) => registry.getId(image),
        createObserver: (observerEnvironment) =>
          new SourceImageObserver(observerEnvironment),
        secretClassifier: documentSecretClassifier,
      });
      return;
    }
    if (!readSemanticSourcePortIdentity(port.name, 'isolated-html')) return;
    new SemanticSourceSession({
      port,
      document: sourceDocument,
      window: sourceWindow,
      bridge: 'isolated-html',
      secretClassifier: documentSecretClassifier,
      getNodeId: (node) => registry.getId(node),
      createMutationObserver: environment.createMutationObserver,
      schedule: (callback) => queueMicrotask(callback),
    });
  });
}

interface HtmlMirrorSourceSessionEnvironment {
  readonly port: Browser.runtime.Port;
  readonly document: Document;
  readonly window: Window;
  readonly registry: WeakNodeIdRegistry;
  readonly secretClassifier?: StickySourceSecretClassifier;
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

/**
 * One bounded open-shadow-root observation pass. A mutation batch shares a
 * single walk across its records so nested targets are traversed once, and
 * the node budget keeps a hostile page from stalling the observer callback.
 */
interface ShadowObservationWalk {
  readonly visited: WeakSet<Node>;
  remaining: number;
  exhausted: boolean;
}

const MAX_HTML_MIRROR_PENDING_TARGETS = 4_000;
const SHADOW_DISCOVERY_INTERVAL_MS = 500;
const MAX_SHADOW_HOSTS_PER_TICK = 1_000;
const MAX_SHADOW_OBSERVATION_NODES = 20_000;
const MAX_STYLE_SHEETS_PER_TICK = 512;
const MAX_STYLE_RULES_PER_TICK = 25_000;
const MAX_STYLE_CHARACTERS_PER_TICK = 1024 * 1024;
const STYLE_CHANGE_STABILITY_OBSERVATIONS = 3;
const OVERSIZED_STYLE_RETRY_PASSES = 120;
const MAX_MIRRORED_IMAGE_CANDIDATES = 4_000;
const MAX_IMAGE_EVENT_ROOTS = 4_000;
const MAX_VISIBILITY_MUTATION_RECORDS = 2_048;
const CONTROLLED_LAYOUT_SETTLE_EVENTS = Object.freeze([
  'transitionend',
  'transitioncancel',
  'animationend',
  'animationcancel',
] as const);
const VISIBILITY_INTERACTION_EVENTS = Object.freeze([
  'pointerover',
  'pointerout',
  'pointerdown',
  'pointerup',
  'click',
  'focusin',
  'focusout',
  'keydown',
  'keyup',
  'beforeinput',
  'input',
  'change',
  'beforetoggle',
  'toggle',
] as const);

type ReconciliationDecision =
  | 'reconcile'
  | 'missingReconciliationProofFallbackCount'
  | 'coveredDirtyBranchFallbackCount'
  | 'attributeContextFallbackCount'
  | 'crossParentFallbackCount';

type StylePollResult = 'changed' | 'unchanged' | 'capacity';
type StylePollChannel = 'ordinary' | 'adopted';

function oppositeStylePollChannel(
  channel: StylePollChannel,
): StylePollChannel {
  return channel === 'ordinary' ? 'adopted' : 'ordinary';
}

function stylePollChannelMask(channel: StylePollChannel): number {
  return channel === 'ordinary' ? 1 : 2;
}

export class HtmlMirrorSourceSession {
  readonly #sessionId: string;
  #identity: ReplicaDocumentIdentity | undefined;
  #fidelityPolicy: SelectableReplicaFidelityPolicy | undefined;
  #observer: Pick<MutationObserver, 'observe' | 'disconnect'> | undefined;
  #resizeObserver: Pick<ResizeObserver, 'observe' | 'disconnect'> | undefined;
  #pendingChildren = new Set<Node>();
  #pendingAttributes = new Set<Element>();
  #pendingText = new Set<Text>();
  #pendingDimensions = false;
  #lastDimensions: ReturnType<typeof readSourceDimensions> | undefined;
  #pendingOverflow = false;
  #mirroredNodes = new WeakSet<Node>();
  #mirroredOpaqueSecrets = new WeakSet<Element>();
  #emittedChildren = new WeakMap<Node, readonly Node[]>();
  #emittedParent = new WeakMap<Node, Node>();
  #emittedNodeSignatures = new WeakMap<Node, string>();
  #mirroredImageCandidates: Element[] = [];
  #knownMirroredImageCandidates = new WeakSet<Element>();
  #selectedImageSources = new WeakMap<Element, string>();
  #imageRefreshRequested = false;
  readonly #imageEventRoots = new Set<Document | ShadowRoot>();
  readonly #observedShadowRoots = new WeakSet<ShadowRoot>();
  #shadowHostCandidates: Element[] = [];
  #knownShadowHostCandidates = new WeakSet<Element>();
  #settledShadowHostCandidates = new WeakSet<Element>();
  #shadowDiscoveryCursor = 0;
  #shadowObservationOmissionCount = 0;
  #shadowObservationVisitCount = 0;
  #stylePollingCursor = 0;
  #stylePollingPass = 0;
  #stylePollingPhases = new WeakMap<object, StylePollChannel>();
  #styleCapacityChannels = new WeakMap<object, number>();
  #styleCapacityRetryPasses = new WeakMap<object, readonly [number, number]>();
  readonly #adoptedStyleSignatures = new StableSignatureTracker(
    STYLE_CHANGE_STABILITY_OBSERVATIONS,
  );
  readonly #ordinaryStyleSignatures = new StableSignatureTracker(
    STYLE_CHANGE_STABILITY_OBSERVATIONS,
  );
  #shadowDiscoveryTimer: unknown;
  #frame: unknown;
  #scrollFrame: unknown;
  #activeNestedScroller: Element | undefined;
  #pendingNestedScroller: Element | undefined;
  #nestedOwnerKeys = new WeakMap<Element, number>();
  #nestedOwnerOrdinals = new WeakMap<Element, number>();
  #nextNestedOwnerKey = 1;
  #pendingDocumentScroll = false;
  #lastDocumentScroll:
    ReturnType<typeof readDocumentScrollSnapshot> | undefined;
  #sequence = 0;
  #acknowledged = 0;
  #paused = false;
  #recoveryCheckpointSequence: number | undefined;
  #shadowReconciliationPending = false;
  #controlledContentPolicy: SourceControlledContentPolicy | undefined;
  #controlledLayoutSettlePending = false;
  #visibilityBoundaryIndex: SourceVisibilityBoundaryIndex | undefined;
  #visibilityMutationRecords: MutationRecord[] = [];
  #visibilityMutationOverflow = false;
  #visibilityInteractionTargets = new Set<Element>();
  #visibilityFullRefreshPending = false;
  #disposed = false;

  constructor(private readonly environment: HtmlMirrorSourceSessionEnvironment) {
    const sessionId = readHtmlMirrorPortSessionId(environment.port.name);
    if (!sessionId) throw new Error('Invalid HTML mirror Port.');
    this.#sessionId = sessionId;
    environment.port.onMessage.addListener(this.#onMessage);
    environment.port.onDisconnect.addListener(this.#onDisconnect);
  }

  /**
   * Nodes visited by open-shadow-root observation walks since construction.
   * A content-free traversal counter for tests and diagnostics.
   */
  get shadowObservationVisitCount(): number {
    return this.#shadowObservationVisitCount;
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
    this.environment.window.removeEventListener('scroll', this.#onScroll, true);
    this.environment.window.removeEventListener(
      'hashchange',
      this.#onLayoutChange,
    );
    for (const type of CONTROLLED_LAYOUT_SETTLE_EVENTS) {
      this.environment.document.removeEventListener(
        type,
        this.#onControlledLayoutSettle,
        true,
      );
    }
    for (const type of VISIBILITY_INTERACTION_EVENTS) {
      this.environment.document.removeEventListener(
        type,
        this.#onVisibilityInteraction,
        true,
      );
    }
    for (const root of this.#imageEventRoots) {
      root.removeEventListener('load', this.#onCapturedResourceLoad, true);
      root.removeEventListener('error', this.#onCapturedResourceError, true);
      root.removeEventListener('scroll', this.#onScroll, true);
    }
    this.#imageEventRoots.clear();
    this.environment.document.fonts?.removeEventListener?.(
      'loadingdone',
      this.#onFontLoadingDone,
    );
    if (this.#frame !== undefined) this.environment.cancelFrame(this.#frame);
    this.#frame = undefined;
    if (this.#scrollFrame !== undefined) {
      this.environment.cancelFrame(this.#scrollFrame);
    }
    this.#scrollFrame = undefined;
    if (this.#shadowDiscoveryTimer !== undefined) {
      this.environment.clearTimer(this.#shadowDiscoveryTimer);
    }
    this.#shadowDiscoveryTimer = undefined;
    this.#shadowHostCandidates = [];
    this.#knownShadowHostCandidates = new WeakSet<Element>();
    this.#settledShadowHostCandidates = new WeakSet<Element>();
    this.#shadowDiscoveryCursor = 0;
    this.#stylePollingCursor = 0;
    this.#stylePollingPass = 0;
    this.#stylePollingPhases = new WeakMap<object, StylePollChannel>();
    this.#styleCapacityChannels = new WeakMap<object, number>();
    this.#styleCapacityRetryPasses = new WeakMap<
      object,
      readonly [number, number]
    >();
    this.#mirroredImageCandidates = [];
    this.#knownMirroredImageCandidates = new WeakSet<Element>();
    this.#selectedImageSources = new WeakMap<Element, string>();
    this.#imageRefreshRequested = false;
    this.#activeNestedScroller = undefined;
    this.#pendingNestedScroller = undefined;
    this.#nestedOwnerKeys = new WeakMap<Element, number>();
    this.#nestedOwnerOrdinals = new WeakMap<Element, number>();
    this.#pendingDocumentScroll = false;
    this.#lastDocumentScroll = undefined;
    this.#lastDimensions = undefined;
    this.#emittedNodeSignatures = new WeakMap<Node, string>();
    this.#adoptedStyleSignatures.reset();
    this.#ordinaryStyleSignatures.reset();
    this.#controlledContentPolicy = undefined;
    this.#controlledLayoutSettlePending = false;
    this.#visibilityBoundaryIndex?.dispose();
    this.#visibilityBoundaryIndex = undefined;
    this.#visibilityMutationRecords = [];
    this.#visibilityMutationOverflow = false;
    this.#visibilityInteractionTargets.clear();
    this.#visibilityFullRefreshPending = false;
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
    if (message.kind === 'simul:html-mirror-v2:start') {
      if (this.#identity || message.identity.frameId !== 0) {
        this.dispose(true);
        return;
      }
      this.#start(message.identity, message.fidelityPolicy);
      return;
    }
    if (!this.#identity) {
      this.dispose(true);
      return;
    }
    if (message.kind === 'simul:html-mirror-v2:ack') {
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

  #start(
    identity: ReplicaDocumentIdentity,
    fidelityPolicy: SelectableReplicaFidelityPolicy,
  ): void {
    if (this.environment.window.top !== this.environment.window) {
      this.#post(createHtmlMirrorError(identity, 'stream_failed'));
      this.dispose(true);
      return;
    }
    this.#identity = identity;
    this.#fidelityPolicy = fidelityPolicy;
    try {
      this.#observer = this.environment.createMutationObserver(
        (records) => this.#onMutations(records),
      );
      this.#observer.observe(this.environment.document.documentElement, {
        attributes: true,
        attributeOldValue: true,
        characterData: true,
        characterDataOldValue: true,
        childList: true,
        subtree: true,
      });
      this.environment.window.addEventListener('resize', this.#onLayoutChange);
      this.environment.window.addEventListener('scroll', this.#onScroll, {
        capture: true,
        passive: true,
      });
      this.environment.window.addEventListener(
        'hashchange',
        this.#onLayoutChange,
      );
      for (const type of CONTROLLED_LAYOUT_SETTLE_EVENTS) {
        this.environment.document.addEventListener(
          type,
          this.#onControlledLayoutSettle,
          true,
        );
      }
      for (const type of VISIBILITY_INTERACTION_EVENTS) {
        this.environment.document.addEventListener(
          type,
          this.#onVisibilityInteraction,
          true,
        );
      }
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
    const fidelityPolicy = this.#fidelityPolicy;
    if (!identity || !fidelityPolicy || this.#disposed) return;
    const startedAt = this.environment.now();
    const representability = createHtmlMirrorRepresentabilityCollector();
    try {
      const controlledContentPolicy = createSourceControlledContentPolicy(
        this.environment.document,
        this.environment.window,
        MAX_HTML_MIRROR_NODES,
      );
      const graph = sanitizeSourceDocument(
        this.environment.document,
        this.environment.window,
        this.environment.registry,
        representability,
        fidelityPolicy,
        controlledContentPolicy,
      );
      const checkpoint = graph && createHtmlMirrorCheckpoint(
        this.#identityAt(this.#sequence),
        {
          root: graph.root,
          adoptedStyleSheets: graph.adoptedStyleSheets,
          documentMode: graph.documentMode,
          captureMs: Math.max(0, this.environment.now() - startedAt),
          viewportWidth: graph.viewportWidth,
          viewportHeight: graph.viewportHeight,
          documentWidth: graph.documentWidth,
          documentHeight: graph.documentHeight,
          representability: this.#summarizeRepresentability(representability),
        },
        fidelityPolicy,
      );
      if (!checkpoint) {
        if (graph && representability.capacityOmissionCount === 0) {
          incrementSourceRepresentability(
            representability,
            'capacityOmissionCount',
          );
        }
        this.#post(createHtmlMirrorError(
          this.#identityAt(this.#sequence),
          representability.capacityOmissionCount > 0
            ? 'stream_overflow'
            : 'privacy_rejected',
          snapshotHtmlMirrorRepresentability(representability),
        ));
        return;
      }
      this.#mirroredNodes = new WeakSet<Node>();
      this.#mirroredOpaqueSecrets = new WeakSet<Element>();
      this.#emittedChildren = new WeakMap<Node, readonly Node[]>();
      this.#emittedParent = new WeakMap<Node, Node>();
      this.#emittedNodeSignatures = new WeakMap<Node, string>();
      this.#shadowHostCandidates = [];
      this.#knownShadowHostCandidates = new WeakSet<Element>();
      this.#shadowDiscoveryCursor = 0;
      this.#stylePollingCursor = 0;
      this.#mirroredImageCandidates = [];
      this.#knownMirroredImageCandidates = new WeakSet<Element>();
      this.#selectedImageSources = new WeakMap<Element, string>();
      this.#imageRefreshRequested = false;
      this.#adoptedStyleSignatures.reset();
      this.#adoptedStyleSignatures.prime(
        this.environment.document,
        adoptedStyleSignature(checkpoint.payload.adoptedStyleSheets),
      );
      this.#ordinaryStyleSignatures.reset();
      this.#controlledContentPolicy = controlledContentPolicy;
      this.#visibilityBoundaryIndex?.dispose();
      this.#visibilityBoundaryIndex = new SourceVisibilityBoundaryIndex(
        this.environment.document,
        this.environment.window,
        MAX_HTML_MIRROR_NODES,
      );
      this.#markMirroredGraph(checkpoint.payload.root);
      this.#lastDimensions = Object.freeze({
        viewportWidth: checkpoint.payload.viewportWidth,
        viewportHeight: checkpoint.payload.viewportHeight,
        documentWidth: checkpoint.payload.documentWidth,
        documentHeight: checkpoint.payload.documentHeight,
        ...(checkpoint.payload.root.canvasBackgroundColor
          ? { canvasBackgroundColor: checkpoint.payload.root.canvasBackgroundColor }
          : {}),
      });
      this.#observeOpenShadowRoots(this.environment.document.documentElement);
      this.#primeOrdinaryStyleSignatures();
      this.#shadowReconciliationPending = false;
      this.#post(checkpoint);
      this.#postScroll();
      this.#scheduleShadowDiscovery();
    } catch (error) {
      if (
        error instanceof HtmlMirrorCapacityError &&
        !error.diagnosticRecorded
      ) {
        incrementSourceRepresentability(
          representability,
          'capacityOmissionCount',
        );
      }
      this.#post(createHtmlMirrorError(
        this.#identityAt(this.#sequence),
        representability.capacityOmissionCount > 0
          ? 'stream_overflow'
          : 'privacy_rejected',
        snapshotHtmlMirrorRepresentability(representability),
      ));
    }
  }

  #onMutations(records: MutationRecord[]): void {
    if (this.#disposed || !this.#identity) return;
    try {
      this.#queueMutationRecords(records);
    } catch {
      // An exception here used to drop the whole batch silently, after which
      // the replica drifted with no diagnostic. Reuse the bounded checkpoint
      // reconciliation signal: the receiver requests a fresh checkpoint and
      // the stream stays paused until that checkpoint is acknowledged.
      this.#shadowReconciliationPending = true;
      this.#signalShadowReconciliation();
    }
  }

  #queueMutationRecords(records: MutationRecord[]): void {
    rememberSourceMutationSecrets(
      records,
      this.environment.window,
      this.environment.secretClassifier ?? sourceDocumentSecretClassifier(
        this.environment.document,
      ),
    );
    // Native observers can report an attribute/character assignment whose
    // final value is exactly its old value. Keep the sticky secret ledger
    // above authoritative, then discard only these provable DOM no-ops before
    // they consume the bounded pending-target budget and force recovery.
    if (!records.every(sourceMutationMayChangeCurrentValue)) {
      records = records.filter(sourceMutationMayChangeCurrentValue);
    }
    if (records.length === 0) return;
    if (records.length > 0) {
      this.#nestedOwnerOrdinals = new WeakMap<Element, number>();
    }
    let accepted = false;
    let visibilityQueued = false;
    const visibilityRecords = this.#visibilityBoundaryIndex
      ? records.filter((record) =>
          belongsToSourceDocument(record.target, this.environment.document)
        )
      : [];
    if (this.#visibilityBoundaryIndex && visibilityRecords.length > 0) {
      visibilityQueued = true;
      if (
        this.#visibilityMutationOverflow ||
        this.#visibilityMutationRecords.length + visibilityRecords.length >
          MAX_VISIBILITY_MUTATION_RECORDS
      ) {
        this.#visibilityMutationRecords = [];
        this.#visibilityMutationOverflow = true;
      } else {
        this.#visibilityMutationRecords.push(...visibilityRecords);
      }
    }
    if (this.#controlledContentPolicy &&
      sourceControlledContentMutationsMayChange(
        records,
        this.#controlledContentPolicy,
      )) {
      accepted = this.#refreshControlledContentPolicy() || accepted;
    }
    // One bounded walk per batch: nested records share the visited set so a
    // descendant subtree is not traversed again for each ancestor record.
    const walk = this.#createShadowObservationWalk();
    for (const record of records) {
      // The top-document observer must never turn a same-origin embedded
      // browsing context into an accidental second mirror surface. This is a
      // defensive boundary for synthetic/polyfilled observers as well as the
      // normal browser observer, which does not cross Document boundaries.
      if (!belongsToSourceDocument(record.target, this.environment.document)) {
        continue;
      }
      const mutationElement = sourceMutationOwnerElement(record.target);
      if (
        mutationElement &&
        hasSourceCredentialSecretAncestor(
          mutationElement,
          this.environment.secretClassifier ?? sourceDocumentSecretClassifier(
            this.environment.document,
          ),
          this.environment.window,
        )
      ) {
        // A public graph node cannot be converted into the canonical opaque
        // shell by a patch: the shell deliberately has a new extension-owned
        // tag and no authored attributes, descendants, or presentation hints.
        // Rebuild once, then ignore every later mutation under that shell for
        // the rest of this document lifetime.
        if (
          this.#mirroredNodes.has(mutationElement) &&
          !this.#mirroredOpaqueSecrets.has(mutationElement)
        ) {
          this.#shadowReconciliationPending = true;
          this.#signalShadowReconciliation();
          return;
        }
        continue;
      }
      const structuralSelectOwner = sourceNativeSelectStructuralOwner(record.target);
      if (record.type === 'childList') {
        accepted = true;
        this.#observeOpenShadowRoots(record.target, walk);
        this.#queuePending(this.#pendingChildren, record.target);
        for (const added of record.addedNodes) {
          this.#observeOpenShadowRoots(added, walk);
        }
      } else if (record.type === 'attributes' && record.target instanceof Element) {
        accepted = true;
        this.#observeOpenShadowRoots(record.target, walk);
        const changesPrivacyContext =
          record.attributeName === 'role' ||
          record.attributeName === 'contenteditable' ||
          record.attributeName === 'type' ||
          record.attributeName === 'autocomplete';
        if (changesPrivacyContext && structuralSelectOwner) {
          // Public/private transitions replace select grammar and state in one
          // root-level batch so an old public label cannot survive recovery.
          this.#queuePending(this.#pendingChildren, structuralSelectOwner);
          this.#queuePending(this.#pendingAttributes, structuralSelectOwner);
        } else {
          this.#queuePending(
            this.#pendingAttributes,
            record.target,
          );
        }
        if (changesPrivacyContext) {
          // A children patch can re-sanitize a host's light DOM, but it cannot
          // replace that host's already-mirrored ShadowRoot. Rebuild the whole
          // graph whenever the host's privacy context can change.
          if (record.target.shadowRoot?.mode === 'open') {
            this.#shadowReconciliationPending = true;
            this.#signalShadowReconciliation();
            return;
          }
          if (!structuralSelectOwner) {
            this.#queuePending(this.#pendingChildren, record.target);
          }
        }
      } else if (record.type === 'characterData' && record.target instanceof Text) {
        accepted = true;
        this.#observeOpenShadowRoots(record.target, walk);
        this.#queuePending(this.#pendingText, record.target);
      }
    }
    if (!accepted && !visibilityQueued) return;
    if (accepted) this.#pendingDimensions = true;
    this.#scheduleFlush();
  }

  #flush(): void {
    const fidelityPolicy = this.#fidelityPolicy;
    if (
      this.#disposed || !this.#identity || !fidelityPolicy || this.#paused
    ) return;
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
    if (this.#controlledLayoutSettlePending) {
      this.#controlledLayoutSettlePending = false;
      this.#refreshControlledContentPolicy();
      if (this.#paused || this.#shadowReconciliationPending) return;
    }
    if (this.#visibilityBoundaryIndex) {
      const mutationRecords = this.#visibilityMutationRecords;
      const requiresFullRefresh = this.#visibilityFullRefreshPending ||
        this.#visibilityMutationOverflow ||
        this.#visibilityInteractionTargets.size > 0;
      const visibilityRefresh = requiresFullRefresh
        ? this.#visibilityBoundaryIndex.refreshAll()
        : mutationRecords.length > 0
          ? this.#visibilityBoundaryIndex.refreshMutations(mutationRecords)
          : this.#visibilityBoundaryIndex.refreshInteractionTargets([]);
      this.#visibilityMutationRecords = [];
      this.#visibilityMutationOverflow = false;
      this.#visibilityFullRefreshPending = false;
      this.#visibilityInteractionTargets.clear();
      this.#applyVisibilityBoundaryRefresh(visibilityRefresh);
      if (this.#paused || this.#shadowReconciliationPending) return;
    }
    if (this.#imageRefreshRequested) {
      this.#imageRefreshRequested = false;
      this.#refreshChangedImageSources();
      if (this.#paused) return;
    }
    if ([...this.#pendingChildren].some(
      (target) => this.#coversOwnOpenShadowWork(target),
    )) {
      this.#shadowReconciliationPending = true;
      this.#signalShadowReconciliation();
      return;
    }
    const childrenTargets = minimizeConnectedComposedTargets(
      this.#pendingChildren,
    );
    const covered = (node: Node): boolean =>
      childrenTargets.some(
        (target) => target !== node && containsComposedSource(target, node),
      );
    const operations: HtmlMirrorPatchOperation[] = [];
    const representability = createHtmlMirrorRepresentabilityCollector();
    const batchBudget = createHtmlMirrorReadBudget();
    const styleWork = createHtmlMirrorStyleWorkBudget();
    try {
      const childCaptures: Array<{
        readonly target: Node;
        readonly nodeId: number;
        readonly sources: readonly Node[];
        readonly previous: readonly Node[];
        readonly reconciliation: ReconciliationDecision;
      }> = [];
      for (const target of childrenTargets) {
        if (!target.isConnected || !this.#mirroredNodes.has(target)) continue;
        const sources = Object.freeze([...target.childNodes]);
        childCaptures.push({
          target,
          nodeId: this.environment.registry.peekId(target) as number,
          sources,
          previous: this.#emittedChildren.get(target) ?? [],
          reconciliation: this.#reconciliationDecision(target, sources),
        });
      }
      // Cross-parent churn and covered descendant changes are intentionally
      // kept on the conservative replacement path for the whole structural
      // batch. This prevents a mixed batch from accidentally treating a move
      // as same-parent identity retention.
      for (const { reconciliation } of childCaptures) {
        if (reconciliation === 'reconcile') continue;
        incrementSourceRepresentability(representability, reconciliation);
      }
      const useReconciliation = childCaptures.every(
        ({ reconciliation }) => reconciliation === 'reconcile',
      );
      if (!useReconciliation) {
        for (const capture of childCaptures) {
          const children = sanitizeSourceChildren(
            capture.target,
            this.environment.registry,
            this.environment.document.baseURI,
            representability,
            fidelityPolicy,
            batchBudget,
            styleWork,
            this.#controlledContentPolicy,
          );
          if (!children) throw new Error('Unsafe children patch.');
          const sources = children.map(
            (child) => this.environment.registry.getNode(child.id),
          );
          if (sources.some(
            (source) => !source || source.parentNode !== capture.target,
          )) throw new Error('Unstable children patch.');
          operations.push(Object.freeze({
            kind: 'children',
            nodeId: capture.nodeId,
            children,
          }));
        }
      } else {
        for (const capture of childCaptures) {
          const previous = new Set(capture.previous);
          const newSources = capture.sources.filter(
            (source) => !previous.has(source),
          );
          const serialized = sanitizeSourceSubtrees(
            newSources,
            this.environment.registry,
            this.environment.document.baseURI,
            representability,
            batchBudget,
            styleWork,
            fidelityPolicy,
          );
          if (!serialized) throw new Error('Unsafe new children patch.');
          const newGraphs = new Map<Node, import(
            './html-mirror-sanitizer'
          ).HtmlMirrorNode>();
          serialized.forEach((graph, index) => {
            if (!graph) return;
            const source = newSources[index]!;
            if (
              this.environment.registry.getNode(graph.id) !== source ||
              source.parentNode !== capture.target
            ) throw new Error('Unstable new children patch.');
            newGraphs.set(source, graph);
          });
          const entries: HtmlMirrorReconcileChild[] = [];
          for (const source of capture.sources) {
            if (previous.has(source)) {
              const nodeId = this.environment.registry.peekId(source);
              if (
                !nodeId || source.parentNode !== capture.target ||
                this.#emittedParent.get(source) !== capture.target
              ) throw new Error('Unstable retained child.');
              entries.push(Object.freeze({ kind: 'retain', nodeId }));
              continue;
            }
            const graph = newGraphs.get(source);
            if (graph) entries.push(Object.freeze({ kind: 'graph', node: graph }));
          }
          if (!reconciliationMatchesEmittedChildren(
            entries,
            capture.previous,
            this.environment.registry,
          )) {
            operations.push(Object.freeze({
              kind: 'reconcile-children',
              nodeId: capture.nodeId,
              children: Object.freeze(entries),
            }));
          }
        }
      }
      for (const target of this.#pendingAttributes) {
        if (
          !target.isConnected || covered(target) ||
          !this.#mirroredNodes.has(target)
        ) continue;
        const attributes = sanitizeSourceAttributes(
          target,
          this.environment.document.baseURI,
          representability,
          fidelityPolicy,
          this.#controlledContentPolicy,
        );
        if (!attributes) throw new Error('Unsafe attributes patch.');
        const hints = sanitizeSourceElementHints(
          target,
          this.environment.document.baseURI,
          representability,
          fidelityPolicy,
          styleWork,
          this.#controlledContentPolicy,
        );
        if (target.localName.toLowerCase() === 'img') {
          this.#selectedImageSources.set(
            target,
            hints.selectedImageSource ?? '',
          );
        }
        const operation = Object.freeze({
          kind: 'attributes',
          nodeId: this.environment.registry.peekId(target) as number,
          namespace: sourceElementNamespace(target),
          tagName: target.localName.toLowerCase(),
          attributes,
          ...hints,
        } as const);
        if (
          emittedElementSignature(operation) ===
            this.#emittedNodeSignatures.get(target)
        ) continue;
        operations.push(operation);
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
          representability,
          fidelityPolicy,
        );
        if (!node || node.kind !== 'text') throw new Error('Unsafe text patch.');
        const operation = Object.freeze({
          kind: 'text',
          nodeId: node.id,
          node,
        } as const);
        if (
          emittedTextSignature(node) === this.#emittedNodeSignatures.get(target)
        ) continue;
        operations.push(operation);
      }
      let emittedDimensions:
        ReturnType<typeof readSourceDimensions> | undefined;
      if (this.#pendingDimensions) {
        const dimensions = readSourceDimensions(
          this.environment.document,
          this.environment.window,
        );
        if (!sameSourceDimensions(dimensions, this.#lastDimensions)) {
          emittedDimensions = dimensions;
          operations.push(Object.freeze({
            kind: 'dimensions',
            ...dimensions,
          }));
        }
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
        this.#summarizeRepresentability(representability),
        fidelityPolicy,
      );
      if (!batch) {
        incrementSourceRepresentability(
          representability,
          'capacityOmissionCount',
        );
        throw new HtmlMirrorCapacityError(true);
      }
      for (const operation of batch.operations) {
        if (operation.kind === 'children') {
          const target = this.environment.registry.getNode(operation.nodeId);
          if (target) this.#recordEmittedChildren(target, operation.children);
        } else if (operation.kind === 'reconcile-children') {
          const target = this.environment.registry.getNode(operation.nodeId);
          if (target) this.#recordReconciledChildren(target, operation.children);
        } else if (operation.kind === 'attributes') {
          const target = this.environment.registry.getNode(operation.nodeId);
          if (target) {
            this.#emittedNodeSignatures.set(
              target,
              emittedElementSignature(operation),
            );
          }
        } else if (operation.kind === 'text') {
          const target = this.environment.registry.getNode(operation.nodeId);
          if (target) {
            this.#emittedNodeSignatures.set(
              target,
              emittedTextSignature(operation.node),
            );
          }
        }
      }
      this.#clearPending();
      this.#sequence = sequence;
      if (emittedDimensions) this.#lastDimensions = emittedDimensions;
      this.#post(batch);
    } catch (error) {
      if (
        error instanceof HtmlMirrorCapacityError &&
        !error.diagnosticRecorded
      ) {
        incrementSourceRepresentability(
          representability,
          'capacityOmissionCount',
        );
      }
      this.#clearPending();
      this.#paused = true;
      this.#post(createHtmlMirrorError(
        this.#identityAt(this.#sequence),
        representability.capacityOmissionCount > 0
          ? 'stream_overflow'
          : 'privacy_rejected',
        this.#summarizeRepresentability(representability),
      ));
    }
  }

  /**
   * Snapshots a batch's diagnostics and folds in the bounded, content-free
   * count of observation walks that ran out of budget since the last summary.
   * The collector itself stays untouched so its overflow decisions are not
   * affected by a deferred walk omission.
   */
  #summarizeRepresentability(
    representability: HtmlMirrorRepresentabilityCollector,
  ): HtmlMirrorRepresentabilitySummary {
    const omitted = this.#shadowObservationOmissionCount;
    this.#shadowObservationOmissionCount = 0;
    if (omitted === 0) return snapshotHtmlMirrorRepresentability(representability);
    return snapshotHtmlMirrorRepresentability({
      ...representability,
      capacityOmissionCount: Math.min(
        MAX_HTML_MIRROR_DIAGNOSTIC_COUNT,
        representability.capacityOmissionCount + omitted,
      ),
    });
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
    this.#controlledLayoutSettlePending = false;
    this.#visibilityMutationRecords = [];
    this.#visibilityMutationOverflow = false;
    this.#visibilityInteractionTargets.clear();
    this.#visibilityFullRefreshPending = false;
  }

  readonly #onLayoutChange = (): void => {
    if (this.#disposed || !this.#identity) return;
    this.#observeOpenShadowRoots(this.environment.document.documentElement);
    this.#refreshControlledContentPolicy();
    this.#visibilityFullRefreshPending = true;
    this.#imageRefreshRequested = true;
    this.#nestedOwnerOrdinals = new WeakMap<Element, number>();
    this.#pendingDimensions = true;
    this.#scheduleFlush();
    this.#postScroll();
  };

  readonly #onScroll = (event?: Event): void => {
    if (this.#disposed || !this.#identity) return;
    if (event) {
      if (isDocumentScrollTarget(
        event.target,
        this.environment.document,
        this.environment.window,
      )) {
        this.#pendingDocumentScroll = true;
      } else if (
        event.target instanceof Element &&
        readNestedScrollSnapshot(
          event.target,
          this.environment.document,
          this.environment.window,
        )
      ) {
        if (event.target !== this.#activeNestedScroller) {
          this.#nestedOwnerOrdinals.delete(event.target);
        }
        this.#pendingNestedScroller = event.target;
      } else {
        return;
      }
    } else {
      this.#nestedOwnerOrdinals = new WeakMap<Element, number>();
    }
    this.#scheduleScroll();
  };

  #scheduleScroll(): void {
    if (
      this.#disposed || !this.#identity || this.#scrollFrame !== undefined
    ) return;
    this.#scrollFrame = this.environment.scheduleFrame(() => {
      this.#scrollFrame = undefined;
      this.#postScroll();
    });
  }

  #postScroll(): void {
    if (this.#disposed || !this.#identity) return;
    const documentScroll = readDocumentScrollSnapshot(
      this.environment.document,
      this.environment.window,
    );
    const documentMoved = this.#lastDocumentScroll !== undefined &&
      (documentScroll.scrollX !== this.#lastDocumentScroll.scrollX ||
        documentScroll.scrollY !== this.#lastDocumentScroll.scrollY);
    let scroll = documentScroll;
    if (this.#pendingDocumentScroll) {
      this.#activeNestedScroller = undefined;
    } else if (this.#pendingNestedScroller) {
      const nestedScroll = readNestedScrollSnapshot(
        this.#pendingNestedScroller,
        this.environment.document,
        this.environment.window,
      );
      if (nestedScroll) {
        this.#activeNestedScroller = this.#pendingNestedScroller;
        scroll = nestedScroll;
      } else if (this.#pendingNestedScroller === this.#activeNestedScroller) {
        this.#activeNestedScroller = undefined;
      }
    } else if (documentMoved) {
      this.#activeNestedScroller = undefined;
    } else if (this.#activeNestedScroller) {
      const nestedScroll = readNestedScrollSnapshot(
        this.#activeNestedScroller,
        this.environment.document,
        this.environment.window,
      );
      if (nestedScroll) {
        scroll = nestedScroll;
      } else {
        this.#activeNestedScroller = undefined;
      }
    }
    this.#lastDocumentScroll = documentScroll;
    this.#pendingNestedScroller = undefined;
    this.#pendingDocumentScroll = false;

    let nestedOwnerKey: number | undefined;
    let nestedOwnerOrdinalValue: number | undefined;
    if (scroll.scrollTarget === 'nested' && this.#activeNestedScroller) {
      nestedOwnerKey = this.#nestedOwnerKeys.get(this.#activeNestedScroller);
      if (nestedOwnerKey === undefined) {
        nestedOwnerKey = this.#nextNestedOwnerKey;
        this.#nextNestedOwnerKey = this.#nextNestedOwnerKey >= 1_000_000_000
          ? 1
          : this.#nextNestedOwnerKey + 1;
        this.#nestedOwnerKeys.set(this.#activeNestedScroller, nestedOwnerKey);
      }
      nestedOwnerOrdinalValue = this.#nestedOwnerOrdinals.get(
        this.#activeNestedScroller,
      );
      if (nestedOwnerOrdinalValue === undefined) {
        nestedOwnerOrdinalValue = nestedScrollerOrdinal(
          this.#activeNestedScroller,
          this.environment.document,
          this.environment.window,
        );
        if (nestedOwnerOrdinalValue !== undefined) {
          this.#nestedOwnerOrdinals.set(
            this.#activeNestedScroller,
            nestedOwnerOrdinalValue,
          );
        }
      }
    }
    const update = createHtmlMirrorScrollUpdate(
      this.#identityAt(this.#sequence),
      {
        ...scroll,
        ...(nestedOwnerKey !== undefined ? { nestedOwnerKey } : {}),
        ...(nestedOwnerOrdinalValue !== undefined
          ? { nestedOwnerOrdinal: nestedOwnerOrdinalValue }
          : {}),
        documentScrollX: documentScroll.scrollX,
        documentScrollY: documentScroll.scrollY,
        documentMaxScrollX: documentScroll.maxScrollX,
        documentMaxScrollY: documentScroll.maxScrollY,
      },
    );
    if (update) this.#post(update);
  }

  readonly #onControlledLayoutSettle = (event: Event): void => {
    const target = event.target;
    if (
      this.#disposed || !this.#identity ||
      !target || typeof target !== 'object' ||
      (target as Node).nodeType !== 1
    ) return;
    const element = target as Element;
    this.#visibilityInteractionTargets.add(element);
    const controlledMayChange = this.#controlledContentPolicy &&
      sourceControlledContentLayoutMayChange(
        element,
        this.#controlledContentPolicy,
      );
    if (!controlledMayChange && !this.#visibilityBoundaryIndex) return;
    // A final transition/animation style can reveal or withdraw a selected
    // panel without another mutation. Refresh admission inside the same one
    // post-paint frame used for the resulting patch; bursts remain coalesced.
    this.#controlledLayoutSettlePending = Boolean(controlledMayChange);
    this.#pendingDimensions = true;
    this.#scheduleFlush();
  };

  readonly #onVisibilityInteraction = (event: Event): void => {
    const target = event.target;
    if (
      this.#disposed || !this.#identity ||
      !target || typeof target !== 'object' ||
      (target as Node).nodeType !== 1 ||
      !this.#visibilityBoundaryIndex
    ) return;
    this.#visibilityInteractionTargets.add(target as Element);
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

  #refreshControlledContentPolicy(): boolean {
    const previous = this.#controlledContentPolicy;
    if (!previous) return false;
    const next = createSourceControlledContentPolicy(
      this.environment.document,
      this.environment.window,
      MAX_HTML_MIRROR_NODES,
    );
    this.#controlledContentPolicy = next;
    if (sourceControlledContentBoundaryChanged(previous, next)) {
      this.#shadowReconciliationPending = true;
      this.#signalShadowReconciliation();
      return true;
    }
    const changed = sourceControlledContentChangedTargets(previous, next);
    for (const panel of changed) {
      this.#queuePending(this.#pendingChildren, panel);
      this.#queuePending(this.#pendingAttributes, panel);
    }
    return changed.length > 0;
  }

  #applyVisibilityBoundaryRefresh(
    refresh: SourceVisibilityBoundaryRefresh,
  ): boolean {
    if (refresh.overflow) {
      this.#shadowReconciliationPending = true;
      this.#signalShadowReconciliation();
      return true;
    }
    for (const target of refresh.changedTargets) {
      this.#queuePending(this.#pendingChildren, target);
      this.#queuePending(this.#pendingAttributes, target);
    }
    return refresh.changedTargets.length > 0;
  }

  #scheduleFlush(): void {
    if (this.#paused || this.#frame !== undefined || this.#disposed) return;
    if (
      this.#pendingChildren.size === 0 &&
      this.#pendingAttributes.size === 0 &&
      this.#pendingText.size === 0 &&
      !this.#pendingDimensions &&
      !this.#controlledLayoutSettlePending &&
      this.#visibilityMutationRecords.length === 0 &&
      !this.#visibilityMutationOverflow &&
      !this.#visibilityFullRefreshPending &&
      this.#visibilityInteractionTargets.size === 0
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
      this.#emittedNodeSignatures.set(
        source,
        node.kind === 'text'
          ? emittedTextSignature(node)
          : emittedElementSignature(node),
      );
      if (source instanceof Element) {
        if (node.kind === 'element' && node.opaquePlaceholder === true) {
          this.#mirroredOpaqueSecrets.add(source);
        }
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
        this.#adoptedStyleSignatures.prime(
          shadow,
          adoptedStyleSignature(node.shadowRoot.adoptedStyleSheets),
        );
        // Every mirrored open root is observed here, while the graph is still
        // bounded by the sanitizer's own capacity, so the budgeted DOM walk
        // only has to find roots the emitted graph does not carry.
        const openShadow = readOpenShadowRoot(shadow);
        if (openShadow) this.#observeOpenShadowRoot(openShadow);
      }
      for (const child of node.shadowRoot.children) this.#markMirroredGraph(child);
      if (shadow) this.#setEmittedChildren(shadow, node.shadowRoot.children);
    }
    for (const child of node.children) this.#markMirroredGraph(child);
    if (source) this.#setEmittedChildren(source, node.children);
  }

  #recordEmittedChildren(
    target: Node,
    children: readonly import('./html-mirror-sanitizer').HtmlMirrorNode[],
  ): void {
    for (const child of children) this.#markMirroredGraph(child);
    this.#setEmittedChildren(target, children);
  }

  #recordReconciledChildren(
    target: Node,
    children: readonly HtmlMirrorReconcileChild[],
  ): void {
    for (const child of children) {
      if (child.kind === 'graph') this.#markMirroredGraph(child.node);
    }
    const sources = children.map((child) => this.environment.registry.getNode(
      child.kind === 'retain' ? child.nodeId : child.node.id,
    ));
    if (sources.some((source) => !source)) {
      throw new Error('Reconciled source node is unavailable.');
    }
    this.#setEmittedSourceChildren(target, sources as Node[]);
  }

  #setEmittedChildren(
    target: Node,
    children: readonly import('./html-mirror-sanitizer').HtmlMirrorNode[],
  ): void {
    const sources: Node[] = [];
    for (const child of children) {
      const source = this.environment.registry.getNode(child.id);
      if (source) sources.push(source);
    }
    this.#setEmittedSourceChildren(target, sources);
  }

  #setEmittedSourceChildren(target: Node, sources: readonly Node[]): void {
    const previous = this.#emittedChildren.get(target) ?? [];
    const next = new Set(sources);
    for (const child of previous) {
      if (!next.has(child) && this.#emittedParent.get(child) === target) {
        this.#emittedParent.delete(child);
      }
    }
    for (const child of sources) this.#emittedParent.set(child, target);
    this.#emittedChildren.set(target, Object.freeze(sources));
  }

  #reconciliationDecision(
    target: Node,
    children: readonly Node[],
  ): ReconciliationDecision {
    const previous = this.#emittedChildren.get(target);
    if (!previous) return 'missingReconciliationProofFallbackCount';
    if (this.#pendingAttributes.has(target as Element)) {
      return 'attributeContextFallbackCount';
    }
    if (
      iterableContainsComposedSource(this.#pendingChildren, target, target) ||
      iterableContainsComposedSource(this.#pendingAttributes, target, target) ||
      iterableContainsComposedSource(this.#pendingText, target, target)
    ) return 'coveredDirtyBranchFallbackCount';

    const previousSet = new Set(previous);
    for (const child of children) {
      if (!previousSet.has(child)) continue;
      if (
        this.environment.registry.peekId(child) === undefined ||
        this.#emittedParent.get(child) !== target
      ) return 'missingReconciliationProofFallbackCount';
    }
    const newRoots = children.filter((child) => !previousSet.has(child));
    const incomingSources = collectLiveSubtreeNodes(newRoots);
    if (!incomingSources) return 'missingReconciliationProofFallbackCount';
    for (const current of incomingSources) {
      const oldParent = this.#emittedParent.get(current);
      // A currently-emitted node whose prior parent is outside this new graph
      // would collide with receiver state. Internal parents are allowed for a
      // whole subtree that was removed in an earlier emitted batch and is now
      // being reinserted as a graph.
      if (oldParent && !incomingSources.has(oldParent)) {
        return 'crossParentFallbackCount';
      }
    }
    return 'reconcile';
  }

  #coversOwnOpenShadowWork(target: Node): boolean {
    if (target.nodeType !== Node.ELEMENT_NODE) return false;
    const shadow = (target as Element).shadowRoot;
    if (!shadow || shadow.mode !== 'open') return false;
    return iterableContainsComposedSource(this.#pendingChildren, shadow) ||
      iterableContainsComposedSource(this.#pendingAttributes, shadow) ||
      iterableContainsComposedSource(this.#pendingText, shadow);
  }

  #registerShadowHostCandidate(element: Element): void {
    if (
      this.#knownShadowHostCandidates.has(element) ||
      this.#settledShadowHostCandidates.has(element)
    ) return;
    const shadow = element.shadowRoot;
    if (shadow?.mode === 'open') {
      // A host's shadow root cannot be detached or replaced. Its existing root
      // is captured by the checkpoint walk, so only unresolved hosts belong in
      // the periodic late-attachment discovery rotation.
      this.#settledShadowHostCandidates.add(element);
      return;
    }
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
          undefined,
          this.#fidelityPolicy ?? 'conservative',
          undefined,
          this.#controlledContentPolicy,
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
    root.addEventListener('scroll', this.#onScroll, true);
  }

  #compactImageEventRoots(): void {
    for (const root of this.#imageEventRoots) {
      if (root === this.environment.document || ('host' in root && root.host.isConnected)) {
        continue;
      }
      root.removeEventListener('load', this.#onCapturedResourceLoad, true);
      root.removeEventListener('error', this.#onCapturedResourceError, true);
      root.removeEventListener('scroll', this.#onScroll, true);
      this.#imageEventRoots.delete(root);
    }
  }

  #compactShadowHostCandidates(): void {
    const retained = this.#shadowHostCandidates.filter(
      (element) =>
        element.isConnected &&
        this.#mirroredNodes.has(element) &&
        !this.#settledShadowHostCandidates.has(element),
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
    if (this.#pendingOverflow || this.#paused) return;
    if (this.#shadowReconciliationPending) return;
    const candidateCount = this.#shadowHostCandidates.length;
    if (candidateCount > 0) {
      const scanCount = Math.min(candidateCount, MAX_SHADOW_HOSTS_PER_TICK);
      let processed = 0;
      let settled = false;
      for (let offset = 0; offset < scanCount; offset += 1) {
        const index = (this.#shadowDiscoveryCursor + offset) % candidateCount;
        const element = this.#shadowHostCandidates[index];
        processed += 1;
        if (!element?.isConnected || !this.#mirroredNodes.has(element)) continue;
        const shadow = element.shadowRoot;
        if (shadow?.mode !== 'open') continue;
        this.#settledShadowHostCandidates.add(element);
        settled = true;
        this.#observeOpenShadowRoot(shadow);
        if (this.#shadowReconciliationPending) return;
      }
      this.#shadowDiscoveryCursor =
        (this.#shadowDiscoveryCursor + processed) % candidateCount;
      if (settled) this.#compactShadowHostCandidates();
    }
    this.#pollStyleChanges();
  }

  #adoptedStylesChanged(
    owner: Document | ShadowRoot,
    work: HtmlMirrorStyleWorkBudget,
  ): StylePollResult {
    const styles = sanitizeSourceAdoptedStyleSheets(
      owner,
      this.environment.document.baseURI,
      work,
      undefined,
      this.#fidelityPolicy ?? 'conservative',
    );
    if (!styles) return work.exhausted ? 'capacity' : 'unchanged';
    const signature = adoptedStyleSignature(styles);
    return this.#adoptedStyleSignatures.observe(owner, signature)
      ? 'changed'
      : 'unchanged';
  }

  #ordinaryStylesChanged(
    owner: Document | ShadowRoot,
    work: HtmlMirrorStyleWorkBudget,
  ): StylePollResult {
    const read = ordinaryStyleSignature(owner, work);
    if (read.kind === 'capacity') return 'capacity';
    const signature = read.signature;
    if (signature === undefined) return 'unchanged';
    return this.#ordinaryStyleSignatures.observe(owner, signature)
      ? 'changed'
      : 'unchanged';
  }

  #primeOrdinaryStyleSignatures(): void {
    const owners = this.#styleOwners();
    if (owners.length === 0) return;
    const work = this.#createStylePollingBudget();
    const scanCount = Math.min(
      owners.length,
      MAX_SHADOW_HOSTS_PER_TICK + 1,
    );
    let processed = 0;
    for (let offset = 0; offset < scanCount; offset += 1) {
      const index = (this.#stylePollingCursor + offset) % owners.length;
      const owner = owners[index]!;
      processed += 1;
      const read = ordinaryStyleSignature(owner, work);
      if (read.kind === 'signature' && read.signature !== undefined) {
        this.#ordinaryStyleSignatures.prime(owner, read.signature);
      }
      if (read.kind === 'capacity') break;
    }
    this.#stylePollingCursor =
      (this.#stylePollingCursor + processed) % owners.length;
  }

  #pollStyleChanges(): void {
    this.#stylePollingPass += 1;
    const owners = this.#styleOwners();
    if (owners.length === 0) return;
    const work = this.#createStylePollingBudget();
    const scanCount = Math.min(
      owners.length,
      MAX_SHADOW_HOSTS_PER_TICK + 1,
    );
    let processed = 0;
    for (let offset = 0; offset < scanCount; offset += 1) {
      const index = (this.#stylePollingCursor + offset) % owners.length;
      const owner = owners[index]!;
      processed += 1;
      const firstChannel = this.#stylePollingPhases.get(owner) ?? 'ordinary';
      const channels = [
        firstChannel,
        oppositeStylePollChannel(firstChannel),
      ] as const;
      for (const channel of channels) {
        const wasCapacity = ((this.#styleCapacityChannels.get(owner) ?? 0) &
          stylePollChannelMask(channel)) !== 0;
        if (wasCapacity && this.#styleCapacityRetryPending(owner, channel)) {
          continue;
        }
        const channelStartedWithUnusedBudget = work.sheets === 0 &&
          work.rules === 0 && work.characters === 0;
        const result = channel === 'ordinary'
          ? this.#ordinaryStylesChanged(owner, work)
          : this.#adoptedStylesChanged(owner, work);
        if (result === 'changed' || (wasCapacity && result === 'unchanged')) {
          this.#clearStyleCapacity(owner, channel);
          this.#stylePollingPhases.set(
            owner,
            oppositeStylePollChannel(channel),
          );
          this.#advanceStylePollingCursor(processed, owners.length);
          this.#shadowReconciliationPending = true;
          this.#signalShadowReconciliation();
          return;
        }
        if (result === 'capacity') {
          // Retry the channel that could not fit first on the owner's next
          // turn. This prevents a large ordinary sheet from permanently
          // starving adopted sheets (and vice versa).
          this.#stylePollingPhases.set(owner, channel);
          this.#advanceStylePollingCursor(processed, owners.length);
          if (channelStartedWithUnusedBudget) {
            this.#suppressOversizedStyleChannel(owner, channel);
          }
          return;
        }
        this.#clearStyleCapacity(owner, channel);
      }
      this.#stylePollingPhases.set(
        owner,
        oppositeStylePollChannel(firstChannel),
      );
    }
    this.#advanceStylePollingCursor(processed, owners.length);
  }

  #styleOwners(): readonly (Document | ShadowRoot)[] {
    this.#compactImageEventRoots();
    return [...this.#imageEventRoots].filter((root) =>
      root === this.environment.document ||
      ('host' in root && root.host.isConnected && this.#mirroredNodes.has(root))
    );
  }

  #createStylePollingBudget(): HtmlMirrorStyleWorkBudget {
    return createHtmlMirrorStyleWorkBudget({
      maxSheets: MAX_STYLE_SHEETS_PER_TICK,
      maxRules: MAX_STYLE_RULES_PER_TICK,
      maxCharacters: MAX_STYLE_CHARACTERS_PER_TICK,
    });
  }

  #advanceStylePollingCursor(processed: number, ownerCount: number): void {
    this.#stylePollingCursor = ownerCount === 0
      ? 0
      : (this.#stylePollingCursor + processed) % ownerCount;
  }

  #clearStyleCapacity(
    owner: Document | ShadowRoot,
    channel: StylePollChannel,
  ): void {
    const next = (this.#styleCapacityChannels.get(owner) ?? 0) &
      ~stylePollChannelMask(channel);
    if (next === 0) {
      this.#styleCapacityChannels.delete(owner);
      this.#styleCapacityRetryPasses.delete(owner);
    } else {
      this.#styleCapacityChannels.set(owner, next);
      const retries = this.#styleCapacityRetryPasses.get(owner) ?? [0, 0];
      this.#styleCapacityRetryPasses.set(
        owner,
        channel === 'ordinary'
          ? [0, retries[1]]
          : [retries[0], 0],
      );
    }
  }

  #styleCapacityRetryPending(
    owner: Document | ShadowRoot,
    channel: StylePollChannel,
  ): boolean {
    const retries = this.#styleCapacityRetryPasses.get(owner);
    const retryPass = retries?.[channel === 'ordinary' ? 0 : 1] ??
      Number.MAX_SAFE_INTEGER;
    return this.#stylePollingPass < retryPass;
  }

  #suppressOversizedStyleChannel(
    owner: Document | ShadowRoot,
    channel: StylePollChannel,
  ): void {
    const mask = stylePollChannelMask(channel);
    const reported = this.#styleCapacityChannels.get(owner) ?? 0;
    this.#styleCapacityChannels.set(owner, reported | mask);
    const retries = this.#styleCapacityRetryPasses.get(owner) ?? [0, 0];
    const retryPass = this.#stylePollingPass + OVERSIZED_STYLE_RETRY_PASSES;
    this.#styleCapacityRetryPasses.set(
      owner,
      channel === 'ordinary'
        ? [retryPass, retries[1]]
        : [retries[0], retryPass],
    );
  }

  #createShadowObservationWalk(): ShadowObservationWalk {
    return {
      visited: new WeakSet<Node>(),
      remaining: MAX_SHADOW_OBSERVATION_NODES,
      exhausted: false,
    };
  }

  /**
   * Iterative and bounded: a hostile DOM depth must not overflow the stack
   * inside the MutationObserver callback, and one oversized subtree must not
   * stall the page. Subtrees already covered by the same walk are skipped.
   * Once the node budget is spent the walk stops and records one bounded,
   * content-free capacity omission for the next representability summary
   * instead of stopping silently; mirrored roots are observed as their graph
   * is marked, so the budget only defers the discovery of unmirrored roots.
   */
  #observeOpenShadowRoots(
    root: Node,
    walk: ShadowObservationWalk = this.#createShadowObservationWalk(),
  ): void {
    const stack: Node[] = [root];
    while (stack.length > 0) {
      const node = stack.pop() as Node;
      if (walk.visited.has(node)) continue;
      if (walk.remaining === 0) {
        if (!walk.exhausted) {
          walk.exhausted = true;
          this.#shadowObservationOmissionCount = Math.min(
            MAX_HTML_MIRROR_DIAGNOSTIC_COUNT,
            this.#shadowObservationOmissionCount + 1,
          );
        }
        return;
      }
      walk.remaining -= 1;
      walk.visited.add(node);
      this.#shadowObservationVisitCount += 1;
      const directShadow = readOpenShadowRoot(node);
      if (directShadow) this.#observeOpenShadowRoot(directShadow);
      if (node.nodeType === Node.ELEMENT_NODE) {
        const shadow = (node as Element).shadowRoot;
        if (shadow && shadow.mode === 'open') this.#observeOpenShadowRoot(shadow);
        if (shadow) {
          for (let child = shadow.lastChild; child; child = child.previousSibling) {
            stack.push(child);
          }
        }
      }
      for (let child = node.lastChild; child; child = child.previousSibling) {
        stack.push(child);
      }
    }
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

function sourceElementNamespace(element: Element): HtmlMirrorNamespace {
  if (element.namespaceURI === 'http://www.w3.org/2000/svg') return 'svg';
  if (element.namespaceURI === 'http://www.w3.org/1998/Math/MathML') {
    return 'mathml';
  }
  return 'html';
}

function readOpenShadowRoot(node: Node): ShadowRoot | undefined {
  if (node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return undefined;
  const candidate = node as ShadowRoot;
  return candidate.mode === 'open' && candidate.host?.nodeType === Node.ELEMENT_NODE
    ? candidate
    : undefined;
}

function sourceMutationOwnerElement(node: Node): Element | undefined {
  if (node instanceof Element) return node;
  const shadowRoot = readOpenShadowRoot(node);
  if (shadowRoot) return shadowRoot.host;
  return node.parentElement ?? undefined;
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

type OrdinaryStyleSignatureRead = Readonly<{
  kind: 'signature';
  signature: string | undefined;
}> | Readonly<{
  kind: 'capacity';
}>;

function ordinaryStyleSignature(
  owner: Document | ShadowRoot,
  work: HtmlMirrorStyleWorkBudget,
): OrdinaryStyleSignatureRead {
  let sheets: ArrayLike<CSSStyleSheet>;
  try {
    sheets = (owner as Document & {
      readonly styleSheets: ArrayLike<CSSStyleSheet>;
    }).styleSheets;
  } catch {
    return Object.freeze({ kind: 'signature', signature: undefined });
  }
  if (!sheets) {
    return Object.freeze({ kind: 'signature', signature: undefined });
  }
  const sheetCount = sheets.length;
  if (
    !Number.isSafeInteger(sheetCount) ||
    sheetCount < 0
  ) return Object.freeze({ kind: 'signature', signature: undefined });
  if (work.sheets + sheetCount > work.maxSheets) {
    work.exhausted = true;
    return Object.freeze({ kind: 'capacity' });
  }
  const parts: string[] = [];
  const visited = new Set<object>();
  for (let index = 0; index < sheetCount; index += 1) {
    const sheet = sheets[index];
    if (!sheet) continue;
    work.sheets += 1;
    let disabled = false;
    let media = '';
    try {
      disabled = sheet.disabled === true;
      media = sheet.media?.mediaText ?? '';
    } catch {
      parts.push(`${index}:unreadable`);
      continue;
    }
    const rules = cssomRuleSignature(sheet, work, visited, 0);
    if (rules.kind === 'capacity') return rules;
    parts.push(`${index}:${disabled ? 1 : 0}:${media}:${rules.signature}`);
  }
  return Object.freeze({
    kind: 'signature',
    signature: adoptedStyleSignature(parts),
  });
}

function cssomRuleSignature(
  sheet: CSSStyleSheet,
  work: HtmlMirrorStyleWorkBudget,
  visited: Set<object>,
  depth: number,
): OrdinaryStyleSignatureRead {
  if (depth > 8 || visited.has(sheet)) {
    return Object.freeze({ kind: 'signature', signature: 'cycle' });
  }
  visited.add(sheet);
  try {
    const rules = sheet.cssRules;
    const ruleCount = rules.length;
    if (
      !Number.isSafeInteger(ruleCount) ||
      ruleCount < 0
    ) return Object.freeze({ kind: 'signature', signature: 'unreadable' });
    if (work.rules + ruleCount > work.maxRules) {
      work.exhausted = true;
      return Object.freeze({ kind: 'capacity' });
    }
    const parts: string[] = [];
    for (let index = 0; index < ruleCount; index += 1) {
      const rule = rules[index] ?? rules.item(index);
      if (!rule || typeof rule.cssText !== 'string') {
        return Object.freeze({ kind: 'signature', signature: 'unreadable' });
      }
      if (work.characters + rule.cssText.length > work.maxCharacters) {
        work.exhausted = true;
        return Object.freeze({ kind: 'capacity' });
      }
      work.rules += 1;
      work.characters += rule.cssText.length;
      const imported = (rule as CSSRule & {
        readonly styleSheet?: CSSStyleSheet | null;
      }).styleSheet;
      if (!imported) {
        parts.push(rule.cssText);
        continue;
      }
      const nested = cssomRuleSignature(imported, work, visited, depth + 1);
      if (nested.kind === 'capacity') return nested;
      parts.push(`${rule.cssText}:${nested.signature ?? 'unavailable'}`);
    }
    return Object.freeze({
      kind: 'signature',
      signature: adoptedStyleSignature(parts),
    });
  } catch {
    return Object.freeze({ kind: 'signature', signature: 'unreadable' });
  } finally {
    visited.delete(sheet);
  }
}

function collectLiveSubtreeNodes(
  roots: readonly Node[],
): ReadonlySet<Node> | undefined {
  try {
    const sources = new Set<Node>();
    const stack = [...roots];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (sources.has(current)) continue;
      if (sources.size >= MAX_HTML_MIRROR_NODES) return undefined;
      sources.add(current);
      if (current.nodeType === Node.ELEMENT_NODE) {
        const shadow = (current as Element).shadowRoot;
        if (shadow?.mode === 'open') stack.push(shadow);
      }
      stack.push(...current.childNodes);
    }
    return sources;
  } catch {
    return undefined;
  }
}

function containsComposedSource(ancestor: Node, descendant: Node): boolean {
  for (let current: Node | undefined = descendant; current;) {
    if (current === ancestor) return true;
    if (current.parentNode) {
      current = current.parentNode;
      continue;
    }
    if (current.nodeType === Node.DOCUMENT_FRAGMENT_NODE && 'host' in current) {
      current = (current as ShadowRoot).host;
      continue;
    }
    const root = current.getRootNode();
    current = root !== current && root.nodeType === Node.DOCUMENT_FRAGMENT_NODE &&
      'host' in root
      ? (root as ShadowRoot).host
      : undefined;
  }
  return false;
}

function reconciliationMatchesEmittedChildren(
  entries: readonly HtmlMirrorReconcileChild[],
  previous: readonly Node[],
  registry: WeakNodeIdRegistry,
): boolean {
  return entries.length === previous.length && entries.every((entry, index) =>
    entry.kind === 'retain' && registry.peekId(previous[index]!) === entry.nodeId);
}

function emittedElementSignature(
  element: Pick<HtmlMirrorElementNode,
    | 'namespace'
    | 'tagName'
    | 'attributes'
    | 'visuallyHidden'
    | 'selectedImageSource'
    | 'selectedOptionIndexes'
    | 'selectPickerOpen'
    | 'selectPresentationStyle'
    | 'controlText'
    | 'canvasBackgroundColor'
    | 'resolvedStyleSheetText'
  >,
): string {
  const controlText = element.controlText;
  return JSON.stringify([
    element.namespace,
    element.tagName,
    element.attributes,
    element.visuallyHidden === true,
    element.selectedImageSource ?? null,
    element.selectedOptionIndexes ?? null,
    element.selectPickerOpen === true,
    element.selectPresentationStyle ?? null,
    controlText
      ? [controlText.kind, controlText.text, controlText.translatable]
      : null,
    element.canvasBackgroundColor ?? null,
    element.resolvedStyleSheetText ?? null,
  ]);
}

function emittedTextSignature(
  text: Readonly<{ text: string; translatable: boolean }>,
): string {
  return JSON.stringify([text.text, text.translatable]);
}

function sameSourceDimensions(
  current: ReturnType<typeof readSourceDimensions>,
  previous: ReturnType<typeof readSourceDimensions> | undefined,
): boolean {
  return Boolean(
    previous &&
    current.viewportWidth === previous.viewportWidth &&
    current.viewportHeight === previous.viewportHeight &&
    current.documentWidth === previous.documentWidth &&
    current.documentHeight === previous.documentHeight &&
    current.canvasBackgroundColor === previous.canvasBackgroundColor
  );
}

function incrementSourceRepresentability(
  target: HtmlMirrorRepresentabilityCollector,
  key: keyof HtmlMirrorRepresentabilityCollector,
): void {
  target[key] = Math.min(
    MAX_HTML_MIRROR_DIAGNOSTIC_COUNT,
    target[key] + 1,
  );
}

/** Finds the DOM owner even while its privacy role is changing. */
function sourceNativeSelectStructuralOwner(node: Node): Element | undefined {
  let current = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement ?? undefined;
  for (; current; current = composedSourceParentElement(current)) {
    const tagName = current.localName.toLowerCase();
    if (tagName === 'datalist') return undefined;
    if (tagName === 'select') return current;
  }
  return undefined;
}

function composedSourceParentElement(element: Element): Element | undefined {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root.nodeType === 11 && 'host' in root
    ? (root as ShadowRoot).host
    : undefined;
}

function belongsToSourceDocument(node: Node, sourceDocument: Document): boolean {
  return node === sourceDocument || node.ownerDocument === sourceDocument;
}

function iterableContainsComposedSource(
  values: Iterable<Node>,
  root: Node,
  excluded?: Node,
): boolean {
  for (const value of values) {
    if (value !== excluded && containsComposedSource(root, value)) return true;
  }
  return false;
}

function readSourceDimensions(document: Document, window: Window): {
  viewportWidth: number;
  viewportHeight: number;
  documentWidth: number;
  documentHeight: number;
  canvasBackgroundColor?: string;
} {
  const html = document.documentElement;
  const body = document.body;
  const viewportWidth = Math.max(1, Math.round(window.innerWidth || html?.clientWidth || 1));
  const viewportHeight = Math.max(1, Math.round(window.innerHeight || html?.clientHeight || 1));
  const canvasBackgroundColor = html
    ? sanitizeSourceElementHints(html, document.baseURI).canvasBackgroundColor
    : undefined;
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
    ...(canvasBackgroundColor ? { canvasBackgroundColor } : {}),
  };
}

// Kept in the emitted bundle as an artifact marker even after minification.
export const HTML_MIRROR_RUNTIME_MARKER = HTML_MIRROR_PORT_PREFIX;
