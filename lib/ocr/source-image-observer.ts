import {
  readSourceDocumentIdentity,
  type ReplicaSourceDocumentIdentity,
} from '../replica/source-identity';
import {
  hasSourcePrivateOrActivationElementAncestor,
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
  readonly scheduleFrame?: AnimationFrameScheduler;
  readonly cancelFrame?: AnimationFrameCanceller;
  readonly maxImages?: number;
  readonly maxSubscribers?: number;
}

export const MAX_OBSERVED_SOURCE_IMAGES = 10_000;
export const MAX_SOURCE_IMAGE_OBSERVER_SUBSCRIBERS = 16;
const MAX_IMAGE_DIMENSION = 1_000_000;
const MAX_PRIVATE_TOKEN_INPUT = 64 * 1024;

type PrivateSourceToken =
  | { readonly kind: 'exact'; readonly value: string }
  | { readonly kind: 'oversized' };

interface ImageFacts {
  readonly renderedWidth: number;
  readonly renderedHeight: number;
  readonly intrinsicWidth: number;
  readonly intrinsicHeight: number;
  readonly viewportToken: string;
}

interface ObservedImageState {
  readonly image: HTMLImageElement;
  readonly nodeId: number;
  sourceToken: PrivateSourceToken;
  viewportToken: string;
  visibleSettled: boolean;
  nearSettled: boolean;
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
  readonly #listeners = new Set<(event: SourceImageObservationEvent) => void>();
  readonly #states = new Map<HTMLImageElement, ObservedImageState>();
  readonly #capacityCandidates = new Set<HTMLImageElement>();
  readonly #visible = new Set<HTMLImageElement>();
  readonly #near = new Set<HTMLImageElement>();
  #visibleObserver: ElementObserver<Element> | undefined;
  #nearObserver: ElementObserver<Element> | undefined;
  #resizeObserver: ElementObserver<Element> | undefined;
  #mutationObserver: MutationObserverPort | undefined;
  #loadListener: ((event: Event) => void) | undefined;
  #viewportListener: (() => void) | undefined;
  #scrollListener: (() => void) | undefined;
  #scrollFrame: number | undefined;
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
  }

  get subscriberCount(): number {
    return this.#listeners.size;
  }

  /** Safe counts only: no source URLs, text, node identifiers, or pixels. */
  get readySummary(): ImageSourceReadySummary {
    let candidateImages = this.#states.size;
    try {
      candidateImages = Math.max(
        candidateImages,
        Math.min(
          MAX_OBSERVED_SOURCE_IMAGES,
          this.#environment.document.querySelectorAll('img').length,
        ),
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
    for (const image of [...this.#states.keys()]) this.#refresh(image);
    for (const image of this.#environment.document.querySelectorAll('img')) {
      if (!this.#states.has(image)) this.#discover(image);
    }
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
    this.#mutationObserver.observe(this.#environment.document, {
      attributes: true,
      attributeFilter: [
        'src',
        'srcset',
        'sizes',
        'width',
        'height',
        'class',
        'style',
        'lang',
        'role',
        'contenteditable',
      ],
      childList: true,
      subtree: true,
    });
    this.#loadListener = (event) => {
      if (!this.#isActiveGeneration(generation)) return;
      if (isImageElement(event.target)) this.#refresh(event.target, true);
    };
    this.#viewportListener = () => {
      if (!this.#isActiveGeneration(generation)) return;
      this.refreshAll();
    };
    this.#scrollListener = () => {
      if (!this.#isActiveGeneration(generation) || this.#scrollFrame !== undefined) {
        return;
      }
      this.#scrollFrame = this.#scheduleFrame(() => {
        this.#scrollFrame = undefined;
        if (!this.#isActiveGeneration(generation)) return;
        for (const image of [...this.#visible]) this.#refresh(image);
      });
    };
    this.#environment.document.addEventListener(
      'load',
      this.#loadListener,
      true,
    );
    this.#environment.document.defaultView?.addEventListener(
      'resize',
      this.#viewportListener,
    );
    this.#environment.document.addEventListener(
      'scroll',
      this.#scrollListener,
      true,
    );
    for (const image of this.#environment.document.querySelectorAll('img')) {
      this.#discover(image);
    }
  }

  #stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.#lifecycleGeneration += 1;
    if (this.#loadListener) {
      this.#environment.document.removeEventListener(
        'load',
        this.#loadListener,
        true,
      );
    }
    if (this.#viewportListener) {
      this.#environment.document.defaultView?.removeEventListener(
        'resize',
        this.#viewportListener,
      );
    }
    if (this.#scrollListener) {
      this.#environment.document.removeEventListener(
        'scroll',
        this.#scrollListener,
        true,
      );
    }
    if (this.#scrollFrame !== undefined) {
      this.#cancelFrame(this.#scrollFrame);
      this.#scrollFrame = undefined;
    }
    this.#visibleObserver?.disconnect();
    this.#nearObserver?.disconnect();
    this.#resizeObserver?.disconnect();
    this.#mutationObserver?.disconnect();
    this.#visibleObserver = undefined;
    this.#nearObserver = undefined;
    this.#resizeObserver = undefined;
    this.#mutationObserver = undefined;
    this.#loadListener = undefined;
    this.#viewportListener = undefined;
    this.#scrollListener = undefined;
    this.#states.clear();
    this.#capacityCandidates.clear();
    this.#visible.clear();
    this.#near.clear();
    this.#fillingCapacity = false;
  }

  #discover(image: HTMLImageElement): void {
    if (!this.#started || !image.isConnected || this.#isPrivate(image)) return;
    const nodeId = this.#readNodeId(image);
    if (!isNodeId(nodeId)) return;
    const existing = this.#states.get(image);
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
    const state: ObservedImageState = {
      image,
      nodeId,
      sourceToken: readPrivateSourceToken(image),
      viewportToken: facts.viewportToken,
      visibleSettled: false,
      nearSettled: false,
    };
    this.#states.set(image, state);
    this.#visibleObserver?.observe(image);
    this.#nearObserver?.observe(image);
    this.#resizeObserver?.observe(image);
    if (!state.lastEvent) this.#emitUpsert(state, true, true, facts);
  }

  #refresh(
    image: HTMLImageElement,
    forceContentChange = false,
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
    const contentChanged = forceContentChange ||
      privateSourceTokenChanged(state.sourceToken, token);
    const observationChanged = state.viewportToken !== facts.viewportToken;
    state.sourceToken = token;
    state.viewportToken = facts.viewportToken;
    this.#emitUpsert(state, contentChanged, observationChanged, facts);
  }

  #emitUpsert(
    state: ObservedImageState,
    contentChanged: boolean,
    observationChanged: boolean,
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
      for (const image of this.#environment.document.querySelectorAll('img')) {
        if (this.#states.size >= this.#maxImages) break;
        if (!this.#states.has(image)) this.#discover(image);
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
    for (const record of records) {
      if (record.type === 'childList') {
        for (const node of record.removedNodes) {
          for (const image of collectImages(node)) this.#remove(image);
        }
        for (const node of record.addedNodes) {
          for (const image of collectImages(node)) this.#discover(image);
        }
      }
      if (record.type !== 'attributes' || !isElement(record.target)) continue;
      const attributeName = record.attributeName?.toLowerCase();
      if (attributeName === 'lang') {
        for (const image of collectImages(record.target)) {
          // Routing metadata is part of OCR content identity even though the
          // raw language attribute never leaves the source adapter.
          this.#refresh(image, true);
        }
        continue;
      }
      if (attributeName === 'role' || attributeName === 'contenteditable') {
        for (const image of collectImages(record.target)) this.#refresh(image);
        continue;
      }
      if (isImageElement(record.target)) {
        this.#refresh(
          record.target,
          attributeName === 'src' ||
            attributeName === 'srcset' ||
            attributeName === 'sizes',
        );
      } else if (record.target.tagName.toLowerCase() === 'source') {
        const picture = record.target.closest('picture');
        for (const image of picture?.querySelectorAll('img') ?? []) {
          this.#refresh(image, true);
        }
      }
    }
  }

  #visibility(image: HTMLImageElement): ImageVisibilityTier {
    if (this.#visible.has(image)) return 'visible';
    if (this.#near.has(image)) return 'near';
    return 'background';
  }

  #isPrivate(image: HTMLImageElement): boolean {
    if (hasSourcePrivateOrActivationElementAncestor(image)) return true;
    if (!this.#environment.isPrivateImage) return false;
    try {
      return this.#environment.isPrivateImage(image);
    } catch {
      return true;
    }
  }

  #readNodeId(image: HTMLImageElement): number | undefined {
    try {
      return this.#environment.getNodeId(image);
    } catch {
      return undefined;
    }
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

function collectImages(node: Node): HTMLImageElement[] {
  if (!isElement(node)) return [];
  const images: HTMLImageElement[] = [];
  if (isImageElement(node)) images.push(node);
  for (const image of node.querySelectorAll('img')) images.push(image);
  return images;
}

function readPrivateSourceToken(image: HTMLImageElement): PrivateSourceToken {
  let parts: string[];
  try {
    parts = [
      image.currentSrc,
      image.getAttribute('src') ?? '',
      image.getAttribute('srcset') ?? '',
      image.getAttribute('sizes') ?? '',
    ].map((value) => typeof value === 'string' ? value : '');
  } catch {
    return OVERSIZED_PRIVATE_SOURCE_TOKEN;
  }
  let encodedLength = 0;
  for (const part of parts) {
    encodedLength += String(part.length).length + 1 + part.length;
    if (encodedLength > MAX_PRIVATE_TOKEN_INPUT) {
      return OVERSIZED_PRIVATE_SOURCE_TOKEN;
    }
  }
  const encoded = parts.map((part) => `${part.length}:${part}`).join('');
  return Object.freeze({ kind: 'exact', value: encoded });
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
    !isBoundedDimension(bounds.width) ||
    !isBoundedDimension(bounds.height) ||
    !isBoundedDimension(image.naturalWidth) ||
    !isBoundedDimension(image.naturalHeight)
  ) return undefined;
  return Object.freeze({
    renderedWidth: bounds.width,
    renderedHeight: bounds.height,
    intrinsicWidth: image.naturalWidth,
    intrinsicHeight: image.naturalHeight,
    viewportToken: viewportObservationToken(image, bounds),
  });
}

function viewportObservationToken(
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
  return [left, top, bounds.width, bounds.height, viewportWidth, viewportHeight]
    .join(',');
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
