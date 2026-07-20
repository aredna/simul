import type { MirrorDisplayMode } from '../preferences';
import { computeMirrorScale } from '../visual-renderer';

export const STATIC_REPLAY_LABEL = 'Replica reconnecting';
export const LIVE_REPLAY_LABEL = 'Live translated replica';
export const LEGACY_FALLBACK_LABEL = 'Legacy mirror · fallback';

const MAX_REPLAY_DIMENSION = 1_000_000;
const MAX_REPLAY_SCALE = 3;
const MAX_OWNED_EXTENT = MAX_REPLAY_DIMENSION * MAX_REPLAY_SCALE;

export interface VisibleReplayDimensions {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly documentWidth: number;
  readonly documentHeight: number;
}

export interface VisibleReplayExtent {
  readonly width: number;
  readonly height: number;
}

export interface VisibleReplayLayout {
  readonly displayMode: MirrorDisplayMode;
  readonly zoomPercent: number;
}

export interface VisibleReplayScroll {
  readonly scrollX: number;
  readonly scrollY: number;
}

export interface VisibleReplayCandidateLease {
  readonly mount: HTMLElement;
  commit(iframe: HTMLIFrameElement, extent: VisibleReplayExtent): void;
  release(): void;
}

export interface ReplayPresentationHost {
  createCandidate(dimensions: VisibleReplayDimensions): VisibleReplayCandidateLease;
  markLive(iframe: HTMLIFrameElement): void;
  refreshExtent(iframe: HTMLIFrameElement, extent: VisibleReplayExtent): void;
  refreshDimensions?(
    iframe: HTMLIFrameElement,
    dimensions: VisibleReplayDimensions,
  ): void;
  showLegacy(showFallbackLabel: boolean): void;
  dispose(): void;
}

interface VisibleReplayHostOptions {
  readonly hostDocument: Document;
  readonly legacySurface: HTMLElement;
  readonly previewSurface: HTMLElement;
  readonly badge: HTMLElement;
}

/**
 * Owns the extension-side presentation surfaces only. Replayer lifetime stays
 * with the engine, while this host makes candidate-to-visible DOM swaps
 * synchronous and keeps the source viewport geometry independent of zoom.
 */
export class VisibleReplayHost implements ReplayPresentationHost {
  readonly #document: Document;
  readonly #legacySurface: HTMLElement;
  readonly #previewSurface: HTMLElement;
  readonly #badge: HTMLElement;
  #candidate: CandidateLease | undefined;
  #committed: CandidateLease | undefined;
  #layout: VisibleReplayLayout = { displayMode: 'fit', zoomPercent: 100 };
  #sourceScrollX = 0;
  #sourceScrollY = 0;
  #disposed = false;
  #resizeObserver: ResizeObserver | undefined;

  constructor(options: VisibleReplayHostOptions) {
    this.#document = options.hostDocument;
    this.#legacySurface = options.legacySurface;
    this.#previewSurface = options.previewSurface;
    this.#badge = options.badge;
  }

  get previewVisible(): boolean {
    return Boolean(this.#committed && !this.#previewSurface.hidden);
  }

  get hasCommittedReplica(): boolean {
    return Boolean(this.#committed && !this.#committed.released);
  }

  createCandidate(
    dimensions: VisibleReplayDimensions,
  ): VisibleReplayCandidateLease {
    if (this.#disposed) throw new Error('The replay presentation host is disposed.');
    this.#ensureResizeObserver();
    this.#candidate?.release();
    const candidate = new CandidateLease(
      this,
      this.#document,
      normalizeDimensions(dimensions),
    );
    this.#candidate = candidate;
    // An iframe's browsing context may be discarded and its srcdoc reloaded
    // when a connected ancestor is moved between parents. Stage candidates in
    // their final preview parent and reveal them in place at commit time.
    this.#previewSurface.append(candidate.root);
    return candidate;
  }

  updateLayout(layout: VisibleReplayLayout): void {
    this.#layout = layout;
    const committed = this.#committed;
    if (!committed) return;
    this.#applyLayout(committed);
  }

  #applyLayout(committed: CandidateLease): void {
    const availableWidth =
      committed.scroller.clientWidth ||
      this.#previewSurface.clientWidth ||
      committed.dimensions.viewportWidth;
    const scale = computeMirrorScale(
      availableWidth,
      committed.dimensions.viewportWidth,
      this.#layout.displayMode,
      this.#layout.zoomPercent,
    );
    committed.scale = scale;
    const contentWidth = Math.max(
      committed.live ? 0 : committed.dimensions.documentWidth,
      committed.replayExtent.width,
      committed.dimensions.viewportWidth,
    );
    const contentHeight = Math.max(
      committed.live ? 0 : committed.dimensions.documentHeight,
      committed.replayExtent.height,
      committed.dimensions.viewportHeight,
    );
    const viewportWidth = boundedExtent(committed.dimensions.viewportWidth * scale);
    const viewportHeight = boundedExtent(committed.dimensions.viewportHeight * scale);
    committed.mount.style.width = `${committed.dimensions.viewportWidth}px`;
    committed.mount.style.height = `${committed.dimensions.viewportHeight}px`;
    committed.scaleLayer.style.width = `${committed.dimensions.viewportWidth}px`;
    committed.scaleLayer.style.height = `${committed.dimensions.viewportHeight}px`;
    committed.scaleLayer.style.transform = `scale(${scale})`;
    committed.stickyViewport.style.width = `${viewportWidth}px`;
    committed.stickyViewport.style.height = `${viewportHeight}px`;
    const availableHeight =
      committed.scroller.clientHeight ||
      this.#previewSurface.clientHeight ||
      viewportHeight;
    // When the scaled source viewport is smaller than the panel, extend the
    // track so the iframe can still reach the source document's final offset.
    // When it is larger, the content extent preserves panning across the
    // clipped portion of that zoomed viewport after internal scroll clamps.
    committed.stage.style.width = `${boundedExtent(Math.max(
      contentWidth * scale,
      maximumSourceScrollX(committed) * scale + availableWidth,
    ))}px`;
    committed.stage.style.height = `${boundedExtent(Math.max(
      contentHeight * scale,
      maximumSourceScrollY(committed) * scale + availableHeight,
    ))}px`;
    committed.iframe.style.width = `${committed.dimensions.viewportWidth}px`;
    committed.iframe.style.height = `${committed.dimensions.viewportHeight}px`;
    committed.iframe.setAttribute('width', String(committed.dimensions.viewportWidth));
    committed.iframe.setAttribute('height', String(committed.dimensions.viewportHeight));
    this.#setOuterScroll(committed);
    this.#projectScroll(committed);
  }

  followSourceScroll(scroll: VisibleReplayScroll): void {
    const committed = this.#committed;
    if (!committed) return;
    this.#sourceScrollX = clamp(
      scroll.scrollX,
      0,
      maximumSourceScrollX(committed),
    );
    this.#sourceScrollY = clamp(
      scroll.scrollY,
      0,
      maximumSourceScrollY(committed),
    );
    this.#setOuterScroll(committed);
    this.#projectScroll(committed);
  }

  markLive(iframe: HTMLIFrameElement): void {
    const committed = this.#committed;
    if (committed?.iframe !== iframe || committed.released) return;
    const wasLive = committed.live;
    committed.live = true;
    this.#previewSurface.hidden = false;
    this.#previewSurface.setAttribute('aria-hidden', 'true');
    this.#legacySurface.hidden = true;
    this.#legacySurface.setAttribute('aria-hidden', 'true');
    this.#badge.textContent = LIVE_REPLAY_LABEL;
    this.#badge.hidden = false;
    if (!wasLive) this.#applyLayout(committed);
  }

  refreshExtent(iframe: HTMLIFrameElement, extent: VisibleReplayExtent): void {
    const committed = this.#committed;
    if (!committed || committed.iframe !== iframe || committed.released) return;
    committed.replayExtent = normalizeExtent(extent);
    this.#sourceScrollX = clamp(
      this.#sourceScrollX,
      0,
      maximumSourceScrollX(committed),
    );
    this.#sourceScrollY = clamp(
      this.#sourceScrollY,
      0,
      maximumSourceScrollY(committed),
    );
    this.#applyLayout(committed);
  }

  refreshDimensions(
    iframe: HTMLIFrameElement,
    dimensions: VisibleReplayDimensions,
  ): void {
    const committed = this.#committed;
    if (!committed || committed.iframe !== iframe || committed.released) return;
    committed.dimensions = normalizeDimensions(dimensions);
    this.#sourceScrollX = clamp(
      this.#sourceScrollX,
      0,
      maximumSourceScrollX(committed),
    );
    this.#sourceScrollY = clamp(
      this.#sourceScrollY,
      0,
      maximumSourceScrollY(committed),
    );
    this.#applyLayout(committed);
  }

  showLegacy(showFallbackLabel: boolean): void {
    this.#legacySurface.hidden = false;
    this.#legacySurface.removeAttribute('aria-hidden');
    this.#previewSurface.hidden = true;
    this.#previewSurface.setAttribute('aria-hidden', 'true');
    if (showFallbackLabel) {
      this.#badge.textContent = LEGACY_FALLBACK_LABEL;
      this.#badge.hidden = false;
    } else {
      this.#badge.textContent = '';
      this.#badge.hidden = true;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.showLegacy(false);
    this.#candidate?.release();
    this.#committed?.release();
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = undefined;
    this.#disposed = true;
  }

  commitCandidate(
    candidate: CandidateLease,
    iframe: HTMLIFrameElement,
    extent: VisibleReplayExtent,
  ): void {
    if (
      this.#disposed ||
      this.#candidate !== candidate ||
      candidate.released ||
      candidate.root.parentElement !== this.#previewSurface ||
      !candidate.mount.contains(iframe) ||
      !isProtectedReplayIframe(iframe)
    ) {
      throw new Error('The replay candidate is not eligible for presentation.');
    }

    candidate.markCommitted(iframe, normalizeExtent(extent));
    const previous = this.#committed;
    this.#sourceScrollX = boundedScroll(iframe.contentWindow?.scrollX);
    this.#sourceScrollY = boundedScroll(iframe.contentWindow?.scrollY);

    candidate.installScrollListener(() => {
      if (this.#committed !== candidate || candidate.released) return;
      this.#sourceScrollX = clamp(
        candidate.scroller.scrollLeft / candidate.scale,
        0,
        maximumSourceScrollX(candidate),
      );
      this.#sourceScrollY = clamp(
        candidate.scroller.scrollTop / candidate.scale,
        0,
        maximumSourceScrollY(candidate),
      );
      this.#projectScroll(candidate);
    });
    this.#applyLayout(candidate);

    // Reveal the already-connected candidate synchronously. Never move its
    // iframe subtree: Chrome can reload srcdoc during a connected DOM move and
    // erase the constructed replica back to Simul's empty shell.
    candidate.root.classList.remove('replica-replay-root--candidate');
    candidate.root.classList.add('replica-replay-root--committed');
    candidate.root.removeAttribute('inert');
    candidate.root.removeAttribute('style');
    this.#candidate = undefined;
    this.#committed = candidate;
    this.#previewSurface.hidden = false;
    this.#previewSurface.setAttribute('aria-hidden', 'true');
    this.#legacySurface.hidden = true;
    this.#legacySurface.setAttribute('aria-hidden', 'true');
    this.#badge.textContent = STATIC_REPLAY_LABEL;
    this.#badge.hidden = false;
    this.#applyLayout(candidate);

    // The new surface is visible before the old lease is released. Both
    // changes occur in one task, so replacement stays atomic between paints.
    previous?.release();
  }

  detach(candidate: CandidateLease): void {
    if (this.#candidate === candidate) this.#candidate = undefined;
    if (this.#committed === candidate) {
      const wasVisible = !this.#previewSurface.hidden;
      this.#committed = undefined;
      this.#previewSurface.replaceChildren();
      if (wasVisible) this.showLegacy(false);
    }
  }

  #setOuterScroll(candidate: CandidateLease): void {
    candidate.scroller.scrollLeft = boundedScrollExtent(
      this.#sourceScrollX * candidate.scale,
    );
    candidate.scroller.scrollTop = boundedScrollExtent(
      this.#sourceScrollY * candidate.scale,
    );
  }

  #projectScroll(candidate: CandidateLease): void {
    const target = candidate.iframe.contentWindow;
    if (!target || typeof target.scrollTo !== 'function') return;
    try {
      target.scrollTo({
        left: this.#sourceScrollX,
        top: this.#sourceScrollY,
        behavior: 'auto',
      });
    } catch {
      try {
        target.scrollTo(this.#sourceScrollX, this.#sourceScrollY);
      } catch {
        // A replay viewport that rejects scroll projection remains a usable,
        // static preview; it must not unwind an otherwise atomic commit.
      }
    }
  }

  #ensureResizeObserver(): void {
    if (this.#resizeObserver || typeof ResizeObserver !== 'function') return;
    this.#resizeObserver = new ResizeObserver(() => this.updateLayout(this.#layout));
    this.#resizeObserver.observe(this.#previewSurface);
  }
}

class CandidateLease implements VisibleReplayCandidateLease {
  readonly root: HTMLElement;
  readonly scroller: HTMLElement;
  readonly stage: HTMLElement;
  readonly stickyViewport: HTMLElement;
  readonly scaleLayer: HTMLElement;
  readonly mount: HTMLElement;
  dimensions: VisibleReplayDimensions;
  replayExtent: VisibleReplayExtent = { width: 1, height: 1 };
  iframe!: HTMLIFrameElement;
  scale = 1;
  live = false;
  released = false;
  #scrollListener: (() => void) | undefined;

  constructor(
    private readonly host: VisibleReplayHost,
    targetDocument: Document,
    dimensions: VisibleReplayDimensions,
  ) {
    this.dimensions = dimensions;
    this.root = targetDocument.createElement('div');
    this.root.className = 'replica-replay-root replica-replay-root--candidate';
    this.root.dataset.simulReplicaCandidate = 'v2';
    this.root.setAttribute('aria-hidden', 'true');
    this.root.setAttribute('inert', '');
    this.root.style.position = 'fixed';
    this.root.style.left = '-1000000px';
    this.root.style.top = '0';
    this.root.style.width = `${dimensions.viewportWidth}px`;
    this.root.style.height = `${dimensions.viewportHeight}px`;
    this.root.style.visibility = 'hidden';
    this.root.style.opacity = '0';
    this.root.style.pointerEvents = 'none';
    this.root.style.overflow = 'hidden';
    this.root.style.contain = 'strict';

    this.scroller = targetDocument.createElement('div');
    this.scroller.className = 'replica-replay-scroll';
    this.stage = targetDocument.createElement('div');
    this.stage.className = 'replica-replay-stage';
    this.stickyViewport = targetDocument.createElement('div');
    this.stickyViewport.className = 'replica-replay-sticky-viewport';
    this.scaleLayer = targetDocument.createElement('div');
    this.scaleLayer.className = 'replica-replay-scale-layer';
    this.mount = targetDocument.createElement('div');
    this.mount.className = 'replica-replay-mount';
    this.mount.style.width = `${dimensions.viewportWidth}px`;
    this.mount.style.height = `${dimensions.viewportHeight}px`;
    this.scaleLayer.append(this.mount);
    this.stickyViewport.append(this.scaleLayer);
    this.stage.append(this.stickyViewport);
    this.scroller.append(this.stage);
    this.root.append(this.scroller);
  }

  commit(iframe: HTMLIFrameElement, extent: VisibleReplayExtent): void {
    this.host.commitCandidate(this, iframe, extent);
  }

  markCommitted(iframe: HTMLIFrameElement, extent: VisibleReplayExtent): void {
    this.iframe = iframe;
    this.replayExtent = extent;
    delete this.root.dataset.simulReplicaCandidate;
    this.root.dataset.simulReplicaViewport = 'v2';
  }

  installScrollListener(listener: () => void): void {
    this.#scrollListener = listener;
    this.scroller.addEventListener('scroll', listener, { passive: true });
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    if (this.#scrollListener) {
      this.scroller.removeEventListener('scroll', this.#scrollListener);
      this.#scrollListener = undefined;
    }
    this.host.detach(this);
    this.root.remove();
  }
}

function isProtectedReplayIframe(iframe: HTMLIFrameElement): boolean {
  return (
    iframe.getAttribute('sandbox') === 'allow-same-origin' &&
    iframe.getAttribute('aria-hidden') === 'true' &&
    iframe.hasAttribute('inert') &&
    iframe.getAttribute('tabindex') === '-1' &&
    iframe.getAttribute('referrerpolicy') === 'no-referrer' &&
    iframe.style.pointerEvents === 'none'
  );
}

function normalizeDimensions(
  dimensions: VisibleReplayDimensions,
): VisibleReplayDimensions {
  return {
    viewportWidth: boundedDimension(dimensions.viewportWidth),
    viewportHeight: boundedDimension(dimensions.viewportHeight),
    documentWidth: boundedDimension(dimensions.documentWidth),
    documentHeight: boundedDimension(dimensions.documentHeight),
  };
}

function normalizeExtent(extent: VisibleReplayExtent): VisibleReplayExtent {
  return {
    width: boundedDimension(extent.width),
    height: boundedDimension(extent.height),
  };
}

function maximumSourceScrollX(candidate: CandidateLease): number {
  return Math.max(
    0,
    (candidate.live ? 0 : candidate.dimensions.documentWidth) -
      candidate.dimensions.viewportWidth,
    candidate.replayExtent.width - candidate.dimensions.viewportWidth,
  );
}

function maximumSourceScrollY(candidate: CandidateLease): number {
  return Math.max(
    0,
    (candidate.live ? 0 : candidate.dimensions.documentHeight) -
      candidate.dimensions.viewportHeight,
    candidate.replayExtent.height - candidate.dimensions.viewportHeight,
  );
}

function boundedDimension(value: number): number {
  return Number.isFinite(value)
    ? Math.max(1, Math.min(MAX_REPLAY_DIMENSION, Math.round(value)))
    : 1;
}

function boundedExtent(value: number): number {
  return Number.isFinite(value)
    ? Math.max(0, Math.min(MAX_OWNED_EXTENT, Math.ceil(value)))
    : 0;
}

function boundedScrollExtent(value: number): number {
  return Number.isFinite(value)
    ? Math.max(0, Math.min(MAX_OWNED_EXTENT, value))
    : 0;
}

function boundedScroll(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}
