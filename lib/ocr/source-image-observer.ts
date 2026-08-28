import {
  readSourceDocumentIdentity,
  type ReplicaSourceDocumentIdentity,
} from '../replica/source-identity';
import {
  hasSourceCredentialSecretAncestor,
  hasSourceImageCaptureBlockingAncestor,
  readSourceFlatTreeElementPath,
} from '../replica/source-privacy-policy';
import {
  receiverSafeAnimationFrameCanceller,
  receiverSafeAnimationFrameScheduler,
  type AnimationFrameCanceller,
  type AnimationFrameScheduler,
} from '../browser-scheduling';
import type { ImageVisibilityTier } from './contracts';
import type { ImageSourceReadySummary } from './image-source-protocol';
import type { SourceImageUpsert } from './source-image-model';
import {
  imageTransformIsAxisAligned,
  styleAllowsImageCapture,
} from './image-capture-style';

export type SourceImageObservationEvent =
  | { readonly kind: 'upsert'; readonly input: SourceImageUpsert }
  | {
      readonly kind: 'remove';
      readonly document: ReplicaSourceDocumentIdentity;
      readonly nodeId: number;
    };

interface ElementObserver<TElement extends Element> {
  observe(target: TElement): void;
  unobserve(target: TElement): void;
  disconnect(): void;
}

interface MutationObserverPort {
  observe(target: Node, options: MutationObserverInit): void;
  disconnect(): void;
}

export interface SourceImageObserverEnvironment {
  readonly document: Document;
  readonly documentIdentity: ReplicaSourceDocumentIdentity;
  readonly getNodeId: (image: HTMLImageElement) => number | undefined;
  readonly createIntersectionObserver: (
    callback: (entries: readonly IntersectionObserverEntry[]) => void,
    options: IntersectionObserverInit,
  ) => ElementObserver<Element>;
  readonly createResizeObserver: (
    callback: (entries: readonly ResizeObserverEntry[]) => void,
  ) => ElementObserver<Element>;
  readonly createMutationObserver: (
    callback: (records: readonly MutationRecord[]) => void,
  ) => MutationObserverPort;
  readonly isPrivateImage?: (image: HTMLImageElement) => boolean;
  /** Refresh a shared, document-wide admission index before a global scan. */
  readonly beforeRefreshAll?: () => void;
  /**
   * Refresh shared admission before this mutation batch can discover/read an
   * image. `true` requests a global scan, `false` proves the batch unrelated,
   * and `undefined` retains the observer's generic relationship fallback.
   */
  readonly beforeMutationRead?: (
    records: readonly MutationRecord[],
  ) => boolean | undefined;
  /** Whether a completed transition can change document-wide admission. */
  readonly layoutSettleRequiresRefreshAll?: (target: Element) => boolean;
  readonly scheduleFrame?: AnimationFrameScheduler;
  readonly cancelFrame?: AnimationFrameCanceller;
  readonly setTimer?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly maxImages?: number;
  readonly maxSubscribers?: number;
}

export const MAX_OBSERVED_SOURCE_IMAGES = 10_000;
export const MAX_SOURCE_IMAGE_OBSERVER_SUBSCRIBERS = 16;
export const MAX_SOURCE_IMAGE_IDENTITY_RETRY_FRAMES = 4;
const MAX_IMAGE_DIMENSION = 1_000_000;
const MAX_PRIVATE_TOKEN_INPUT = 64 * 1024;
const MAX_SOURCE_IMAGE_TRAVERSAL_NODES = 50_000;
const MAX_SOURCE_IMAGE_OPEN_ROOTS = 1_024;
const MAX_SOURCE_SHADOW_HOST_CANDIDATES = 50_000;
const MAX_SOURCE_SHADOW_HOSTS_PER_TICK = 1_000;
const MAX_SOURCE_IMAGE_MUTATION_RECORDS = 2_048;
const MAX_SOURCE_IMAGE_MUTATION_CHILD_NODES = 4_096;
const OPEN_SHADOW_DISCOVERY_INTERVAL_MS = 1_000;
const MAX_CAPTURE_SAFETY_SCAN_ELEMENTS = 50_000;
const MAX_CAPTURE_SAFETY_TARGETS = 1_024;
const MAX_CAPTURE_OVERLAP_COMPARISONS = 50_000;
const MAX_LAYOUT_SETTLE_TARGETS = 256;
const UNREADABLE_OPEN_SHADOW_ROOT = Symbol('unreadable-open-shadow-root');
type OpenShadowRootRead = ShadowRoot | null |
  typeof UNREADABLE_OPEN_SHADOW_ROOT;
const LAYOUT_SETTLE_EVENT_TYPES = Object.freeze([
  'transitionend',
  'transitioncancel',
  'animationend',
  'animationcancel',
  'beforetoggle',
  'toggle',
] as const);
const IMAGE_CAPTURE_ROUTING_ATTRIBUTES = new Set([
  'alt',
  'autocomplete',
  'aria-label',
  'aria-hidden',
  'aria-selected',
  'aria-controls',
  'aria-expanded',
  'aria-haspopup',
  'aria-pressed',
  'contenteditable',
  'class',
  'hidden',
  'href',
  'id',
  'open',
  'popover',
  'role',
  'style',
  'type',
]);
const SOURCE_IMAGE_MUTATION_OPTIONS: MutationObserverInit = Object.freeze({
  attributes: true,
  characterData: true,
  childList: true,
  subtree: true,
});
const EXPLICIT_CONTENT_ROUTING_ATTRIBUTES = new Set([
  'alt',
  'aria-label',
  'aria-hidden',
  'aria-selected',
  'aria-controls',
  'aria-expanded',
  'aria-haspopup',
  'aria-pressed',
  'hidden',
  'lang',
  'role',
]);
const CAPTURE_GEOMETRY_OR_SAFETY_ATTRIBUTES = new Set([
  'aria-hidden',
  'aria-haspopup',
  'autocomplete',
  'class',
  'contenteditable',
  'hidden',
  'href',
  'id',
  'open',
  'popover',
  'role',
  'style',
  'type',
]);

type PrivateSourceToken =
  | { readonly kind: 'exact'; readonly value: string }
  | { readonly kind: 'oversized' };

interface ImageFacts {
  readonly renderedWidth: number;
  readonly renderedHeight: number;
  readonly intrinsicWidth: number;
  readonly intrinsicHeight: number;
  readonly viewportToken: string;
  readonly safetyBounds: CaptureSafetyBounds;
}

interface CaptureSafetyBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

interface CaptureSafetyRelationAssessment {
  readonly changedImages: ReadonlySet<HTMLImageElement>;
  readonly controlBounds: ReadonlyMap<Element, CaptureSafetyBounds>;
}

interface ObservedImageState {
  readonly image: HTMLImageElement;
  readonly nodeId: number;
  sourceToken: PrivateSourceToken;
  routingToken: PrivateSourceToken;
  layoutToken: PrivateSourceToken;
  viewportToken: string;
  visibleSettled: boolean;
  nearSettled: boolean;
  safetyBounds: CaptureSafetyBounds;
  lastEvent?: Extract<SourceImageObservationEvent, { kind: 'upsert' }>;
}

const OVERSIZED_PRIVATE_SOURCE_TOKEN: PrivateSourceToken = Object.freeze({
  kind: 'oversized',
});

/**
 * Shared source-frame adapter. Raw URL-like attributes are kept only as a
 * bounded private comparison token and never leave this object.
 */
export class SourceImageObserver {
  readonly #environment: SourceImageObserverEnvironment;
  readonly #documentIdentity: ReplicaSourceDocumentIdentity;
  readonly #maxImages: number;
  readonly #maxSubscribers: number;
  readonly #scheduleFrame: AnimationFrameScheduler;
  readonly #cancelFrame: AnimationFrameCanceller;
  readonly #setTimer: (callback: () => void, milliseconds: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  readonly #listeners = new Set<(event: SourceImageObservationEvent) => void>();
  readonly #states = new Map<HTMLImageElement, ObservedImageState>();
  readonly #capacityCandidates = new Set<HTMLImageElement>();
  readonly #identityCandidates = new Map<HTMLImageElement, number>();
  readonly #visible = new Set<HTMLImageElement>();
  readonly #near = new Set<HTMLImageElement>();
  #visibleObserver: ElementObserver<Element> | undefined;
  #nearObserver: ElementObserver<Element> | undefined;
  #resizeObserver: ElementObserver<Element> | undefined;
  #mutationObserver: MutationObserverPort | undefined;
  #observedMutationRoots = new WeakSet<Node>();
  #observedMutationRootCount = 0;
  #rootObservationOverflow = false;
  #shadowHostCandidates: Element[] = [];
  #knownShadowHostCandidates = new WeakSet<Element>();
  #settledShadowHostCandidates = new WeakSet<Element>();
  #shadowHostCursor = 0;
  readonly #eventRoots = new Set<Document | ShadowRoot>();
  #loadListener: ((event: Event) => void) | undefined;
  #viewportListener: (() => void) | undefined;
  #scrollListener: (() => void) | undefined;
  #layoutSettleListener: ((event: Event) => void) | undefined;
  #fontSettleListener: (() => void) | undefined;
  #scrollFrame: number | undefined;
  #layoutSettleFrame: number | undefined;
  #layoutSettleRefreshAll = false;
  #layoutSettleSafetyRefreshAll = false;
  readonly #layoutSettleTargets = new Set<Element>();
  readonly #layoutSettleSafetyTargets = new Set<Element>();
  readonly #captureSafetyBounds = new Map<Element, CaptureSafetyBounds>();
  #captureSafetyBoundsReliable = true;
  #identityRetryFrame: number | undefined;
  #shadowDiscoveryTimer: unknown;
  #started = false;
  #lifecycleGeneration = 0;
  #fillingCapacity = false;

  constructor(environment: SourceImageObserverEnvironment) {
    const documentIdentity = readSourceDocumentIdentity(
      environment.documentIdentity,
    );
    if (!documentIdentity) {
      throw new Error('Invalid source image observer document identity.');
    }
    this.#environment = environment;
    this.#documentIdentity = documentIdentity;
    this.#maxImages = boundedPositiveInteger(
      environment.maxImages,
      MAX_OBSERVED_SOURCE_IMAGES,
      MAX_OBSERVED_SOURCE_IMAGES,
    );
    this.#maxSubscribers = boundedPositiveInteger(
      environment.maxSubscribers,
      MAX_SOURCE_IMAGE_OBSERVER_SUBSCRIBERS,
      MAX_SOURCE_IMAGE_OBSERVER_SUBSCRIBERS,
    );
    const view = environment.document.defaultView;
    this.#scheduleFrame = environment.scheduleFrame
      ? receiverSafeAnimationFrameScheduler(environment.scheduleFrame)
      : (callback) => {
          if (typeof view?.requestAnimationFrame === 'function') {
            return view.requestAnimationFrame(() => callback());
          }
          queueMicrotask(callback);
          return 0;
        };
    this.#cancelFrame = environment.cancelFrame
      ? receiverSafeAnimationFrameCanceller(environment.cancelFrame)
      : (handle) => {
          if (
            handle !== 0 &&
            typeof view?.cancelAnimationFrame === 'function'
          ) view.cancelAnimationFrame(handle);
        };
    this.#setTimer = environment.setTimer ?? ((callback, milliseconds) =>
      view?.setTimeout(callback, milliseconds) ?? setTimeout(callback, milliseconds));
    this.#clearTimer = environment.clearTimer ?? ((handle) => {
      if (view) view.clearTimeout(handle as number);
      else clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
  }

  get subscriberCount(): number {
    return this.#listeners.size;
  }

  /** Safe counts only: no source URLs, text, node identifiers, or pixels. */
  get readySummary(): ImageSourceReadySummary {
    let candidateImages = this.#states.size;
    try {
      const scan = collectBoundedImageGraph(
        [this.#environment.document],
        createSourceImageTraversalBudget(this.#maxImages),
      );
      candidateImages = Math.max(
        candidateImages,
        scan.images.length,
      );
    } catch {
      // A hostile/synthetic DOM cannot suppress the already-observed count.
    }
    return Object.freeze({
      candidateImages,
      observedImages: this.#states.size,
    });
  }

  subscribe(
    listener: (event: SourceImageObservationEvent) => void,
  ): () => void {
    if (this.#listeners.has(listener)) {
      throw new Error('Source image observer listener is already subscribed.');
    }
    if (this.#listeners.size >= this.#maxSubscribers) {
      throw new Error('Source image observer subscriber capacity exceeded.');
    }
    this.#listeners.add(listener);
    if (!this.#started) {
      this.#start();
    } else {
      for (const state of this.#states.values()) {
        if (state.lastEvent) listener(state.lastEvent);
      }
    }
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.#stop();
    };
  }

  refreshAll(): void {
    if (!this.#started) return;
    this.#performGlobalRefresh(false);
  }

  /** Refresh one requested image without rewalking unrelated page content. */
  refreshImage(image: HTMLImageElement): void {
    if (!this.#started) return;
    this.#refresh(image);
  }

  /** CSSOM has no MutationRecord, so conservatively re-prove every image. */
  refreshAfterStyleChange(): void {
    if (!this.#started) return;
    this.#performGlobalRefresh(true, false, true);
  }

  #performGlobalRefresh(
    forceObservationChange: boolean,
    forceContentChange = false,
    forceCaptureChange = false,
  ): void {
    try {
      this.#environment.beforeRefreshAll?.();
    } catch {
      // The admission callback owns fail-closed state. Continue the bounded
      // scan so previously admitted images can still be withdrawn.
    }
    this.#refreshAllFromCurrentAdmission(
      forceObservationChange,
      forceContentChange,
      forceCaptureChange,
    );
    this.#rebuildCaptureSafetyBounds();
  }

  #refreshAfterViewportChange(): void {
    const images = new Set(this.#states.keys());
    const currentControls = collectCurrentCaptureControlTargets(
      this.#environment.document,
    );
    const safetyAssessment = currentControls
      ? this.#captureSafetyRelationChanges(images, currentControls)
      : undefined;
    const failClosedCandidates = safetyAssessment?.changedImages ?? images;
    try {
      this.#environment.beforeRefreshAll?.();
    } catch {
      // Continue so previously admitted images can still be withdrawn.
    }
    this.#refreshAllFromCurrentAdmission(
      false,
      false,
      false,
      failClosedCandidates,
    );
    this.#applyCaptureSafetyAssessment(safetyAssessment);
  }

  dispose(): void {
    this.#listeners.clear();
    this.#stop();
  }

  #start(): void {
    this.#started = true;
    const generation = ++this.#lifecycleGeneration;
    this.#visibleObserver = this.#environment.createIntersectionObserver(
      (entries) => {
        if (!this.#isActiveGeneration(generation)) return;
        this.#onIntersection(entries, 'visible');
      },
      { rootMargin: '0px', threshold: 0.01 },
    );
    this.#nearObserver = this.#environment.createIntersectionObserver(
      (entries) => {
        if (!this.#isActiveGeneration(generation)) return;
        this.#onIntersection(entries, 'near');
      },
      { rootMargin: '100% 0px', threshold: 0 },
    );
    this.#resizeObserver = this.#environment.createResizeObserver((entries) => {
      if (!this.#isActiveGeneration(generation)) return;
      for (const entry of entries) {
        if (isImageElement(entry.target)) this.#refresh(entry.target);
      }
    });
    this.#mutationObserver = this.#environment.createMutationObserver(
      (records) => {
        if (!this.#isActiveGeneration(generation)) return;
        this.#onMutations(records);
      },
    );
    this.#loadListener = (event) => {
      if (!this.#isActiveGeneration(generation)) return;
      if (isImageElement(event.target)) {
        this.#refresh(event.target, true, false, true);
      } else if (isElement(event.target) && isStyleSourceElement(event.target)) {
        // A passive stylesheet can change panel proof and image geometry
        // without mutating any observed attribute after its load completes.
        this.#queueLayoutSettle(undefined, true, true);
      }
    };
    this.#viewportListener = () => {
      if (!this.#isActiveGeneration(generation)) return;
      this.#refreshAfterViewportChange();
    };
    this.#scrollListener = () => {
      if (!this.#isActiveGeneration(generation) || this.#scrollFrame !== undefined) {
        return;
      }
      this.#scrollFrame = this.#scheduleFrame(() => {
        this.#scrollFrame = undefined;
        if (!this.#isActiveGeneration(generation)) return;
        const visible = new Set(this.#visible);
        // DOM mutations keep the private identity ledger current. Ordinary
        // scrolling only remeasures those known identities; it never repeats
        // document-wide control classification or style traversal.
        const knownControls = this.#captureSafetyBoundsReliable
          ? [...this.#captureSafetyBounds.keys()]
          : undefined;
        const safetyAssessment = knownControls
          ? this.#captureSafetyRelationChanges(visible, knownControls)
          : undefined;
        const failClosedCandidates = safetyAssessment?.changedImages ?? visible;
        for (const image of visible) {
          const captureSafetyChanged = failClosedCandidates.has(image);
          this.#refresh(
            image,
            false,
            captureSafetyChanged,
            captureSafetyChanged,
          );
        }
        this.#applyCaptureSafetyAssessment(safetyAssessment);
      });
    };
    this.#layoutSettleListener = (event) => {
      if (!this.#isActiveGeneration(generation) || !isElement(event.target)) {
        return;
      }
      let refreshAll = false;
      try {
        refreshAll = this.#environment.layoutSettleRequiresRefreshAll?.(
          event.target,
        ) === true;
      } catch {
        // An unreadable admission context must not retain stale eligibility.
        refreshAll = true;
      }
      this.#queueLayoutSettle(
        event.target,
        refreshAll,
        elementSettleMayChangeCaptureOverlap(event.target),
      );
    };
    this.#fontSettleListener = () => {
      if (!this.#isActiveGeneration(generation)) return;
      this.#queueLayoutSettle(undefined, true, true);
    };
    this.#observeSourceRoot(this.#environment.document);
    this.#environment.document.defaultView?.addEventListener(
      'resize',
      this.#viewportListener,
    );
    try {
      this.#environment.document.fonts?.addEventListener(
        'loadingdone',
        this.#fontSettleListener,
      );
    } catch {
      // Font notifications are an optional settle hint, never an admission
      // bypass. DOM/style/load/transition signals continue to cover updates.
    }
    const scan = this.#scanDocumentImages();
    this.#discoverCandidates(scan.images);
    this.#rebuildCaptureSafetyBounds();
    this.#scheduleShadowDiscovery();
  }

  #stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.#lifecycleGeneration += 1;
    if (this.#viewportListener) {
      this.#environment.document.defaultView?.removeEventListener(
        'resize',
        this.#viewportListener,
      );
    }
    for (const root of this.#eventRoots) {
      if (this.#loadListener) {
        root.removeEventListener('load', this.#loadListener, true);
      }
      if (this.#scrollListener) {
        root.removeEventListener('scroll', this.#scrollListener, true);
      }
      if (this.#layoutSettleListener) {
        for (const type of LAYOUT_SETTLE_EVENT_TYPES) {
          root.removeEventListener(type, this.#layoutSettleListener, true);
        }
      }
    }
    this.#eventRoots.clear();
    if (this.#fontSettleListener) {
      try {
        this.#environment.document.fonts?.removeEventListener(
          'loadingdone',
          this.#fontSettleListener,
        );
      } catch {
        // The source document may already have torn down its FontFaceSet.
      }
    }
    if (this.#scrollFrame !== undefined) {
      this.#cancelFrame(this.#scrollFrame);
      this.#scrollFrame = undefined;
    }
    if (this.#identityRetryFrame !== undefined) {
      this.#cancelFrame(this.#identityRetryFrame);
      this.#identityRetryFrame = undefined;
    }
    if (this.#layoutSettleFrame !== undefined) {
      this.#cancelFrame(this.#layoutSettleFrame);
      this.#layoutSettleFrame = undefined;
    }
    if (this.#shadowDiscoveryTimer !== undefined) {
      this.#clearTimer(this.#shadowDiscoveryTimer);
      this.#shadowDiscoveryTimer = undefined;
    }
    this.#visibleObserver?.disconnect();
    this.#nearObserver?.disconnect();
    this.#resizeObserver?.disconnect();
    this.#mutationObserver?.disconnect();
    this.#visibleObserver = undefined;
    this.#nearObserver = undefined;
    this.#resizeObserver = undefined;
    this.#mutationObserver = undefined;
    this.#observedMutationRoots = new WeakSet<Node>();
    this.#observedMutationRootCount = 0;
    this.#rootObservationOverflow = false;
    this.#shadowHostCandidates = [];
    this.#knownShadowHostCandidates = new WeakSet<Element>();
    this.#settledShadowHostCandidates = new WeakSet<Element>();
    this.#shadowHostCursor = 0;
    this.#loadListener = undefined;
    this.#viewportListener = undefined;
    this.#scrollListener = undefined;
    this.#layoutSettleListener = undefined;
    this.#fontSettleListener = undefined;
    this.#states.clear();
    this.#capacityCandidates.clear();
    this.#identityCandidates.clear();
    this.#visible.clear();
    this.#near.clear();
    this.#layoutSettleTargets.clear();
    this.#layoutSettleSafetyTargets.clear();
    this.#layoutSettleRefreshAll = false;
    this.#layoutSettleSafetyRefreshAll = false;
    this.#captureSafetyBounds.clear();
    this.#captureSafetyBoundsReliable = true;
    this.#fillingCapacity = false;
  }

  #observeSourceRoot(root: Document | ShadowRoot): boolean {
    if (!this.#mutationObserver) return false;
    if (this.#observedMutationRoots.has(root)) return true;
    if (this.#observedMutationRootCount >= MAX_SOURCE_IMAGE_OPEN_ROOTS + 1) {
      this.#rootObservationOverflow = true;
      return false;
    }
    this.#observedMutationRoots.add(root);
    this.#observedMutationRootCount += 1;
    this.#mutationObserver.observe(root, SOURCE_IMAGE_MUTATION_OPTIONS);
    this.#eventRoots.add(root);
    if (this.#loadListener) root.addEventListener('load', this.#loadListener, true);
    if (this.#scrollListener) {
      root.addEventListener('scroll', this.#scrollListener, true);
    }
    if (this.#layoutSettleListener) {
      for (const type of LAYOUT_SETTLE_EVENT_TYPES) {
        root.addEventListener(type, this.#layoutSettleListener, true);
      }
    }
    return true;
  }

  #scanDocumentImages(): BoundedImageGraph {
    const scan = collectBoundedImageGraph(
      [this.#environment.document],
      createSourceImageTraversalBudget(this.#maxImages),
    );
    this.#registerShadowHostCandidates(scan.hostCandidates);
    for (const root of scan.openRoots) this.#observeSourceRoot(root);
    return filterImagesToObservedRoots(scan, this.#observedMutationRoots);
  }

  #scanMutationImages(
    nodes: Iterable<Node>,
    budget: SourceImageTraversalBudget,
  ): BoundedImageGraph {
    const scan = collectBoundedImageGraph(nodes, budget);
    this.#registerShadowHostCandidates(scan.hostCandidates);
    for (const root of scan.openRoots) {
      if (!this.#observeSourceRoot(root)) budget.overflow = true;
    }
    return filterImagesToObservedRoots(scan, this.#observedMutationRoots);
  }

  #knownImagesWithin(node: Node): readonly HTMLImageElement[] {
    const contained: HTMLImageElement[] = [];
    for (const image of this.#states.keys()) {
      try {
        if (node === image || node.contains(image)) {
          contained.push(image);
          continue;
        }
      } catch {
        // Fall through to the bounded flat-tree identity walk.
      }
      if (node.nodeType === 1) {
        const path = readSourceFlatTreeElementPath(image);
        if (path?.includes(node as Element)) contained.push(image);
      } else if (node.nodeType === 11 && image.getRootNode() === node) {
        contained.push(image);
      }
    }
    return Object.freeze(contained);
  }

  #removedMutationImages(
    node: Node,
    budget: SourceImageTraversalBudget,
  ): readonly HTMLImageElement[] {
    const scan = collectBoundedImageGraph([node], budget);
    if (scan.overflow) {
      // Exceptional overflow falls back to the identity walk, then the caller
      // performs a fail-closed global refresh after finishing the batch.
      return this.#knownImagesWithin(node);
    }
    return Object.freeze(scan.images.filter((image) => this.#states.has(image)));
  }

  #scheduleShadowDiscovery(): void {
    if (
      !this.#started || this.#rootObservationOverflow ||
      this.#shadowHostCandidates.length === 0 ||
      this.#shadowDiscoveryTimer !== undefined
    ) return;
    const generation = this.#lifecycleGeneration;
    this.#shadowDiscoveryTimer = this.#setTimer(() => {
      this.#shadowDiscoveryTimer = undefined;
      if (!this.#isActiveGeneration(generation)) return;
      this.#discoverNewOpenShadowRoots();
      this.#scheduleShadowDiscovery();
    }, OPEN_SHADOW_DISCOVERY_INTERVAL_MS);
  }

  #registerShadowHostCandidates(candidates: readonly Element[]): void {
    let added = false;
    for (const candidate of candidates) {
      if (
        this.#knownShadowHostCandidates.has(candidate) ||
        this.#settledShadowHostCandidates.has(candidate)
      ) continue;
      if (this.#shadowHostCandidates.length >= MAX_SOURCE_SHADOW_HOST_CANDIDATES) {
        this.#compactShadowHostCandidates();
      }
      if (this.#shadowHostCandidates.length >= MAX_SOURCE_SHADOW_HOST_CANDIDATES) {
        return;
      }
      this.#knownShadowHostCandidates.add(candidate);
      this.#shadowHostCandidates.push(candidate);
      added = true;
    }
    if (added) this.#scheduleShadowDiscovery();
  }

  #compactShadowHostCandidates(nextCandidate?: Element): void {
    const retained = this.#shadowHostCandidates.filter(
      (candidate) =>
        candidate.isConnected &&
        !this.#settledShadowHostCandidates.has(candidate),
    );
    this.#shadowHostCandidates = retained;
    this.#knownShadowHostCandidates = new WeakSet(retained);
    if (retained.length === 0) {
      this.#shadowHostCursor = 0;
      return;
    }
    const nextIndex = nextCandidate === undefined
      ? -1
      : retained.indexOf(nextCandidate);
    this.#shadowHostCursor = nextIndex >= 0
      ? nextIndex
      : this.#shadowHostCursor % retained.length;
  }

  #discoverNewOpenShadowRoots(): void {
    const candidateCount = this.#shadowHostCandidates.length;
    if (candidateCount === 0) return;
    const scanCount = Math.min(
      candidateCount,
      MAX_SOURCE_SHADOW_HOSTS_PER_TICK,
    );
    let processed = 0;
    let shouldCompact = false;
    let discoveredRoot = false;
    for (let offset = 0; offset < scanCount; offset += 1) {
      const index = (this.#shadowHostCursor + offset) % candidateCount;
      const host = this.#shadowHostCandidates[index];
      processed += 1;
      if (!host?.isConnected) {
        shouldCompact = true;
        continue;
      }
      const root = readOpenSourceShadowRoot(host);
      if (root === UNREADABLE_OPEN_SHADOW_ROOT) {
        // Do not keep claiming complete open-root coverage after a host makes
        // that relationship unreadable. Existing directly observed roots stay
        // active, but periodic discovery stops at this fail-closed boundary.
        this.#rootObservationOverflow = true;
        return;
      }
      if (!root) continue;
      this.#settledShadowHostCandidates.add(host);
      shouldCompact = true;
      if (this.#observedMutationRoots.has(root)) continue;
      if (!this.#observeSourceRoot(root)) return;
      discoveredRoot = true;
      const scan = this.#scanMutationImages(
        [root],
        createSourceImageTraversalBudget(this.#maxImages),
      );
      if (!scan.overflow) this.#discoverCandidates(scan.images);
    }
    const nextCandidate = this.#shadowHostCandidates[
      (this.#shadowHostCursor + processed) % candidateCount
    ];
    this.#shadowHostCursor =
      (this.#shadowHostCursor + processed) % candidateCount;
    if (shouldCompact) this.#compactShadowHostCandidates(nextCandidate);
    if (discoveredRoot) this.#refreshAfterViewportChange();
  }

  #discover(image: HTMLImageElement, admissionChecked = false): void {
    if (
      !this.#started ||
      !image.isConnected ||
      (!admissionChecked && this.#isPrivate(image))
    ) {
      this.#forgetIdentityCandidate(image);
      return;
    }
    const nodeId = this.#readNodeId(image);
    const existing = this.#states.get(image);
    if (!isNodeId(nodeId)) {
      if (existing) this.#remove(image, existing, false);
      this.#queueIdentityRetry(image);
      return;
    }
    this.#forgetIdentityCandidate(image);
    if (existing?.nodeId === nodeId) {
      this.#refresh(image);
      return;
    }
    if (existing) this.#remove(image, existing, false);
    const facts = readImageFacts(image);
    if (!facts) return;
    if (this.#states.size >= this.#maxImages) {
      if (this.#capacityCandidates.size < this.#maxImages) {
        this.#capacityCandidates.add(image);
      }
      return;
    }
    this.#capacityCandidates.delete(image);
    const processingTokens = readPrivateProcessingTokens(image);
    const state: ObservedImageState = {
      image,
      nodeId,
      sourceToken: readPrivateSourceToken(image),
      routingToken: processingTokens.routingToken,
      layoutToken: processingTokens.layoutToken,
      viewportToken: facts.viewportToken,
      visibleSettled: false,
      nearSettled: false,
      safetyBounds: facts.safetyBounds,
    };
    this.#states.set(image, state);
    this.#visibleObserver?.observe(image);
    this.#nearObserver?.observe(image);
    this.#resizeObserver?.observe(image);
    if (!state.lastEvent) this.#emitUpsert(state, true, true, true, facts);
  }

  #refresh(
    image: HTMLImageElement,
    forceContentChange = false,
    forceObservationChange = false,
    forceCaptureChange = false,
  ): void {
    if (!this.#started) return;
    const state = this.#states.get(image);
    if (!state) {
      this.#discover(image);
      return;
    }
    const currentNodeId = this.#readNodeId(image);
    if (
      !image.isConnected ||
      !isNodeId(currentNodeId) ||
      currentNodeId !== state.nodeId ||
      this.#isPrivate(image)
    ) {
      this.#remove(image, state, false);
      if (
        image.isConnected &&
        isNodeId(currentNodeId) &&
        !this.#isPrivate(image)
      ) this.#discover(image);
      this.#fillCapacity();
      return;
    }
    const facts = readImageFacts(image);
    if (!facts) {
      this.#remove(image, state);
      return;
    }
    const token = readPrivateSourceToken(image);
    const processingTokens = readPrivateProcessingTokens(image);
    const sourceChanged = privateSourceTokenChanged(state.sourceToken, token);
    const contentChanged = forceContentChange || sourceChanged ||
      privateSourceTokenChanged(
        state.routingToken,
        processingTokens.routingToken,
      );
    const cropChanged = state.viewportToken !== facts.viewportToken;
    const layoutChanged = privateSourceTokenChanged(
      state.layoutToken,
      processingTokens.layoutToken,
    );
    const previous = state.lastEvent?.input;
    const dimensionsChanged = !previous ||
      previous.renderedWidth !== facts.renderedWidth ||
      previous.renderedHeight !== facts.renderedHeight ||
      previous.intrinsicWidth !== facts.intrinsicWidth ||
      previous.intrinsicHeight !== facts.intrinsicHeight;
    const captureChanged = forceCaptureChange || sourceChanged || cropChanged ||
      layoutChanged || dimensionsChanged;
    const observationChanged = forceObservationChange || cropChanged ||
      layoutChanged;
    state.sourceToken = token;
    state.routingToken = processingTokens.routingToken;
    state.layoutToken = processingTokens.layoutToken;
    state.viewportToken = facts.viewportToken;
    state.safetyBounds = facts.safetyBounds;
    this.#emitUpsert(
      state,
      contentChanged,
      observationChanged,
      captureChanged,
      facts,
    );
  }

  #emitUpsert(
    state: ObservedImageState,
    contentChanged: boolean,
    observationChanged: boolean,
    captureChanged: boolean,
    facts: ImageFacts,
  ): void {
    // IntersectionObserver reports an initial state for every observed image.
    // Wait for both tiers so an above-the-fold image is never first queued as
    // background work and immediately superseded by its visible observation.
    if (!state.visibleSettled || !state.nearSettled) return;
    const initial = state.lastEvent === undefined;
    const input: SourceImageUpsert = Object.freeze({
      document: this.#documentIdentity,
      nodeId: state.nodeId,
      contentChanged: initial || contentChanged,
      observationChanged: initial || observationChanged,
      captureChanged: initial || captureChanged,
      visibility: this.#visibility(state.image),
      connected: true,
      renderedWidth: facts.renderedWidth,
      renderedHeight: facts.renderedHeight,
      intrinsicWidth: facts.intrinsicWidth,
      intrinsicHeight: facts.intrinsicHeight,
    });
    const event = Object.freeze({ kind: 'upsert' as const, input });
    if (sameObservation(state.lastEvent?.input, input)) return;
    state.lastEvent = event;
    this.#emit(event);
  }

  #remove(
    image: HTMLImageElement,
    state?: ObservedImageState,
    refill = true,
  ): void {
    this.#capacityCandidates.delete(image);
    this.#forgetIdentityCandidate(image);
    const current = state ?? this.#states.get(image);
    if (!current) return;
    this.#states.delete(image);
    this.#visible.delete(image);
    this.#near.delete(image);
    this.#visibleObserver?.unobserve(image);
    this.#nearObserver?.unobserve(image);
    this.#resizeObserver?.unobserve(image);
    this.#emit(Object.freeze({
      kind: 'remove',
      document: this.#documentIdentity,
      nodeId: current.nodeId,
    }));
    if (refill) this.#fillCapacity();
  }

  #fillCapacity(): void {
    if (
      !this.#started ||
      this.#fillingCapacity ||
      this.#states.size >= this.#maxImages
    ) return;
    this.#fillingCapacity = true;
    try {
      for (const image of [...this.#capacityCandidates]) {
        if (this.#states.size >= this.#maxImages) break;
        this.#capacityCandidates.delete(image);
        this.#discover(image);
      }
      if (this.#states.size >= this.#maxImages) return;
      const scan = this.#scanDocumentImages();
      for (const image of this.#eligibleDiscoveryCandidates(
        scan.images.filter(
          (candidate) => !this.#states.has(candidate),
        ),
      )) {
        if (this.#states.size >= this.#maxImages) break;
        this.#discover(image, true);
      }
    } finally {
      this.#fillingCapacity = false;
    }
  }

  #onIntersection(
    entries: readonly IntersectionObserverEntry[],
    tier: 'visible' | 'near',
  ): void {
    if (!this.#started) return;
    const set = tier === 'visible' ? this.#visible : this.#near;
    for (const entry of entries) {
      if (!isImageElement(entry.target)) continue;
      const state = this.#states.get(entry.target);
      if (!state) continue;
      if (tier === 'visible') state.visibleSettled = true;
      else state.nearSettled = true;
      if (entry.isIntersecting) set.add(entry.target);
      else set.delete(entry.target);
      this.#refresh(entry.target);
    }
  }

  #onMutations(records: readonly MutationRecord[]): void {
    if (!this.#started) return;
    if (records.length > MAX_SOURCE_IMAGE_MUTATION_RECORDS) {
      // A hostile delivery cannot induce unbounded record×subtree work. One
      // global privacy refresh advances both content and observation evidence.
      this.#performGlobalRefresh(true, true, true);
      return;
    }
    let mutationChildNodes = 0;
    let externalStyleMutation = false;
    for (const record of records) {
      if (record.type === 'characterData') {
        externalStyleMutation ||= isInsideStyleSource(record.target);
        continue;
      }
      if (record.type === 'attributes' && isElement(record.target)) {
        externalStyleMutation ||= attributeAffectsExternalStyleSource(
          record.target,
          record.attributeName?.toLowerCase(),
        );
        continue;
      }
      if (record.type !== 'childList') continue;
      mutationChildNodes += record.addedNodes.length + record.removedNodes.length;
      if (mutationChildNodes > MAX_SOURCE_IMAGE_MUTATION_CHILD_NODES) {
        this.#performGlobalRefresh(true, true, true);
        return;
      }
      externalStyleMutation ||= isInsideStyleSource(record.target) ||
        [...record.addedNodes, ...record.removedNodes].some(
          containsStyleSourceElement,
        );
    }
    const traversalBudget = createSourceImageTraversalBudget(this.#maxImages);
    let controlledPolicyPrepared = false;
    let controlledPolicyChanged = false;
    if (this.#environment.beforeMutationRead) {
      try {
        const result = this.#environment.beforeMutationRead(records);
        controlledPolicyPrepared = result !== undefined;
        controlledPolicyChanged = result === true;
      } catch {
        // A failed admission refresh cannot leave previously admitted pixels
        // active under an unknown narrower policy.
        for (const [image, state] of [...this.#states]) {
          this.#remove(image, state, false);
        }
        return;
      }
    }
    if (!controlledPolicyPrepared || externalStyleMutation) {
      // Every delivered mutation is selector surface. Prepare document-wide
      // admission before discovering an added image or reading any existing
      // image/control geometry below.
      try {
        this.#environment.beforeRefreshAll?.();
      } catch {
        for (const [image, state] of [...this.#states]) {
          this.#remove(image, state, false);
        }
        return;
      }
    }
    const observedAtMutationStart = new Set(this.#states.keys());
    const routingCandidates = new Set<HTMLImageElement>();
    const forcedContentCandidates = new Set<HTMLImageElement>();
    const forcedCaptureCandidates = new Set<HTMLImageElement>();
    const safetyTargets = new Set<Element>();
    const currentOnlySafetyTargets = new Set<Element>();
    let refreshAllRouting = controlledPolicyChanged;
    let refreshStylesheetSafety = false;
    let safetyScopeAmbiguous = false;
    let stylesheetSafetySnapshot:
      ReadonlyMap<Element, CaptureSafetyBounds> | undefined;
    let stylesheetSafetyCandidates = new Set<HTMLImageElement>();
    for (const record of records) {
      if (record.type === 'characterData') {
        // Text-node presence is arbitrary selector surface through :empty,
        // sibling combinators, and :has(). Re-evaluate every existing image;
        // unchanged private routing tokens still coalesce to no event.
        refreshAllRouting = true;
        refreshStylesheetSafety = true;
        const owner = record.target.parentElement;
        if (owner && elementSettleMayChangeCaptureOverlap(owner)) {
          safetyTargets.add(owner);
        }
        continue;
      }
      if (record.type === 'childList') {
        // Child presence can change selectors outside the mutated subtree.
        // One callback-level global comparison covers the whole record burst.
        refreshAllRouting = true;
        refreshStylesheetSafety = true;
        for (const node of record.removedNodes) {
          for (const image of this.#removedMutationImages(
            node,
            traversalBudget,
          )) {
            // Mutation delivery observes the final batch state. A remove+add
            // reparent keeps identity, evidence, and the mounted overlay.
            if (image.isConnected) {
              routingCandidates.add(image);
            } else {
              this.#remove(image);
            }
          }
          if (
            !controlledPolicyPrepared &&
            containsControlledRelationshipElement(node)
          ) {
            refreshAllRouting = true;
          }
          if (containsHtmlBaseElement(node)) refreshAllRouting = true;
          if (containsStyleSourceElement(node)) {
            refreshAllRouting = true;
            refreshStylesheetSafety = true;
          }
          if (isElement(node) && elementCanAffectCapturedPixels(node)) {
            safetyTargets.add(node);
          }
        }
        for (const node of record.addedNodes) {
          const scan = this.#scanMutationImages([node], traversalBudget);
          const newImages: HTMLImageElement[] = [];
          for (const image of scan.images) {
            if (observedAtMutationStart.has(image)) {
              routingCandidates.add(image);
            } else {
              newImages.push(image);
            }
          }
          this.#discoverCandidates(newImages);
          if (
            !controlledPolicyPrepared &&
            containsControlledRelationshipElement(node)
          ) {
            refreshAllRouting = true;
          }
          if (isElement(node) && elementCanAffectCapturedPixels(node)) {
            currentOnlySafetyTargets.add(node);
            safetyTargets.add(node);
          }
          if (
            safetyTargets.size > MAX_CAPTURE_SAFETY_TARGETS ||
            currentOnlySafetyTargets.size > MAX_CAPTURE_SAFETY_TARGETS
          ) {
            safetyScopeAmbiguous = true;
          }
          if (containsHtmlBaseElement(node)) refreshAllRouting = true;
          if (containsStyleSourceElement(node)) {
            refreshAllRouting = true;
            refreshStylesheetSafety = true;
          }
        }
        if (isInsideStyleSource(record.target)) {
          refreshAllRouting = true;
          refreshStylesheetSafety = true;
        }
      }
      if (record.type !== 'attributes' || !isElement(record.target)) continue;
      const attributeName = record.attributeName?.toLowerCase();
      // Every authored attribute can participate in selectors, including
      // otherwise "known" routing attributes and attributes on a subtree that
      // already contains an image. A descendant-only proof cannot cover
      // sibling combinators or :has(); compare all current image facts once.
      refreshAllRouting = true;
      refreshStylesheetSafety = true;
      if (
        attributeName &&
        CAPTURE_GEOMETRY_OR_SAFETY_ATTRIBUTES.has(attributeName) &&
        elementSettleMayChangeCaptureOverlap(record.target)
      ) safetyTargets.add(record.target);
      if (
        attributeName === 'href' &&
        record.target.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
        record.target.localName.toLowerCase() === 'base'
      ) {
        refreshAllRouting = true;
        continue;
      }
      if (attributeAffectsExternalStyleSource(record.target, attributeName)) {
        refreshAllRouting = true;
        refreshStylesheetSafety = true;
        continue;
      }
      if (
        attributeName === 'aria-controls' ||
        attributeName === 'aria-selected' ||
        attributeName === 'id'
      ) {
        // aria-controls can target a sibling subtree, so descendant-only
        // invalidation cannot prove which image admission changed.
        if (!controlledPolicyPrepared) refreshAllRouting = true;
        for (const image of this.#scanMutationImages(
          [record.target],
          traversalBudget,
        ).images) {
          routingCandidates.add(image);
          if (attributeName !== 'id') forcedContentCandidates.add(image);
        }
        continue;
      }
      if (attributeName === 'lang') {
        for (const image of this.#scanMutationImages(
          [record.target],
          traversalBudget,
        ).images) {
          // Routing metadata is part of OCR content identity even though the
          // raw language attribute never leaves the source adapter.
          routingCandidates.add(image);
          forcedContentCandidates.add(image);
        }
        continue;
      }
      if (attributeName && IMAGE_CAPTURE_ROUTING_ATTRIBUTES.has(attributeName)) {
        for (const image of this.#scanMutationImages(
          [record.target],
          traversalBudget,
        ).images) {
          routingCandidates.add(image);
          if (EXPLICIT_CONTENT_ROUTING_ATTRIBUTES.has(attributeName)) {
            forcedContentCandidates.add(image);
          }
        }
        continue;
      }
      if (isImageElement(record.target)) {
        routingCandidates.add(record.target);
        if (
          attributeName === 'src' || attributeName === 'srcset' ||
          attributeName === 'sizes'
        ) {
          forcedContentCandidates.add(record.target);
          forcedCaptureCandidates.add(record.target);
        }
      } else if (record.target.tagName.toLowerCase() === 'source') {
        const picture = record.target.closest('picture');
        for (const image of picture
          ? this.#scanMutationImages([picture], traversalBudget).images
          : []) {
          routingCandidates.add(image);
          forcedContentCandidates.add(image);
          forcedCaptureCandidates.add(image);
        }
      }
    }
    if (traversalBudget.overflow) {
      this.#performGlobalRefresh(true, true, true);
      return;
    }
    if (refreshStylesheetSafety) {
      const currentSafetyTargets = collectCurrentCaptureControlTargets(
        this.#environment.document,
      );
      if (currentSafetyTargets) {
        const currentBounds = this.#readCaptureSafetyControlBounds(
          currentSafetyTargets,
        );
        const allControls = currentBounds
          ? new Set<Element>([
              ...this.#captureSafetyBounds.keys(),
              ...currentBounds.keys(),
            ])
          : undefined;
        const candidates = allControls && currentBounds
          ? this.#imagesOverlappedBy(allControls, currentBounds)
          : undefined;
        if (currentBounds) stylesheetSafetySnapshot = currentBounds;
        if (candidates) stylesheetSafetyCandidates = candidates;
        else {
          safetyScopeAmbiguous = true;
        }
      } else {
        safetyScopeAmbiguous = true;
      }
    }
    let safetyCandidates: Set<HTMLImageElement>;
    if (safetyScopeAmbiguous) {
      safetyCandidates = new Set(observedAtMutationStart);
    } else {
      const targetedSafety = this.#captureSafetyCandidatesForTargets(
        safetyTargets,
      );
      const addedSafety = this.#imagesOverlappedBy(currentOnlySafetyTargets);
      if (!targetedSafety || !addedSafety) {
        safetyCandidates = new Set(observedAtMutationStart);
      } else {
        safetyCandidates = targetedSafety;
        for (const image of addedSafety) safetyCandidates.add(image);
        for (const image of stylesheetSafetyCandidates) {
          safetyCandidates.add(image);
        }
      }
    }
    for (const image of [...safetyCandidates]) {
      if (!observedAtMutationStart.has(image)) safetyCandidates.delete(image);
    }
    const refreshedImages = new Set<HTMLImageElement>();
    for (const image of routingCandidates) {
      // A global refresh already discovers newly eligible images with a fresh
      // revision. Existing work advances only when its private routing token
      // proves that the mutation materially changed image processing.
      if (refreshAllRouting && !observedAtMutationStart.has(image)) continue;
      const captureSafetyChanged = safetyCandidates.delete(image);
      const forceCaptureChange = captureSafetyChanged ||
        forcedCaptureCandidates.has(image);
      this.#refresh(
        image,
        forcedContentCandidates.has(image),
        captureSafetyChanged,
        forceCaptureChange,
      );
      refreshedImages.add(image);
    }
    for (const image of safetyCandidates) {
      // The emitted event contains only a boolean currentness boundary. The
      // source session performs the exact private/control overlap check before
      // reading accessibility text or pixels.
      this.#refresh(image, false, true, true);
      refreshedImages.add(image);
    }
    if (refreshAllRouting) {
      // Run targeted forced-content work first so a single mutation cannot
      // advance the same image twice. This global selector proof then catches
      // remote siblings and newly eligible images while coalescing unchanged
      // routing, layout, and capture tokens.
      this.#refreshAllFromCurrentAdmission(
        false,
        false,
        false,
        new Set(),
        refreshedImages,
      );
    }
    if (refreshStylesheetSafety) {
      this.#applyCaptureSafetyAssessment(stylesheetSafetySnapshot
        ? Object.freeze({
            changedImages: stylesheetSafetyCandidates,
            controlBounds: stylesheetSafetySnapshot,
          })
        : undefined);
    } else {
      this.#refreshCaptureSafetyBounds(new Set([
        ...safetyTargets,
        ...currentOnlySafetyTargets,
      ]));
    }
  }

  #refreshAllFromCurrentAdmission(
    forceObservationChange = false,
    forceContentChange = false,
    forceCaptureChange = false,
    captureSafetyCandidates: ReadonlySet<HTMLImageElement> = new Set(),
    skipExistingImages: ReadonlySet<HTMLImageElement> = new Set(),
  ): void {
    // Existing admission may have just narrowed. Revalidate it before any
    // geometry-based attention ordering can touch a newly withheld image.
    for (const image of [...this.#states.keys()]) {
      if (skipExistingImages.has(image)) continue;
      const captureSafetyChanged = captureSafetyCandidates.has(image);
      this.#refresh(
        image,
        forceContentChange,
        forceObservationChange || captureSafetyChanged,
        forceContentChange || forceCaptureChange || captureSafetyChanged,
      );
    }
    const scan = this.#scanDocumentImages();
    for (const image of this.#eligibleDiscoveryCandidates(
      scan.images.filter(
        (candidate) => !this.#states.has(candidate),
      ),
    )) {
      this.#discover(image, true);
    }
  }

  #discoverCandidates(candidates: readonly HTMLImageElement[]): void {
    for (const image of this.#eligibleDiscoveryCandidates(candidates)) {
      this.#discover(image, true);
    }
  }

  #eligibleDiscoveryCandidates(
    candidates: readonly HTMLImageElement[],
  ): HTMLImageElement[] {
    const eligible: Array<{
      readonly image: HTMLImageElement;
      readonly attention: ImageVisualAttention;
      readonly order: number;
    }> = [];
    let order = 0;
    for (const image of candidates) {
      if (!this.#started || !image.isConnected || this.#isPrivate(image)) {
        this.#forgetIdentityCandidate(image);
        continue;
      }
      // Admission is resolved before the first geometry read. Attention is
      // computed exactly once per candidate, then sorted from cached numbers.
      eligible.push({ image, attention: readVisualAttention(image), order });
      order += 1;
    }
    eligible.sort((left, right) =>
      compareImageVisualAttention(left.attention, right.attention) ||
      left.order - right.order
    );
    return eligible.map(({ image }) => image);
  }

  /**
   * Transition/animation completions are bursty. Coalesce all affected images
   * into one post-paint frame; a stylesheet/font or relationship-relevant
   * settle escalates that one frame to a bounded global refresh.
   */
  #queueLayoutSettle(
    target: Element | undefined,
    refreshAll: boolean,
    captureSafetyRelevant = false,
  ): void {
    if (!this.#started) return;
    if (captureSafetyRelevant) {
      if (!target) {
        this.#layoutSettleSafetyRefreshAll = true;
      } else if (
        !this.#layoutSettleSafetyTargets.has(target) &&
        this.#layoutSettleSafetyTargets.size >= MAX_LAYOUT_SETTLE_TARGETS
      ) {
        this.#layoutSettleSafetyTargets.clear();
        this.#layoutSettleSafetyRefreshAll = true;
      } else if (!this.#layoutSettleSafetyRefreshAll) {
        this.#layoutSettleSafetyTargets.add(target);
      }
    }
    if (refreshAll) {
      this.#layoutSettleRefreshAll = true;
    } else if (target) {
      if (
        !this.#layoutSettleTargets.has(target) &&
        this.#layoutSettleTargets.size >= MAX_LAYOUT_SETTLE_TARGETS
      ) {
        // A hostile event burst cannot grow work without bound. One global
        // refresh is the fail-closed equivalent of the oversized target union.
        this.#layoutSettleTargets.clear();
        this.#layoutSettleRefreshAll = true;
      } else if (!this.#layoutSettleRefreshAll) {
        this.#layoutSettleTargets.add(target);
      }
    }
    if (
      (!this.#layoutSettleRefreshAll && this.#layoutSettleTargets.size === 0) ||
      this.#layoutSettleFrame !== undefined
    ) return;
    const generation = this.#lifecycleGeneration;
    this.#layoutSettleFrame = this.#scheduleFrame(() => {
      this.#layoutSettleFrame = undefined;
      if (!this.#isActiveGeneration(generation)) return;
      const refreshEveryImage = this.#layoutSettleRefreshAll;
      const refreshEveryImageForSafety = this.#layoutSettleSafetyRefreshAll;
      const targets = new Set(this.#layoutSettleTargets);
      const safetyTargets = new Set(this.#layoutSettleSafetyTargets);
      this.#layoutSettleRefreshAll = false;
      this.#layoutSettleSafetyRefreshAll = false;
      this.#layoutSettleTargets.clear();
      this.#layoutSettleSafetyTargets.clear();
      if (refreshEveryImageForSafety) {
        // Fonts and external styles can move images or protected controls, but
        // they do not by themselves prove that every image's pixels changed.
        // Reuse the bounded viewport reassessment so unchanged images retain
        // OCR capture currency; unreadable safety evidence still fails closed
        // by marking every observed image as a candidate.
        this.#refreshAfterViewportChange();
        return;
      }
      if (refreshEveryImage && safetyTargets.size > 0) {
        const safetyCandidates = this.#captureSafetyCandidatesForTargets(
          safetyTargets,
        ) ?? new Set(this.#states.keys());
        try {
          this.#environment.beforeRefreshAll?.();
        } catch {
          // Continue so a narrowed policy can still withdraw prior images.
        }
        this.#refreshAllFromCurrentAdmission(
          false,
          false,
          false,
          safetyCandidates,
        );
        this.#rebuildCaptureSafetyBounds();
        return;
      }
      if (refreshEveryImage) {
        this.#performGlobalRefresh(false);
        return;
      }
      const safetyCandidates = this.#captureSafetyCandidatesForTargets(
        safetyTargets,
      );
      if (!safetyCandidates) {
        this.#performGlobalRefresh(true, false, true);
        return;
      }
      for (const image of this.#states.keys()) {
        const path = readSourceFlatTreeElementPath(image);
        const captureSafetyChanged = safetyCandidates.has(image);
        if (
          captureSafetyChanged ||
          path?.some((element) => targets.has(element))
        ) {
          this.#refresh(
            image,
            false,
            captureSafetyChanged,
            captureSafetyChanged,
          );
        }
      }
      this.#refreshCaptureSafetyBounds(safetyTargets);
    });
  }

  #captureSafetyCandidatesForTargets(
    targets: ReadonlySet<Element>,
  ): Set<HTMLImageElement> | undefined {
    if (targets.size === 0) return new Set();
    if (!this.#captureSafetyBoundsReliable) return undefined;
    const controls = new Set<Element>();
    const movingImages = new Set<HTMLImageElement>();
    for (const target of targets) {
      let targetHasBoundedDependency = false;
      for (const known of this.#captureSafetyBounds.keys()) {
        const containsKnown = sameOrContainsElement(target, known);
        if (containsKnown === undefined) return undefined;
        if (containsKnown) {
          controls.add(known);
          targetHasBoundedDependency = true;
        }
      }
      const passivePresentation = passiveImagePresentationSubtree(target);
      if (passivePresentation === undefined) return undefined;
      if (!targetHasBoundedDependency && passivePresentation) {
        targetHasBoundedDependency = true;
      }
      const currentControls = collectCaptureControlTargets(target);
      if (!currentControls) return undefined;
      for (const control of currentControls) {
        controls.add(control);
        targetHasBoundedDependency = true;
      }
      for (const image of this.#states.keys()) {
        const path = readSourceFlatTreeElementPath(image);
        if (path?.includes(target)) {
          movingImages.add(image);
          targetHasBoundedDependency = true;
        }
      }
      if (!targetHasBoundedDependency) {
        // A positioned non-control overlay is not retained in the private
        // control ledger. Its pre-transition bounds are unavailable, so the
        // only safe old+new union is the bounded global fallback.
        return undefined;
      }
    }
    const overlapped = this.#imagesOverlappedBy(controls);
    if (!overlapped) return undefined;
    const movingOverlaps = this.#movingImagesOverlappingControls(
      movingImages,
      controls,
    );
    if (!movingOverlaps) return undefined;
    for (const image of movingOverlaps) overlapped.add(image);
    return overlapped;
  }

  #imagesOverlappedBy(
    targets: ReadonlySet<Element>,
    currentSnapshot?: ReadonlyMap<Element, CaptureSafetyBounds>,
  ): Set<HTMLImageElement> | undefined {
    const overlapped = new Set<HTMLImageElement>();
    if (targets.size === 0) return overlapped;
    if (
      !this.#captureSafetyBoundsReliable ||
      targets.size > MAX_CAPTURE_SAFETY_TARGETS
    ) return undefined;
    const targetBounds: Array<{
      readonly target: Element;
      readonly bounds: CaptureSafetyBounds;
    }> = [];
    for (const target of targets) {
      const previous = this.#captureSafetyBounds.get(target);
      const current = currentSnapshot
        ? currentSnapshot.get(target)
        : target.isConnected
          ? readCaptureSafetyBounds(target)
          : undefined;
      if (current) {
        targetBounds.push({
          target,
          bounds: previous && !sameCaptureSafetyBounds(previous, current)
            ? captureSafetyBoundsHull(previous, current)
            : current,
        });
      } else if (!previous) {
        if (!currentSnapshot || target.isConnected) return undefined;
      } else {
        targetBounds.push({ target, bounds: previous });
      }
    }
    if (targetBounds.length === 0) return undefined;
    const images: HTMLImageElement[] = [];
    for (const image of [...this.#states.keys()]) {
      if (this.#isPrivate(image)) {
        // Admission can narrow in the same mutation batch. Withdraw the image
        // before overlap ordering or geometry reads touch its newly private
        // paint surface.
        this.#refresh(image);
      } else {
        images.push(image);
      }
    }
    const imageBounds = new Map<
      HTMLImageElement,
      readonly CaptureSafetyBounds[]
    >();
    const imagePaths = new Map<HTMLImageElement, readonly Element[]>();
    for (const image of images) {
      const current = readCaptureSafetyBounds(image);
      if (!current) return undefined;
      const previous = this.#states.get(image)?.safetyBounds;
      imageBounds.set(image, previous && !sameCaptureSafetyBounds(previous, current)
        ? Object.freeze([captureSafetyBoundsHull(previous, current)])
        : Object.freeze([current]));
      const path = readSourceFlatTreeElementPath(image);
      if (!path) return undefined;
      imagePaths.set(image, path);
    }
    let comparisons = 0;
    for (const { target, bounds: targetRect } of targetBounds) {
      for (const image of images) {
        comparisons += 1;
        if (comparisons > MAX_CAPTURE_OVERLAP_COMPARISONS) {
          // A hostile target×image product cannot grow work without bound.
          // Advancing every admitted image is the content-free fail-closed
          // currentness boundary.
          return new Set(images);
        }
        if (overlapped.has(image)) continue;
        const path = imagePaths.get(image);
        if (!path || path.includes(target)) continue;
        const bounds = imageBounds.get(image);
        if (bounds?.some((candidate) => rectanglesOverlap(candidate, targetRect))) {
          overlapped.add(image);
        }
      }
    }
    return overlapped;
  }

  #movingImagesOverlappingControls(
    images: ReadonlySet<HTMLImageElement>,
    changedControls: ReadonlySet<Element>,
  ): Set<HTMLImageElement> | undefined {
    const overlapped = new Set<HTMLImageElement>();
    if (images.size === 0) return overlapped;
    if (!this.#captureSafetyBoundsReliable) return undefined;
    const controls = new Set<Element>([
      ...this.#captureSafetyBounds.keys(),
      ...changedControls,
    ]);
    if (controls.size > MAX_CAPTURE_SAFETY_TARGETS) return undefined;
    const controlBounds: Array<{
      readonly control: Element;
      readonly bounds: CaptureSafetyBounds;
    }> = [];
    for (const control of controls) {
      const previous = this.#captureSafetyBounds.get(control);
      if (!control.isConnected) {
        if (previous) controlBounds.push({ control, bounds: previous });
        continue;
      }
      const current = readCaptureSafetyBounds(control);
      if (!current) return undefined;
      controlBounds.push({
        control,
        bounds: previous && !sameCaptureSafetyBounds(previous, current)
          ? captureSafetyBoundsHull(previous, current)
          : current,
      });
    }
    if (controlBounds.length === 0) return overlapped;
    let comparisons = 0;
    for (const image of images) {
      const state = this.#states.get(image);
      if (!state) continue;
      const current = readCaptureSafetyBounds(image);
      const path = readSourceFlatTreeElementPath(image);
      if (!current || !path) return undefined;
      const imageBounds = sameCaptureSafetyBounds(state.safetyBounds, current)
        ? [current]
        : [captureSafetyBoundsHull(state.safetyBounds, current)];
      for (const { control, bounds } of controlBounds) {
        comparisons += 1;
        if (comparisons > MAX_CAPTURE_OVERLAP_COMPARISONS) return undefined;
        if (path.includes(control)) continue;
        if (imageBounds.some((candidate) => rectanglesOverlap(candidate, bounds))) {
          overlapped.add(image);
          break;
        }
      }
    }
    return overlapped;
  }

  /**
   * Scroll and viewport changes can move every rectangle while preserving the
   * exact image/control relationship. Compare the previous private ledger to
   * one current control scan so stable motion does not advance capture work.
   */
  #captureSafetyRelationChanges(
    images: ReadonlySet<HTMLImageElement>,
    currentControls: readonly Element[],
  ): CaptureSafetyRelationAssessment | undefined {
    const controlBounds = this.#readCaptureSafetyControlBounds(currentControls);
    if (!controlBounds) return undefined;
    if (!this.#captureSafetyBoundsReliable) {
      return Object.freeze({
        changedImages: new Set(images),
        controlBounds,
      });
    }
    const controls = new Set<Element>([
      ...this.#captureSafetyBounds.keys(),
      ...controlBounds.keys(),
    ]);
    if (controls.size > MAX_CAPTURE_SAFETY_TARGETS) return undefined;
    const changedImages = new Set<HTMLImageElement>();
    let comparisons = 0;
    for (const image of images) {
      const state = this.#states.get(image);
      if (!state) continue;
      const currentImageBounds = readCaptureSafetyBounds(image);
      const path = readSourceFlatTreeElementPath(image);
      if (!currentImageBounds || !path) {
        return Object.freeze({
          changedImages: new Set(images),
          controlBounds,
        });
      }
      for (const control of controls) {
        comparisons += 1;
        if (comparisons > MAX_CAPTURE_OVERLAP_COMPARISONS) {
          return Object.freeze({
            changedImages: new Set(images),
            controlBounds,
          });
        }
        // Controls inside the image's own flat-tree path are not sibling paint
        // surfaces and are excluded from both sides of the comparison.
        if (path.includes(control)) continue;
        const previousControlBounds = this.#captureSafetyBounds.get(control);
        const currentControlBounds = controlBounds.get(control);
        const previouslyOverlapped = previousControlBounds
          ? rectanglesOverlap(state.safetyBounds, previousControlBounds)
          : false;
        const currentlyOverlapped = currentControlBounds
          ? rectanglesOverlap(currentImageBounds, currentControlBounds)
          : false;
        if (previouslyOverlapped !== currentlyOverlapped) {
          changedImages.add(image);
          break;
        }
        if (
          !previouslyOverlapped && !currentlyOverlapped &&
          previousControlBounds && currentControlBounds &&
          !sameCaptureSafetyRelativeGeometry(
            state.safetyBounds,
            currentImageBounds,
            previousControlBounds,
            currentControlBounds,
          ) &&
          rectanglesOverlap(
            captureSafetyBoundsHull(state.safetyBounds, currentImageBounds),
            captureSafetyBoundsHull(
              previousControlBounds,
              currentControlBounds,
            ),
          )
        ) {
          // Clear endpoints do not prove a clear path. Preserve capture
          // currency when the two swept rectangles can have crossed between
          // coalesced scroll frames.
          changedImages.add(image);
          break;
        }
      }
    }
    return Object.freeze({ changedImages, controlBounds });
  }

  #readCaptureSafetyControlBounds(
    controls: readonly Element[],
  ): Map<Element, CaptureSafetyBounds> | undefined {
    if (controls.length > MAX_CAPTURE_SAFETY_TARGETS) return undefined;
    const next = new Map<Element, CaptureSafetyBounds>();
    for (const control of controls) {
      if (!control.isConnected) return undefined;
      const bounds = readCaptureSafetyBounds(control);
      if (!bounds) return undefined;
      next.set(control, bounds);
    }
    return next;
  }

  #applyCaptureSafetyAssessment(
    assessment: CaptureSafetyRelationAssessment | undefined,
  ): void {
    this.#captureSafetyBounds.clear();
    if (!assessment) {
      this.#captureSafetyBoundsReliable = false;
      return;
    }
    for (const [control, bounds] of assessment.controlBounds) {
      this.#captureSafetyBounds.set(control, bounds);
    }
    this.#captureSafetyBoundsReliable = true;
  }

  #rebuildCaptureSafetyBounds(): void {
    const controls = collectCurrentCaptureControlTargets(
      this.#environment.document,
    );
    if (!controls) {
      this.#captureSafetyBounds.clear();
      this.#captureSafetyBoundsReliable = false;
      return;
    }
    const next = this.#readCaptureSafetyControlBounds(controls);
    this.#captureSafetyBounds.clear();
    if (!next) {
      this.#captureSafetyBoundsReliable = false;
      return;
    }
    for (const [control, bounds] of next) {
      this.#captureSafetyBounds.set(control, bounds);
    }
    this.#captureSafetyBoundsReliable = true;
  }

  #refreshCaptureSafetyBounds(targets: ReadonlySet<Element>): void {
    if (targets.size === 0) return;
    if (!this.#captureSafetyBoundsReliable) {
      this.#rebuildCaptureSafetyBounds();
      return;
    }
    const affected = new Set<Element>();
    for (const target of targets) {
      for (const known of this.#captureSafetyBounds.keys()) {
        const containsKnown = sameOrContainsElement(target, known);
        if (containsKnown === undefined) {
          this.#captureSafetyBoundsReliable = false;
          return;
        }
        if (containsKnown) affected.add(known);
      }
      const current = collectCaptureControlTargets(target);
      if (!current) {
        this.#captureSafetyBoundsReliable = false;
        return;
      }
      for (const control of current) affected.add(control);
    }
    if (
      this.#captureSafetyBounds.size + affected.size >
        MAX_CAPTURE_SAFETY_TARGETS * 2
    ) {
      this.#rebuildCaptureSafetyBounds();
      return;
    }
    for (const control of affected) {
      const controlMatch = elementMatchesCaptureControl(control);
      if (controlMatch === undefined) {
        this.#captureSafetyBoundsReliable = false;
        return;
      }
      if (!control.isConnected || !controlMatch) {
        this.#captureSafetyBounds.delete(control);
        continue;
      }
      const bounds = readCaptureSafetyBounds(control);
      if (!bounds) {
        this.#captureSafetyBoundsReliable = false;
        return;
      }
      this.#captureSafetyBounds.set(control, bounds);
    }
  }

  #visibility(image: HTMLImageElement): ImageVisibilityTier {
    if (this.#visible.has(image)) return 'visible';
    if (this.#near.has(image)) return 'near';
    return 'background';
  }

  #isPrivate(image: HTMLImageElement): boolean {
    if (this.#environment.isPrivateImage) {
      try {
        return this.#environment.isPrivateImage(image);
      } catch {
        return true;
      }
    }
    return hasSourceCredentialSecretAncestor(image) ||
      hasSourceImageCaptureBlockingAncestor(image);
  }

  #readNodeId(image: HTMLImageElement): number | undefined {
    try {
      return this.#environment.getNodeId(image);
    } catch {
      return undefined;
    }
  }

  #queueIdentityRetry(image: HTMLImageElement): void {
    if (!this.#identityCandidates.has(image)) {
      if (this.#identityCandidates.size >= this.#maxImages) return;
      this.#identityCandidates.set(image, 0);
    }
    this.#scheduleIdentityRetry();
  }

  #forgetIdentityCandidate(image: HTMLImageElement): void {
    if (!this.#identityCandidates.delete(image)) return;
    if (
      this.#identityCandidates.size === 0 &&
      this.#identityRetryFrame !== undefined
    ) {
      this.#cancelFrame(this.#identityRetryFrame);
      this.#identityRetryFrame = undefined;
    }
  }

  #scheduleIdentityRetry(): void {
    if (
      !this.#started ||
      this.#identityRetryFrame !== undefined ||
      ![...this.#identityCandidates.values()].some(
        (attempts) => attempts < MAX_SOURCE_IMAGE_IDENTITY_RETRY_FRAMES,
      )
    ) return;
    const generation = this.#lifecycleGeneration;
    this.#identityRetryFrame = this.#scheduleFrame(() => {
      this.#identityRetryFrame = undefined;
      if (!this.#isActiveGeneration(generation)) return;
      for (const [image, attempts] of [...this.#identityCandidates]) {
        if (attempts >= MAX_SOURCE_IMAGE_IDENTITY_RETRY_FRAMES) continue;
        const nextAttempt = attempts + 1;
        this.#identityCandidates.set(image, nextAttempt);
        this.#discover(image);
        if (
          nextAttempt >= MAX_SOURCE_IMAGE_IDENTITY_RETRY_FRAMES &&
          this.#identityCandidates.get(image) === nextAttempt
        ) {
          this.#identityCandidates.delete(image);
        }
      }
      this.#scheduleIdentityRetry();
    });
  }

  #emit(event: SourceImageObservationEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }

  #isActiveGeneration(generation: number): boolean {
    return this.#started && this.#lifecycleGeneration === generation;
  }
}

export function createBrowserSourceImageObserver(
  document: Document,
  documentIdentity: ReplicaSourceDocumentIdentity,
  getNodeId: (image: HTMLImageElement) => number | undefined,
): SourceImageObserver {
  return new SourceImageObserver({
    document,
    documentIdentity,
    getNodeId,
    createIntersectionObserver: (callback, options) =>
      new IntersectionObserver((entries) => callback(entries), options),
    createResizeObserver: (callback) =>
      new ResizeObserver((entries) => callback(entries)),
    createMutationObserver: (callback) =>
      new MutationObserver((records) => callback(records)),
  });
}

interface SourceImageTraversalBudget {
  nodesRemaining: number;
  imagesRemaining: number;
  rootsRemaining: number;
  overflow: boolean;
}

interface BoundedImageGraph {
  readonly images: readonly HTMLImageElement[];
  readonly openRoots: readonly ShadowRoot[];
  readonly hostCandidates: readonly Element[];
  readonly overflow: boolean;
}

function createSourceImageTraversalBudget(
  maximumImages: number,
): SourceImageTraversalBudget {
  return {
    nodesRemaining: MAX_SOURCE_IMAGE_TRAVERSAL_NODES,
    imagesRemaining: Math.min(MAX_OBSERVED_SOURCE_IMAGES, maximumImages),
    rootsRemaining: MAX_SOURCE_IMAGE_OPEN_ROOTS,
    overflow: false,
  };
}

function collectBoundedImageGraph(
  initialNodes: Iterable<Node>,
  budget: SourceImageTraversalBudget,
): BoundedImageGraph {
  const images: HTMLImageElement[] = [];
  const openRoots: ShadowRoot[] = [];
  const hostCandidates: Element[] = [];
  const pending: Node[] = [];
  for (const node of initialNodes) {
    if (pending.length >= budget.nodesRemaining) {
      budget.overflow = true;
      break;
    }
    pending.push(node);
  }
  while (pending.length > 0) {
    if (budget.nodesRemaining <= 0) {
      budget.overflow = true;
      break;
    }
    const node = pending.pop();
    if (!node) break;
    budget.nodesRemaining -= 1;
    if (isElement(node)) {
      if (hostCandidates.length < MAX_SOURCE_SHADOW_HOST_CANDIDATES) {
        hostCandidates.push(node);
      } else {
        budget.overflow = true;
      }
      if (isImageElement(node)) {
        if (budget.imagesRemaining <= 0) {
          budget.overflow = true;
        } else {
          budget.imagesRemaining -= 1;
          images.push(node);
        }
      }
      const shadow = readOpenSourceShadowRoot(node);
      if (shadow === UNREADABLE_OPEN_SHADOW_ROOT) {
        budget.overflow = true;
      } else if (shadow) {
        if (budget.rootsRemaining <= 0) {
          budget.overflow = true;
        } else {
          budget.rootsRemaining -= 1;
          openRoots.push(shadow);
          if (!appendBoundedChildNodes(
            shadow,
            pending,
            budget.nodesRemaining,
          )) budget.overflow = true;
        }
      }
    }
    if (!appendBoundedChildNodes(node, pending, budget.nodesRemaining)) {
      budget.overflow = true;
    }
  }
  return Object.freeze({
    images: Object.freeze(images),
    openRoots: Object.freeze(openRoots),
    hostCandidates: Object.freeze(hostCandidates),
    overflow: budget.overflow,
  });
}

function filterImagesToObservedRoots(
  graph: BoundedImageGraph,
  observedRoots: WeakSet<Node>,
): BoundedImageGraph {
  const images = graph.images.filter((image) => {
    try {
      return observedRoots.has(image.getRootNode());
    } catch {
      return false;
    }
  });
  return Object.freeze({
    images: Object.freeze(images),
    openRoots: graph.openRoots,
    hostCandidates: graph.hostCandidates,
    overflow: graph.overflow,
  });
}

const CAPTURE_CONTROL_SELECTOR = [
  'a[href]',
  'area[href]',
  'audio[controls]',
  'button',
  'details',
  'dialog',
  'input',
  'label',
  'meter',
  'option',
  'output',
  'progress',
  'select',
  'summary',
  'textarea',
  'video[controls]',
  '[autocomplete]',
  '[contenteditable]',
  '[popover]',
  '[role]',
].join(',');

/**
 * HTML metadata/resource nodes can alter routing or stylesheet state, but the
 * nodes themselves never contribute pixels to a capture. Their dedicated
 * mutation paths already refresh admission and the current control ledger;
 * treating the detached metadata node as an unknown overlay would turn every
 * base/style/link replacement into an unnecessary page-wide capture change.
 */
function elementCanAffectCapturedPixels(element: Element): boolean {
  if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml') return true;
  return !(
    element.localName === 'base' ||
    element.localName === 'head' ||
    element.localName === 'link' ||
    element.localName === 'meta' ||
    element.localName === 'script' ||
    element.localName === 'source' ||
    element.localName === 'style' ||
    element.localName === 'template' ||
    element.localName === 'title'
  );
}
function collectCaptureControlTargets(
  node: Node,
): readonly Element[] | undefined {
  if (!isElement(node)) return Object.freeze([]);
  const targets: Element[] = [];
  const rootMatch = elementMatchesCaptureControl(node);
  if (rootMatch === undefined) return undefined;
  if (rootMatch) targets.push(node);
  const pending: Node[] = [];
  if (!appendBoundedChildNodes(
    node,
    pending,
    MAX_CAPTURE_SAFETY_SCAN_ELEMENTS,
  )) return undefined;
  let inspected = 0;
  try {
    while (pending.length > 0) {
      if (inspected >= MAX_CAPTURE_SAFETY_SCAN_ELEMENTS) return undefined;
      const current = pending.pop();
      if (!current) break;
      inspected += 1;
      if (!isElement(current)) continue;
      const currentMatch = elementMatchesCaptureControl(current);
      if (currentMatch === undefined) return undefined;
      if (currentMatch) {
        if (targets.length >= MAX_CAPTURE_SAFETY_TARGETS) return undefined;
        targets.push(current);
      }
      if (!appendBoundedChildNodes(
        current,
        pending,
        MAX_CAPTURE_SAFETY_SCAN_ELEMENTS - inspected,
      )) return undefined;
      const shadow = readOpenSourceShadowRoot(current);
      if (shadow === UNREADABLE_OPEN_SHADOW_ROOT) return undefined;
      if (shadow && !appendBoundedChildNodes(
        shadow,
        pending,
        MAX_CAPTURE_SAFETY_SCAN_ELEMENTS - inspected,
      )) return undefined;
    }
  } catch {
    return undefined;
  }
  return Object.freeze(targets);
}

function elementSettleMayChangeCaptureOverlap(element: Element): boolean {
  try {
    // A transition owned by an image, or by a bounded image-only presentation
    // shell, can move that image across a protected sibling. The settle queue
    // resolves only the shell's observed images against the bounded control
    // ledger; it does not turn an ordinary carousel into page-wide work.
    const passivePresentation = passiveImagePresentationSubtree(element);
    const carriesImage = boundedDescendantMatch(
      element,
      'img',
      MAX_CAPTURE_SAFETY_SCAN_ELEMENTS,
    );
    if (
      isImageElement(element) || passivePresentation !== false ||
      carriesImage !== false
    ) {
      return true;
    }
    // A generic computed -webkit-text-security surface is just as protected
    // as a native or ARIA control. Include both the target and its bounded
    // descendants so settle events cannot move masked pixels without
    // invalidating intersecting image capture evidence.
    const captureControls = collectCaptureControlTargets(element);
    if (!captureControls || captureControls.length > 0) return true;
    const view = element.ownerDocument.defaultView;
    const style = view?.getComputedStyle?.(element);
    const position = style?.position?.trim().toLowerCase();
    return position === 'absolute' || position === 'fixed' ||
      position === 'sticky';
  } catch {
    return true;
  }
}

/**
 * Strict structural proof for a passive image presentation subtree. Text node
 * presence is checked without reading its contents. Editable/value-bearing
 * controls fail closed even when they also contain an image.
 */
function passiveImagePresentationSubtree(
  element: Element,
): boolean | undefined {
  const pending: Node[] = [element];
  let inspected = 0;
  let foundImage = false;
  try {
    while (pending.length > 0) {
      if (++inspected > MAX_CAPTURE_SAFETY_SCAN_ELEMENTS) return undefined;
      const current = pending.pop();
      if (!current) break;
      if (
        current.nodeType === 3 || current.nodeType === 4 ||
        current.nodeType === 5
      ) return false;
      if (!isElement(current)) continue;
      const tagName = current.localName.toLowerCase();
      if (
        tagName === 'input' || tagName === 'option' || tagName === 'output' ||
        tagName === 'select' || tagName === 'textarea' ||
        current.hasAttribute('autocomplete') ||
        current.hasAttribute('contenteditable')
      ) return false;
      foundImage ||= isImageElement(current);
      if (!appendBoundedChildNodes(
        current,
        pending,
        MAX_CAPTURE_SAFETY_SCAN_ELEMENTS - inspected,
      )) return undefined;
      const shadow = readOpenSourceShadowRoot(current);
      if (shadow === UNREADABLE_OPEN_SHADOW_ROOT) return undefined;
      if (shadow && !appendBoundedChildNodes(
        shadow,
        pending,
        MAX_CAPTURE_SAFETY_SCAN_ELEMENTS - inspected,
      )) return undefined;
    }
  } catch {
    return undefined;
  }
  return foundImage;
}

/** true=match, false=complete/no match, undefined=bounded scan overflow. */
function boundedDescendantMatch(
  root: Element,
  selector: string,
  maximumNodes: number,
): boolean | undefined {
  const pending: Node[] = [];
  if (!appendBoundedChildNodes(root, pending, maximumNodes)) return undefined;
  let inspected = 0;
  while (pending.length > 0) {
    if (inspected >= maximumNodes) return undefined;
    const node = pending.pop();
    if (!node) break;
    inspected += 1;
    if (!isElement(node)) continue;
    if (node.matches(selector)) return true;
    if (!appendBoundedChildNodes(
      node,
      pending,
      maximumNodes - inspected,
    )) return undefined;
    const shadow = readOpenSourceShadowRoot(node);
    if (shadow === UNREADABLE_OPEN_SHADOW_ROOT) return undefined;
    if (shadow && !appendBoundedChildNodes(
      shadow,
      pending,
      maximumNodes - inspected,
    )) return undefined;
  }
  return false;
}

function elementMatchesCaptureControl(element: Element): boolean | undefined {
  try {
    if (element.matches(CAPTURE_CONTROL_SELECTOR)) return true;
    const view = element.ownerDocument.defaultView;
    if (!view || !('getComputedStyle' in view)) return false;
    const getComputedStyle = view.getComputedStyle;
    if (typeof getComputedStyle !== 'function') return undefined;
    const style = getComputedStyle.call(view, element);
    if (typeof style?.getPropertyValue !== 'function') return undefined;
    const textSecurity = style.getPropertyValue('-webkit-text-security')
      .trim().toLowerCase();
    return textSecurity !== '' && textSecurity !== 'none';
  } catch {
    return undefined;
  }
}

function sameOrContainsElement(
  ancestor: Element,
  candidate: Element,
): boolean | undefined {
  if (ancestor === candidate) return true;
  try {
    if (ancestor.contains(candidate)) return true;
  } catch {
    // Flat-tree ancestry can still provide a bounded answer. Do not silently
    // collapse an unreadable DOM containment relation into "unrelated".
  }
  const path = readSourceFlatTreeElementPath(candidate);
  return path ? path.includes(ancestor) : undefined;
}

function appendBoundedChildNodes(
  node: Node,
  pending: Node[],
  maximumPending: number,
): boolean {
  let complete = true;
  let children: NodeListOf<ChildNode>;
  try {
    children = node.childNodes;
  } catch {
    return false;
  }
  for (let index = children.length - 1; index >= 0; index -= 1) {
    if (pending.length >= maximumPending) {
      complete = false;
      break;
    }
    const child = children.item(index);
    if (child) pending.push(child);
  }
  return complete;
}

function readOpenSourceShadowRoot(element: Element): OpenShadowRootRead {
  try {
    const root = element.shadowRoot;
    return root?.mode === 'open' ? root : null;
  } catch {
    return UNREADABLE_OPEN_SHADOW_ROOT;
  }
}

function collectCurrentCaptureControlTargets(
  document: Document,
): readonly Element[] | undefined {
  const targets: Element[] = [];
  const pending: Node[] = [document];
  let scanned = 0;
  try {
    while (pending.length > 0) {
      if (scanned >= MAX_CAPTURE_SAFETY_SCAN_ELEMENTS) return undefined;
      const node = pending.pop();
      if (!node) break;
      scanned += 1;
      if (isElement(node)) {
        const controlMatch = elementMatchesCaptureControl(node);
        if (controlMatch === undefined) return undefined;
        if (controlMatch) {
          if (targets.length >= MAX_CAPTURE_SAFETY_TARGETS) return undefined;
          targets.push(node);
        }
        const shadow = readOpenSourceShadowRoot(node);
        if (shadow === UNREADABLE_OPEN_SHADOW_ROOT) return undefined;
        if (shadow && !appendBoundedChildNodes(
          shadow,
          pending,
          MAX_CAPTURE_SAFETY_SCAN_ELEMENTS - scanned,
        )) return undefined;
      }
      if (!appendBoundedChildNodes(
        node,
        pending,
        MAX_CAPTURE_SAFETY_SCAN_ELEMENTS - scanned,
      )) return undefined;
    }
  } catch {
    return undefined;
  }
  return Object.freeze(targets);
}

function containsControlledRelationshipElement(node: Node): boolean {
  if (!isElement(node)) return false;
  try {
    return node.hasAttribute('aria-controls') || node.hasAttribute('id') ||
      boundedDescendantMatch(
        node,
        '[aria-controls],[id]',
        MAX_SOURCE_IMAGE_TRAVERSAL_NODES,
      ) !== false;
  } catch {
    // A relationship-changing subtree that cannot be inspected must trigger a
    // bounded global re-evaluation rather than retaining prior admission.
    return true;
  }
}

function containsHtmlBaseElement(node: Node): boolean {
  if (!isElement(node)) return false;
  if (
    node.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
    node.localName.toLowerCase() === 'base'
  ) return true;
  return boundedDescendantMatch(
    node,
    'base',
    MAX_SOURCE_IMAGE_TRAVERSAL_NODES,
  ) !== false;
}

function containsStyleSourceElement(node: Node): boolean {
  if (!isElement(node)) return false;
  if (isStyleSourceElement(node)) return true;
  return boundedDescendantMatch(
    node,
    'style,link[rel~="stylesheet"]',
    MAX_SOURCE_IMAGE_TRAVERSAL_NODES,
  ) !== false;
}

function isInsideStyleSource(node: Node): boolean {
  const element = isElement(node) ? node : node.parentElement;
  return Boolean(element?.closest('style'));
}

function attributeAffectsExternalStyleSource(
  element: Element,
  attributeName: string | undefined,
): boolean {
  if (
    !attributeName ||
    !['href', 'rel', 'media', 'disabled'].includes(attributeName) ||
    element.namespaceURI !== 'http://www.w3.org/1999/xhtml'
  ) return false;
  const tagName = element.localName.toLowerCase();
  return tagName === 'style' || tagName === 'link';
}

function isStyleSourceElement(element: Element): boolean {
  if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml') return false;
  const tagName = element.localName.toLowerCase();
  if (tagName === 'style') return true;
  if (tagName !== 'link') return false;
  try {
    return element.getAttribute('rel')?.trim().toLowerCase()
      .split(/\s+/u).includes('stylesheet') === true;
  } catch {
    return true;
  }
}

function readPrivateSourceToken(image: HTMLImageElement): PrivateSourceToken {
  let parts: readonly string[];
  try {
    const currentSrc = image.currentSrc;
    const src = image.getAttribute('src');
    const srcset = image.getAttribute('srcset');
    const sizes = image.getAttribute('sizes');
    parts = [
      typeof currentSrc === 'string' ? currentSrc : '',
      typeof src === 'string' ? src : '',
      typeof srcset === 'string' ? srcset : '',
      typeof sizes === 'string' ? sizes : '',
    ];
  } catch {
    return OVERSIZED_PRIVATE_SOURCE_TOKEN;
  }
  return encodePrivateToken(parts);
}

/**
 * Captures only facts that can change OCR/ALT routing or safe paint admission.
 * In particular, raw class/style strings are excluded: framework state churn
 * should not recapture every descendant when computed behavior is unchanged.
 */
function readPrivateProcessingTokens(image: HTMLImageElement): {
  readonly routingToken: PrivateSourceToken;
  readonly layoutToken: PrivateSourceToken;
} {
  const path = readSourceFlatTreeElementPath(image);
  if (!path) {
    return Object.freeze({
      routingToken: OVERSIZED_PRIVATE_SOURCE_TOKEN,
      layoutToken: OVERSIZED_PRIVATE_SOURCE_TOKEN,
    });
  }
  const routingParts: string[] = [];
  const layoutParts: string[] = [];
  try {
    for (const current of path) {
      routingParts.push(current.localName.toLowerCase());
      const attributes = current === image
        ? ['alt', 'aria-label', 'aria-hidden', 'hidden', 'lang', 'role'] as const
        : ['aria-hidden', 'hidden', 'lang'] as const;
      for (const attribute of attributes) {
        routingParts.push(current.getAttribute(attribute) ?? '');
      }
      const style = readRoutingComputedStyle(image, current);
      routingParts.push(
        style?.getPropertyValue?.('-webkit-text-security') ?? '',
      );
      layoutParts.push(
        style && styleAllowsImageCapture(style) ? 'paint-safe' : 'paint-blocked',
        style && imageTransformIsAxisAligned(style)
          ? 'axis-aligned'
          : 'transform-blocked',
        style?.opacity ?? '',
        style?.filter ?? '',
        style?.getPropertyValue?.('backdrop-filter') ?? '',
        style?.mixBlendMode ?? '',
      );
      if (current === image) {
        layoutParts.push(
          style?.objectFit ?? '',
          style?.objectPosition ?? '',
          style?.imageRendering ?? '',
          style?.getPropertyValue?.('object-view-box') ?? '',
          style?.getPropertyValue?.('image-orientation') ?? '',
          style?.background ?? '',
          style?.border ?? '',
          style?.padding ?? '',
          style?.content ?? '',
        );
      }
    }
  } catch {
    return Object.freeze({
      routingToken: OVERSIZED_PRIVATE_SOURCE_TOKEN,
      layoutToken: OVERSIZED_PRIVATE_SOURCE_TOKEN,
    });
  }
  return Object.freeze({
    routingToken: encodePrivateToken(routingParts),
    layoutToken: encodePrivateToken(layoutParts),
  });
}

function readRoutingComputedStyle(
  image: HTMLImageElement,
  element: Element,
): CSSStyleDeclaration | undefined {
  const getComputedStyle = image.ownerDocument.defaultView?.getComputedStyle;
  if (typeof getComputedStyle !== 'function') return undefined;
  try {
    return getComputedStyle.call(
      image.ownerDocument.defaultView,
      element,
    );
  } catch {
    // A missing synthetic-DOM style API does not turn ordinary attribute
    // churn into a permanent invalidation loop; security is checked separately.
    return undefined;
  }
}

function encodePrivateToken(parts: readonly string[]): PrivateSourceToken {
  let encodedLength = 0;
  for (const part of parts) {
    encodedLength += String(part.length).length + 1 + part.length;
    if (encodedLength > MAX_PRIVATE_TOKEN_INPUT) {
      return OVERSIZED_PRIVATE_SOURCE_TOKEN;
    }
  }
  let value = '';
  for (const part of parts) {
    value += `${part.length}:${part}`;
  }
  return Object.freeze({
    kind: 'exact',
    value,
  });
}

function privateSourceTokenChanged(
  previous: PrivateSourceToken,
  current: PrivateSourceToken,
): boolean {
  if (previous.kind === 'oversized' || current.kind === 'oversized') {
    // Oversized URL-like strings are never retained. Mutation/load callbacks
    // explicitly force content invalidation; geometry/measurement refreshes
    // must otherwise treat a stable oversized sentinel as stable to avoid a
    // revision/capture hot loop.
    return previous.kind !== current.kind;
  }
  return previous.value !== current.value;
}

function readImageFacts(image: HTMLImageElement): ImageFacts | undefined {
  let bounds: DOMRect;
  try {
    bounds = image.getBoundingClientRect();
  } catch {
    return undefined;
  }
  if (
    !boundedRect(bounds) ||
    !isBoundedDimension(image.naturalWidth) ||
    !isBoundedDimension(image.naturalHeight)
  ) return undefined;
  return Object.freeze({
    renderedWidth: bounds.width,
    renderedHeight: bounds.height,
    intrinsicWidth: image.naturalWidth,
    intrinsicHeight: image.naturalHeight,
    viewportToken: imageClippingToken(image, bounds),
    safetyBounds: captureSafetyBounds(bounds),
  });
}

/**
 * Pixel capture depends on the image-relative crop imposed by the viewport and
 * flat-tree overflow ancestors, not its absolute page position. Keeping only
 * crop edges means a fully visible image can move during ordinary scrolling
 * without invalidating identical pixels, while newly clipped/revealed pixels
 * still advance observation currentness.
 */
function imageClippingToken(
  image: HTMLImageElement,
  bounds: DOMRect,
): string {
  const left = finitePosition(bounds.left, bounds.x);
  const top = finitePosition(bounds.top, bounds.y);
  const view = image.ownerDocument.defaultView;
  const viewportWidth = finitePosition(
    view?.innerWidth,
    image.ownerDocument.documentElement?.clientWidth,
  );
  const viewportHeight = finitePosition(
    view?.innerHeight,
    image.ownerDocument.documentElement?.clientHeight,
  );
  let clipLeft = 0;
  let clipTop = 0;
  let clipRight = viewportWidth;
  let clipBottom = viewportHeight;
  const path = readSourceFlatTreeElementPath(image);
  if (!path) return 'unreadable';
  const viewStyle = image.ownerDocument.defaultView?.getComputedStyle;
  for (const ancestor of path.slice(1)) {
    if (
      ancestor === image.ownerDocument.body ||
      ancestor === image.ownerDocument.documentElement
    ) continue;
    if (typeof viewStyle !== 'function') break;
    let style: CSSStyleDeclaration;
    let ancestorBounds: DOMRect;
    try {
      style = viewStyle.call(image.ownerDocument.defaultView, ancestor);
      ancestorBounds = ancestor.getBoundingClientRect();
    } catch {
      return 'unreadable';
    }
    if (!boundedRect(ancestorBounds)) return 'unreadable';
    if (clipsOverflow(style.overflowX)) {
      clipLeft = Math.max(clipLeft, ancestorBounds.left);
      clipRight = Math.min(clipRight, ancestorBounds.right);
    }
    if (clipsOverflow(style.overflowY)) {
      clipTop = Math.max(clipTop, ancestorBounds.top);
      clipBottom = Math.min(clipBottom, ancestorBounds.bottom);
    }
  }
  const [cropLeft, cropRight] = clippedRange(
    clipLeft - left,
    clipRight - left,
    bounds.width,
  );
  const [cropTop, cropBottom] = clippedRange(
    clipTop - top,
    clipBottom - top,
    bounds.height,
  );
  return [cropLeft, cropTop, cropRight, cropBottom].join(',');
}

function clippedRange(
  start: number,
  end: number,
  length: number,
): readonly [number, number] {
  const leading = clamp(start, 0, length);
  const trailing = clamp(end, 0, length);
  if (trailing <= leading) {
    return Object.freeze([normalizeZero(leading), normalizeZero(leading)]);
  }
  return Object.freeze([
    normalizeZero(leading),
    normalizeZero(trailing),
  ]);
}

function clipsOverflow(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'hidden' || normalized === 'clip' ||
    normalized === 'scroll' || normalized === 'auto' ||
    normalized === 'overlay';
}

function readCaptureSafetyBounds(
  element: Element,
): CaptureSafetyBounds | undefined {
  try {
    const bounds = element.getBoundingClientRect();
    return boundedRect(bounds) ? captureSafetyBounds(bounds) : undefined;
  } catch {
    return undefined;
  }
}

function captureSafetyBounds(bounds: DOMRect): CaptureSafetyBounds {
  return Object.freeze({
    left: bounds.left,
    top: bounds.top,
    right: bounds.right,
    bottom: bounds.bottom,
    width: bounds.width,
    height: bounds.height,
  });
}

function sameCaptureSafetyBounds(
  left: CaptureSafetyBounds,
  right: CaptureSafetyBounds,
): boolean {
  return left.left === right.left && left.top === right.top &&
    left.right === right.right && left.bottom === right.bottom &&
    left.width === right.width && left.height === right.height;
}

function sameCaptureSafetyRelativeGeometry(
  previousImage: CaptureSafetyBounds,
  currentImage: CaptureSafetyBounds,
  previousControl: CaptureSafetyBounds,
  currentControl: CaptureSafetyBounds,
): boolean {
  return previousControl.left - previousImage.left ===
      currentControl.left - currentImage.left &&
    previousControl.top - previousImage.top ===
      currentControl.top - currentImage.top &&
    previousControl.right - previousImage.right ===
      currentControl.right - currentImage.right &&
    previousControl.bottom - previousImage.bottom ===
      currentControl.bottom - currentImage.bottom;
}

function captureSafetyBoundsHull(
  left: CaptureSafetyBounds,
  right: CaptureSafetyBounds,
): CaptureSafetyBounds {
  const minimumLeft = Math.min(left.left, right.left);
  const minimumTop = Math.min(left.top, right.top);
  const maximumRight = Math.max(left.right, right.right);
  const maximumBottom = Math.max(left.bottom, right.bottom);
  return Object.freeze({
    left: minimumLeft,
    top: minimumTop,
    right: maximumRight,
    bottom: maximumBottom,
    width: maximumRight - minimumLeft,
    height: maximumBottom - minimumTop,
  });
}

function boundedRect(bounds: DOMRect): boolean {
  return isBoundedDimension(bounds.width) &&
    isBoundedDimension(bounds.height) &&
    Number.isFinite(bounds.left) &&
    Number.isFinite(bounds.top) &&
    Number.isFinite(bounds.right) &&
    Number.isFinite(bounds.bottom);
}

function rectanglesOverlap(
  left: CaptureSafetyBounds,
  right: CaptureSafetyBounds,
): boolean {
  return left.width > 0 && left.height > 0 &&
    right.width > 0 && right.height > 0 &&
    Math.max(left.left, right.left) < Math.min(left.right, right.right) &&
    Math.max(left.top, right.top) < Math.min(left.bottom, right.bottom);
}

interface ImageVisualAttention {
  readonly visibleRatio: number;
  readonly top: number;
  readonly left: number;
  readonly area: number;
}

function compareImageVisualAttention(
  leftAttention: ImageVisualAttention,
  rightAttention: ImageVisualAttention,
): number {
  return (
    rightAttention.visibleRatio - leftAttention.visibleRatio ||
    leftAttention.top - rightAttention.top ||
    leftAttention.left - rightAttention.left ||
    rightAttention.area - leftAttention.area
  );
}

function readVisualAttention(element: Element): ImageVisualAttention {
  try {
    const bounds = element.getBoundingClientRect();
    const width = isBoundedDimension(bounds.width) ? bounds.width : 0;
    const height = isBoundedDimension(bounds.height) ? bounds.height : 0;
    const left = finitePosition(bounds.left, bounds.x);
    const top = finitePosition(bounds.top, bounds.y);
    const view = element.ownerDocument.defaultView;
    const viewportWidth = Math.max(0, finitePosition(
      view?.innerWidth,
      element.ownerDocument.documentElement?.clientWidth,
    ));
    const viewportHeight = Math.max(0, finitePosition(
      view?.innerHeight,
      element.ownerDocument.documentElement?.clientHeight,
    ));
    const visibleWidth = Math.max(
      0,
      Math.min(left + width, viewportWidth) - Math.max(left, 0),
    );
    const visibleHeight = Math.max(
      0,
      Math.min(top + height, viewportHeight) - Math.max(top, 0),
    );
    const area = width * height;
    return Object.freeze({
      visibleRatio: area > 0 ? (visibleWidth * visibleHeight) / area : 0,
      top: Math.max(0, top),
      left: Math.max(0, left),
      area: Number.isFinite(area) ? area : Number.MAX_VALUE,
    });
  } catch {
    return Object.freeze({
      visibleRatio: 0,
      top: Number.MAX_VALUE,
      left: Number.MAX_VALUE,
      area: 0,
    });
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function finitePosition(primary: unknown, fallback: unknown): number {
  if (typeof primary === 'number' && Number.isFinite(primary)) return primary;
  if (typeof fallback === 'number' && Number.isFinite(fallback)) return fallback;
  return 0;
}

function sameObservation(
  left: SourceImageUpsert | undefined,
  right: SourceImageUpsert,
): boolean {
  return Boolean(
    left &&
    !right.contentChanged &&
    !right.observationChanged &&
    !right.captureChanged &&
    left.nodeId === right.nodeId &&
    left.visibility === right.visibility &&
    left.renderedWidth === right.renderedWidth &&
    left.renderedHeight === right.renderedHeight &&
    left.intrinsicWidth === right.intrinsicWidth &&
    left.intrinsicHeight === right.intrinsicHeight,
  );
}

function isNodeId(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0;
}

function isBoundedDimension(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= MAX_IMAGE_DIMENSION;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  return Number.isSafeInteger(value) &&
    (value ?? 0) > 0 &&
    (value ?? Number.POSITIVE_INFINITY) <= maximum
    ? value as number
    : fallback;
}

function isElement(value: unknown): value is Element {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'nodeType' in value &&
    (value as Node).nodeType === 1 &&
    'querySelectorAll' in value,
  );
}

function isImageElement(value: unknown): value is HTMLImageElement {
  return isElement(value) && value.tagName.toLowerCase() === 'img';
}
