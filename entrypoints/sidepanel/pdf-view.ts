import type { RgbaPixels } from '../../lib/pdf/colour-sample';
import {
  MAX_DRAWN_PDF_PAGES,
  pdfDrawPlan,
  pdfPageBoxes,
  pdfReadingPosition,
  pdfRenderScale,
  pdfScrollLeftFor,
  pdfScrollTopFor,
  type PdfLayoutSettings,
  type PdfPageLayout,
  type PdfPagePoints,
  type PdfReadingPosition,
} from '../../lib/pdf/pdf-layout';
import type { PdfFontFace } from '../../lib/pdf/pdf-overlay-style';
import type { PdfSurfaceBlock, PdfTextSink } from '../../lib/pdf/pdf-text-surface';
import { PDF_FIT_PASSES, PdfPageTextLayer, type PdfBlockMeasure } from './pdf-text-layer';

/** Padding around the column and the space between pages, in CSS pixels. */
export const PDF_PAGE_GAP = 8;
/** How long a layout change settles before drawn pages are drawn again. */
export const PDF_RERENDER_DELAY_MS = 150;
// Drawn pages are redrawn only when their scale moved by more than this share.
const SCALE_TOLERANCE = 0.01;

/** The part of an open pdf.js document the view draws with. */
export interface PdfViewDocument {
  render(
    pageNumber: number,
    canvas: HTMLCanvasElement,
    scale: number,
    signal?: AbortSignal,
  ): Promise<number>;
  releasePage(pageNumber: number): Promise<void>;
  /** Weight and slant of the page's fonts, known once it is drawn. */
  fontFaces?(
    pageNumber: number,
    fontIds: readonly string[],
  ): Promise<Readonly<Record<string, PdfFontFace>>>;
}

/** What the PDF controller needs from the view. */
export interface PdfViewSurface {
  /**
   * Replaces whatever was shown with `document`'s pages and shows the view,
   * at `position` when given (a PDF shown again), else at the top.
   */
  mount(
    document: PdfViewDocument,
    pageSizes: readonly PdfPagePoints[],
    position?: PdfReadingPosition,
  ): void;
  /** The page at the top of the view and how far into it, while mounted. */
  readingPosition(): PdfReadingPosition | undefined;
  /** Stops drawing, empties the view and hides it. */
  clear(): void;
  updateLayout(settings: PdfLayoutSettings): void;
}

interface ResizeObserverLike {
  observe(target: Element): void;
  disconnect(): void;
}

/** Browser hooks, replaceable in tests. */
export interface PdfViewEnvironment {
  readonly requestFrame?: (callback: () => void) => unknown;
  readonly cancelFrame?: (handle: unknown) => void;
  readonly createResizeObserver?: (callback: () => void) => ResizeObserverLike | undefined;
  readonly devicePixelRatio?: () => number;
  /**
   * Calls back once when the device pixel ratio changes (the panel moved to
   * another screen); returns a function that stops watching.
   */
  readonly watchDevicePixelRatio?: (callback: () => void) => (() => void) | undefined;
  readonly rerenderDelayMs?: number;
  readonly maxDrawnPages?: number;
  /** The accessible name of page `page` (1-based) of `total`. */
  readonly pageLabel?: (page: number, total: number) => string;
  /** Called when another page (0-based) reaches the top of the view. */
  readonly onReadingPageChange?: (index: number) => void;
  /** Reads a drawn canvas's pixels, for the overlay colours. */
  readonly readPixels?: (canvas: HTMLCanvasElement) => RgbaPixels | undefined;
  /** Measures a translated block, for fitting it. */
  readonly measureBlock?: PdfBlockMeasure;
}

interface ViewPage {
  readonly element: HTMLElement;
  canvas: HTMLCanvasElement | undefined;
  /** The pdf.js scale the canvas was drawn at. */
  drawnScale: number | undefined;
  failed: boolean;
  /** The page's text, once read. */
  layer: PdfPageTextLayer | undefined;
}

interface Rendering {
  readonly index: number;
  readonly controller: AbortController;
}

/**
 * Shows an open PDF as a column of page placeholders in `#pdf-view` and
 * draws only the pages near the view, one at a time, nearest first. At most
 * eight pages keep a canvas; a released page gives its memory back to
 * pdf.js. After a layout change the drawn canvases stretch at once and are
 * drawn again at the new size once the change settles. The reading position
 * (page and share of it) stays at the top of the view. Positions and choices
 * come from `lib/pdf/pdf-layout.ts`; this class only touches the DOM.
 *
 * Each page's text sits over its canvas in a `PdfPageTextLayer`, where
 * translations replace the source text block by block (the view is the
 * `PdfTextSink` of the PDF's translation surface).
 */
export class PdfView implements PdfViewSurface, PdfTextSink {
  readonly #element: HTMLElement;
  readonly #requestFrame: (callback: () => void) => unknown;
  readonly #cancelFrame: (handle: unknown) => void;
  readonly #createResizeObserver: (callback: () => void) => ResizeObserverLike | undefined;
  readonly #devicePixelRatio: () => number;
  readonly #watchDevicePixelRatio: (callback: () => void) => (() => void) | undefined;
  #stopWatchingPixelRatio: (() => void) | undefined;
  readonly #rerenderDelayMs: number;
  readonly #maxDrawnPages: number;
  readonly #pageLabel: (page: number, total: number) => string;
  readonly #onReadingPageChange: ((index: number) => void) | undefined;
  readonly #readPixels: (canvas: HTMLCanvasElement) => RgbaPixels | undefined;
  readonly #measureBlock: PdfBlockMeasure;
  #document: PdfViewDocument | undefined;
  #sizes: readonly PdfPagePoints[] = [];
  #pages: ViewPage[] = [];
  #stage: HTMLElement | undefined;
  #layout: PdfPageLayout | undefined;
  #layoutViewportWidth = -1;
  #settings: PdfLayoutSettings = { displayMode: 'fit', zoomPercent: 100, sourceZoomFactor: 1 };
  #rendering: Rendering | undefined;
  #frame: unknown;
  #rerenderTimer: ReturnType<typeof setTimeout> | undefined;
  #holdRedraw = false;
  #resizeObserver: ResizeObserverLike | undefined;
  /** The page each text block is on. */
  readonly #blockPages = new Map<number, number>();
  #readingIndex = -1;

  constructor(element: HTMLElement, environment: PdfViewEnvironment = {}) {
    this.#element = element;
    const view = element.ownerDocument.defaultView as (Window & typeof globalThis) | null;
    this.#requestFrame = environment.requestFrame ?? ((callback) =>
      typeof view?.requestAnimationFrame === 'function'
        ? view.requestAnimationFrame(() => callback())
        : setTimeout(callback, 16));
    this.#cancelFrame = environment.cancelFrame ?? ((handle) => {
      if (typeof view?.cancelAnimationFrame === 'function') {
        view.cancelAnimationFrame(handle as number);
      } else {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      }
    });
    this.#createResizeObserver = environment.createResizeObserver ?? ((callback) => {
      const Observer = view?.ResizeObserver ?? globalThis.ResizeObserver;
      return typeof Observer === 'function' ? new Observer(() => callback()) : undefined;
    });
    this.#devicePixelRatio = environment.devicePixelRatio ??
      (() => view?.devicePixelRatio ?? 1);
    this.#watchDevicePixelRatio = environment.watchDevicePixelRatio ?? ((callback) => {
      if (typeof view?.matchMedia !== 'function') return undefined;
      const query = view.matchMedia(`(resolution: ${view.devicePixelRatio}dppx)`);
      const listener = () => callback();
      query.addEventListener('change', listener, { once: true });
      return () => query.removeEventListener('change', listener);
    });
    this.#rerenderDelayMs = environment.rerenderDelayMs ?? PDF_RERENDER_DELAY_MS;
    this.#maxDrawnPages = environment.maxDrawnPages ?? MAX_DRAWN_PDF_PAGES;
    this.#pageLabel = environment.pageLabel ?? ((page, total) => `Page ${page} of ${total}`);
    this.#onReadingPageChange = environment.onReadingPageChange;
    this.#readPixels = environment.readPixels ?? readCanvasPixels;
    this.#measureBlock = environment.measureBlock ?? measureBlock;
    element.addEventListener('scroll', () => this.#schedule(), { passive: true });
  }

  get mounted(): boolean {
    return this.#document !== undefined;
  }

  /** Pages (1-based) that hold a drawn canvas now. */
  get drawnPages(): number[] {
    return this.#pages.flatMap((page, index) => (page.canvas ? [index + 1] : []));
  }

  mount(
    document: PdfViewDocument,
    pageSizes: readonly PdfPagePoints[],
    position?: PdfReadingPosition,
  ): void {
    this.clear();
    this.#document = document;
    this.#sizes = [...pageSizes];
    const owner = this.#element.ownerDocument;
    const stage = owner.createElement('div');
    stage.className = 'pdf-view-pages';
    const total = this.#sizes.length;
    this.#pages = this.#sizes.map((_, index) => {
      const element = owner.createElement('div');
      element.className = 'pdf-page';
      element.setAttribute('role', 'group');
      element.setAttribute('aria-label', this.#pageLabel(index + 1, total));
      stage.append(element);
      return {
        element,
        canvas: undefined,
        drawnScale: undefined,
        failed: false,
        layer: undefined,
      };
    });
    this.#stage = stage;
    this.#element.replaceChildren(stage);
    // Shown first, so the layout reads the real width.
    this.#element.hidden = false;
    this.#element.scrollTop = 0;
    this.#element.scrollLeft = 0;
    this.#applyLayout(false);
    if (position && this.#layout) {
      this.#element.scrollTop = pdfScrollTopFor(this.#layout.boxes, position);
    }
    this.#resizeObserver = this.#createResizeObserver(() => this.#schedule());
    this.#resizeObserver?.observe(this.#element);
    this.#watchPixelRatio();
    this.#pump();
    this.#reportReadingPage();
  }

  readingPosition(): PdfReadingPosition | undefined {
    if (!this.#document || !this.#layout) return undefined;
    return pdfReadingPosition(this.#layout.boxes, this.#element.scrollTop);
  }

  /** Scrolls so that `position` is at the top of the view (following, D108). */
  followPosition(position: PdfReadingPosition): void {
    if (!this.#document || !this.#layout) return;
    const top = pdfScrollTopFor(this.#layout.boxes, position);
    if (Math.abs(this.#element.scrollTop - top) < 0.5) return;
    this.#element.scrollTop = top;
  }

  /** Names every page again, in the language now current. */
  relabelPages(): void {
    const total = this.#pages.length;
    this.#pages.forEach((page, index) => {
      page.element.setAttribute('aria-label', this.#pageLabel(index + 1, total));
    });
  }

  setPageText(pageIndex: number, blocks: readonly PdfSurfaceBlock[]): void {
    const page = this.#pages[pageIndex];
    const size = this.#sizes[pageIndex];
    if (!this.#document || !page || !size) return;
    if (page.layer) {
      for (const id of page.layer.ids) this.#blockPages.delete(id);
      page.layer.element.remove();
    }
    const layer = new PdfPageTextLayer(this.#element.ownerDocument, size, blocks);
    page.layer = layer;
    for (const block of blocks) this.#blockPages.set(block.id, pageIndex);
    page.element.append(layer.element);
    syncOverlays(page);
    if (page.canvas) this.#decorate(pageIndex);
  }

  showTranslation(blockId: number, text: string, language: string | undefined): void {
    const index = this.#blockPages.get(blockId);
    const page = index === undefined ? undefined : this.#pages[index];
    if (!page?.layer) return;
    page.layer.setTranslation(blockId, text, language);
    if (!page.canvas) return;
    if (page.layer.coloursSampled || page.layer.colourReadFailed) this.#schedule();
    else this.#decorate(index!);
  }

  hideTranslations(): void {
    for (const page of this.#pages) page.layer?.hideTranslations();
  }

  /** A new screen density redraws the canvases sharp at the next pass. */
  #watchPixelRatio(): void {
    this.#stopWatchingPixelRatio?.();
    this.#stopWatchingPixelRatio = this.#watchDevicePixelRatio(() => {
      if (!this.#document) return;
      this.#watchPixelRatio();
      this.#schedule();
    });
  }

  clear(): void {
    if (this.#frame !== undefined) this.#cancelFrame(this.#frame);
    this.#frame = undefined;
    if (this.#rerenderTimer !== undefined) clearTimeout(this.#rerenderTimer);
    this.#rerenderTimer = undefined;
    this.#holdRedraw = false;
    this.#rendering?.controller.abort();
    this.#rendering = undefined;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = undefined;
    this.#stopWatchingPixelRatio?.();
    this.#stopWatchingPixelRatio = undefined;
    // The document is destroyed next, which frees pdf.js's side of every page.
    for (const page of this.#pages) {
      if (page.canvas) discardCanvas(page.canvas);
    }
    this.#pages = [];
    this.#blockPages.clear();
    this.#readingIndex = -1;
    this.#sizes = [];
    this.#stage = undefined;
    this.#layout = undefined;
    this.#layoutViewportWidth = -1;
    this.#document = undefined;
    this.#element.replaceChildren();
    this.#element.hidden = true;
  }

  updateLayout(settings: PdfLayoutSettings): void {
    const previous = this.#settings;
    this.#settings = settings;
    if (!this.#document) return;
    // The mirror's layout hook runs often; an unchanged layout moves nothing.
    const unchanged = previous.displayMode === settings.displayMode &&
      previous.zoomPercent === settings.zoomPercent &&
      previous.sourceZoomFactor === settings.sourceZoomFactor &&
      this.#element.clientWidth === this.#layoutViewportWidth;
    if (!unchanged) this.#relayout();
    this.#pump();
  }

  #schedule(): void {
    if (this.#frame !== undefined || !this.#document) return;
    this.#frame = this.#requestFrame(() => {
      this.#frame = undefined;
      if (!this.#document) return;
      // A width change moves every page (Fit follows the width); a height
      // change only changes which pages are near.
      if (this.#element.clientWidth !== this.#layoutViewportWidth) this.#relayout();
      this.#pump();
      this.#fitDrawnPages();
      this.#reportReadingPage();
    });
  }

  /**
   * Fits waiting translations on drawn pages, and all of them after a zoom.
   * Each round measures every page's blocks, then resizes them, so a round
   * lays the view out once, not once per page.
   */
  #fitDrawnPages(): void {
    const scale = this.#layout?.scale;
    if (scale === undefined) return;
    let fitting: PdfPageTextLayer[] = [];
    for (const page of this.#pages) {
      const layer = page.layer;
      if (!page.canvas || !layer) continue;
      const fittedAt = layer.fittedAtScale;
      if (fittedAt !== undefined && Math.abs(fittedAt / scale - 1) > 0.1) layer.resetFit();
      if (layer.needsFit && layer.startFit(scale)) fitting.push(layer);
    }
    for (let pass = 0; pass < PDF_FIT_PASSES && fitting.length > 0; pass += 1) {
      for (const layer of fitting) layer.measureFit(this.#measureBlock);
      fitting = fitting.filter((layer) => layer.applyFit());
    }
    for (const layer of fitting) layer.finishFit();
  }

  #reportReadingPage(): void {
    const position = this.readingPosition();
    if (!position || position.index === this.#readingIndex) return;
    this.#readingIndex = position.index;
    try {
      this.#onReadingPageChange?.(position.index);
    } catch {
      // The reading order is a preference; the view carries on.
    }
  }

  /**
   * A drawn page with text: its fonts' weight and slant come from pdf.js,
   * which knows them now, and, once a translation shows, the overlay colours
   * come from the canvas. Each is read once per page.
   */
  #decorate(index: number): void {
    const page = this.#pages[index];
    const document = this.#document;
    const layer = page?.layer;
    if (!page || !document || !layer || !page.canvas || layer.ids.length === 0) return;
    const size = this.#sizes[index];
    if (!layer.coloursSampled && !layer.colourReadFailed && layer.hasTranslations && size) {
      const pixels = this.#readPixels(page.canvas);
      // The canvas spans the page, so its width over the page's gives the scale.
      if (pixels) layer.applyColours(pixels, pixels.width / size.width);
      else layer.colourReadFailed = true;
    }
    syncOverlays(page);
    if (!layer.fontFacesRequested && document.fontFaces) {
      layer.fontFacesRequested = true;
      void document.fontFaces(index + 1, layer.fontIds).then((faces) => {
        if (this.#document !== document || page.layer !== layer) return;
        layer.applyFontFaces(faces);
        this.#schedule();
      }, () => {
        layer.fontFacesRequested = false;
      });
    }
    this.#schedule();
  }

  #relayout(): void {
    const previousScale = this.#layout?.scale;
    this.#applyLayout(true);
    if (previousScale !== this.#layout?.scale) {
      // A page that failed to draw gets another try at the new size.
      for (const page of this.#pages) page.failed = false;
      this.#deferRedraw();
    }
  }

  #applyLayout(keepPosition: boolean): void {
    const stage = this.#stage;
    if (!stage) return;
    const previous = this.#layout;
    const viewportWidth = this.#element.clientWidth;
    const position = keepPosition && previous
      ? pdfReadingPosition(previous.boxes, this.#element.scrollTop)
      : undefined;
    const layout = pdfPageBoxes(
      this.#sizes,
      this.#settings,
      viewportWidth - 2 * PDF_PAGE_GAP,
      PDF_PAGE_GAP,
    );
    this.#layout = layout;
    this.#layoutViewportWidth = viewportWidth;
    stage.style.setProperty('--pdf-scale', String(layout.scale));
    stage.style.width = `${layout.width}px`;
    stage.style.height = `${layout.height}px`;
    this.#pages.forEach((page, index) => {
      const box = layout.boxes[index];
      if (!box) return;
      page.element.style.top = `${box.top}px`;
      page.element.style.left = `${box.left}px`;
      page.element.style.width = `${box.width}px`;
      page.element.style.height = `${box.height}px`;
    });
    if (previous && position && previous.scale !== layout.scale) {
      const scrollLeft = this.#element.scrollLeft;
      this.#element.scrollTop = pdfScrollTopFor(layout.boxes, position);
      this.#element.scrollLeft = pdfScrollLeftFor(
        previous.width,
        layout.width,
        viewportWidth,
        scrollLeft,
      );
    }
  }

  /** Stretched canvases are redrawn at the new size once the change settles. */
  #deferRedraw(): void {
    this.#holdRedraw = true;
    if (this.#rerenderTimer !== undefined) clearTimeout(this.#rerenderTimer);
    this.#rerenderTimer = setTimeout(() => {
      this.#rerenderTimer = undefined;
      this.#holdRedraw = false;
      this.#pump();
    }, this.#rerenderDelayMs);
  }

  #targetScale(index: number): number {
    const size = this.#sizes[index];
    const box = this.#layout?.boxes[index];
    return pdfRenderScale(
      size?.width ?? Number.NaN,
      size?.height ?? Number.NaN,
      box?.width ?? Number.NaN,
      this.#devicePixelRatio(),
    );
  }

  #pump(): void {
    const layout = this.#layout;
    if (!this.#document || !layout) return;
    const drawn = new Set<number>();
    const stale = new Set<number>();
    const failed = new Set<number>();
    this.#pages.forEach((page, index) => {
      if (page.failed) failed.add(index);
      if (!page.canvas) return;
      drawn.add(index);
      if (
        !this.#holdRedraw &&
        page.drawnScale !== undefined &&
        Math.abs(page.drawnScale / this.#targetScale(index) - 1) > SCALE_TOLERANCE
      ) {
        stale.add(index);
      }
    });
    const rendering = this.#rendering;
    if (rendering) drawn.add(rendering.index);
    const plan = pdfDrawPlan({
      boxes: layout.boxes,
      scrollTop: this.#element.scrollTop,
      viewportHeight: this.#element.clientHeight,
      drawn,
      stale,
      failed,
      maxDrawn: this.#maxDrawnPages,
    });
    for (const index of plan.release) this.#release(index);
    if (this.#rendering) {
      // Scrolled away from the page being drawn: let the near pages go first.
      if (!plan.wanted.includes(this.#rendering.index)) {
        this.#rendering.controller.abort();
      }
      return;
    }
    const next = plan.draw[0];
    if (next !== undefined) this.#draw(next);
  }

  #draw(index: number): void {
    const document = this.#document;
    const page = this.#pages[index];
    if (!document || !page) return;
    const scale = this.#targetScale(index);
    // A fresh canvas each time, swapped in when drawn, so a redraw never
    // blanks the page while it runs.
    const canvas = this.#element.ownerDocument.createElement('canvas');
    canvas.className = 'pdf-page-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    const controller = new AbortController();
    const rendering: Rendering = { index, controller };
    this.#rendering = rendering;
    let placed = false;
    void document.render(index + 1, canvas, scale, controller.signal)
      .then(
        () => {
          if (
            this.#rendering !== rendering ||
            this.#document !== document ||
            controller.signal.aborted
          ) return;
          if (page.canvas) discardCanvas(page.canvas);
          page.element.prepend(canvas);
          page.canvas = canvas;
          page.drawnScale = scale;
          placed = true;
          // A new drawing is a new chance to read colours that failed.
          if (page.layer) page.layer.colourReadFailed = false;
          this.#decorate(index);
        },
        () => {
          // A page pdf.js cannot draw stays a blank placeholder.
          if (!controller.signal.aborted && this.#document === document) page.failed = true;
        },
      )
      .finally(() => {
        if (!placed) discardCanvas(canvas);
        if (this.#rendering !== rendering) return;
        this.#rendering = undefined;
        this.#pump();
      });
  }

  #release(index: number): void {
    const page = this.#pages[index];
    if (!page) return;
    if (this.#rendering?.index === index) this.#rendering.controller.abort();
    if (page.canvas) discardCanvas(page.canvas);
    page.canvas = undefined;
    page.drawnScale = undefined;
    syncOverlays(page);
    void this.#document?.releasePage(index + 1).catch(() => {});
  }
}

/**
 * Translations show only on a page that is drawn and whose colours were
 * read (or could not be); before that the page looks as it did before
 * translation. Its text still reaches screen readers (see style.css).
 */
function syncOverlays(page: ViewPage): void {
  const layer = page.layer;
  if (page.canvas && layer && (layer.coloursSampled || layer.colourReadFailed)) {
    page.element.setAttribute('data-overlays', '');
  } else {
    page.element.removeAttribute('data-overlays');
  }
}

/** The whole canvas as pixels; `undefined` when it cannot be read. */
function readCanvasPixels(canvas: HTMLCanvasElement): RgbaPixels | undefined {
  try {
    const context = canvas.getContext('2d');
    if (!context || canvas.width < 1 || canvas.height < 1) return undefined;
    return context.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return undefined;
  }
}

/** The room a translated block has and the room its text takes, laid out. */
function measureBlock(block: HTMLElement, text: HTMLElement): {
  readonly needed: { readonly width: number; readonly height: number };
  readonly available: { readonly width: number; readonly height: number };
} | undefined {
  const available = { width: block.clientWidth, height: block.clientHeight };
  if (!(available.width > 0) || !(available.height > 0)) return undefined;
  return { needed: { width: text.scrollWidth, height: text.scrollHeight }, available };
}

/** Gives a canvas's backing memory back at once instead of at collection. */
function discardCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
  canvas.remove();
}
