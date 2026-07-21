import type { ImageBoundingBox } from './contracts';
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

export const IMAGE_OVERLAY_LAYER_ATTRIBUTE = 'data-simul-image-overlay-layer';
export const MAX_IMAGE_OVERLAY_REGIONS = 10_000;
const MIN_IMAGE_OVERLAY_FONT_PX = 3;
const MAX_IMAGE_OVERLAY_FONT_PX = 32;
const IMAGE_OVERLAY_LINE_HEIGHT = 1.12;
const IMAGE_OVERLAY_FIT_STEPS = 7;

export interface TranslatedImageRegion {
  readonly text: string;
  readonly boundingBox: ImageBoundingBox;
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
  readonly projection: ImageOverlayProjection;
  anchor: ReplicaImageAnchor;
  readonly root: HTMLElement;
}

interface DocumentLayer {
  readonly document: Document;
  readonly root: HTMLElement;
  readonly entries: Map<number, ProjectedEntry>;
  readonly refresh: () => void;
  readonly resizeObserver?: ResizeObserver;
  frame?: number;
}

/**
 * Projects inert translated line boxes into a viewport layer in the replay
 * document. The layer is a body sibling, never a wrapper around the image, so
 * projection cannot influence page layout or source/replay ownership.
 */
export class ImageOverlayProjector {
  readonly #scheduleFrame: AnimationFrameScheduler;
  readonly #cancelFrame: AnimationFrameCanceller;
  readonly #layers = new Map<Document, DocumentLayer>();
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
    this.#removeEntry(layer, projection.nodeId, true);
    if (projection.regions.length === 0) {
      if (layer.entries.size === 0) {
        this.#disposeLayer(layer);
        this.#layers.delete(layer.document);
      }
      return true;
    }

    const root = replayDocument.createElement('div');
    root.dataset.simulImageOverlay = String(projection.nodeId);
    applyImageRootStyle(root);
    for (const region of projection.regions) {
      const element = replayDocument.createElement('span');
      element.textContent = region.text;
      element.dir = 'auto';
      applyRegionStyle(element);
      root.append(element);
    }
    layer.root.append(root);
    layer.entries.set(projection.nodeId, { projection, anchor, root });
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

  refresh(): void {
    for (const layer of this.#layers.values()) this.#scheduleRefresh(layer);
  }

  clear(): void {
    for (const layer of this.#layers.values()) this.#disposeLayer(layer);
    this.#layers.clear();
  }

  dispose(): void {
    this.clear();
  }

  #layerFor(replayDocument: Document): DocumentLayer | undefined {
    const existing = this.#layers.get(replayDocument);
    if (existing?.root.isConnected) return existing;
    if (existing) this.#disposeLayer(existing);
    const parent = replayDocument.body ?? replayDocument.documentElement;
    const view = replayDocument.defaultView;
    if (!parent || !view) return undefined;
    const root = replayDocument.createElement('div');
    root.setAttribute(IMAGE_OVERLAY_LAYER_ATTRIBUTE, 'v1');
    applyLayerStyle(root);
    const refresh = (): void => {
      const layer = this.#layers.get(replayDocument);
      if (layer) this.#scheduleRefresh(layer);
    };
    const resizeObserver = this.environment.createResizeObserver?.(refresh) ??
      (typeof ResizeObserver === 'function'
        ? new ResizeObserver(refresh)
        : undefined);
    const layer: DocumentLayer = {
      document: replayDocument,
      root,
      entries: new Map(),
      refresh,
      ...(resizeObserver ? { resizeObserver } : {}),
    };
    parent.append(root);
    view.addEventListener('scroll', refresh, { passive: true, capture: true });
    view.addEventListener('resize', refresh, { passive: true });
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
    });
  }

  #refreshEntry(layer: DocumentLayer, nodeId: number): void {
    const entry = layer.entries.get(nodeId);
    if (!entry) return;
    const { projection, root } = entry;
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
      !currentAnchor.image.isConnected ||
      !root.isConnected
    ) {
      this.#removeEntry(layer, nodeId);
      return;
    }
    if (currentAnchor.image !== entry.anchor.image) {
      layer.resizeObserver?.unobserve(entry.anchor.image);
      entry.anchor = currentAnchor;
      layer.resizeObserver?.observe(currentAnchor.image);
      this.environment.onAnchorRebound?.(projection.jobOrdinal);
    }
    const anchor = entry.anchor;
    const rect = anchor.image.getBoundingClientRect();
    if (!validRect(rect)) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    root.style.left = `${rect.left}px`;
    root.style.top = `${rect.top}px`;
    root.style.width = `${rect.width}px`;
    root.style.height = `${rect.height}px`;
    const scaleX = rect.width / projection.renderedWidthCss;
    const scaleY = rect.height / projection.renderedHeightCss;
    const regionElements = root.children;
    projection.regions.forEach((region, index) => {
      const element = regionElements.item(index) as HTMLElement | null;
      if (!element) return;
      const box = mappedBox(projection, region.boundingBox, scaleX, scaleY);
      element.style.left = `${box.x}px`;
      element.style.top = `${box.y}px`;
      element.style.width = `${box.width}px`;
      element.style.height = `${box.height}px`;
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
    layer.entries.clear();
    layer.root.remove();
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

function applyLayerStyle(element: HTMLElement): void {
  Object.assign(element.style, {
    position: 'fixed',
    inset: '0',
    overflow: 'hidden',
    pointerEvents: 'none',
    zIndex: '2147483647',
    contain: 'strict',
  });
}

function applyImageRootStyle(element: HTMLElement): void {
  Object.assign(element.style, {
    position: 'absolute',
    overflow: 'hidden',
    pointerEvents: 'none',
    contain: 'strict',
  });
}

function applyRegionStyle(element: HTMLElement): void {
  Object.assign(element.style, {
    position: 'absolute',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    padding: '0',
    margin: '0',
    border: '0',
    boxSizing: 'border-box',
    borderRadius: '2px',
    color: '#111',
    background: 'rgba(255, 255, 255, 0.94)',
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
