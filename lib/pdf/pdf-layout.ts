import { displayScale } from '../display-scale';
import type { MirrorDisplayMode } from '../preferences';

/**
 * CSS pixels per PDF point at 100%: a point is 1/72 inch and a CSS pixel
 * 1/96 inch. Chrome's viewer shows a page at this size when its zoom is 100%.
 */
export const PDF_POINTS_TO_CSS_PX = 4 / 3;
/** The largest canvas the PDF view draws per page, in device pixels. */
export const MAX_PDF_PAGE_PIXELS = 4 * 1024 * 1024;
/** At most this many pages keep a drawn canvas; the rest are placeholders. */
export const MAX_DRAWN_PDF_PAGES = 8;

// A page size pdf.js could not give sensibly lays out as US Letter.
const FALLBACK_PAGE = { width: 612, height: 792 } as const;

/** A page's size in PDF points, rotation applied. */
export interface PdfPagePoints {
  readonly width: number;
  readonly height: number;
}

export interface PdfLayoutSettings {
  readonly displayMode: MirrorDisplayMode;
  readonly zoomPercent: number;
  /** The source tab's browser zoom (D104). */
  readonly sourceZoomFactor: number;
}

/** Where a page sits in the view, in CSS pixels. */
export interface PdfPageBox {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface PdfPageLayout {
  readonly boxes: readonly PdfPageBox[];
  /** The scrolling content's size, padding included. */
  readonly width: number;
  readonly height: number;
  /** CSS pixels per PDF point, the same for every page. */
  readonly scale: number;
}

/**
 * Lays the pages out in one column. Every page shares one scale, so pages
 * keep their sizes relative to each other, and each keeps its own aspect
 * ratio. Fit fills `contentWidth` with the widest page, growing or shrinking;
 * 1:1 is the size the tab shows (points × 4/3 × the tab's zoom); custom zoom
 * multiplies that. `gap` pads the column and separates the pages; a page
 * narrower than `contentWidth` is centred.
 */
export function pdfPageBoxes(
  pageSizes: readonly PdfPagePoints[],
  settings: PdfLayoutSettings,
  contentWidth: number,
  gap: number,
): PdfPageLayout {
  const pages = pageSizes.map(normalizePageSize);
  const padding = Number.isFinite(gap) && gap > 0 ? gap : 0;
  const widestPoints = pages.reduce((widest, page) => Math.max(widest, page.width), 0);
  const actualWidth = widestPoints * PDF_POINTS_TO_CSS_PX;
  const fitScale = Number.isFinite(contentWidth) && contentWidth > 0 && actualWidth > 0
    ? contentWidth / actualWidth
    : Number.NaN;
  const scale = PDF_POINTS_TO_CSS_PX * displayScale(
    settings.displayMode,
    fitScale,
    settings.zoomPercent,
    settings.sourceZoomFactor,
  );
  const column = Math.max(
    Number.isFinite(contentWidth) && contentWidth > 0 ? contentWidth : 0,
    widestPoints * scale,
  );
  const boxes: PdfPageBox[] = [];
  let top = padding;
  for (const page of pages) {
    const width = page.width * scale;
    const height = page.height * scale;
    boxes.push({
      top: cssLength(top),
      left: cssLength(padding + (column - width) / 2),
      width: cssLength(width),
      height: cssLength(height),
    });
    top += height + padding;
  }
  return {
    boxes,
    width: cssLength(column + padding * 2),
    height: cssLength(boxes.length > 0 ? top : padding * 2),
    scale,
  };
}

/** Rounds to 1/100 px, which hides floating-point noise such as 399.99999999999994. */
function cssLength(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The pdf.js scale for drawing a page at `cssWidth` on this screen: sharp at
 * the device pixel ratio, but at most `maxPixels` device pixels in all
 * (scale 1 is one pixel per point).
 */
export function pdfRenderScale(
  pagePointsWidth: number,
  pagePointsHeight: number,
  cssWidth: number,
  devicePixelRatio: number,
  maxPixels = MAX_PDF_PAGE_PIXELS,
): number {
  const page = normalizePageSize({ width: pagePointsWidth, height: pagePointsHeight });
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1;
  const width = Number.isFinite(cssWidth) && cssWidth > 0
    ? cssWidth
    : page.width * PDF_POINTS_TO_CSS_PX;
  const wanted = (width * ratio) / page.width;
  const limit = Math.sqrt(Math.max(1, maxPixels) / (page.width * page.height));
  return Math.min(wanted, limit);
}

export interface PdfDrawPlanInput {
  readonly boxes: readonly PdfPageBox[];
  readonly scrollTop: number;
  readonly viewportHeight: number;
  /** Pages (0-based) that hold a drawn canvas, or are being drawn now. */
  readonly drawn: ReadonlySet<number>;
  /** Drawn pages whose canvas is at an old size and needs drawing again. */
  readonly stale?: ReadonlySet<number>;
  /** Pages pdf.js could not draw; they take no place in the budget. */
  readonly failed?: ReadonlySet<number>;
  readonly maxDrawn?: number;
}

export interface PdfDrawPlan {
  /** Pages to have drawn, nearest to the middle of the view first. */
  readonly wanted: readonly number[];
  /** Wanted pages that still need drawing, in order. */
  readonly draw: readonly number[];
  /** Drawn pages to release so that at most `maxDrawn` stay drawn. */
  readonly release: readonly number[];
}

/**
 * Chooses which pages to draw and which to release. The pages within one
 * screen above and one screen below the view are wanted, nearest to the
 * middle of the view first, up to `maxDrawn`; pages that failed to draw are
 * skipped. Drawn pages are kept while there is room, so scrolling back is
 * instant; beyond the cap, pages outside that window go first, then the
 * farthest.
 */
export function pdfDrawPlan(input: PdfDrawPlanInput): PdfDrawPlan {
  const maxDrawn = Math.max(1, Math.floor(input.maxDrawn ?? MAX_DRAWN_PDF_PAGES));
  const viewportHeight = Number.isFinite(input.viewportHeight) && input.viewportHeight > 0
    ? input.viewportHeight
    : 1;
  const scrollTop = Number.isFinite(input.scrollTop) ? Math.max(0, input.scrollTop) : 0;
  const windowTop = scrollTop - viewportHeight;
  const windowBottom = scrollTop + 2 * viewportHeight;
  const middle = scrollTop + viewportHeight / 2;
  const distance = (index: number): number => {
    const box = input.boxes[index];
    if (!box) return Number.POSITIVE_INFINITY;
    if (middle < box.top) return box.top - middle;
    if (middle > box.top + box.height) return middle - (box.top + box.height);
    return 0;
  };
  const inWindow = (index: number): boolean => {
    const box = input.boxes[index];
    return Boolean(box && box.top < windowBottom && box.top + box.height > windowTop);
  };
  const byDistance = (left: number, right: number) =>
    distance(left) - distance(right) || left - right;

  const failed = input.failed ?? new Set<number>();
  const wanted = input.boxes
    .map((_, index) => index)
    .filter((index) => inWindow(index) && !failed.has(index))
    .sort(byDistance)
    .slice(0, maxDrawn);
  const wantedSet = new Set(wanted);
  const stale = input.stale ?? new Set<number>();
  const draw = wanted.filter((index) => !input.drawn.has(index) || stale.has(index));

  const kept = [...input.drawn].filter((index) => !wantedSet.has(index));
  const newlyDrawn = wanted.filter((index) => !input.drawn.has(index)).length;
  const excess = input.drawn.size + newlyDrawn - maxDrawn;
  const release = excess > 0
    ? kept
        .sort((left, right) =>
          Number(inWindow(left)) - Number(inWindow(right)) ||
          distance(right) - distance(left) ||
          right - left)
        .slice(0, excess)
    : [];
  return { wanted, draw, release };
}

/** A reading position: a page and how far down it the view's top edge is. */
export interface PdfReadingPosition {
  readonly index: number;
  /** 0 at the page's top edge, 1 at its bottom edge. */
  readonly fraction: number;
}

/** The page at the top of the view and the share of it scrolled past. */
export function pdfReadingPosition(
  boxes: readonly PdfPageBox[],
  scrollTop: number,
): PdfReadingPosition | undefined {
  if (boxes.length === 0) return undefined;
  const top = Number.isFinite(scrollTop) ? scrollTop : 0;
  let index = 0;
  for (let candidate = 0; candidate < boxes.length; candidate += 1) {
    if (boxes[candidate]!.top <= top) index = candidate;
    else break;
  }
  const box = boxes[index]!;
  const fraction = box.height > 0 ? (top - box.top) / box.height : 0;
  return { index, fraction: Math.min(1, Math.max(0, fraction)) };
}

/** The scroll offset that puts `position` back at the top of the view. */
export function pdfScrollTopFor(
  boxes: readonly PdfPageBox[],
  position: PdfReadingPosition | undefined,
): number {
  if (!position) return 0;
  const box = boxes[Math.min(position.index, boxes.length - 1)];
  return box ? Math.max(0, box.top + position.fraction * box.height) : 0;
}

/**
 * The horizontal offset that keeps the same share of the content under the
 * middle of the view when the content width changes.
 */
export function pdfScrollLeftFor(
  previousWidth: number,
  nextWidth: number,
  viewportWidth: number,
  scrollLeft: number,
): number {
  const maximum = Math.max(0, nextWidth - viewportWidth);
  if (maximum === 0) return 0;
  const middle = previousWidth > 0
    ? (scrollLeft + viewportWidth / 2) / previousWidth
    : 0.5;
  const next = middle * nextWidth - viewportWidth / 2;
  return Number.isFinite(next) ? Math.min(maximum, Math.max(0, next)) : 0;
}

function normalizePageSize(page: PdfPagePoints): PdfPagePoints {
  return Number.isFinite(page.width) &&
    Number.isFinite(page.height) &&
    page.width > 0 &&
    page.height > 0
    ? { width: page.width, height: page.height }
    : FALLBACK_PAGE;
}
