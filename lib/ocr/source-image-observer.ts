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
  canHostAuthorShadowRoot,
  readSourceShadowRoot,
} from '../replica/source-shadow-root';
import {
  receiverSafeAnimationFrameCanceller,
  receiverSafeAnimationFrameScheduler,
  type AnimationFrameCanceller,
  type AnimationFrameScheduler,
} from '../browser-scheduling';
import type { ImageVisibilityTier } from './contracts';
import {
  sourceVisibilityMutationMaySkip,
  type SourceStyleNames,
} from '../replica/source-style-names';
import type { ImageSourceReadySummary } from './image-source-protocol';
import type { SourceImageUpsert } from './source-image-model';
import {
  imageTransformIsAxisAligned,
  styleAllowsImageCapture,
  styleReplacesImagePicture,
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
  /**
   * The names the page's style rules mention, when every sheet has been
   * read (the mirror's census; D182). A change of a `class` token or a
   * `data-*` attribute that no rule names restyles nothing, and the
   * observer then reads nothing for it. Without it every change is read.
   */
  readonly styleNames?: () => SourceStyleNames | undefined;
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
// How much of each end of a long part the oversized digest reads.
const PRIVATE_TOKEN_DIGEST_END = 8 * 1024;
const MAX_SOURCE_IMAGE_TRAVERSAL_NODES = 50_000;
const MAX_SOURCE_IMAGE_SHADOW_ROOTS = 1_024;
const MAX_SOURCE_SHADOW_HOST_CANDIDATES = 50_000;
const MAX_SOURCE_SHADOW_HOSTS_PER_TICK = 1_000;
const MAX_SOURCE_IMAGE_MUTATION_RECORDS = 2_048;
const MAX_SOURCE_IMAGE_MUTATION_CHILD_NODES = 4_096;
const SHADOW_DISCOVERY_INTERVAL_MS = 1_000;
const MAX_CAPTURE_SAFETY_SCAN_ELEMENTS = 50_000;
const MAX_CAPTURE_SAFETY_TARGETS = 1_024;
/**
 * Past MAX_CAPTURE_SAFETY_TARGETS controls their positions are not read at
 * every scroll frame. They are read once into an index of the document by
 * bands of this height, and a scroll compares an image only with the
 * controls in the bands it passes through (D172). At most this many
 * controls are indexed; past that the page fails closed, as before.
 */
const CAPTURE_BAND_HEIGHT = 512;
const MAX_CAPTURE_BAND_TARGETS = 16_384;
/** A control taller than this many bands is compared with every image. */
const MAX_CAPTURE_BAND_SPAN = 16;
/**
 * The pointer or the focus moved (`:hover` may move a control with no
 * mutation): an index of at most this many controls is checked whole at the
 * next frame and kept if nothing moved; a larger one is made again.
 */
const MAX_CAPTURE_BAND_RECHECK = 4_096;
const MAX_CAPTURE_OVERLAP_COMPARISONS = 50_000;
/**
 * Boxes kept of elements that may paint over an image without being a
 * control (D182), and how many elements under a changed ancestor are looked
 * at for them.
 */
const MAX_COVER_LEDGER = 512;
const MAX_COVER_SCAN_ELEMENTS = 512;
const MAX_LAYOUT_SETTLE_TARGETS = 256;
const UNREADABLE_SHADOW_ROOT = Symbol('unreadable-shadow-root');
type ShadowRootRead = ShadowRoot | null |
  typeof UNREADABLE_SHADOW_ROOT;
/**
 * The pointer coming onto an element or leaving it, pressed or let go, and
 * the focus moving: what `:hover`, `:active` (since D172), `:focus` and
 * `:focus-within` follow, on an image or on anything around it.
 */
const PICTURE_STATE_EVENT_TYPES = Object.freeze([
  'pointerover',
  'pointerout',
  'pointerdown',
  'pointerup',
  'pointercancel',
  'focusin',
  'focusout',
] as const);
/**
 * A CSS animation on an image or around it may swap its picture with no
 * event between (keyframes of `content`). While one runs, the pictures on
 * screen are looked at again at this pace, and at most this many times for
 * each start: an endless spinner does not keep the page busy (D172).
 */
export const PICTURE_ANIMATION_LOOK_MS = 500;
export const MAX_PICTURE_ANIMATION_LOOKS = 16;
const PICTURE_ANIMATION_EVENT_TYPES = Object.freeze([
  'animationstart',
  'animationend',
  'animationcancel',
] as const);
/**
 * How long the pointer and the focus must have stayed where they are before
 * the pictures on screen are looked at again. A state that is left sooner
 * (the pointer crossing an image) is never reported: its picture would be
 * gone before it could be read.
 */
export const PICTURE_STATE_SETTLE_MS = 100;
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
  // The class tokens a change took away, which the skip of changes no
  // style rule names compares (D182).
  attributeOldValue: true,
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
  | {
      readonly kind: 'oversized';
      readonly length: number;
      readonly first: number;
      readonly second: number;
    }
  | { readonly kind: 'unreadable' };

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

/**
 * Where each control is in the document, read once while nothing but the
 * document's own scroll has happened since. A control that a document
 * scroll moves on the screen differently from the page (fixed, sticky, or
 * moved by a scroll timeline) is a mover: it is read again at each frame.
 */
interface CaptureBandIndex {
  readonly bands: ReadonlyMap<number, readonly Element[]>;
  readonly wide: readonly Element[];
  readonly documentBounds: ReadonlyMap<Element, CaptureSafetyBounds>;
  /** Controls with no box when the index was made. */
  readonly empty: readonly Element[];
  readonly movers: readonly Element[];
  /** Movers' screen bounds, and images' document bounds, at the last frame. */
  readonly moverBounds: Map<Element, CaptureSafetyBounds>;
  readonly imageBounds: Map<HTMLImageElement, CaptureSafetyBounds>;
  scrollX: number;
  scrollY: number;
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
  /** The number of the picture CSS gives the image, when CSS decides it. */
  cssPicture: number | undefined;
  viewportToken: string;
  visibleSettled: boolean;
  nearSettled: boolean;
  safetyBounds: CaptureSafetyBounds;
  lastEvent?: Extract<SourceImageObservationEvent, { kind: 'upsert' }>;
}

// The parts could not be read at all, so there is nothing to compare.
const UNREADABLE_PRIVATE_SOURCE_TOKEN: PrivateSourceToken = Object.freeze({
  kind: 'unreadable',
});

/**
 * A picture that CSS gives an image, and the number it travels under. The
 * facts (the computed values and the file they apply to) stay here; the
 * number says nothing of them. It is the image's for as long as the facts
 * are these, across readers of the same page, and is never given to another
 * picture or another image: a result the panel keeps under it is this
 * picture's.
 */
interface CssPicture {
  readonly facts: PrivateSourceToken;
  readonly number: number;
}
const cssPictures = new WeakMap<HTMLImageElement, CssPicture>();
let cssPictureCount = 0;

function cssPictureNumber(
  image: HTMLImageElement,
  facts: PrivateSourceToken | undefined,
): number | undefined {
  if (!facts) return undefined;
  const known = cssPictures.get(image);
  if (known && !privateSourceTokenChanged(known.facts, facts)) {
    return known.number;
  }
  cssPictureCount += 1;
  cssPictures.set(image, Object.freeze({ facts, number: cssPictureCount }));
  return cssPictureCount;
}

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
  #scrollListener: ((event: Event) => void) | undefined;
  #pictureStateListener: (() => void) | undefined;
  /** Pointer and focus events seen, and the timer that waits for them to stop. */
  #pictureStateEvents = 0;
  #pictureStateTimer: unknown;
  #pictureAnimationListener: ((event: Event) => void) | undefined;
  #pictureAnimationTimer: unknown;
  #pictureAnimationLooksLeft = 0;
  /** Animations running on an image's path, by their element. */
  readonly #pictureAnimations = new Map<Element, number>();
  #layoutSettleListener: ((event: Event) => void) | undefined;
  #fontSettleListener: (() => void) | undefined;
  #scrollFrame: number | undefined;
  #layoutSettleFrame: number | undefined;
  #layoutSettleRefreshAll = false;
  #layoutSettleSafetyRefreshAll = false;
  readonly #layoutSettleTargets = new Set<Element>();
  readonly #layoutSettleSafetyTargets = new Set<Element>();
  readonly #captureSafetyBounds = new Map<Element, CaptureSafetyBounds>();
  /** The last box seen of each element that may cover an image (D182). */
  readonly #coverBounds = new Map<Element, CaptureSafetyBounds>();
  #captureSafetyBoundsReliable = true;
  #captureBandIndex: CaptureBandIndex | undefined;
  /** An index could not be made; none is tried again until a change. */
  #captureBandIndexRefused = false;
  /** The pointer or the focus moved since the index was last checked. */
  #captureBandIndexUnchecked = false;
  /** A scroll of something other than the document came in this frame. */
  #innerScrollSeen = false;
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

  /**
   * The images on screen can be captured again after something no observer
   * here reports (a pinch zoom ended). Their observation advances, which
   * asks the panel to try the ones it had to leave; an image that was read
   * keeps its result, and nothing is captured for it.
   */
  advanceVisibleObservation(): void {
    if (!this.#started) return;
    for (const image of [...this.#visible]) this.#refresh(image, false, true);
  }

  /**
   * The file of an image's CSS picture has now decoded, after its rectangle
   * was given without it (D172): the image is a new capture of a new
   * picture, which the tab can now paint.
   */
  refreshLoadedPicture(image: HTMLImageElement): void {
    if (!this.#started || !this.#states.has(image)) return;
    this.#refresh(image, false, true, true, true);
  }

  /**
   * Something that is no change to the document may have given the images
   * on screen another picture (the system's colour scheme, the pointer, the
   * focus). Each is looked at again, and only one whose picture CSS now
   * decides differently is a change.
   */
  refreshVisiblePictures(): void {
    if (!this.#started) return;
    // A media feature that changed a picture may have moved controls too.
    this.#invalidateCaptureBands();
    this.#refreshVisiblePicturesOnly();
  }

  #refreshVisiblePicturesOnly(): void {
    for (const image of [...this.#visible]) this.#refreshPicture(image);
  }

  /**
   * Looks at the pictures on screen once no pointer or focus event has come
   * for a whole wait. While they keep coming the timer only starts again.
   */
  #awaitPictureStateRest(generation: number): void {
    const seen = this.#pictureStateEvents;
    this.#pictureStateTimer = this.#setTimer(() => {
      this.#pictureStateTimer = undefined;
      if (!this.#isActiveGeneration(generation)) return;
      if (this.#pictureStateEvents !== seen) {
        this.#awaitPictureStateRest(generation);
        return;
      }
      // What the pointer and the focus moved is checked by the index's own
      // whole check (#captureBandIndexUnchecked).
      this.#refreshVisiblePicturesOnly();
    }, PICTURE_STATE_SETTLE_MS);
  }

  /**
   * An animation started or ended on an element. One on the path of an image
   * on screen (the image or anything around it) has the pictures on screen
   * looked at again at a bounded pace while it runs (D172).
   */
  #onPictureAnimation(type: string, target: Element, generation: number): void {
    if (type !== 'animationstart') {
      const running = (this.#pictureAnimations.get(target) ?? 0) - 1;
      if (running > 0) this.#pictureAnimations.set(target, running);
      else this.#pictureAnimations.delete(target);
      if (
        this.#pictureAnimations.size === 0 &&
        this.#pictureAnimationTimer !== undefined
      ) {
        this.#clearTimer(this.#pictureAnimationTimer);
        this.#pictureAnimationTimer = undefined;
      }
      // Its last frame may be another picture.
      this.refreshVisiblePictures();
      return;
    }
    let onPath = false;
    for (const image of this.#visible) {
      const contains = sameOrContainsElement(target, image);
      // Unreadable ancestry counts as on the path: a look too many is safe.
      if (contains !== false) {
        onPath = true;
        break;
      }
    }
    if (!onPath) return;
    this.#pictureAnimations.set(
      target,
      (this.#pictureAnimations.get(target) ?? 0) + 1,
    );
    this.#pictureAnimationLooksLeft = MAX_PICTURE_ANIMATION_LOOKS;
    if (this.#pictureAnimationTimer === undefined) {
      this.#awaitPictureAnimationLook(generation);
    }
  }

  #awaitPictureAnimationLook(generation: number): void {
    this.#pictureAnimationTimer = this.#setTimer(() => {
      this.#pictureAnimationTimer = undefined;
      if (!this.#isActiveGeneration(generation)) return;
      if (this.#pictureAnimations.size === 0) return;
      this.#pictureAnimationLooksLeft -= 1;
      this.refreshVisiblePictures();
      if (this.#pictureAnimationLooksLeft > 0) {
        this.#awaitPictureAnimationLook(generation);
      }
    }, PICTURE_ANIMATION_LOOK_MS);
  }

  /** Reads one image's own style, and refreshes it if its picture changed. */
  #refreshPicture(image: HTMLImageElement): void {
    const state = this.#states.get(image);
    if (!state) return;
    let facts: PrivateSourceToken | undefined;
    try {
      facts = readCssPictureFacts(image, readRoutingComputedStyle(image, image));
    } catch {
      return;
    }
    if (cssPictureNumber(image, facts) !== state.cssPicture) this.#refresh(image);
  }

  /** CSSOM has no MutationRecord, so conservatively re-prove every image. */
  refreshAfterStyleChange(): void {
    if (!this.#started) return;
    this.#invalidateCaptureBands();
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
      this.#invalidateCaptureBands();
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
      this.#invalidateCaptureBands();
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
      this.#invalidateCaptureBands();
      this.#refreshAfterViewportChange();
    };
    this.#scrollListener = (event) => {
      if (!this.#isActiveGeneration(generation)) return;
      const target = event.target;
      if (
        target !== this.#environment.document &&
        target !== this.#environment.document.scrollingElement
      ) {
        // An inner scroller moves its own controls past the images: the
        // document index does not know where they are now.
        this.#innerScrollSeen = true;
      }
      if (this.#scrollFrame !== undefined) return;
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
        if (this.#innerScrollSeen) {
          this.#innerScrollSeen = false;
          this.#invalidateCaptureBands();
        }
        const failClosedCandidates = safetyAssessment?.changedImages ??
          (knownControls ? visible : this.#captureBandChanges(visible)) ??
          visible;
        for (const image of visible) {
          const captureSafetyChanged = failClosedCandidates.has(image);
          // What a scroll changes is where the image is: its crop by the
          // view, and what it passes under on the way. Its capture is new;
          // its picture is the one it had.
          this.#refresh(
            image,
            false,
            captureSafetyChanged,
            captureSafetyChanged,
            false,
          );
        }
        this.#applyCaptureSafetyAssessment(safetyAssessment);
      });
    };
    // A picture that `:hover` or `:focus` swaps, on the image or on anything
    // around it, changes with no change to the document. Once the pointer
    // and the focus have rested, the images on screen are asked for their
    // picture, and only one whose picture is now another is a change: a
    // state that restyles an image otherwise is no change here.
    this.#pictureStateListener = () => {
      if (!this.#isActiveGeneration(generation)) return;
      // `:hover`, `:active` and `:focus` may move controls with no mutation:
      // the index is checked whole before it is used again.
      this.#captureBandIndexUnchecked = true;
      this.#pictureStateEvents += 1;
      if (this.#pictureStateTimer === undefined) {
        this.#awaitPictureStateRest(generation);
      }
    };
    this.#pictureAnimationListener = (event) => {
      if (!this.#isActiveGeneration(generation) || !isElement(event.target)) {
        return;
      }
      this.#onPictureAnimation(event.type, event.target, generation);
    };
    this.#layoutSettleListener = (event) => {
      if (!this.#isActiveGeneration(generation)) return;
      this.#invalidateCaptureBands();
      if (!isElement(event.target)) return;
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
      this.#invalidateCaptureBands();
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
      if (this.#pictureStateListener) {
        for (const type of PICTURE_STATE_EVENT_TYPES) {
          root.removeEventListener(type, this.#pictureStateListener, true);
        }
      }
      if (this.#pictureAnimationListener) {
        for (const type of PICTURE_ANIMATION_EVENT_TYPES) {
          root.removeEventListener(type, this.#pictureAnimationListener, true);
        }
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
    if (this.#pictureStateTimer !== undefined) {
      this.#clearTimer(this.#pictureStateTimer);
      this.#pictureStateTimer = undefined;
    }
    if (this.#pictureAnimationTimer !== undefined) {
      this.#clearTimer(this.#pictureAnimationTimer);
      this.#pictureAnimationTimer = undefined;
    }
    this.#pictureAnimations.clear();
    this.#pictureAnimationLooksLeft = 0;
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
    this.#pictureStateListener = undefined;
    this.#pictureAnimationListener = undefined;
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
    this.#coverBounds.clear();
    this.#fillingCapacity = false;
  }

  #observeSourceRoot(root: Document | ShadowRoot): boolean {
    if (!this.#mutationObserver) return false;
    if (this.#observedMutationRoots.has(root)) return true;
    if (this.#observedMutationRootCount >= MAX_SOURCE_IMAGE_SHADOW_ROOTS + 1) {
      this.#stopShadowDiscovery();
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
    if (this.#pictureStateListener) {
      for (const type of PICTURE_STATE_EVENT_TYPES) {
        root.addEventListener(type, this.#pictureStateListener, {
          capture: true,
          passive: true,
        });
      }
    }
    if (this.#pictureAnimationListener) {
      for (const type of PICTURE_ANIMATION_EVENT_TYPES) {
        root.addEventListener(type, this.#pictureAnimationListener, {
          capture: true,
          passive: true,
        });
      }
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
    for (const root of scan.shadowRoots) this.#observeSourceRoot(root);
    return filterImagesToObservedRoots(scan, this.#observedMutationRoots);
  }

  #scanMutationImages(
    nodes: Iterable<Node>,
    budget: SourceImageTraversalBudget,
  ): BoundedImageGraph {
    const scan = collectBoundedImageGraph(nodes, budget);
    this.#registerShadowHostCandidates(scan.hostCandidates);
    for (const root of scan.shadowRoots) {
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
      this.#discoverNewShadowRoots();
      this.#scheduleShadowDiscovery();
    }, SHADOW_DISCOVERY_INTERVAL_MS);
  }

  /**
   * Periodic discovery stops for good at its fail-closed boundary, so the
   * hosts it would have asked about are let go. Kept, every component a
   * page dropped stayed alive with its tree: a page that replaces its
   * components kept several times the nodes it holds (D125).
   */
  #stopShadowDiscovery(): void {
    this.#rootObservationOverflow = true;
    this.#shadowHostCandidates = [];
    this.#knownShadowHostCandidates = new WeakSet<Element>();
    this.#shadowHostCursor = 0;
  }

  #registerShadowHostCandidates(candidates: readonly Element[]): void {
    if (this.#rootObservationOverflow) return;
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

  #discoverNewShadowRoots(): void {
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
      // An open root shows on the host. A closed one shows here once the
      // mirror's own discovery, the one place that asks Chrome again, has
      // found it (D125).
      const root = readImageSourceShadowRoot(host);
      if (root === UNREADABLE_SHADOW_ROOT) {
        // Do not keep claiming complete root coverage after a host makes
        // that relationship unreadable. Existing directly observed roots stay
        // active, but periodic discovery stops at this fail-closed boundary.
        this.#stopShadowDiscovery();
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
      cssPicture: cssPictureNumber(image, processingTokens.cssPicture),
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
    forcedCaptureChangesPicture = true,
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
    // A crop alone is the same picture seen through another part of the view.
    const pictureChanged = contentChanged || layoutChanged ||
      dimensionsChanged || (forceCaptureChange && forcedCaptureChangesPicture);
    // A crop alone admits or refuses a read of the image as before; a
    // control or protected element it passes under does not (D168).
    const admissionChanged = contentChanged || layoutChanged ||
      dimensionsChanged || forceCaptureChange;
    const observationChanged = forceObservationChange || cropChanged ||
      layoutChanged;
    state.sourceToken = token;
    state.routingToken = processingTokens.routingToken;
    state.layoutToken = processingTokens.layoutToken;
    state.cssPicture = cssPictureNumber(image, processingTokens.cssPicture);
    state.viewportToken = facts.viewportToken;
    state.safetyBounds = facts.safetyBounds;
    this.#emitUpsert(
      state,
      contentChanged,
      observationChanged,
      captureChanged,
      facts,
      pictureChanged,
      admissionChanged,
    );
  }

  #emitUpsert(
    state: ObservedImageState,
    contentChanged: boolean,
    observationChanged: boolean,
    captureChanged: boolean,
    facts: ImageFacts,
    pictureChanged = captureChanged,
    admissionChanged = captureChanged,
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
      pictureChanged: initial || pictureChanged,
      admissionChanged: initial || admissionChanged,
      visibility: this.#visibility(state.image),
      connected: true,
      renderedWidth: facts.renderedWidth,
      renderedHeight: facts.renderedHeight,
      intrinsicWidth: facts.intrinsicWidth,
      intrinsicHeight: facts.intrinsicHeight,
      ...(state.cssPicture === undefined
        ? {}
        : { cssPicture: state.cssPicture }),
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

  #onMutations(delivered: readonly MutationRecord[]): void {
    if (!this.#started) return;
    // A class token or `data-*` attribute of an element that is no image,
    // which no style rule names: nothing it could restyle, and nothing this
    // observer reads (D182). A page that marks a counter or a timer in such
    // an attribute every frame walked the document at every frame.
    const styleNames = this.#environment.styleNames;
    const records = styleNames
      ? delivered.filter((record) => !imageObserverMaySkip(record, styleNames))
      : delivered;
    if (records.length === 0) return;
    this.#invalidateCaptureBands();
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
        // Each control's box is compared with the last snapshot, as on a
        // scroll: an image is renewed where a control came over it, left it
        // or crossed it, not wherever one lies over it at every change of
        // the page (D182). On a page a script changes every frame, an image
        // with a link over it was otherwise never read. A control restyled
        // in place over an image is left to the rectangles: a read made
        // while it lay over the image is marked as covered and looked at
        // again once it has gone (D172), and the page checks for protected
        // controls at every rectangle.
        // Admission can narrow in the same batch: a newly private image is
        // withdrawn before its box is read.
        const comparable = new Set<HTMLImageElement>();
        for (const image of observedAtMutationStart) {
          if (!this.#states.has(image)) continue;
          if (this.#isPrivate(image)) this.#refresh(image);
          else comparable.add(image);
        }
        const assessment = this.#captureSafetyRelationChanges(
          comparable,
          currentSafetyTargets,
        );
        if (assessment) {
          stylesheetSafetySnapshot = assessment.controlBounds;
          stylesheetSafetyCandidates = new Set(assessment.changedImages);
        } else {
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
    const coverImages = new Set<HTMLImageElement>();
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
      let targetHoldsImage = false;
      for (const image of this.#states.keys()) {
        const path = readSourceFlatTreeElementPath(image);
        if (path?.includes(target)) {
          movingImages.add(image);
          targetHasBoundedDependency = true;
          targetHoldsImage = true;
        }
      }
      if (targetHoldsImage && !this.#coversWithin(target, coverImages)) {
        return undefined;
      }
      if (!targetHasBoundedDependency) {
        // A positioned element that is not a control is not in the control
        // ledger. Once its box has been seen, the old and new boxes are
        // compared (D182); the first time, the old box of one positioned
        // absolute, fixed or sticky is not known, and only the bounded
        // global fallback is safe. One moved in flow (relative, by a
        // transform) is taken where it is now.
        const moved = this.#coverMoveCandidates(
          target,
          coverImages,
          !elementCoversInFlow(target),
        );
        if (!moved) return undefined;
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
    for (const image of coverImages) overlapped.add(image);
    return overlapped;
  }

  /**
   * Compares an element that may cover an image with its last box seen,
   * and adds the images under either box (D182). With no box seen before,
   * `needsOldBox` says the old place matters (false: none can be given) or
   * that the images under the box now are enough.
   */
  #coverMoveCandidates(
    cover: Element,
    into: Set<HTMLImageElement>,
    needsOldBox: boolean,
  ): boolean {
    const current = cover.isConnected
      ? readCaptureSafetyBounds(cover)
      : undefined;
    const previous = this.#coverBounds.get(cover);
    this.#coverBounds.delete(cover);
    if (current) {
      this.#coverBounds.set(cover, current);
      if (this.#coverBounds.size > MAX_COVER_LEDGER) {
        const oldest = this.#coverBounds.keys().next().value;
        if (oldest) this.#coverBounds.delete(oldest);
      }
    }
    if (!previous && !current) return !needsOldBox;
    if (!previous && needsOldBox) return false;
    const box = previous && current
      ? sameCaptureSafetyBounds(previous, current)
        ? current
        : captureSafetyBoundsHull(previous, current)
      : (current ?? previous)!;
    let comparisons = 0;
    for (const [image, state] of this.#states) {
      if (++comparisons > MAX_CAPTURE_OVERLAP_COMPARISONS) return false;
      const path = readSourceFlatTreeElementPath(image);
      const bounds = readCaptureSafetyBounds(image);
      if (!path || !bounds) return false;
      if (path.includes(cover)) continue;
      if (
        rectanglesOverlap(bounds, box) ||
        rectanglesOverlap(state.safetyBounds, box)
      ) into.add(image);
    }
    return true;
  }

  /**
   * A class or style on an element that holds images can move another
   * element inside it over them or off them (a menu shown by a class on
   * `body`): those images are not themselves moved, so the elements under
   * the ancestor that may cover them are compared with their last boxes
   * (D182). Bounded: past MAX_COVER_SCAN_ELEMENTS nothing more is looked at.
   */
  #coversWithin(target: Element, into: Set<HTMLImageElement>): boolean {
    const view = target.ownerDocument?.defaultView;
    const getComputedStyle = view?.getComputedStyle;
    if (!view || typeof getComputedStyle !== 'function') return true;
    const pending: Element[] = [...target.children];
    let inspected = 0;
    while (pending.length > 0 && inspected < MAX_COVER_SCAN_ELEMENTS) {
      const element = pending.pop()!;
      inspected += 1;
      if (isImageElement(element)) continue;
      let style: CSSStyleDeclaration | undefined;
      try {
        style = getComputedStyle.call(view, element) ?? undefined;
      } catch {
        style = undefined;
      }
      const position = style?.position?.trim().toLowerCase() ?? '';
      const transform = style?.transform?.trim().toLowerCase() ?? '';
      const covers = position === 'absolute' || position === 'fixed' ||
        position === 'sticky' || position === 'relative' ||
        (transform !== '' && transform !== 'none');
      const holdsImage = covers &&
        boundedDescendantMatch(element, 'img', MAX_COVER_SCAN_ELEMENTS) !== false;
      if (covers && !holdsImage) {
        if (!this.#coverMoveCandidates(element, into, false)) return false;
        continue;
      }
      for (const child of element.children) pending.push(child);
    }
    return true;
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
    // No control before or now: no relation can have changed, and no image
    // box needs reading.
    if (controls.size === 0) return Object.freeze({ changedImages, controlBounds });
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

  #invalidateCaptureBands(): void {
    this.#captureBandIndex = undefined;
    this.#captureBandIndexRefused = false;
    this.#captureBandIndexUnchecked = false;
  }

  /**
   * Whether every control is where the index has it, at the present scroll:
   * the same box in the document, still no box, or still a mover. Asked
   * after the pointer or the focus moved; an index too large to check is
   * not kept.
   */
  #captureBandIndexHolds(
    index: CaptureBandIndex,
    scrollX: number,
    scrollY: number,
  ): boolean {
    if (
      index.documentBounds.size + index.empty.length + index.movers.length >
        MAX_CAPTURE_BAND_RECHECK
    ) return false;
    const moving = new Map<Element, boolean>();
    for (const [control, placed] of index.documentBounds) {
      if (!control.isConnected) return false;
      const bounds = readCaptureSafetyBounds(control);
      if (!bounds) return false;
      if (elementMovesWithViewport(control, moving) !== false) return false;
      const now = translateBounds(bounds, scrollX, scrollY);
      if (
        Math.abs(now.left - placed.left) > 0.5 ||
        Math.abs(now.top - placed.top) > 0.5 ||
        Math.abs(now.right - placed.right) > 0.5 ||
        Math.abs(now.bottom - placed.bottom) > 0.5
      ) return false;
    }
    for (const control of index.empty) {
      if (!control.isConnected) return false;
      const bounds = readCaptureSafetyBounds(control);
      if (!bounds || (bounds.width > 0 && bounds.height > 0)) return false;
      if (elementMovesWithViewport(control, moving) !== false) return false;
    }
    for (const mover of index.movers) {
      if (elementMovesWithViewport(mover, moving) !== true) return false;
    }
    return true;
  }

  /**
   * The images on screen whose capture a document scroll may have changed,
   * on a page of more controls than are read at each frame (D172). Only the
   * controls in the bands of the document each image passed through, the
   * wide controls and the movers are compared; the rest stayed where they
   * were in the document, away from the image. `undefined` fails closed:
   * there is no index yet (it is made now, for the next frame), it could
   * not be made, or anything is animating.
   */
  #captureBandChanges(
    images: ReadonlySet<HTMLImageElement>,
  ): Set<HTMLImageElement> | undefined {
    if (images.size === 0) return new Set();
    const view = this.#environment.document.defaultView;
    const scrollX = view?.scrollX;
    const scrollY = view?.scrollY;
    if (
      typeof scrollX !== 'number' || !Number.isFinite(scrollX) ||
      typeof scrollY !== 'number' || !Number.isFinite(scrollY)
    ) return undefined;
    // A running animation or transition may move any control between
    // frames with no event: the index is not trusted while one runs.
    if (documentHasRunningAnimation(this.#environment.document)) {
      this.#invalidateCaptureBands();
      return undefined;
    }
    let index = this.#captureBandIndex;
    if (index && this.#captureBandIndexUnchecked) {
      this.#captureBandIndexUnchecked = false;
      if (!this.#captureBandIndexHolds(index, scrollX, scrollY)) {
        this.#invalidateCaptureBands();
        index = undefined;
      }
    }
    if (!index) {
      if (this.#captureBandIndexRefused) return undefined;
      index = this.#buildCaptureBandIndex(scrollX, scrollY);
      if (!index) {
        this.#captureBandIndexRefused = true;
        return undefined;
      }
      this.#captureBandIndex = index;
      for (const image of images) {
        const bounds = readCaptureSafetyBounds(image);
        if (bounds) {
          index.imageBounds.set(image, translateBounds(bounds, scrollX, scrollY));
        }
      }
      // Nothing to compare with yet.
      return undefined;
    }
    const moverBounds = new Map<Element, CaptureSafetyBounds>();
    for (const mover of index.movers) {
      const bounds = mover.isConnected ? readCaptureSafetyBounds(mover) : undefined;
      if (!bounds) {
        this.#invalidateCaptureBands();
        return undefined;
      }
      moverBounds.set(mover, bounds);
    }
    const changed = new Set<HTMLImageElement>();
    const imageBounds = new Map<HTMLImageElement, CaptureSafetyBounds>();
    let comparisons = 0;
    for (const image of images) {
      const current = readCaptureSafetyBounds(image);
      const path = readSourceFlatTreeElementPath(image);
      if (!current || !path) {
        this.#invalidateCaptureBands();
        return undefined;
      }
      const currentDocument = translateBounds(current, scrollX, scrollY);
      imageBounds.set(image, currentDocument);
      const previousDocument = index.imageBounds.get(image);
      if (!previousDocument) {
        // New on screen since the last frame: its capture is new anyway.
        changed.add(image);
        continue;
      }
      const sweptDocument = captureSafetyBoundsHull(
        previousDocument,
        currentDocument,
      );
      const stillInDocument = sameCaptureSafetyBounds(
        previousDocument,
        currentDocument,
      );
      const nearby = new Set<Element>(index.wide);
      const first = Math.floor(sweptDocument.top / CAPTURE_BAND_HEIGHT) - 1;
      const last = Math.floor(sweptDocument.bottom / CAPTURE_BAND_HEIGHT) + 1;
      if (last - first > MAX_CAPTURE_BAND_SPAN * 4) {
        this.#invalidateCaptureBands();
        return undefined;
      }
      for (let band = first; band <= last; band += 1) {
        for (const control of index.bands.get(band) ?? []) nearby.add(control);
      }
      let imageChanged = false;
      for (const control of nearby) {
        comparisons += 1;
        if (comparisons > MAX_CAPTURE_OVERLAP_COMPARISONS) {
          this.#invalidateCaptureBands();
          return undefined;
        }
        if (path.includes(control)) continue;
        // A control that left the document since is a change only through
        // the mutation that removed it, which drops this index first.
        const bounds = index.documentBounds.get(control);
        if (!bounds) continue;
        if (stillInDocument) continue;
        // The control stayed in place in the document; widened by a pixel
        // so that rounding never hides a touch.
        const control1 = inflateBounds(bounds, 1);
        const before = rectanglesOverlap(previousDocument, control1);
        const after = rectanglesOverlap(currentDocument, control1);
        if (before !== after || rectanglesOverlap(sweptDocument, control1)) {
          imageChanged = true;
          break;
        }
      }
      if (!imageChanged) {
        const previousScreen = translateBounds(
          previousDocument,
          -index.scrollX,
          -index.scrollY,
        );
        for (const mover of index.movers) {
          comparisons += 1;
          if (comparisons > MAX_CAPTURE_OVERLAP_COMPARISONS) {
            this.#invalidateCaptureBands();
            return undefined;
          }
          if (path.includes(mover)) continue;
          const before = index.moverBounds.get(mover);
          const after = moverBounds.get(mover);
          if (!before || !after) {
            imageChanged = true;
            break;
          }
          const overlappedBefore = rectanglesOverlap(previousScreen, before);
          const overlappedAfter = rectanglesOverlap(current, after);
          if (
            overlappedBefore !== overlappedAfter ||
            (
              !sameCaptureSafetyRelativeGeometry(
                previousScreen,
                current,
                before,
                after,
              ) &&
              rectanglesOverlap(
                captureSafetyBoundsHull(previousScreen, current),
                captureSafetyBoundsHull(before, after),
              )
            )
          ) {
            imageChanged = true;
            break;
          }
        }
      }
      if (imageChanged) changed.add(image);
    }
    index.imageBounds.clear();
    for (const [image, bounds] of imageBounds) index.imageBounds.set(image, bounds);
    index.moverBounds.clear();
    for (const [mover, bounds] of moverBounds) index.moverBounds.set(mover, bounds);
    index.scrollX = scrollX;
    index.scrollY = scrollY;
    return changed;
  }

  #buildCaptureBandIndex(
    scrollX: number,
    scrollY: number,
  ): CaptureBandIndex | undefined {
    const controls = collectCurrentCaptureControlTargets(
      this.#environment.document,
      MAX_CAPTURE_BAND_TARGETS,
    );
    if (!controls) return undefined;
    const bands = new Map<number, Element[]>();
    const wide: Element[] = [];
    const documentBounds = new Map<Element, CaptureSafetyBounds>();
    const empty: Element[] = [];
    const movers: Element[] = [];
    const moverBounds = new Map<Element, CaptureSafetyBounds>();
    const moving = new Map<Element, boolean>();
    for (const control of controls) {
      const bounds = readCaptureSafetyBounds(control);
      if (!bounds) return undefined;
      const mover = elementMovesWithViewport(control, moving);
      if (mover === undefined) return undefined;
      if (mover) {
        if (movers.length >= MAX_CAPTURE_SAFETY_TARGETS) return undefined;
        movers.push(control);
        moverBounds.set(control, bounds);
        continue;
      }
      // An empty box paints nothing and overlaps nothing.
      if (!(bounds.width > 0 && bounds.height > 0)) {
        empty.push(control);
        continue;
      }
      const placed = translateBounds(bounds, scrollX, scrollY);
      documentBounds.set(control, placed);
      const first = Math.floor(placed.top / CAPTURE_BAND_HEIGHT);
      const last = Math.floor(placed.bottom / CAPTURE_BAND_HEIGHT);
      if (last - first > MAX_CAPTURE_BAND_SPAN) {
        if (wide.length >= MAX_CAPTURE_SAFETY_TARGETS) return undefined;
        wide.push(control);
        continue;
      }
      for (let band = first; band <= last; band += 1) {
        const list = bands.get(band);
        if (list) list.push(control);
        else bands.set(band, [control]);
      }
    }
    return {
      bands,
      wide,
      documentBounds,
      empty,
      movers,
      moverBounds,
      imageBounds: new Map(),
      scrollX,
      scrollY,
    };
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
  readonly shadowRoots: readonly ShadowRoot[];
  readonly hostCandidates: readonly Element[];
  readonly overflow: boolean;
}

function createSourceImageTraversalBudget(
  maximumImages: number,
): SourceImageTraversalBudget {
  return {
    nodesRemaining: MAX_SOURCE_IMAGE_TRAVERSAL_NODES,
    imagesRemaining: Math.min(MAX_OBSERVED_SOURCE_IMAGES, maximumImages),
    rootsRemaining: MAX_SOURCE_IMAGE_SHADOW_ROOTS,
    overflow: false,
  };
}

function collectBoundedImageGraph(
  initialNodes: Iterable<Node>,
  budget: SourceImageTraversalBudget,
): BoundedImageGraph {
  const images: HTMLImageElement[] = [];
  const shadowRoots: ShadowRoot[] = [];
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
      // Only an element the page can attach a root to waits for one (D125).
      if (canHostAuthorShadowRoot(node)) {
        if (hostCandidates.length < MAX_SOURCE_SHADOW_HOST_CANDIDATES) {
          hostCandidates.push(node);
        } else {
          budget.overflow = true;
        }
      }
      if (isImageElement(node)) {
        // Images are collected past the configured cap, up to the absolute
        // observer maximum, so admission can rank them by visual attention
        // instead of by DOM order; the image budget only records that the
        // configured cap was exceeded.
        if (budget.imagesRemaining <= 0) {
          budget.overflow = true;
        } else {
          budget.imagesRemaining -= 1;
        }
        if (images.length < MAX_OBSERVED_SOURCE_IMAGES) {
          images.push(node);
        } else {
          budget.overflow = true;
        }
      }
      const shadow = readImageSourceShadowRoot(node);
      if (shadow === UNREADABLE_SHADOW_ROOT) {
        budget.overflow = true;
      } else if (shadow) {
        if (budget.rootsRemaining <= 0) {
          budget.overflow = true;
        } else {
          budget.rootsRemaining -= 1;
          shadowRoots.push(shadow);
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
    shadowRoots: Object.freeze(shadowRoots),
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
    shadowRoots: graph.shadowRoots,
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
  // The element's own root, as a descendant's below.
  const ownShadow = readImageSourceShadowRoot(node);
  if (ownShadow === UNREADABLE_SHADOW_ROOT) return undefined;
  if (ownShadow && !appendBoundedChildNodes(
    ownShadow,
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
      const shadow = readImageSourceShadowRoot(current);
      if (shadow === UNREADABLE_SHADOW_ROOT) return undefined;
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

/**
 * Whether an element is moved in flow (relative, or by a transform) rather
 * than placed out of it: where it was before its change is about where it
 * is now, so the images under it now are the ones it may have left.
 */
function imageObserverMaySkip(
  record: MutationRecord,
  names: () => SourceStyleNames | undefined,
): boolean {
  if (record.type !== 'attributes' || !isElement(record.target)) return false;
  const name = record.attributeName?.toLowerCase();
  if (!name || (name !== 'class' && !name.startsWith('data-'))) return false;
  // An image's own attributes, and what holds its label or its admission
  // (aria-*, id, title), are read by this observer whatever the rules say.
  if (isImageElement(record.target)) return false;
  return sourceVisibilityMutationMaySkip(record, names);
}

function elementCoversInFlow(element: Element): boolean {
  try {
    const style = element.ownerDocument.defaultView?.getComputedStyle?.(element);
    const position = style?.position?.trim().toLowerCase();
    const transform = style?.transform?.trim().toLowerCase() ?? '';
    return position === 'relative' || (
      position !== 'absolute' && position !== 'fixed' &&
      position !== 'sticky' && transform !== '' && transform !== 'none'
    );
  } catch {
    return false;
  }
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
    const transform = style?.transform?.trim().toLowerCase() ?? '';
    // An element moved by its own `left`, `top` or `transform` in flow
    // paints over what it reaches as well (D182).
    return position === 'absolute' || position === 'fixed' ||
      position === 'sticky' || position === 'relative' ||
      (transform !== '' && transform !== 'none');
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
      const shadow = readImageSourceShadowRoot(current);
      if (shadow === UNREADABLE_SHADOW_ROOT) return undefined;
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
  // The element's own root, as a descendant's below.
  const ownShadow = readImageSourceShadowRoot(root);
  if (ownShadow === UNREADABLE_SHADOW_ROOT) return undefined;
  if (ownShadow && !appendBoundedChildNodes(ownShadow, pending, maximumNodes)) {
    return undefined;
  }
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
    const shadow = readImageSourceShadowRoot(node);
    if (shadow === UNREADABLE_SHADOW_ROOT) return undefined;
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

/** The element's root, open or closed (D125). */
function readImageSourceShadowRoot(element: Element): ShadowRootRead {
  try {
    return readSourceShadowRoot(element) ?? null;
  } catch {
    return UNREADABLE_SHADOW_ROOT;
  }
}

function collectCurrentCaptureControlTargets(
  document: Document,
  limit = MAX_CAPTURE_SAFETY_TARGETS,
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
          if (targets.length >= limit) return undefined;
          targets.push(node);
        }
        const shadow = readImageSourceShadowRoot(node);
        if (shadow === UNREADABLE_SHADOW_ROOT) return undefined;
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

/**
 * Whether a document scroll may move an element on the screen otherwise than
 * the page: it or something around it is fixed or sticky, or follows a
 * scroll or view timeline. Unreadable is `undefined`. Answers for the
 * elements around are kept in `known`, which one index build shares.
 */
function elementMovesWithViewport(
  element: Element,
  known: Map<Element, boolean>,
): boolean | undefined {
  const path = readSourceFlatTreeElementPath(element);
  if (!path) return undefined;
  const view = element.ownerDocument.defaultView;
  const getComputedStyle = view?.getComputedStyle;
  if (typeof getComputedStyle !== 'function') return undefined;
  const walked: Element[] = [];
  let moves = false;
  for (const current of path) {
    const cached = known.get(current);
    if (cached !== undefined) {
      moves = cached;
      break;
    }
    walked.push(current);
    let style: CSSStyleDeclaration;
    try {
      style = getComputedStyle.call(view, current);
    } catch {
      return undefined;
    }
    const position = style.position ?? '';
    const timeline = style.getPropertyValue?.('animation-timeline') ?? '';
    if (
      position === 'fixed' || position === 'sticky' ||
      (timeline !== '' && timeline !== 'auto')
    ) {
      moves = true;
      break;
    }
  }
  for (const current of walked) known.set(current, moves);
  return moves;
}

/** Whether any animation or transition of the document is playing now. */
function documentHasRunningAnimation(document: Document): boolean {
  try {
    if (typeof document.getAnimations !== 'function') return true;
    return document.getAnimations().some(
      (animation) => animation.playState === 'running',
    );
  } catch {
    return true;
  }
}

function translateBounds(
  bounds: CaptureSafetyBounds,
  x: number,
  y: number,
): CaptureSafetyBounds {
  return Object.freeze({
    left: bounds.left + x,
    top: bounds.top + y,
    right: bounds.right + x,
    bottom: bounds.bottom + y,
    width: bounds.width,
    height: bounds.height,
  });
}

function inflateBounds(
  bounds: CaptureSafetyBounds,
  amount: number,
): CaptureSafetyBounds {
  return Object.freeze({
    left: bounds.left - amount,
    top: bounds.top - amount,
    right: bounds.right + amount,
    bottom: bounds.bottom + amount,
    width: bounds.width + 2 * amount,
    height: bounds.height + 2 * amount,
  });
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
    return UNREADABLE_PRIVATE_SOURCE_TOKEN;
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
  /** The facts of the picture CSS gives the image, when CSS decides it. */
  readonly cssPicture: PrivateSourceToken | undefined;
} {
  const path = readSourceFlatTreeElementPath(image);
  if (!path) {
    return Object.freeze({
      routingToken: UNREADABLE_PRIVATE_SOURCE_TOKEN,
      layoutToken: UNREADABLE_PRIVATE_SOURCE_TOKEN,
      cssPicture: undefined,
    });
  }
  const routingParts: string[] = [];
  const layoutParts: string[] = [];
  let cssPicture: PrivateSourceToken | undefined;
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
        // Every fact of the picture is in the paint facts below, or is the
        // image's address, so a change of one is a capture change and
        // reaches the panel with the picture's new number.
        cssPicture = readCssPictureFacts(image, style);
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
      routingToken: UNREADABLE_PRIVATE_SOURCE_TOKEN,
      layoutToken: UNREADABLE_PRIVATE_SOURCE_TOKEN,
      cssPicture: undefined,
    });
  }
  return Object.freeze({
    routingToken: encodePrivateToken(routingParts),
    layoutToken: encodePrivateToken(layoutParts),
    cssPicture,
  });
}

/**
 * What decides the picture of an image whose picture CSS decides: the
 * computed `content` and `object-view-box`, how the picture is fitted, and
 * the file they apply to. `undefined` for an image that shows its own file,
 * which is nearly always.
 */
function readCssPictureFacts(
  image: HTMLImageElement,
  style: CSSStyleDeclaration | undefined,
): PrivateSourceToken | undefined {
  const file = typeof image.currentSrc === 'string' ? image.currentSrc : '';
  if (!style || !styleReplacesImagePicture(style, file, naturalSizeOf(image))) {
    return undefined;
  }
  return encodePrivateToken([
    style.content ?? '',
    style.getPropertyValue?.('object-view-box') ?? '',
    style.objectFit ?? '',
    style.objectPosition ?? '',
    file,
  ]);
}

/** The file's own size, when the image can say (D172). */
function naturalSizeOf(
  image: HTMLImageElement,
): { width: number; height: number } | undefined {
  try {
    return { width: image.naturalWidth, height: image.naturalHeight };
  } catch {
    return undefined;
  }
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
      return digestPrivateToken(parts);
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

/**
 * Oversized URL-like strings are never retained. Their token is a digest
 * instead: two 32-bit mixes of the length-prefixed parts, and the total
 * length. One shared marker made every oversized token equal, so a paint or
 * routing change in an oversized token went unnoticed; calling every
 * oversized token changed would make each geometry refresh a new revision
 * (D121). The digest is for noticing a change, not for security: the first
 * mix is FNV-1a, and the second turns its state before each unit, so that
 * its low bits do not follow the first's (FNV-1 from another seed is the
 * same recurrence: bit 0 of both was the input's parity).
 *
 * A refresh runs on every scroll frame for a visible image, and hashing a
 * megabyte takes over a millisecond. So a long part is read at its two ends
 * only, with its length: the cost stays the same however large the address
 * is. A change inside such a part that keeps its length is left to the
 * mutation or load callback that forces it.
 */
function digestPrivateToken(parts: readonly string[]): PrivateSourceToken {
  let first = 0x811c9dc5;
  let second = 0x9747b28c;
  let length = 0;
  for (const part of parts) {
    const read = `${part.length}:${
      part.length <= 2 * PRIVATE_TOKEN_DIGEST_END
        ? part
        : part.slice(0, PRIVATE_TOKEN_DIGEST_END) +
          part.slice(part.length - PRIVATE_TOKEN_DIGEST_END)
    }`;
    // One plain loop: a helper closing over both hashes ran five times
    // slower.
    for (let index = 0; index < read.length; index += 1) {
      const unit = read.charCodeAt(index);
      first = Math.imul(first ^ unit, 0x01000193);
      second = Math.imul(((second << 13) | (second >>> 19)) ^ unit, 0x5bd1e995);
    }
    length += String(part.length).length + 1 + part.length;
  }
  return Object.freeze({
    kind: 'oversized',
    length,
    first: first >>> 0,
    second: second >>> 0,
  });
}

function privateSourceTokenChanged(
  previous: PrivateSourceToken,
  current: PrivateSourceToken,
): boolean {
  if (previous.kind === 'exact' && current.kind === 'exact') {
    return previous.value !== current.value;
  }
  if (previous.kind === 'oversized' && current.kind === 'oversized') {
    return previous.length !== current.length ||
      previous.first !== current.first ||
      previous.second !== current.second;
  }
  // Two unreadable tokens have nothing to compare. Mutation/load callbacks
  // explicitly force content invalidation; geometry/measurement refreshes
  // must otherwise treat them as stable to avoid a revision/capture hot loop.
  return previous.kind !== current.kind;
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
