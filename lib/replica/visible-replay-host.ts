import { displayScale } from '../display-scale';
import type { MirrorDisplayMode } from '../preferences';
import {
  MAX_SCROLL_PANES,
  PRIMARY_SCROLL_MAX,
  VISUAL_SCALE_MAX,
} from '../primary-scroll';

export const STATIC_REPLAY_LABEL = 'Replica reconnecting';
export const LIVE_REPLAY_LABEL = 'Live page replica';

const MAX_REPLAY_DIMENSION = 1_000_000;
const MAX_REPLAY_SCALE = 3;
const MAX_OWNED_EXTENT = MAX_REPLAY_DIMENSION * MAX_REPLAY_SCALE;

export interface VisibleReplayDimensions {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly documentWidth: number;
  readonly documentHeight: number;
  readonly canvasBackgroundColor?: string;
}

export interface VisibleReplayExtent {
  readonly width: number;
  readonly height: number;
}

export interface VisibleReplayLayout {
  readonly displayMode: MirrorDisplayMode;
  readonly zoomPercent: number;
  /**
   * The source tab's browser zoom (D104): 1:1 shows the page at the size the
   * tab shows it and custom zoom multiplies that. 1 when absent or invalid.
   */
  readonly sourceZoomFactor?: number;
}

/**
 * A pane that scrolls on its own in the tab (D122): the mirror node id of
 * the element, and how far it is scrolled inside its own range.
 */
export interface VisibleReplayPaneScroll {
  readonly nodeId: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly maxScrollX: number;
  readonly maxScrollY: number;
}

/** Finds the replica's node for a mirror node id. */
export type VisibleReplayNodeResolver = (nodeId: number) => Node | undefined;

export interface VisibleReplayScroll {
  /** The document's place and, when known, its scroll ranges. */
  readonly scrollX: number;
  readonly scrollY: number;
  readonly maxScrollX?: number;
  readonly maxScrollY?: number;
  /** Every pane that is not at its start; one not listed is at its start. */
  readonly panes?: readonly VisibleReplayPaneScroll[];
  /** The viewport-scale pane the tab scrolls in place of its document. */
  readonly primaryPaneId?: number;
  /** The tab's pinch zoom and its corner in the layout viewport (D115). */
  readonly visualScale?: number;
  readonly visualOffsetX?: number;
  readonly visualOffsetY?: number;
}

/** A pinch zoom the replica shows: no magnification is 1 at 0, 0. */
interface VisualViewport {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

const NO_VISUAL_ZOOM: VisualViewport = Object.freeze({ scale: 1, offsetX: 0, offsetY: 0 });

export interface VisibleReplayCandidateLease {
  readonly mount: HTMLElement;
  /**
   * `resolveNode` finds this replica's node for a mirror node id, so the
   * host can put the panes the tab scrolled at their place (D122).
   */
  commit(
    iframe: HTMLIFrameElement,
    extent: VisibleReplayExtent,
    resolveNode?: VisibleReplayNodeResolver,
  ): void;
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
  /** Whether the committed, shown replica can present interactive facsimiles. */
  setInteractiveAccessibility?(
    iframe: HTMLIFrameElement,
    accessible: boolean,
  ): boolean;
  clearPresentation(): void;
  dispose(): void;
}

interface VisibleReplayHostOptions {
  readonly hostDocument: Document;
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
  readonly #previewSurface: HTMLElement;
  readonly #badge: HTMLElement;
  #candidate: CandidateLease | undefined;
  #committed: CandidateLease | undefined;
  #layout: VisibleReplayLayout = { displayMode: 'fit', zoomPercent: 100 };
  #sourceScrollX = 0;
  #sourceScrollY = 0;
  #sourceMaxScrollX = 0;
  #sourceMaxScrollY = 0;
  /** The panes the tab has scrolled, as last followed (D122). */
  #sourcePanes: readonly VisibleReplayPaneScroll[] = [];
  /** The one of them the tab scrolls in place of its document, if any. */
  #primaryPane: VisibleReplayPaneScroll | undefined;
  #hasSourceScroll = false;
  /** The tab's pinch zoom, shown while the source's scrolling is followed. */
  #sourceVisual: VisualViewport = NO_VISUAL_ZOOM;
  /** Where the reader scrolled the replica itself, in replica pixels. */
  #readerScroll: { readonly left: number; readonly top: number } | undefined;
  /** The last source position the replica followed, to tell real moves apart. */
  #lastFollowedScroll: VisibleReplayScroll | undefined;
  #disposed = false;
  #resizeObserver: ResizeObserver | undefined;

  constructor(options: VisibleReplayHostOptions) {
    this.#document = options.hostDocument;
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
    // The frame keeps its own scrollbar, so the page lays out at the width it
    // has in the source tab; the panel's scroller does the scrolling, so that
    // strip is cropped away instead of showing a second scrollbar (D84).
    const gutters = replicaScrollbarGutters(committed.iframe);
    const visibleWidth = Math.max(
      1,
      committed.dimensions.viewportWidth - gutters.right,
    );
    const visibleHeight = Math.max(
      1,
      committed.dimensions.viewportHeight - gutters.bottom,
    );
    const scale = computeMirrorScale(
      availableWidth,
      visibleWidth,
      this.#layout.displayMode,
      this.#layout.zoomPercent,
      this.#layout.sourceZoomFactor,
    );
    committed.scale = scale;
    const contentWidth = Math.max(
      committed.live ? 0 : committed.dimensions.documentWidth,
      committed.replayExtent.width,
      visibleWidth,
    );
    const contentHeight = Math.max(
      committed.live ? 0 : committed.dimensions.documentHeight,
      committed.replayExtent.height,
      visibleHeight,
    );
    const viewportWidth = boundedExtent(visibleWidth * scale);
    const viewportHeight = boundedExtent(visibleHeight * scale);
    committed.mount.style.width = `${committed.dimensions.viewportWidth}px`;
    committed.mount.style.height = `${committed.dimensions.viewportHeight}px`;
    committed.scaleLayer.style.width = `${committed.dimensions.viewportWidth}px`;
    committed.scaleLayer.style.height = `${committed.dimensions.viewportHeight}px`;
    this.#applyScale(committed);
    committed.stickyViewport.style.width = `${viewportWidth}px`;
    committed.stickyViewport.style.height = `${viewportHeight}px`;
    const availableHeight =
      committed.scroller.clientHeight ||
      this.#previewSurface.clientHeight ||
      viewportHeight;
    // When the scaled source viewport is smaller than the panel, extend the
    // track so the iframe can still reach the replica's final offset. When it
    // is larger, the content extent preserves panning across the clipped
    // portion of that zoomed viewport after internal scroll clamps.
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
    this.#projectPanes(committed);
  }

  /**
   * Sizes the page inside the space its view takes. A pinch zoom in the tab
   * magnifies the same part of the page there (D115): the space stays, so a
   * pinch gesture changes one transform and no layout.
   */
  #applyScale(committed: CandidateLease): void {
    const visual = this.#sourceVisual;
    const magnified = committed.scale * visual.scale;
    committed.scaleLayer.style.transform = visual === NO_VISUAL_ZOOM
      ? `scale(${committed.scale})`
      : `translate(${-visual.offsetX * magnified}px, ${-visual.offsetY * magnified}px) ` +
        `scale(${magnified})`;
  }

  /**
   * Moves the replica to the source's reading position when the source moved.
   * The source re-reports an unchanged position after every layout change
   * (an image load, a font, a resize) and with every checkpoint; following
   * those would throw away the reader's own scrolling in the replica, so a
   * repeat is ignored unless `force` asks to re-align (following turned on).
   *
   * A pane that scrolls on its own is put at its place whatever the page did
   * (D122). Its move is not a move of the page: the replica document and the
   * reader's own scrolling stay where they are.
   */
  followSourceScroll(scroll: VisibleReplayScroll, force = false): void {
    const lastFollowed = this.#lastFollowedScroll;
    this.#lastFollowedScroll = scroll;
    const committed = this.#committed;
    const previousPrimaryPane = this.#primaryPane;
    this.#sourcePanes = readPanes(scroll.panes);
    this.#primaryPane = this.#sourcePanes.find(
      ({ nodeId }) => nodeId === scroll.primaryPaneId,
    );
    // A pane the replica cannot scroll moves the page in its place, so its
    // move in the tab is a move of the page. Both places are read against
    // the replica as it is now: a pane that gains its own range in the
    // replica (a late style, a translation) has not moved in the tab, and
    // the reader's own scrolling stays.
    const standInMoved = committed !== undefined && !samePanePosition(
      this.#documentStandIn(committed, previousPrimaryPane),
      this.#documentStandIn(committed, this.#primaryPane),
    );
    if (
      force ||
      !lastFollowed ||
      !sameSourceScrollPosition(lastFollowed, scroll) ||
      standInMoved
    ) this.#followPage(scroll);
    if (committed) this.#projectPanes(committed);
  }

  /** The document, a pane standing in for it, or the pinch zoom moved. */
  #followPage(scroll: VisibleReplayScroll): void {
    this.#readerScroll = undefined;
    this.#hasSourceScroll = true;
    const committed = this.#committed;
    this.#sourceMaxScrollX = Number.isFinite(scroll.maxScrollX)
      ? boundedScroll(scroll.maxScrollX)
      : committed ? maximumSourceScrollX(committed) : boundedScroll(scroll.scrollX);
    this.#sourceMaxScrollY = Number.isFinite(scroll.maxScrollY)
      ? boundedScroll(scroll.maxScrollY)
      : committed ? maximumSourceScrollY(committed) : boundedScroll(scroll.scrollY);
    this.#sourceScrollX = clamp(
      scroll.scrollX,
      0,
      this.#sourceMaxScrollX,
    );
    this.#sourceScrollY = clamp(
      scroll.scrollY,
      0,
      this.#sourceMaxScrollY,
    );
    const visual = readVisualViewport(scroll);
    const visualChanged = !sameVisualViewport(visual, this.#sourceVisual);
    this.#sourceVisual = visual;
    if (!committed) return;
    if (visualChanged) this.#applyScale(committed);
    this.#setOuterScroll(committed);
    this.#projectScroll(committed);
  }

  /**
   * Following was turned off: the replica shows the page unmagnified again,
   * so the reader can scroll all of it. Following again restores the zoom.
   */
  clearSourceVisualViewport(): void {
    if (this.#sourceVisual === NO_VISUAL_ZOOM) return;
    this.#sourceVisual = NO_VISUAL_ZOOM;
    // The next source report is followed again, pinch zoom and all.
    this.#lastFollowedScroll = undefined;
    if (this.#committed) this.#applyScale(this.#committed);
  }

  resetSourceScroll(): void {
    this.#sourceScrollX = 0;
    this.#sourceScrollY = 0;
    this.#sourceMaxScrollX = 0;
    this.#sourceMaxScrollY = 0;
    this.#sourcePanes = [];
    this.#primaryPane = undefined;
    this.#hasSourceScroll = false;
    this.#sourceVisual = NO_VISUAL_ZOOM;
    this.#readerScroll = undefined;
    this.#lastFollowedScroll = undefined;
  }

  markLive(iframe: HTMLIFrameElement): void {
    const committed = this.#committed;
    if (committed?.iframe !== iframe || committed.released) return;
    const wasLive = committed.live;
    if (wasLive) return;
    committed.live = true;
    this.#previewSurface.hidden = false;
    this.#exposeToAssistiveTechnology(committed);
    this.#badge.textContent = LIVE_REPLAY_LABEL;
    this.#badge.hidden = false;
    if (!wasLive) this.#applyLayout(committed);
  }

  refreshExtent(iframe: HTMLIFrameElement, extent: VisibleReplayExtent): void {
    const committed = this.#committed;
    if (!committed || committed.iframe !== iframe || committed.released) return;
    const normalized = normalizeExtent(extent);
    if (
      committed.replayExtent.width === normalized.width &&
      committed.replayExtent.height === normalized.height
    ) {
      // The page is the size it was, but a patch may have made a pane again
      // and a translation may have lengthened one (D122). A pane that stood
      // in for the page may have gained its own range, or lost it: the page
      // is then put where it belongs without it (the reader's place stays).
      if (!samePanePosition(
        committed.standIn,
        this.#documentStandIn(committed, this.#primaryPane),
      )) {
        this.#setOuterScroll(committed);
        this.#projectScroll(committed);
      }
      this.#projectPanes(committed);
      return;
    }
    committed.replayExtent = normalized;
    this.#clampSourceScroll();
    this.#applyLayout(committed);
  }

  refreshDimensions(
    iframe: HTMLIFrameElement,
    dimensions: VisibleReplayDimensions,
  ): void {
    const committed = this.#committed;
    if (!committed || committed.iframe !== iframe || committed.released) return;
    committed.dimensions = normalizeDimensions(dimensions);
    committed.canvasBackgroundColor = committed.dimensions.canvasBackgroundColor;
    committed.applyCanvasBackground();
    this.#clampSourceScroll();
    this.#applyLayout(committed);
  }

  /**
   * Whether the replica's interactive facsimiles can be reached. The shown
   * replica is always exposed (D118), so this only refuses a replica that is
   * not the committed one or is not on screen.
   */
  setInteractiveAccessibility(
    iframe: HTMLIFrameElement,
    accessible: boolean,
  ): boolean {
    const committed = this.#committed;
    if (!committed || committed.released || committed.iframe !== iframe) {
      return false;
    }
    if (accessible && this.#previewSurface.hidden) return false;
    return true;
  }

  /**
   * The committed replica is what the panel shows, so a screen reader reads
   * it as it reads the page (D118). A candidate stays hidden until this runs.
   */
  #exposeToAssistiveTechnology(committed: CandidateLease): void {
    this.#previewSurface.removeAttribute('aria-hidden');
    committed.root.removeAttribute('aria-hidden');
    committed.iframe.removeAttribute('aria-hidden');
  }

  clearPresentation(): void {
    this.#previewSurface.hidden = true;
    this.#previewSurface.setAttribute('aria-hidden', 'true');
    this.#badge.textContent = '';
    this.#badge.hidden = true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.clearPresentation();
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
    resolveNode?: VisibleReplayNodeResolver,
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

    candidate.markCommitted(iframe, normalizeExtent(extent), resolveNode);
    const previous = this.#committed;
    if (!this.#hasSourceScroll) {
      this.#sourceMaxScrollX = maximumSourceScrollX(candidate);
      this.#sourceMaxScrollY = maximumSourceScrollY(candidate);
      this.#sourceScrollX = boundedScroll(iframe.contentWindow?.scrollX);
      this.#sourceScrollY = boundedScroll(iframe.contentWindow?.scrollY);
    } else {
      this.#clampSourceScroll();
    }

    candidate.installScrollListener(() => {
      if (this.#committed !== candidate || candidate.released) return;
      const left = candidate.scroller.scrollLeft;
      const top = candidate.scroller.scrollTop;
      const projected = candidate.projectedScroll;
      candidate.projectedScroll = undefined;
      // Following the source sets the panel scroller, which echoes back as a
      // scroll event; only the reader moves it anywhere else.
      if (
        projected &&
        Math.abs(left - projected.left) < 1 &&
        Math.abs(top - projected.top) < 1
      ) return;
      // The reader's position is kept in replica pixels until the source
      // moves, including across a recovery candidate that commits before the
      // source's first scroll packet arrives.
      this.#readerScroll = {
        left: clamp(left / candidate.scale, 0, maximumSourceScrollX(candidate)),
        top: clamp(top / candidate.scale, 0, maximumSourceScrollY(candidate)),
      };
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
    candidate.applyCanvasBackground();
    this.#candidate = undefined;
    this.#committed = candidate;
    this.#previewSurface.hidden = false;
    this.#exposeToAssistiveTechnology(candidate);
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
      if (wasVisible) this.clearPresentation();
    }
  }

  #setOuterScroll(candidate: CandidateLease): void {
    const { left, top } = this.#replicaDocumentScroll(candidate);
    candidate.scroller.scrollLeft = boundedScrollExtent(left * candidate.scale);
    candidate.scroller.scrollTop = boundedScrollExtent(top * candidate.scale);
    candidate.projectedScroll = {
      left: candidate.scroller.scrollLeft,
      top: candidate.scroller.scrollTop,
    };
  }

  #projectScroll(candidate: CandidateLease): void {
    const target = candidate.iframe.contentWindow;
    if (!target || typeof target.scrollTo !== 'function') return;
    const { left, top } = this.#replicaDocumentScroll(candidate);
    try {
      // At once: the replica keeps the page's own `scroll-behavior`, and a
      // page that asks for smooth scrolling would otherwise animate every
      // followed move and lag behind the tab (D122).
      target.scrollTo({
        left,
        top,
        behavior: 'instant',
      });
    } catch {
      try {
        target.scrollTo(left, top);
      } catch {
        // A replay viewport that rejects scroll projection remains a usable,
        // static preview; it must not unwind an otherwise atomic commit.
      }
    }
  }

  /**
   * Puts every pane the tab has scrolled at the same share of its own range
   * in the replica, and sends one the report no longer lists back to its
   * start (D122). A pane is found by its node id, never by what is in view.
   * Only the panes move: not the replica document, not the panel's scroller
   * and not the reader's own place.
   */
  #projectPanes(candidate: CandidateLease): void {
    const listed = new Set<number>();
    for (const pane of this.#sourcePanes) {
      listed.add(pane.nodeId);
      const element = candidate.paneElement(pane.nodeId);
      if (!element) continue;
      candidate.placedPanes.add(pane.nodeId);
      scrollPaneTo(
        element,
        projectPaneOffset(pane.scrollX, pane.maxScrollX, scrollRangeX(element)),
        projectPaneOffset(pane.scrollY, pane.maxScrollY, scrollRangeY(element)),
      );
    }
    for (const nodeId of candidate.placedPanes) {
      if (listed.has(nodeId)) continue;
      candidate.placedPanes.delete(nodeId);
      const element = candidate.paneElement(nodeId);
      if (element) scrollPaneTo(element, 0, 0);
    }
  }

  /**
   * The part of the tab's viewport-scale pane that the replica cannot scroll
   * and that therefore moves the replica document instead (D100). It is
   * decided for each axis: the pane stands in on an axis where the tab's
   * pane has a range and the replica's has none (the element is not there,
   * or the replica lays it out without that range). On an axis the replica
   * can scroll, the pane is placed like any other and adds nothing here.
   */
  #documentStandIn(
    candidate: CandidateLease,
    pane: VisibleReplayPaneScroll | undefined,
  ): VisibleReplayPaneScroll | undefined {
    if (!pane) return undefined;
    const element = candidate.paneElement(pane.nodeId);
    const standsX = pane.maxScrollX > 0 &&
      !(element && scrollRangeX(element) > 0);
    const standsY = pane.maxScrollY > 0 &&
      !(element && scrollRangeY(element) > 0);
    const scrollX = standsX ? pane.scrollX : 0;
    const scrollY = standsY ? pane.scrollY : 0;
    if (scrollX === 0 && scrollY === 0) return undefined;
    return {
      nodeId: pane.nodeId,
      scrollX,
      scrollY,
      maxScrollX: standsX ? pane.maxScrollX : 0,
      maxScrollY: standsY ? pane.maxScrollY : 0,
    };
  }

  /**
   * Where the replica document sits. The reader's own scroll stays put.
   * Otherwise the source's share of its scroll range becomes the same share
   * of the replica's: a translation that lengthens the page scrolls the
   * replica further, and both reach the end together. When the tab scrolls a
   * viewport-scale pane the replica cannot scroll on an axis, that pane's
   * progress on that axis moves the replica document as well.
   */
  #replicaDocumentScroll(
    candidate: CandidateLease,
  ): { readonly left: number; readonly top: number } {
    const maxScrollX = maximumSourceScrollX(candidate);
    const maxScrollY = maximumSourceScrollY(candidate);
    const standIn = this.#documentStandIn(candidate, this.#primaryPane);
    candidate.standIn = standIn;
    if (this.#readerScroll) {
      return {
        left: clamp(this.#readerScroll.left, 0, maxScrollX),
        top: clamp(this.#readerScroll.top, 0, maxScrollY),
      };
    }
    const left = projectProgress(
      this.#sourceScrollX,
      this.#sourceMaxScrollX,
      maxScrollX,
    );
    const top = projectProgress(
      this.#sourceScrollY,
      this.#sourceMaxScrollY,
      maxScrollY,
    );
    if (!standIn) return { left, top };
    return {
      left: clamp(
        left + projectProgress(
          Math.abs(standIn.scrollX),
          standIn.maxScrollX,
          maxScrollX,
        ),
        0,
        maxScrollX,
      ),
      top: clamp(
        top + projectProgress(
          Math.abs(standIn.scrollY),
          standIn.maxScrollY,
          maxScrollY,
        ),
        0,
        maxScrollY,
      ),
    };
  }

  #clampSourceScroll(): void {
    this.#sourceScrollX = clamp(
      this.#sourceScrollX,
      0,
      this.#sourceMaxScrollX,
    );
    this.#sourceScrollY = clamp(
      this.#sourceScrollY,
      0,
      this.#sourceMaxScrollY,
    );
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
  /** Finds this replica's node for a mirror node id (D122). */
  resolveNode: VisibleReplayNodeResolver | undefined;
  /** Node ids of the panes this replica was scrolled at, to put them back. */
  readonly placedPanes = new Set<number>();
  /** What a pane added to this replica's page place when it was last set. */
  standIn: VisibleReplayPaneScroll | undefined;
  /** The panel scroll offsets the host last set, to recognize their echo. */
  projectedScroll: { readonly left: number; readonly top: number } | undefined;
  canvasBackgroundColor: string | undefined;
  #scrollListener: (() => void) | undefined;

  constructor(
    private readonly host: VisibleReplayHost,
    targetDocument: Document,
    dimensions: VisibleReplayDimensions,
  ) {
    this.dimensions = dimensions;
    this.canvasBackgroundColor = dimensions.canvasBackgroundColor;
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
    this.applyCanvasBackground();
  }

  commit(
    iframe: HTMLIFrameElement,
    extent: VisibleReplayExtent,
    resolveNode?: VisibleReplayNodeResolver,
  ): void {
    this.host.commitCandidate(this, iframe, extent, resolveNode);
  }

  markCommitted(
    iframe: HTMLIFrameElement,
    extent: VisibleReplayExtent,
    resolveNode: VisibleReplayNodeResolver | undefined,
  ): void {
    this.iframe = iframe;
    this.replayExtent = extent;
    this.resolveNode = resolveNode;
    delete this.root.dataset.simulReplicaCandidate;
    this.root.dataset.simulReplicaViewport = 'v2';
  }

  applyCanvasBackground(): void {
    const color = this.canvasBackgroundColor;
    for (const element of [
      this.root,
      this.scroller,
      this.stage,
      this.stickyViewport,
      this.scaleLayer,
      this.mount,
      this.iframe,
    ]) {
      if (color) {
        element?.style.setProperty('background-color', color);
      } else {
        element?.style.removeProperty('background-color');
      }
    }
  }

  /**
   * The replica's element for a pane: one that is in this replica's document
   * now. Never the replica's own scroller or `html`: those follow the
   * document, and the reader scrolls them.
   */
  paneElement(nodeId: number): HTMLElement | undefined {
    const replica = this.iframe?.contentDocument;
    let node: Node | undefined;
    try {
      node = this.resolveNode?.(nodeId);
    } catch {
      return undefined;
    }
    if (
      !replica || !node || node.nodeType !== 1 ||
      node.ownerDocument !== replica ||
      node.isConnected === false ||
      node === replica.documentElement ||
      node === replica.scrollingElement
    ) return undefined;
    return node as HTMLElement;
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
    this.resolveNode = undefined;
    this.placedPanes.clear();
    this.host.detach(this);
    this.root.remove();
  }
}

function isProtectedReplayIframe(iframe: HTMLIFrameElement): boolean {
  const commonProtection =
    iframe.getAttribute('sandbox') === 'allow-same-origin' &&
    iframe.getAttribute('aria-hidden') === 'true' &&
    iframe.getAttribute('tabindex') === '-1' &&
    iframe.getAttribute('referrerpolicy') === 'no-referrer';
  if (!commonProtection) return false;
  const strictlyInert = iframe.hasAttribute('inert') &&
    iframe.style.pointerEvents === 'none';
  const disclosureOnly = !iframe.hasAttribute('inert') &&
    iframe.style.pointerEvents === 'auto' &&
    iframe.getAttribute('data-simul-interaction-boundary') ===
      'css-disclosure-v1';
  return strictlyInert || disclosureOnly;
}

function normalizeDimensions(
  dimensions: VisibleReplayDimensions,
): VisibleReplayDimensions {
  const canvasBackgroundColor = normalizeCanvasBackgroundColor(
    dimensions.canvasBackgroundColor,
  );
  return {
    viewportWidth: boundedDimension(dimensions.viewportWidth),
    viewportHeight: boundedDimension(dimensions.viewportHeight),
    documentWidth: boundedDimension(dimensions.documentWidth),
    documentHeight: boundedDimension(dimensions.documentHeight),
    ...(canvasBackgroundColor ? { canvasBackgroundColor } : {}),
  };
}

function normalizeCanvasBackgroundColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 128 ||
    /[;{}@]/u.test(normalized) ||
    /(?:url|image|var)\s*\(/iu.test(normalized)
  ) return undefined;
  return normalized;
}

function normalizeExtent(extent: VisibleReplayExtent): VisibleReplayExtent {
  return {
    width: boundedDimension(extent.width),
    height: boundedDimension(extent.height),
  };
}

/** Largest scrollbar a replica frame is trusted to have; beyond it, none. */
const MAX_REPLICA_SCROLLBAR_GUTTER = 64;

/**
 * The width and height of the replica frame's own scrollbars: its viewport
 * less its scrolling element's client box. Overlay scrollbars take none.
 */
function replicaScrollbarGutters(
  iframe: HTMLIFrameElement | undefined,
): { readonly right: number; readonly bottom: number } {
  try {
    const view = iframe?.contentWindow;
    const document = iframe?.contentDocument;
    const root = document?.scrollingElement ?? document?.documentElement;
    if (!view || !root) return { right: 0, bottom: 0 };
    const gutter = (outer: number, inner: number): number => {
      const value = outer - inner;
      return Number.isFinite(value) &&
        value > 0 &&
        value <= MAX_REPLICA_SCROLLBAR_GUTTER
        ? value
        : 0;
    };
    return {
      right: gutter(view.innerWidth, root.clientWidth),
      bottom: gutter(view.innerHeight, root.clientHeight),
    };
  } catch {
    return { right: 0, bottom: 0 };
  }
}

/**
 * Fit fills the panel width, growing as well as shrinking; the tab's zoom
 * already narrows a zoomed page's CSS width, so Fit follows it too. 1:1 and
 * custom zoom follow the tab's zoom directly (D104).
 */
function computeMirrorScale(
  availableWidth: number,
  sourceWidth: number,
  mode: MirrorDisplayMode,
  zoomPercent = 100,
  sourceZoomFactor: number | undefined = 1,
): number {
  const fitScale =
    Number.isFinite(availableWidth) &&
    Number.isFinite(sourceWidth) &&
    availableWidth > 0 &&
    sourceWidth > 0
      ? availableWidth / sourceWidth
      : 1;
  return displayScale(mode, fitScale, zoomPercent, sourceZoomFactor);
}

/** The document at the same offsets; its scrollable maxima may differ. */
function sameSourceScrollPosition(
  left: VisibleReplayScroll,
  right: VisibleReplayScroll,
): boolean {
  return left.scrollX === right.scrollX &&
    left.scrollY === right.scrollY &&
    sameVisualViewport(readVisualViewport(left), readVisualViewport(right));
}

/** The same pane at the same offsets, or no pane both times. */
function samePanePosition(
  left: VisibleReplayPaneScroll | undefined,
  right: VisibleReplayPaneScroll | undefined,
): boolean {
  return left?.nodeId === right?.nodeId &&
    left?.scrollX === right?.scrollX &&
    left?.scrollY === right?.scrollY;
}

/**
 * The panes of a source report, each once, with numbers the replica can use.
 * The protocol already checked them; this keeps the host safe by itself.
 */
function readPanes(
  input: readonly VisibleReplayPaneScroll[] | undefined,
): readonly VisibleReplayPaneScroll[] {
  if (!Array.isArray(input)) return [];
  const panes = new Map<number, VisibleReplayPaneScroll>();
  for (const pane of input.slice(0, MAX_SCROLL_PANES)) {
    if (
      !pane || !Number.isSafeInteger(pane.nodeId) || pane.nodeId <= 0 ||
      ![pane.scrollX, pane.scrollY, pane.maxScrollX, pane.maxScrollY]
        .every((value) => typeof value === 'number' && Number.isFinite(value))
    ) continue;
    const maxScrollX = clamp(pane.maxScrollX, 0, PRIMARY_SCROLL_MAX);
    const maxScrollY = clamp(pane.maxScrollY, 0, PRIMARY_SCROLL_MAX);
    panes.set(pane.nodeId, {
      nodeId: pane.nodeId,
      scrollX: clamp(pane.scrollX, -maxScrollX, maxScrollX),
      scrollY: clamp(pane.scrollY, -maxScrollY, maxScrollY),
      maxScrollX,
      maxScrollY,
    });
  }
  return [...panes.values()];
}

function scrollRangeX(element: HTMLElement): number {
  return Math.max(0, element.scrollWidth - element.clientWidth);
}

function scrollRangeY(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

/**
 * A pane's offset in the replica: the same share of the replica pane's range,
 * on the same side of its start (a right-to-left strip counts down from 0).
 */
function projectPaneOffset(
  sourceOffset: number,
  sourceMaximum: number,
  targetMaximum: number,
): number {
  const offset = projectProgress(
    Math.abs(sourceOffset),
    sourceMaximum,
    targetMaximum,
  );
  return sourceOffset < 0 ? -offset : offset;
}

/**
 * Scrolls a replica pane at once. A page that asks for smooth scrolling
 * would otherwise animate every followed move, and lag behind the tab.
 */
function scrollPaneTo(element: HTMLElement, left: number, top: number): void {
  if (
    Math.abs(element.scrollLeft - left) < 1 &&
    Math.abs(element.scrollTop - top) < 1
  ) return;
  try {
    if (typeof element.scrollTo === 'function') {
      element.scrollTo({ left, top, behavior: 'instant' });
      return;
    }
  } catch {
    // Fall through to the plain offsets.
  }
  element.scrollLeft = left;
  element.scrollTop = top;
}

/** The pinch zoom a source report carries; none when absent or not valid. */
function readVisualViewport(scroll: VisibleReplayScroll): VisualViewport {
  const { visualScale, visualOffsetX, visualOffsetY } = scroll;
  if (
    typeof visualScale !== 'number' || !Number.isFinite(visualScale) || !(visualScale > 1)
  ) return NO_VISUAL_ZOOM;
  return {
    scale: Math.min(VISUAL_SCALE_MAX, visualScale),
    offsetX: boundedScroll(visualOffsetX),
    offsetY: boundedScroll(visualOffsetY),
  };
}

function sameVisualViewport(left: VisualViewport, right: VisualViewport): boolean {
  return left.scale === right.scale &&
    left.offsetX === right.offsetX &&
    left.offsetY === right.offsetY;
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

function projectProgress(
  sourcePosition: number,
  sourceMaximum: number,
  targetMaximum: number,
): number {
  if (sourceMaximum <= 0 || targetMaximum <= 0) return 0;
  // Equal ranges keep exact pixels, free of division rounding.
  if (sourceMaximum === targetMaximum) {
    return clamp(sourcePosition, 0, targetMaximum);
  }
  return clamp(sourcePosition / sourceMaximum, 0, 1) * targetMaximum;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}
