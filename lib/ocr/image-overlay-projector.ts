import type { ImageBoundingBox } from './contracts';
import {
  ACCESSIBILITY_TEXT_METHOD_ID,
  isImageReadingMethodId,
  isOcrImageReadingMethod,
  type ImageReadingMethodId,
} from './image-reading-methods';
import type { ReplicaImageAnchor } from '../replica/contracts';
import {
  receiverSafeAnimationFrameCanceller,
  receiverSafeAnimationFrameScheduler,
  type AnimationFrameCanceller,
  type AnimationFrameScheduler,
} from '../browser-scheduling';
import {
  sameSourceDocument,
  type ReplicaSourceDocumentIdentity,
} from '../replica/source-identity';

/**
 * The element that holds one image's translation. It sits in the image's
 * parent, so the page's own stacking decides what paints over it (D74), and
 * out of sight of page selectors where the parent allows it (D92).
 */
export const IMAGE_OVERLAY_ELEMENT = 'simul-image-overlay';
/**
 * Parents that may host a shadow root (the HTML standard's list, less `body`,
 * which stays the mirror's own). An image's overlay lives in such a parent's
 * Simul-owned shadow root (D92).
 */
const OVERLAY_SHADOW_HOSTS: ReadonlySet<string> = new Set([
  'article', 'aside', 'blockquote', 'div', 'footer', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'header', 'main', 'nav', 'p', 'section', 'span',
]);
export const MAX_IMAGE_OVERLAY_REGIONS = 10_000;
export const MAX_IMAGE_OVERLAY_RETAINED_WEIGHT = 1_000_000;
const IMAGE_OVERLAY_ENTRY_WEIGHT = 256;
const IMAGE_OVERLAY_REGION_WEIGHT = 128;
const MIN_IMAGE_OVERLAY_FONT_PX = 3;
const MAX_IMAGE_OVERLAY_FONT_PX = 32;
const IMAGE_OVERLAY_LINE_HEIGHT = 1.12;
const IMAGE_OVERLAY_FIT_STEPS = 7;
export const CAPTION_BAND_MIN_PX = 20;
export const CAPTION_BAND_MAX_FRACTION = 0.34;
/** The band grows to this share only when its text would be illegible (O3). */
export const CAPTION_BAND_GROWN_FRACTION = 0.6;
const CAPTION_BAND_LEGIBLE_FONT_PX = 9;
/**
 * Frames an overlay layer keeps re-measuring after a CSS transition or
 * animation starts around a projected image (about 1.5 s at 60 Hz); the end
 * event always re-measures once more, so a longer motion still settles.
 */
export const IMAGE_OVERLAY_MOTION_FRAMES = 90;
const MAX_CLIP_ANCESTOR_DEPTH = 256;
const MOTION_EVENTS = [
  'transitionrun',
  'transitionend',
  'transitioncancel',
  'animationstart',
  'animationend',
  'animationcancel',
] as const;
const MOTION_START_EVENTS: ReadonlySet<string> = new Set([
  'transitionrun',
  'animationstart',
]);

export interface TranslatedImageRegion {
  readonly text: string;
  readonly boundingBox: ImageBoundingBox;
  readonly placement?: 'ocr-box' | 'whole-image';
}

export interface ImageOverlayProjection {
  readonly jobOrdinal: number;
  readonly document: ReplicaSourceDocumentIdentity;
  readonly nodeId: number;
  readonly contentRevision: number;
  readonly observationRevision: number;
  readonly replayLease: number;
  readonly pairEpoch: number;
  readonly pairKey: string;
  readonly pixelHash: string;
  readonly bitmapWidth: number;
  readonly bitmapHeight: number;
  readonly cropOffsetXCss: number;
  readonly cropOffsetYCss: number;
  readonly cropWidthCss: number;
  readonly cropHeightCss: number;
  readonly renderedWidthCss: number;
  readonly renderedHeightCss: number;
  readonly regions: readonly TranslatedImageRegion[];
  readonly methodId: ImageReadingMethodId;
  readonly evidenceKind: 'ocr' | 'semantic';
}

export interface ImageOverlayProjectorEnvironment {
  readonly resolveAnchor: (
    document: ReplicaSourceDocumentIdentity,
    nodeId: number,
  ) => ReplicaImageAnchor | undefined;
  readonly isCurrent: (projection: ImageOverlayProjection) => boolean;
  readonly scheduleFrame?: AnimationFrameScheduler;
  readonly cancelFrame?: AnimationFrameCanceller;
  readonly createResizeObserver?: (
    callback: ResizeObserverCallback,
  ) => ResizeObserver | undefined;
  readonly onAnchorRebound?: (jobOrdinal: number) => void;
}

interface ProjectedEntry {
  projection: ImageOverlayProjection;
  anchor: ReplicaImageAnchor;
  /** The overlay element after the image, sized to the image's visible part. */
  readonly root: HTMLElement;
  /** The image-sized box inside the root's closed shadow root. */
  readonly content: HTMLElement;
  readonly weight: number;
  layoutWidth?: number;
  layoutHeight?: number;
  /** Ancestors that clip the image, cached until the replica's layout changes. */
  clipAncestors?: readonly ClipAncestor[];
  /** The root's last written box, in its containing block's coordinates. */
  placed?: OverlayBox;
  /** How the root's containing block maps to the viewport, last measured. */
  calibration?: OverlayCalibration;
}

interface OverlayBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Viewport position = origin + scale × CSS position, for boxes positioned in
 * the root's containing block. A transformed or zoomed ancestor gives a scale
 * other than 1; rotation is not modelled.
 */
interface OverlayCalibration {
  readonly originX: number;
  readonly originY: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

const IDENTITY_CALIBRATION: OverlayCalibration = {
  originX: 0,
  originY: 0,
  scaleX: 1,
  scaleY: 1,
};
const MIN_CALIBRATION_SCALE = 0.01;
const MAX_CALIBRATION_SCALE = 100;
/**
 * Layout rounds boxes to fractions of a pixel, so a measured mapping jitters
 * slightly. Changes below these tolerances keep the previous mapping (and a
 * scale this close to 1 is 1), so a settled overlay is neither rewritten nor
 * refitted every frame.
 */
const CALIBRATION_ORIGIN_TOLERANCE_PX = 0.25;
const CALIBRATION_SCALE_TOLERANCE = 0.002;
const OVERLAY_BOX_TOLERANCE_PX = 0.1;
const overlayContents = new WeakMap<Element, HTMLElement>();
const OVERLAY_SHADOW_CSS =
  ':host::before,:host::after{content:none!important;display:none!important}';

interface ClipAncestor {
  readonly element: Element;
  readonly clipsX: boolean;
  readonly clipsY: boolean;
}

interface ViewportBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

interface DocumentLayer {
  readonly document: Document;
  readonly entries: Map<number, ProjectedEntry>;
  readonly refresh: () => void;
  readonly onMotion: (event: Event) => void;
  readonly resizeObserver?: ResizeObserver;
  frame?: number;
  /** Frames left to follow a running transition or animation. */
  motionFrames: number;
}

/**
 * Projects inert translated line boxes over images in the replay document.
 * Each image's overlay is an absolutely positioned element in the image's
 * parent, with no z-index, so it paints where the image paints: whatever the
 * page draws over the image (a pop-up, a sticky header, a dimming backdrop)
 * also covers or dims its translation (D74). It never wraps the image and
 * takes no part in layout; its content sits in a closed shadow root so page
 * CSS cannot restyle it. See `placeOverlay` for where in the parent it goes.
 * The mirror may drop or displace it when it rewrites the image's parent, so
 * every refresh puts it back.
 *
 * The overlay is positioned by measuring where it actually lands, so any
 * containing block (a transformed carousel track, a zoomed subtree) is
 * accounted for. It is sized to the part of the image its clipping ancestors
 * (a carousel window, a scroller) leave visible, hidden while the image is not
 * painted (a faded-out slide), and re-measured every frame while a transition
 * or animation moves the image.
 */
export class ImageOverlayProjector {
  readonly #scheduleFrame: AnimationFrameScheduler;
  readonly #cancelFrame: AnimationFrameCanceller;
  readonly #layers = new Map<Document, DocumentLayer>();
  readonly #retainedEntries = new Map<ProjectedEntry, DocumentLayer>();
  #retainedWeight = 0;
  #pairEpoch = 0;
  #pairKey: string | undefined;

  constructor(private readonly environment: ImageOverlayProjectorEnvironment) {
    this.#scheduleFrame = receiverSafeAnimationFrameScheduler(
      environment.scheduleFrame,
    );
    this.#cancelFrame = receiverSafeAnimationFrameCanceller(
      environment.cancelFrame,
    );
  }

  beginPair(pairEpoch: number, pairKey: string | undefined): boolean {
    if (
      !Number.isSafeInteger(pairEpoch) ||
      pairEpoch < 0 ||
      (pairKey !== undefined &&
        (pairKey.length < 1 || pairKey.length > 128))
    ) return false;
    if (pairEpoch === this.#pairEpoch && pairKey === this.#pairKey) return true;
    this.clear();
    this.#pairEpoch = pairEpoch;
    this.#pairKey = pairKey;
    return true;
  }

  project(projection: ImageOverlayProjection): boolean {
    if (
      !validProjection(projection) ||
      projection.pairEpoch !== this.#pairEpoch ||
      projection.pairKey !== this.#pairKey ||
      !this.environment.isCurrent(projection)
    ) return false;
    const projectionWeight = imageOverlayProjectionWeight(projection);
    if (projectionWeight > MAX_IMAGE_OVERLAY_RETAINED_WEIGHT) {
      this.remove(projection.document, projection.nodeId);
      return false;
    }
    const anchor = this.environment.resolveAnchor(
      projection.document,
      projection.nodeId,
    );
    if (
      !anchor ||
      anchor.replayLease !== projection.replayLease ||
      !sameSourceDocument(anchor.document, projection.document) ||
      !anchor.image.isConnected ||
      anchor.image.ownerDocument !== anchor.iframe.contentDocument
    ) return false;

    const replayDocument = anchor.image.ownerDocument;
    const layer = this.#layerFor(replayDocument);
    if (!layer) return false;
    const existing = layer.entries.get(projection.nodeId);
    if (
      existing &&
      projectionCanRebaseInPlace(existing.projection, projection)
    ) {
      existing.projection = projection;
      existing.root.dataset.simulImageMethod = projection.methodId;
      // Currency rebases are active use, so refresh their bounded FIFO/LRU
      // position without replacing any retained DOM.
      this.#retainedEntries.delete(existing);
      this.#retainedEntries.set(existing, layer);
      this.#refreshEntry(layer, projection.nodeId);
      return layer.entries.get(projection.nodeId)?.root === existing.root;
    }
    this.#removeEntry(layer, projection.nodeId, true);
    if (projection.regions.length === 0) {
      if (layer.entries.size === 0) {
        this.#disposeLayer(layer);
        this.#layers.delete(layer.document);
      }
      return true;
    }
    if (!this.#makeRetainedWeightAvailable(projectionWeight, layer)) {
      if (layer.entries.size === 0) {
        this.#disposeLayer(layer);
        this.#layers.delete(layer.document);
      }
      return false;
    }

    const { root, content } = createOverlayElement(replayDocument);
    root.dataset.simulImageOverlay = String(projection.nodeId);
    root.dataset.simulImageMethod = projection.methodId;
    for (const region of projection.regions) {
      const element = replayDocument.createElement('span');
      element.textContent = region.text;
      element.dir = 'auto';
      applyRegionStyle(element, region.placement === 'whole-image');
      content.append(element);
    }
    if (!placeOverlay(root, anchor.image)) {
      if (layer.entries.size === 0) {
        this.#disposeLayer(layer);
        this.#layers.delete(layer.document);
      }
      return false;
    }
    const entry: ProjectedEntry = {
      projection,
      anchor,
      root,
      content,
      weight: projectionWeight,
    };
    layer.entries.set(projection.nodeId, entry);
    this.#retainedEntries.set(entry, layer);
    this.#retainedWeight += projectionWeight;
    layer.resizeObserver?.observe(anchor.image);
    this.#refreshEntry(layer, projection.nodeId);
    return layer.entries.has(projection.nodeId);
  }

  remove(
    document: ReplicaSourceDocumentIdentity,
    nodeId: number,
  ): void {
    for (const layer of this.#layers.values()) {
      const entry = layer.entries.get(nodeId);
      if (entry && sameSourceDocument(entry.projection.document, document)) {
        this.#removeEntry(layer, nodeId);
      }
    }
  }

  /** The replica's layout changed: re-read clipping ancestors and positions. */
  refresh(): void {
    for (const layer of this.#layers.values()) {
      for (const entry of layer.entries.values()) entry.clipAncestors = undefined;
      this.#scheduleRefresh(layer);
    }
  }

  clear(): void {
    for (const layer of this.#layers.values()) this.#disposeLayer(layer);
    this.#layers.clear();
    this.#retainedEntries.clear();
    this.#retainedWeight = 0;
  }

  dispose(): void {
    this.clear();
  }

  #layerFor(replayDocument: Document): DocumentLayer | undefined {
    const existing = this.#layers.get(replayDocument);
    if (existing) return existing;
    const view = replayDocument.defaultView;
    if (!view) return undefined;
    const refresh = (): void => {
      const layer = this.#layers.get(replayDocument);
      if (layer) this.#scheduleRefresh(layer);
    };
    const onMotion = (event: Event): void => {
      const layer = this.#layers.get(replayDocument);
      if (!layer || !motionMovesAnOverlaidImage(layer, event.target)) return;
      if (MOTION_START_EVENTS.has(event.type)) {
        layer.motionFrames = IMAGE_OVERLAY_MOTION_FRAMES;
      }
      this.#scheduleRefresh(layer);
    };
    const resizeObserver = this.environment.createResizeObserver?.(refresh) ??
      (typeof ResizeObserver === 'function'
        ? new ResizeObserver(refresh)
        : undefined);
    const layer: DocumentLayer = {
      document: replayDocument,
      entries: new Map(),
      refresh,
      onMotion,
      motionFrames: 0,
      ...(resizeObserver ? { resizeObserver } : {}),
    };
    view.addEventListener('scroll', refresh, { passive: true, capture: true });
    view.addEventListener('resize', refresh, { passive: true });
    for (const type of MOTION_EVENTS) {
      replayDocument.addEventListener(type, onMotion, {
        passive: true,
        capture: true,
      });
    }
    this.#layers.set(replayDocument, layer);
    return layer;
  }

  #scheduleRefresh(layer: DocumentLayer): void {
    if (layer.frame !== undefined) return;
    layer.frame = this.#scheduleFrame(() => {
      layer.frame = undefined;
      if (this.#layers.get(layer.document) !== layer) return;
      for (const nodeId of [...layer.entries.keys()]) {
        this.#refreshEntry(layer, nodeId);
      }
      if (layer.motionFrames > 0 && layer.entries.size > 0) {
        layer.motionFrames -= 1;
        this.#scheduleRefresh(layer);
      } else {
        layer.motionFrames = 0;
      }
    });
  }

  #refreshEntry(layer: DocumentLayer, nodeId: number): void {
    const entry = layer.entries.get(nodeId);
    if (!entry) return;
    const { projection, root, content } = entry;
    const currentAnchor = this.environment.resolveAnchor(
      projection.document,
      projection.nodeId,
    );
    if (
      projection.pairEpoch !== this.#pairEpoch ||
      projection.pairKey !== this.#pairKey ||
      !this.environment.isCurrent(projection) ||
      !currentAnchor ||
      currentAnchor.replayLease !== projection.replayLease ||
      currentAnchor.image.ownerDocument !== layer.document ||
      !currentAnchor.image.isConnected
    ) {
      this.#removeEntry(layer, nodeId);
      return;
    }
    if (currentAnchor.image !== entry.anchor.image) {
      layer.resizeObserver?.unobserve(entry.anchor.image);
      entry.anchor = currentAnchor;
      entry.clipAncestors = undefined;
      layer.resizeObserver?.observe(currentAnchor.image);
      this.environment.onAnchorRebound?.(projection.jobOrdinal);
    }
    const anchor = entry.anchor;
    if (!placeOverlay(root, anchor.image)) {
      this.#removeEntry(layer, nodeId);
      return;
    }
    const rect = anchor.image.getBoundingClientRect();
    if (!validRect(rect) || !imageIsPainted(anchor.image)) {
      setOverlayShown(root, false);
      return;
    }
    entry.clipAncestors ??= clippingAncestors(anchor.image);
    const visible = visibleImageBox(rect, entry.clipAncestors);
    if (!visible) {
      setOverlayShown(root, false);
      return;
    }
    const calibration = calibrateOverlay(entry, visible);
    const { scaleX, scaleY } = calibration;
    const placed: OverlayBox = {
      left: roundCss((visible.left - calibration.originX) / scaleX),
      top: roundCss((visible.top - calibration.originY) / scaleY),
      width: roundCss((visible.right - visible.left) / scaleX),
      height: roundCss((visible.bottom - visible.top) / scaleY),
    };
    if (!entry.placed || !sameOverlayBox(entry.placed, placed)) {
      writeOverlayBox(root, placed);
      entry.placed = placed;
    }
    setImportantStyle(content, 'left', `${roundCss((rect.left - visible.left) / scaleX)}px`);
    setImportantStyle(content, 'top', `${roundCss((rect.top - visible.top) / scaleY)}px`);
    // Regions are laid out in the containing block's CSS pixels, which a
    // scaled ancestor then scales exactly as it scales the image.
    const width = roundCss(rect.width / scaleX);
    const height = roundCss(rect.height / scaleY);
    if (entry.layoutWidth === width && entry.layoutHeight === height) {
      return;
    }
    entry.layoutWidth = width;
    entry.layoutHeight = height;
    setImportantStyle(content, 'width', `${width}px`);
    setImportantStyle(content, 'height', `${height}px`);
    const regionScaleX = width / projection.renderedWidthCss;
    const regionScaleY = height / projection.renderedHeightCss;
    const regionElements = content.children;
    projection.regions.forEach((region, index) => {
      const element = regionElements.item(index) as HTMLElement | null;
      if (!element) return;
      if (region.placement === 'whole-image') {
        placeCaptionBand(element, region.text, width, height);
        return;
      }
      const box = mappedBox(projection, region.boundingBox, regionScaleX, regionScaleY);
      placeRegion(element, box);
      fitRegionText(element, region.text, box.width, box.height);
    });
  }

  #removeEntry(
    layer: DocumentLayer,
    nodeId: number,
    retainEmptyLayer = false,
  ): void {
    const entry = layer.entries.get(nodeId);
    if (!entry) return;
    layer.entries.delete(nodeId);
    this.#retainedEntries.delete(entry);
    this.#retainedWeight = Math.max(0, this.#retainedWeight - entry.weight);
    layer.resizeObserver?.unobserve(entry.anchor.image);
    entry.root.remove();
    if (layer.entries.size === 0 && !retainEmptyLayer) {
      this.#disposeLayer(layer);
      this.#layers.delete(layer.document);
    }
  }

  #disposeLayer(layer: DocumentLayer): void {
    if (layer.frame !== undefined) this.#cancelFrame(layer.frame);
    layer.frame = undefined;
    layer.resizeObserver?.disconnect();
    const view = layer.document.defaultView;
    view?.removeEventListener('scroll', layer.refresh, true);
    view?.removeEventListener('resize', layer.refresh);
    for (const type of MOTION_EVENTS) {
      layer.document.removeEventListener(type, layer.onMotion, true);
    }
    layer.motionFrames = 0;
    for (const entry of layer.entries.values()) {
      this.#retainedEntries.delete(entry);
      this.#retainedWeight = Math.max(0, this.#retainedWeight - entry.weight);
      entry.root.remove();
    }
    layer.entries.clear();
  }

  #makeRetainedWeightAvailable(
    weight: number,
    retainedLayer?: DocumentLayer,
  ): boolean {
    while (
      this.#retainedWeight > MAX_IMAGE_OVERLAY_RETAINED_WEIGHT - weight
    ) {
      const oldest = this.#retainedEntries.entries().next().value as
        | [ProjectedEntry, DocumentLayer]
        | undefined;
      if (!oldest) return false;
      this.#removeEntry(
        oldest[1],
        oldest[0].projection.nodeId,
        oldest[1] === retainedLayer,
      );
    }
    return true;
  }
}

function validProjection(value: ImageOverlayProjection): boolean {
  if (
    !Number.isSafeInteger(value.nodeId) || value.nodeId < 1 ||
    !Number.isSafeInteger(value.jobOrdinal) || value.jobOrdinal < 1 ||
    !Number.isSafeInteger(value.contentRevision) || value.contentRevision < 1 ||
    !Number.isSafeInteger(value.observationRevision) || value.observationRevision < 1 ||
    !Number.isSafeInteger(value.replayLease) || value.replayLease < 1 ||
    !Number.isSafeInteger(value.pairEpoch) || value.pairEpoch < 0 ||
    typeof value.pairKey !== 'string' || value.pairKey.length < 1 || value.pairKey.length > 128 ||
    !/^[a-f0-9]{64}$/u.test(value.pixelHash) ||
    !positiveFinite(value.bitmapWidth) ||
    !positiveFinite(value.bitmapHeight) ||
    !nonNegativeFinite(value.cropOffsetXCss) ||
    !nonNegativeFinite(value.cropOffsetYCss) ||
    !positiveFinite(value.cropWidthCss) ||
    !positiveFinite(value.cropHeightCss) ||
    !positiveFinite(value.renderedWidthCss) ||
    !positiveFinite(value.renderedHeightCss) ||
    value.cropOffsetXCss + value.cropWidthCss > value.renderedWidthCss + 1 ||
    value.cropOffsetYCss + value.cropHeightCss > value.renderedHeightCss + 1 ||
    !validProjectionProvenance(value.methodId, value.evidenceKind) ||
    !Array.isArray(value.regions) ||
    value.regions.length > MAX_IMAGE_OVERLAY_REGIONS
  ) return false;
  return value.regions.every((region) =>
    typeof region.text === 'string' &&
    region.text.length > 0 &&
    region.text.length <= 100_000 &&
    validBox(region.boundingBox, value.bitmapWidth, value.bitmapHeight),
  );
}

function imageOverlayProjectionWeight(
  projection: ImageOverlayProjection,
): number {
  let weight = IMAGE_OVERLAY_ENTRY_WEIGHT;
  for (const region of projection.regions) {
    const regionWeight = IMAGE_OVERLAY_REGION_WEIGHT + region.text.length * 2;
    if (regionWeight > MAX_IMAGE_OVERLAY_RETAINED_WEIGHT - weight) {
      return MAX_IMAGE_OVERLAY_RETAINED_WEIGHT + 1;
    }
    weight += regionWeight;
  }
  return weight;
}

/**
 * Observation currency may advance while the translated pixel blueprint stays
 * exact. Reusing the existing root keeps visible text continuously mounted;
 * any visual/evidence difference still takes the conservative replacement
 * path.
 */
function projectionCanRebaseInPlace(
  previous: ImageOverlayProjection,
  next: ImageOverlayProjection,
): boolean {
  return sameSourceDocument(previous.document, next.document) &&
    previous.nodeId === next.nodeId &&
    previous.replayLease === next.replayLease &&
    previous.pairEpoch === next.pairEpoch &&
    previous.pairKey === next.pairKey &&
    previous.pixelHash === next.pixelHash &&
    previous.bitmapWidth === next.bitmapWidth &&
    previous.bitmapHeight === next.bitmapHeight &&
    previous.cropOffsetXCss === next.cropOffsetXCss &&
    previous.cropOffsetYCss === next.cropOffsetYCss &&
    previous.cropWidthCss === next.cropWidthCss &&
    previous.cropHeightCss === next.cropHeightCss &&
    previous.renderedWidthCss === next.renderedWidthCss &&
    previous.renderedHeightCss === next.renderedHeightCss &&
    previous.methodId === next.methodId &&
    previous.evidenceKind === next.evidenceKind &&
    sameTranslatedRegions(previous.regions, next.regions);
}

function sameTranslatedRegions(
  previous: readonly TranslatedImageRegion[],
  next: readonly TranslatedImageRegion[],
): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  return previous.every((region, index) => {
    const candidate = next[index];
    return Boolean(
      candidate &&
      region.text === candidate.text &&
      region.placement === candidate.placement &&
      region.boundingBox.x === candidate.boundingBox.x &&
      region.boundingBox.y === candidate.boundingBox.y &&
      region.boundingBox.width === candidate.boundingBox.width &&
      region.boundingBox.height === candidate.boundingBox.height,
    );
  });
}

function validProjectionProvenance(
  methodId: unknown,
  evidenceKind: unknown,
): boolean {
  if (!isImageReadingMethodId(methodId)) return false;
  if (evidenceKind === 'semantic') {
    return methodId === ACCESSIBILITY_TEXT_METHOD_ID;
  }
  if (evidenceKind === 'ocr') return isOcrImageReadingMethod(methodId);
  return false;
}

function validBox(
  box: ImageBoundingBox,
  bitmapWidth: number,
  bitmapHeight: number,
): boolean {
  return nonNegativeFinite(box.x) &&
    nonNegativeFinite(box.y) &&
    positiveFinite(box.width) &&
    positiveFinite(box.height) &&
    box.x + box.width <= bitmapWidth &&
    box.y + box.height <= bitmapHeight;
}

/**
 * A label-based result (accessibility text) carries no geometry, so it is
 * shown as a caption band along the bottom edge of the image rather than as a
 * box over the whole picture (D48): the image stays visible and the
 * translation reads as its caption. OCR regions, which do have geometry,
 * replace it when they arrive.
 */
export function captionBandBox(
  width: number,
  height: number,
  fraction = CAPTION_BAND_MAX_FRACTION,
): ImageBoundingBox {
  const bandHeight = roundCss(Math.min(
    height,
    Math.max(CAPTION_BAND_MIN_PX, height * fraction),
  ));
  return { x: 0, y: roundCss(height - bandHeight), width, height: bandHeight };
}

/**
 * The caption band keeps a third of the image unless its text would fit only
 * below a legible size (long alt text on a short image); then it grows, to
 * at most 60% of the image (review O3, approved by the owner).
 */
function placeCaptionBand(
  element: HTMLElement,
  text: string,
  width: number,
  height: number,
): void {
  const band = captionBandBox(width, height);
  placeRegion(element, band);
  fitRegionText(element, text, band.width, band.height);
  if (Number.parseFloat(element.style.fontSize) >= CAPTION_BAND_LEGIBLE_FONT_PX) return;
  const grown = captionBandBox(width, height, CAPTION_BAND_GROWN_FRACTION);
  if (grown.height <= band.height) return;
  placeRegion(element, grown);
  fitRegionText(element, text, grown.width, grown.height);
}

function placeRegion(element: HTMLElement, box: ImageBoundingBox): void {
  element.style.left = `${box.x}px`;
  element.style.top = `${box.y}px`;
  element.style.width = `${box.width}px`;
  element.style.height = `${box.height}px`;
}

function roundCss(value: number): number {
  return Math.round(value * 100) / 100;
}

function mappedBox(
  projection: ImageOverlayProjection,
  box: ImageBoundingBox,
  scaleX: number,
  scaleY: number,
): ImageBoundingBox {
  const cropX = box.x / projection.bitmapWidth * projection.cropWidthCss;
  const cropY = box.y / projection.bitmapHeight * projection.cropHeightCss;
  const cropWidth = box.width / projection.bitmapWidth * projection.cropWidthCss;
  const cropHeight = box.height / projection.bitmapHeight * projection.cropHeightCss;
  return {
    x: (projection.cropOffsetXCss + cropX) * scaleX,
    y: (projection.cropOffsetYCss + cropY) * scaleY,
    width: cropWidth * scaleX,
    height: cropHeight * scaleY,
  };
}

/**
 * The translated boxes of an overlay element. They live in its closed shadow
 * root, so diagnostics and tests read them through this.
 */
export function imageOverlayContent(
  root: Element | null | undefined,
): HTMLElement | undefined {
  return root ? overlayContents.get(root) : undefined;
}

/**
 * The overlay element resets every property with inline `!important` so page
 * rules that match it (`* {}`, `.card > *`) cannot move or restyle it. It
 * keeps `z-index: auto`: it paints in tree order right after its image.
 * Visibility is inherited so a hidden ancestor hides it with the image.
 */
function createOverlayElement(
  document: Document,
): { root: HTMLElement; content: HTMLElement } {
  const root = document.createElement(IMAGE_OVERLAY_ELEMENT);
  root.style.setProperty('all', 'initial', 'important');
  for (const [property, value] of [
    ['position', 'absolute'],
    ['display', 'none'],
    ['box-sizing', 'border-box'],
    ['margin', '0'],
    ['overflow', 'hidden'],
    ['contain', 'strict'],
    ['pointer-events', 'none'],
    ['visibility', 'inherit'],
  ] as const) {
    root.style.setProperty(property, value, 'important');
  }
  root.hidden = true;
  const content = document.createElement('div');
  for (const [property, value] of [
    ['position', 'absolute'],
    ['margin', '0'],
    ['padding', '0'],
    ['border', '0'],
    ['pointer-events', 'none'],
  ] as const) {
    content.style.setProperty(property, value, 'important');
  }
  let parent: ParentNode = root;
  try {
    const shadow = root.attachShadow({ mode: 'closed' });
    // Page rules such as `.card > *::after` would otherwise add boxes to the
    // overlay; an important rule from inside the shadow wins over the page's.
    const style = document.createElement('style');
    style.textContent = OVERLAY_SHADOW_CSS;
    shadow.append(style);
    parent = shadow;
  } catch {
    // Without shadow DOM the boxes still render; page CSS may reach them.
  }
  parent.append(content);
  overlayContents.set(root, content);
  return { root, content };
}

/** Shadow roots this module attached to image parents, by host. */
const overlayShadowRoots = new WeakMap<Element, ShadowRoot>();

/**
 * Puts an image's overlay back where it belongs, wherever the mirror left or
 * moved the image. Page CSS that counts siblings (`img + p`, `:last-child`,
 * `:nth-child`) must not see it (D92), so when the image's parent can host
 * one, the overlay lives in a closed Simul-owned shadow root on that parent,
 * after a slot that shows the parent's own children unchanged. It then paints
 * after all of the parent's children rather than right after the image, so a
 * later positioned sibling (a badge over the image) no longer covers it. The
 * mirror sees no shadow root (it is closed) and patches the parent's children
 * as before. Any other parent (a link, a picture, a figure, a list item, a
 * parent with its own shadow root) keeps the overlay right after the image.
 */
function placeOverlay(root: HTMLElement, image: HTMLImageElement): boolean {
  const parent = image.parentElement;
  const shadow = parent && image.parentNode === parent
    ? overlayShadowRootFor(parent)
    : undefined;
  if (shadow) {
    if (root.parentNode === shadow) return true;
    try {
      shadow.append(root);
    } catch {
      return false;
    }
    return root.parentNode === shadow;
  }
  if (root.previousSibling === image) return true;
  try {
    image.after(root);
  } catch {
    return false;
  }
  return root.previousSibling === image;
}

function overlayShadowRootFor(parent: Element): ShadowRoot | undefined {
  const known = overlayShadowRoots.get(parent);
  if (known) return known;
  if (
    parent.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
    !OVERLAY_SHADOW_HOSTS.has(parent.localName)
  ) return undefined;
  let shadow: ShadowRoot;
  try {
    // Throws for a parent that already has a shadow root (a mirrored one).
    shadow = parent.attachShadow({ mode: 'closed' });
  } catch {
    return undefined;
  }
  shadow.append(parent.ownerDocument.createElement('slot'));
  overlayShadowRoots.set(parent, shadow);
  return shadow;
}

/**
 * Every overlay element in a replica document, in the light tree or in the
 * owned shadow roots of image parents. For diagnostics and tests.
 */
export function findImageOverlays(document: Document): HTMLElement[] {
  const found = [
    ...document.querySelectorAll<HTMLElement>(IMAGE_OVERLAY_ELEMENT),
  ];
  for (const host of document.querySelectorAll([...OVERLAY_SHADOW_HOSTS].join(','))) {
    const shadow = overlayShadowRoots.get(host);
    if (shadow) {
      found.push(...shadow.querySelectorAll<HTMLElement>(IMAGE_OVERLAY_ELEMENT));
    }
  }
  return found;
}

function setOverlayShown(root: HTMLElement, shown: boolean): void {
  if (root.hidden === !shown) return;
  root.hidden = !shown;
  root.style.setProperty('display', shown ? 'block' : 'none', 'important');
}

function setImportantStyle(
  element: HTMLElement,
  property: string,
  value: string,
): void {
  if (element.style.getPropertyValue(property) === value) return;
  element.style.setProperty(property, value, 'important');
}

function writeOverlayBox(root: HTMLElement, box: OverlayBox): void {
  setImportantStyle(root, 'left', `${box.left}px`);
  setImportantStyle(root, 'top', `${box.top}px`);
  setImportantStyle(root, 'width', `${box.width}px`);
  setImportantStyle(root, 'height', `${box.height}px`);
}

/**
 * Shows the overlay and measures where its last written box landed, which
 * gives the mapping from its containing block to the viewport. A first
 * placement assumes no transform so there is a box to measure. Without a
 * layout (a zero-size box) the last mapping, or the identity, is kept.
 */
function calibrateOverlay(
  entry: ProjectedEntry,
  visible: ViewportBox,
): OverlayCalibration {
  const { root } = entry;
  if (!entry.placed) {
    const guess: OverlayBox = {
      left: roundCss(visible.left),
      top: roundCss(visible.top),
      width: roundCss(visible.right - visible.left),
      height: roundCss(visible.bottom - visible.top),
    };
    writeOverlayBox(root, guess);
    entry.placed = guess;
  }
  setOverlayShown(root, true);
  const placed = entry.placed;
  let measured: DOMRect | undefined;
  try {
    measured = root.getBoundingClientRect();
  } catch {
    measured = undefined;
  }
  if (measured && validRect(measured) && placed.width > 0 && placed.height > 0) {
    const scaleX = measured.width / placed.width;
    const scaleY = measured.height / placed.height;
    if (
      scaleX >= MIN_CALIBRATION_SCALE && scaleX <= MAX_CALIBRATION_SCALE &&
      scaleY >= MIN_CALIBRATION_SCALE && scaleY <= MAX_CALIBRATION_SCALE
    ) {
      const next: OverlayCalibration = {
        originX: measured.left - scaleX * placed.left,
        originY: measured.top - scaleY * placed.top,
        scaleX: settledScale(scaleX, entry.calibration?.scaleX),
        scaleY: settledScale(scaleY, entry.calibration?.scaleY),
      };
      const previous = entry.calibration;
      entry.calibration = previous &&
          previous.scaleX === next.scaleX &&
          previous.scaleY === next.scaleY &&
          Math.abs(previous.originX - next.originX) < CALIBRATION_ORIGIN_TOLERANCE_PX &&
          Math.abs(previous.originY - next.originY) < CALIBRATION_ORIGIN_TOLERANCE_PX
        ? previous
        : next;
    }
  }
  return entry.calibration ?? IDENTITY_CALIBRATION;
}

function settledScale(measured: number, previous: number | undefined): number {
  if (Math.abs(measured - 1) < CALIBRATION_SCALE_TOLERANCE) return 1;
  if (
    previous !== undefined &&
    Math.abs(measured - previous) < previous * CALIBRATION_SCALE_TOLERANCE
  ) return previous;
  return measured;
}

function sameOverlayBox(left: OverlayBox, right: OverlayBox): boolean {
  return Math.abs(left.left - right.left) < OVERLAY_BOX_TOLERANCE_PX &&
    Math.abs(left.top - right.top) < OVERLAY_BOX_TOLERANCE_PX &&
    Math.abs(left.width - right.width) < OVERLAY_BOX_TOLERANCE_PX &&
    Math.abs(left.height - right.height) < OVERLAY_BOX_TOLERANCE_PX;
}

function applyRegionStyle(element: HTMLElement, wholeImage = false): void {
  Object.assign(element.style, {
    position: 'absolute',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    padding: wholeImage ? '4px 6px' : '0',
    margin: '0',
    border: '0',
    boxSizing: 'border-box',
    borderRadius: '2px',
    color: '#111',
    background: wholeImage
      ? 'rgba(255, 255, 255, 0.86)'
      : 'rgba(255, 255, 255, 0.94)',
    fontFamily: 'system-ui, sans-serif',
    fontWeight: '600',
    textAlign: 'center',
    textOverflow: 'clip',
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
    pointerEvents: 'none',
  });
}

/**
 * Fit translated text without changing OCR geometry. The first estimate is
 * script-neutral and deterministic; a short bounded measurement refinement
 * handles real browser font metrics without creating an unbounded layout loop.
 */
function fitRegionText(
  element: HTMLElement,
  text: string,
  width: number,
  height: number,
): void {
  const maximum = Math.max(
    MIN_IMAGE_OVERLAY_FONT_PX,
    Math.min(MAX_IMAGE_OVERLAY_FONT_PX, height / IMAGE_OVERLAY_LINE_HEIGHT),
  );
  const units = Math.max(1, estimatedTextUnits(text));
  const areaFit = Math.sqrt(
    Math.max(1, width * height) / (units * IMAGE_OVERLAY_LINE_HEIGHT),
  );
  let fitted = Math.max(
    MIN_IMAGE_OVERLAY_FONT_PX,
    Math.min(maximum, areaFit),
  );
  applyRegionFont(element, fitted);
  if (!regionOverflows(element, width, height) || fitted <= MIN_IMAGE_OVERLAY_FONT_PX) {
    return;
  }

  let lower = MIN_IMAGE_OVERLAY_FONT_PX;
  let upper = fitted;
  applyRegionFont(element, lower);
  if (regionOverflows(element, width, height)) return;
  for (let step = 0; step < IMAGE_OVERLAY_FIT_STEPS; step += 1) {
    const candidate = (lower + upper) / 2;
    applyRegionFont(element, candidate);
    if (regionOverflows(element, width, height)) upper = candidate;
    else lower = candidate;
  }
  fitted = lower;
  applyRegionFont(element, fitted);
}

function applyRegionFont(element: HTMLElement, fontSize: number): void {
  element.style.fontSize = `${Math.round(fontSize * 100) / 100}px`;
  element.style.lineHeight = String(IMAGE_OVERLAY_LINE_HEIGHT);
}

function regionOverflows(
  element: HTMLElement,
  width: number,
  height: number,
): boolean {
  const scrollWidth = Number(element.scrollWidth);
  const scrollHeight = Number(element.scrollHeight);
  return (
    (Number.isFinite(scrollWidth) && scrollWidth > width + 0.5) ||
    (Number.isFinite(scrollHeight) && scrollHeight > height + 0.5)
  );
}

function estimatedTextUnits(text: string): number {
  let units = 0;
  for (const character of text) {
    if (/\s/u.test(character)) units += 0.34;
    else if (/\p{Mark}/u.test(character)) continue;
    else if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(character)) {
      units += 1;
    } else {
      units += 0.58;
    }
  }
  return units;
}

/**
 * Whether a transition or animation event came from the image or from an
 * element that contains it (across shadow roots). An unreadable target counts,
 * since following it for a bounded number of frames is only extra work.
 */
function motionMovesAnOverlaidImage(
  layer: DocumentLayer,
  target: EventTarget | null,
): boolean {
  if (layer.entries.size === 0) return false;
  const candidate = target as Partial<Node> | null;
  if (!candidate || typeof candidate.contains !== 'function') return true;
  try {
    for (const entry of layer.entries.values()) {
      let node: Node | undefined = entry.anchor.image;
      for (let depth = 0; node && depth < MAX_CLIP_ANCESTOR_DEPTH; depth += 1) {
        if (candidate.contains(node)) return true;
        const root = node.getRootNode?.() as (Node & { host?: Element }) | undefined;
        node = root?.host;
      }
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * False only when Chrome reports the image as not painted: hidden, inside a
 * `display: none` or skipped `content-visibility` subtree, or at zero opacity
 * (a faded-out carousel slide). Without the API the overlay stays visible.
 */
function imageIsPainted(image: Element): boolean {
  const check = (image as Element & {
    checkVisibility?: (options?: Record<string, boolean>) => boolean;
  }).checkVisibility;
  if (typeof check !== 'function') return true;
  try {
    return check.call(image, {
      opacityProperty: true,
      visibilityProperty: true,
    }) !== false;
  } catch {
    return true;
  }
}

/**
 * The ancestors whose overflow clips the image, following the containing-block
 * chain: an absolutely positioned box escapes non-positioned ancestors, and a
 * fixed box escapes all of them. `body` and the root clip at the viewport,
 * which the layer already does. Content-free: only computed style is read.
 */
function clippingAncestors(image: Element): readonly ClipAncestor[] {
  const view = image.ownerDocument?.defaultView;
  const getComputedStyle = view?.getComputedStyle;
  if (!view || typeof getComputedStyle !== 'function') return [];
  const read = (element: Element): CSSStyleDeclaration | undefined => {
    try {
      return getComputedStyle.call(view, element) ?? undefined;
    } catch {
      return undefined;
    }
  };
  const ancestors: ClipAncestor[] = [];
  const ownPosition = styleValue(read(image), 'position');
  if (ownPosition === 'fixed') return ancestors;
  let skipToContainingBlock = ownPosition === 'absolute';
  let current = composedParentElement(image);
  for (
    let depth = 0;
    current && depth < MAX_CLIP_ANCESTOR_DEPTH;
    current = composedParentElement(current), depth += 1
  ) {
    const tagName = current.localName?.toLowerCase();
    if (tagName === 'body' || tagName === 'html') break;
    const style = read(current);
    if (!style) continue;
    if (skipToContainingBlock && !containsAbsoluteBoxes(style)) continue;
    skipToContainingBlock = false;
    const paintContained = /\b(paint|strict|content)\b/u.test(
      styleValue(style, 'contain'),
    );
    const clipsX = paintContained || clipsOverflow(styleValue(style, 'overflowX'));
    const clipsY = paintContained || clipsOverflow(styleValue(style, 'overflowY'));
    if (clipsX || clipsY) ancestors.push({ element: current, clipsX, clipsY });
    const position = styleValue(style, 'position');
    if (position === 'fixed') break;
    if (position === 'absolute') skipToContainingBlock = true;
  }
  return ancestors;
}

function composedParentElement(element: Element): Element | undefined {
  const slot = (element as Element & { assignedSlot?: Element | null })
    .assignedSlot;
  if (slot) return slot;
  if (element.parentElement) return element.parentElement;
  const host = (element.parentNode as (Node & { host?: Element }) | null)?.host;
  return host ?? undefined;
}

function containsAbsoluteBoxes(style: CSSStyleDeclaration): boolean {
  const position = styleValue(style, 'position');
  if (position !== '' && position !== 'static') return true;
  const transform = styleValue(style, 'transform');
  const filter = styleValue(style, 'filter');
  return (transform !== '' && transform !== 'none') ||
    (filter !== '' && filter !== 'none') ||
    /\b(paint|layout|strict|content)\b/u.test(styleValue(style, 'contain'));
}

function clipsOverflow(value: string): boolean {
  return value !== '' && value !== 'visible';
}

function styleValue(
  style: CSSStyleDeclaration | undefined,
  property: 'position' | 'overflowX' | 'overflowY' | 'contain' | 'transform' | 'filter',
): string {
  const value = style?.[property];
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * The part of the image box its clipping ancestors leave visible, or
 * undefined when nothing is left. Ancestor border boxes are used, so a
 * clipping border can show at most its own width of overlay.
 */
function visibleImageBox(
  rect: DOMRect,
  ancestors: readonly ClipAncestor[],
): ViewportBox | undefined {
  let left = rect.left;
  let top = rect.top;
  let right = rect.left + rect.width;
  let bottom = rect.top + rect.height;
  for (const { element, clipsX, clipsY } of ancestors) {
    let box: DOMRect;
    try {
      box = element.getBoundingClientRect();
    } catch {
      continue;
    }
    if (
      !Number.isFinite(box.left) || !Number.isFinite(box.top) ||
      !Number.isFinite(box.width) || !Number.isFinite(box.height)
    ) continue;
    if (clipsX) {
      left = Math.max(left, box.left);
      right = Math.min(right, box.left + box.width);
    }
    if (clipsY) {
      top = Math.max(top, box.top);
      bottom = Math.min(bottom, box.top + box.height);
    }
  }
  if (right - left < 0.5 || bottom - top < 0.5) return undefined;
  return { left, top, right, bottom };
}

function validRect(rect: DOMRect): boolean {
  return Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    positiveFinite(rect.width) &&
    positiveFinite(rect.height);
}

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= 1_000_000;
}

function nonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1_000_000;
}
