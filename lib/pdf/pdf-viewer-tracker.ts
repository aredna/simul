import type { PdfPagePoints, PdfReadingPosition } from './pdf-layout';
import type { PdfViewerViewport } from './pdf-viewer-protocol';

// Chrome's one-page-wide layout (Chromium `pdf/document_layout.h` and
// `PDFiumEngine::GetPageSizeForLayout`), in viewer pixels at 100%: each page
// is trunc(points × 4/3) pixels, padded by these insets, with a separator
// between pages. `pageY` is the top of a page inside its padding.
const INSET_TOP = 3;
const INSET_BOTTOM = 7;
const INSET_LEFT = 5;
const INSET_RIGHT = 5;
const SEPARATOR = 4;
// The viewer's own scrollbar (`getScrollbarWidth`).
const SCROLLBAR_WIDTH = 14;
// How far (screen px) a page may be from where the one-page-wide layout
// puts it before the report is taken to be from another layout.
const BESIDE_OFFSET = 8;
// In the two-page view Chrome reports each page this much narrower
// (viewer pixels at 100%): its insets there are 5 and 1, not 5 and 5.
const TWO_PAGE_NARROWER = 4;
const TWO_PAGE_WIDTH_TOLERANCE = 0.3;
/** The viewer's arrow-key step (`SCROLL_INCREMENT`), in screen pixels. */
export const PDF_VIEWER_ARROW_STEP = 40;
/** PageUp, PageDown and Space move this share of the viewport height. */
export const PDF_VIEWER_PAGE_KEY_SHARE = 0.875;
/** Messages further apart than this start a new movement. */
export const PDF_VIEWER_STREAM_GAP_MS = 100;
/** A lone held report is read after this long without another. */
export const PDF_VIEWER_SETTLE_MS = 150;
/**
 * A held movement goes on while reports come within this time, and is read
 * after this long without one: a viewer busy drawing can stall mid-scroll.
 */
export const PDF_VIEWER_MOVEMENT_SETTLE_MS = 300;
// Within a movement, a page is followed only while the viewer stays this
// close (a share of a page) to where its speed says it should be. Pages of
// one size make every report fit some page within half a page, so a fast
// movement shows up only as a path that jumps about; scrolling by hand
// changes speed by far less than this from one frame to the next.
const FOLLOW_SHARE = 0.2;
// The viewer zooms between 25% and 500%; anything far outside is not a page.
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 20;
// Two zooms this close (relative) are one zoom.
const SAME_ZOOM = 0.002;
// Chrome snaps the scroll position to whole pixels, so a key step lands
// within half a pixel of its exact length.
const ARROW_TOLERANCE = 0.5;
const PAGE_KEY_TOLERANCE = 1.5;
// A lone report this close (screen px) to the last place is a small scroll
// (the first frame of a wheel turn), not a PageDown cut short at the end.
const SMALL_MOVE = 48;
// A lone report this far (screen px) from the last place is not a wheel or
// trackpad frame: a jump, or the first frame of Home, End or a drag. It is
// read once the viewer has been still, from where it stopped.
const LARGE_MOVE = 160;
// A jump to a page (ArrowRight, the page box) reports the page's top
// exactly at the top before Chrome snaps the scroll position (a second
// report follows at once); a scroll that stops near a page top is told
// apart by this margin.
const PAGE_TOP_EXACT = 0.1;
// The snapped report of a jump follows its first report within this time;
// a held key repeats more slowly (about every 30 ms).
const SNAP_REPORT_MS = 20;
// A held ArrowRight's report barely differs from the last (the snapping).
const HELD_PAGE_TOP_MOVE = 0.75;
// One animation frame.
const FRAME_MS = 1000 / 60;
// Chrome snaps the scroll position to whole pixels: a sideways place this
// close (screen px) to the last is the same place, kept through a zoom.
const SAME_LEFT = 0.75;
// How close a held movement must stop to the top or bottom of the PDF.
const EDGE_TOLERANCE = 0.75;
const MAX_SPEED = 50; // viewer pixels per ms

interface ViewerPage {
  /** Page size in viewer pixels at 100%, padding excluded. */
  readonly width: number;
  readonly height: number;
  /** The page's top edge in the document, in viewer pixels at 100%. */
  readonly top: number;
}

/** A decoded report: where the viewer's viewport top is. */
interface Fix {
  /** The most visible page (0-based). */
  readonly page: number;
  /** The viewport's top edge in the document, in viewer pixels at 100%. */
  readonly y: number;
  readonly zoom: number;
  readonly viewport: PdfViewerViewport;
}

interface Candidate {
  readonly page: number;
  readonly zoom: number;
  readonly y: number;
}

/** A movement held until the viewer has been still. */
interface Hold {
  readonly from: Fix;
  /** The speed trusted before the hold, viewer pixels at 100% per ms. */
  readonly speed: number;
  last: PdfViewerViewport;
  /** Reports held: one for a lone jump, more for a movement. */
  frames: number;
}

/** A lone report that is either a small scroll or a page key step. */
interface KeyStep {
  readonly key: Candidate;
  readonly scroll: Candidate;
  readonly viewport: PdfViewerViewport;
}

/**
 * What a report means for the panel: `move` to a new place, `same` place as
 * before, or `hold` while a movement too fast to follow runs (`settle` ends
 * it once the viewer has been still for a moment).
 */
export type PdfViewerTrack =
  | { readonly kind: 'move'; readonly position: PdfReadingPosition }
  | { readonly kind: 'same' }
  /** `wait`: how long the viewer must be still before `settle`, in ms. */
  | { readonly kind: 'hold'; readonly wait: number };

/**
 * Guesses where Chrome's PDF viewer is from its `viewport` reports, which
 * say where the most visible page sits but never which page it is (D108).
 * Every page is a candidate; each implies a zoom (its width against the
 * report's) and a scroll position. A lone report (none for 100 ms before
 * it) is read by the viewer's exact moves: an arrow step, a page top (the
 * next page, or the document's top after scrolling up in the first screen,
 * with Chrome's snapped second report telling a jump apart), the bottom of
 * the PDF, then a page key step, held until it is clear that no scrolling
 * frames follow. Held keys repeat their exact move about every 30 ms and
 * are read as such. Otherwise the guess is the page nearest where the
 * viewer's speed says it is. A movement too fast to follow is held until it stops,
 * then read as the top or bottom of the PDF when it ends there (Home, End),
 * else as the page nearest where it began. The two-page view is noticed and
 * not followed; rotated pages are not modelled.
 *
 * Sideways there is nothing to guess (D115): `pageX` says how far the viewer
 * is scrolled across the PDF's width, whichever page it names. `left` is
 * that place.
 */
export class PdfViewerTracker {
  readonly #pages: readonly ViewerPage[];
  readonly #documentHeight: number;
  #fix: Fix | undefined;
  #anchorY = 0;
  /** The width of the page the panel showed when guessing began. */
  #anchorWidth: number | undefined;
  #speed = 0;
  /** How far the last accepted report moved, in viewer pixels at 100%. */
  #lastStep = 0;
  #previousLone = true;
  #lastTime: number | undefined;
  #hold: Hold | undefined;
  /**
   * A page key step read when no frame followed in time; a frame that does
   * follow (the panel was busy) makes it a scroll after all.
   */
  #keyUndo: { readonly scroll: Candidate; readonly viewport: PdfViewerViewport } | undefined;
  #position: PdfReadingPosition | undefined;
  /** How far the viewer is scrolled sideways, in viewer pixels at 100%. */
  #scrollX: number | undefined;
  /**
   * After a report read as the document's top or an arrow step onto a page
   * top: a jump to the next page looks the same. A jump's position is
   * snapped to whole pixels at once, which sends a second report; a scroll
   * sends none.
   */
  #jumpInstead = false;
  /**
   * A lone report that is either a small scroll or a page key step to
   * another page: a scroll sends more frames at once, a key nothing more.
   */
  /** The place before the last accepted report. */
  #jumpFrom: Fix | undefined;
  #keyStep: KeyStep | undefined;
  /** Whether the last accepted move was a page key step. */
  #lastPageKey = false;
  /** The width most pages have, and the widest, in viewer pixels at 100%. */
  readonly #usualWidth: number;
  readonly #widestWidth: number;
  /** Every distinct page width. */
  readonly #widths: readonly number[];
  /** The zoom at which the viewer went to its two-page view, while in it. */
  #twoPageZoom: number | undefined;

  constructor(pageSizes: readonly PdfPagePoints[]) {
    let top = 0;
    const pages: ViewerPage[] = [];
    for (const size of pageSizes) {
      const width = viewerPixels(size.width);
      const height = viewerPixels(size.height);
      if (pages.length > 0) top += SEPARATOR;
      pages.push({ width, height, top: top + INSET_TOP });
      top += INSET_TOP + height + INSET_BOTTOM;
    }
    this.#pages = pages;
    this.#documentHeight = top;
    const counts = new Map<number, number>();
    for (const page of pages) counts.set(page.width, (counts.get(page.width) ?? 0) + 1);
    let usual = pages[0]?.width ?? 1;
    for (const [width, count] of counts) if (count > (counts.get(usual) ?? 0)) usual = width;
    this.#usualWidth = usual;
    this.#widths = [...counts.keys()];
    this.#widestWidth = pages.reduce((widest, page) => Math.max(widest, page.width), 1);
  }

  /** Whether a report has been read yet. */
  get hasFix(): boolean {
    return this.#fix !== undefined || this.#hold !== undefined || this.#keyStep !== undefined;
  }

  /** The latest guess, as the panel's reading position. */
  get position(): PdfReadingPosition | undefined {
    return this.#position;
  }

  /**
   * How far the viewer is scrolled across the PDF, as a share of the widest
   * page's width: 0 at the far left. It stays the same until the viewer is
   * scrolled sideways, and is 0 while the PDF's whole width fits the
   * viewer. `undefined` before a report is read.
   */
  get left(): number | undefined {
    return this.#scrollX === undefined ? undefined : this.#scrollX / this.#widestWidth;
  }

  /**
   * Where to start guessing from: the first report is read as the place
   * nearest `position`. Ignored once a report has been read.
   */
  anchor(position: PdfReadingPosition | undefined): void {
    if (this.hasFix || !position) return;
    const page = this.#pages[Math.min(Math.max(0, position.index), this.#pages.length - 1)];
    if (!page) return;
    this.#anchorY = page.top + clamp(position.fraction, 0, 1) * page.height;
    this.#anchorWidth = page.width;
  }

  update(viewport: PdfViewerViewport, time: number): PdfViewerTrack {
    if (this.#pages.length === 0) return { kind: 'same' };
    const elapsed = this.#lastTime === undefined || !Number.isFinite(time)
      ? Number.POSITIVE_INFINITY
      : time - this.#lastTime;
    this.#lastTime = time;
    // The two-page view puts pages beside each other: not followed.
    if (this.#twoPageView(viewport) || this.#beside(viewport)) return { kind: 'same' };
    const lone = !(elapsed >= 0 && elapsed <= PDF_VIEWER_STREAM_GAP_MS);
    const previousLone = this.#previousLone;
    this.#previousLone = lone;
    const before = this.#position;
    const keyUndo = this.#keyUndo;
    this.#keyUndo = undefined;
    if (keyUndo && !lone) this.#accept(keyUndo.scroll, keyUndo.viewport, 0);
    if (this.#hold) {
      const within = this.#hold.frames > 1 ? PDF_VIEWER_MOVEMENT_SETTLE_MS : PDF_VIEWER_STREAM_GAP_MS;
      if (elapsed >= 0 && elapsed <= within) {
        this.#hold.last = viewport;
        this.#hold.frames += 1;
        return { kind: 'hold', wait: PDF_VIEWER_MOVEMENT_SETTLE_MS };
      }
      // The held movement stopped before its settle ran: read it first.
      this.settle();
    }
    const keyStep = this.#keyStep;
    if (keyStep) {
      this.#keyStep = undefined;
      // A scroll sends more frames at once; a key sends nothing more. Held
      // down, a key repeats the same step, but only after its first press
      // was read as a key (the keyboard waits before repeating); equal
      // wheel steps can look like repeats of the opposite page key.
      const key = lone || (this.#lastPageKey && this.#repeatsKey(keyStep, viewport, elapsed));
      this.#accept(key ? keyStep.key : keyStep.scroll, keyStep.viewport, 0);
    }
    const track = this.#read(viewport, elapsed, lone, previousLone);
    // A held movement or key read just now moved the place even when this
    // report did not.
    if (track.kind === 'same' && this.#position !== before && this.#position) {
      return { kind: 'move', position: this.#position };
    }
    return track;
  }

  #read(
    viewport: PdfViewerViewport,
    elapsed: number,
    lone: boolean,
    previousLone: boolean,
  ): PdfViewerTrack {
    const fix = this.#fix;
    const jumpInstead = this.#jumpInstead;
    this.#jumpInstead = false;
    // The page ArrowRight would have gone to from the place before.
    const jumpFrom = this.#jumpFrom;
    const all = this.#candidates(viewport);
    if (all.length === 0) return { kind: 'same' };
    if (!fix) {
      // The first report: a page as wide as the panel's page (else of the
      // PDF's usual width) is likelier than a nearer page of another size.
      const width = this.#anchorWidth ?? this.#usualWidth;
      const alike = all.filter((candidate) => this.#pages[candidate.page]!.width === width);
      return this.#accept(nearest(alike.length > 0 ? alike : all, this.#anchorY), viewport, 0);
    }

    const sameZoom = sameZoomCandidates(all, fix, viewport);
    const candidates = sameZoom.length > 0 ? sameZoom : all;
    // Scrolling sideways moves only `pageX`: the same place.
    if (
      sameZoom.length > 0 &&
      Math.abs(viewport.pageY - fix.viewport.pageY) < 0.01 &&
      Math.abs(viewport.pageX - fix.viewport.pageX) >= 0.01
    ) {
      this.#setFix({ ...fix, viewport });
      return { kind: 'same' };
    }

    if (
      jumpInstead &&
      jumpFrom &&
      elapsed <= SNAP_REPORT_MS &&
      sameZoom.length > 0 &&
      Math.abs(viewport.pageY - fix.viewport.pageY) < 1
    ) {
      // Snapped by up to half a pixel from the exact page top.
      const jump = this.#atTopOfNextPage(candidates, jumpFrom, 1);
      if (jump) return this.#accept(jump, viewport, 0);
    }

    if (lone && sameZoom.length > 0) {
      const exact = this.#readLone(candidates, fix, viewport);
      if (exact) return this.#accept(exact, viewport, 0);
      // A page key step to another page than the nearest reading: a
      // scroll sends more frames at once, a key nothing more.
      const scroll = nearest(candidates, fix.y);
      const key = this.#pageKeyStep(candidates, fix, viewport);
      if (key && key !== scroll) {
        this.#keyStep = { key, scroll, viewport };
        return { kind: 'hold', wait: PDF_VIEWER_SETTLE_MS };
      }
      if (key) return this.#accept(key, viewport, 0);
      if (Math.abs(scroll.y - fix.y) * scroll.zoom > LARGE_MOVE) {
        this.#hold = { from: fix, speed: 0, last: viewport, frames: 1 };
        return { kind: 'hold', wait: PDF_VIEWER_SETTLE_MS };
      }
    }

    if (!lone && sameZoom.length > 0 && elapsed > SNAP_REPORT_MS) {
      const held = this.#readHeldKey(candidates, fix, viewport);
      if (held) return this.#accept(held, viewport, 0);
    }

    // A movement's second frame has no speed yet: its first frame's step,
    // one frame on, is the other guess (a wheel turn starts at full speed).
    const predictions = lone ? [fix.y] : [fix.y + this.#speed * elapsed];
    if (!lone && previousLone) predictions.push(fix.y + (this.#lastStep * elapsed) / FRAME_MS);
    let best = nearest(candidates, predictions[0]!);
    let predicted = predictions[0]!;
    for (const prediction of predictions.slice(1)) {
      const candidate = nearest(candidates, prediction);
      if (Math.abs(candidate.y - prediction) < Math.abs(best.y - predicted)) {
        best = candidate;
        predicted = prediction;
      }
    }
    const pitch = (this.#pages[best.page]!.height + INSET_TOP + INSET_BOTTOM + SEPARATOR) *
      best.zoom;
    if (Math.abs(best.y - predicted) * best.zoom <= FOLLOW_SHARE * pitch) {
      // A zoom or resize keeps the viewer's place up to a snapped pixel:
      // the same place, so the reader's own scrolling of the panel stays.
      if (sameZoom.length === 0 && Math.abs(best.y - fix.y) * best.zoom < 1) {
        this.#setFix({ page: best.page, y: best.y, zoom: best.zoom, viewport });
        return { kind: 'same' };
      }
      const speed = lone ? 0 : (best.y - fix.y) / Math.max(1, elapsed);
      return this.#accept(best, viewport, clamp(speed, -MAX_SPEED, MAX_SPEED));
    }
    // A lone jump (page box, outline, link, find): nearest is the best guess.
    if (lone) return this.#accept(best, viewport, 0);
    // A movement's second frame has only its first frame's step for speed.
    const speed = previousLone ? this.#lastStep / FRAME_MS : this.#speed;
    this.#hold = { from: fix, speed: clamp(speed, -MAX_SPEED, MAX_SPEED), last: viewport, frames: 2 };
    return { kind: 'hold', wait: PDF_VIEWER_MOVEMENT_SETTLE_MS };
  }

  /**
   * A key held down repeats its exact move about every 30 ms, faster than a
   * lone report: ArrowRight lands on the next page top again (the report
   * barely differs from the last), and PageDown or Space repeat the same
   * page key step that the last move was.
   */
  #readHeldKey(
    candidates: readonly Candidate[],
    fix: Fix,
    viewport: PdfViewerViewport,
  ): Candidate | undefined {
    const closest = nearest(candidates, fix.y);
    // The next page has another width: only it can be at this zoom.
    const nextOtherWidth = this.#pages[fix.page + 1]?.width !== this.#pages[fix.page]?.width;
    if (Math.abs(closest.y - fix.y) * closest.zoom < HELD_PAGE_TOP_MOVE || nextOtherWidth) {
      const next = this.#atTopOfNextPage(candidates, fix, PAGE_TOP_EXACT);
      if (next) return next;
    }
    if (this.#lastPageKey) {
      const key = this.#pageKeyStep(candidates, fix, viewport);
      if (key) return key;
    }
    // A held key cut short by the end of the PDF.
    return this.#cutShortAtBottom(candidates, fix, viewport);
  }

  /** Whether a report in a movement repeats the pending page key step. */
  #repeatsKey(
    keyStep: KeyStep,
    viewport: PdfViewerViewport,
    elapsed: number,
  ): boolean {
    if (!(elapsed > SNAP_REPORT_MS)) return false;
    const fix: Fix = {
      page: keyStep.key.page,
      y: keyStep.key.y,
      zoom: keyStep.key.zoom,
      viewport: keyStep.viewport,
    };
    const candidates = this.#candidates(viewport)
      .filter((candidate) => Math.abs(candidate.zoom / fix.zoom - 1) <= SAME_ZOOM);
    return candidates.length > 0 && (
      this.#pageKeyStep(candidates, fix, viewport) !== undefined ||
      this.#cutShortAtBottom(candidates, fix, viewport) !== undefined
    );
  }

  /**
   * Whether the viewer is in its two-page view, where it reports a page
   * 4 px narrower (its insets differ) at an unchanged zoom and viewport.
   * Noticed when it is switched on while following, until a report fits
   * the one-page layout at that zoom again.
   */
  #twoPageView(viewport: PdfViewerViewport): boolean {
    const fits = (zoom: number, narrower: number) => this.#widths.some((width) =>
      Math.abs(viewport.pageWidth - (width - narrower) * zoom) <= TWO_PAGE_WIDTH_TOLERANCE);
    const twoPageZoom = this.#twoPageZoom;
    if (twoPageZoom !== undefined) {
      if (fits(twoPageZoom, 0)) {
        // One page wide again; the place is guessed from where it was.
        this.#twoPageZoom = undefined;
        return false;
      }
      // Zoomed while two pages wide: still two pages wide.
      if (!fits(twoPageZoom, TWO_PAGE_NARROWER)) {
        this.#twoPageZoom = viewport.pageWidth / (this.#usualWidth - TWO_PAGE_NARROWER);
      }
      return true;
    }
    const fix = this.#fix;
    if (
      !fix ||
      Math.abs(fix.viewport.viewportWidth - viewport.viewportWidth) >= 0.5 ||
      Math.abs(fix.viewport.viewportHeight - viewport.viewportHeight) >= 0.5 ||
      fits(fix.zoom, 0) ||
      !fits(fix.zoom, TWO_PAGE_NARROWER)
    ) return false;
    this.#twoPageZoom = fix.zoom;
    this.#hold = undefined;
    this.#keyStep = undefined;
    return true;
  }

  /**
   * Whether the report's page is not where the one-page-wide layout puts
   * it: there, a page is centred in the PDF's width, which is centred in
   * the view or scrolled sideways by at most its overhang. In the two-page
   * view pages sit beside each other, which is not modelled.
   */
  #beside(viewport: PdfViewerViewport): boolean {
    for (const width of this.#widths) {
      const zoom = viewport.pageWidth / width;
      const documentWidth = (this.#widestWidth + INSET_LEFT + INSET_RIGHT) * zoom;
      const left = ((this.#widestWidth - width) / 2 + INSET_LEFT) * zoom;
      // Chrome's own scrollbar may or may not take its width from the view.
      for (const scrollbar of [0, SCROLLBAR_WIDTH]) {
        const room = viewport.viewportWidth - scrollbar - documentWidth;
        const lowest = room >= 0 ? left + room / 2 : left + room;
        const highest = room >= 0 ? left + room / 2 : left;
        if (
          viewport.pageX >= lowest - BESIDE_OFFSET &&
          viewport.pageX <= highest + BESIDE_OFFSET
        ) return false;
      }
    }
    return true;
  }

  /**
   * A lone report at the same zoom, read by the viewer's exact moves, most
   * exact first: an arrow step (40 px, only ever a neighbour of the nearest
   * reading); a page top, which is the document's top after scrolling up
   * within the first screen and otherwise the next page (ArrowRight, paged
   * modes, the page box); the bottom of the PDF after a move that is not a
   * small scroll. `undefined` leaves the report to the other rules.
   */
  #readLone(
    candidates: readonly Candidate[],
    fix: Fix,
    viewport: PdfViewerViewport,
  ): Candidate | undefined {
    const moved = (candidate: Candidate) => Math.abs((candidate.y - fix.y) * candidate.zoom);
    const next = this.#atTopOfNextPage(candidates, fix, PAGE_TOP_EXACT);
    const arrow = candidates.find((candidate) =>
      Math.abs(moved(candidate) - PDF_VIEWER_ARROW_STEP) <= ARROW_TOLERANCE);
    if (arrow) {
      // An arrow up onto a page top, or ArrowRight: the snap report decides.
      if (next && next !== arrow) this.#jumpInstead = true;
      return arrow;
    }
    const documentTop = candidates.find((candidate) =>
      Math.abs(candidate.y) * candidate.zoom <= PAGE_TOP_EXACT);
    const fromTop = fix.y * fix.zoom;
    if (
      documentTop &&
      fromTop > 1e-6 &&
      fromTop <= PDF_VIEWER_PAGE_KEY_SHARE * viewport.viewportHeight + PAGE_KEY_TOLERANCE
    ) {
      if (next && next !== documentTop) this.#jumpInstead = true;
      return documentTop;
    }
    if (next) return next;
    if (moved(nearest(candidates, fix.y)) <= SMALL_MOVE) return undefined;
    // PageDown cut short by the end of the PDF stops exactly at its bottom.
    return this.#cutShortAtBottom(candidates, fix, viewport);
  }

  /**
   * The bottom of the PDF reached by a key cut short by it: forward, and
   * by less than a whole step (a page key's, or a page for ArrowRight).
   */
  #cutShortAtBottom(
    candidates: readonly Candidate[],
    fix: Fix,
    viewport: PdfViewerViewport,
  ): Candidate | undefined {
    const bottom = this.#atBottom(candidates, viewport);
    if (!bottom) return undefined;
    const moved = (bottom.y - fix.y) * bottom.zoom;
    const page = this.#pages[fix.page]!;
    const step = Math.max(
      PDF_VIEWER_PAGE_KEY_SHARE * viewport.viewportHeight,
      (page.height + INSET_TOP + INSET_BOTTOM + SEPARATOR) * bottom.zoom,
    );
    return moved > 0 && moved <= step + PAGE_KEY_TOLERANCE ? bottom : undefined;
  }

  /**
   * The candidate at the very bottom of the PDF, if the report fits one.
   * The most visible page there is the last, or, when two pages fit whole,
   * the one before it.
   */
  #atBottom(candidates: readonly Candidate[], viewport: PdfViewerViewport): Candidate | undefined {
    return candidates.find((candidate) =>
      this.#viewHeights(candidate.zoom, viewport).some((height) =>
        Math.abs(candidate.y - this.#maximumY(candidate.zoom, height)) * candidate.zoom <=
          EDGE_TOLERANCE));
  }

  /**
   * The heights the viewer may scroll by: its viewport, and that less a
   * horizontal scrollbar when the PDF is wider than the view.
   */
  #viewHeights(zoom: number, viewport: PdfViewerViewport): number[] {
    const wide = (this.#widestWidth + INSET_LEFT + INSET_RIGHT) * zoom >
      viewport.viewportWidth - SCROLLBAR_WIDTH;
    return wide
      ? [viewport.viewportHeight, viewport.viewportHeight - SCROLLBAR_WIDTH]
      : [viewport.viewportHeight];
  }

  /**
   * The candidate whose viewport top is the top of the page after the most
   * visible one (where ArrowRight and the paged modes go), within
   * `tolerance` screen px; on the last page, Chrome goes to its own top.
   * With several whole pages in view the report may name any of them, so
   * the place is compared, not the page named.
   */
  #atTopOfNextPage(
    candidates: readonly Candidate[],
    fix: Fix,
    tolerance: number,
  ): Candidate | undefined {
    const target = this.#pages[Math.min(fix.page + 1, this.#pages.length - 1)]!;
    const y = target.top - INSET_TOP;
    return candidates.find((candidate) => Math.abs(candidate.y - y) * candidate.zoom <= tolerance);
  }

  /** The candidate a PageUp, PageDown or Space step would reach, if any. */
  #pageKeyStep(
    candidates: readonly Candidate[],
    fix: Fix,
    viewport: PdfViewerViewport,
  ): Candidate | undefined {
    const steps = this.#viewHeights(fix.zoom, viewport)
      .map((height) => PDF_VIEWER_PAGE_KEY_SHARE * height);
    const pageKeys = candidates.filter((candidate) =>
      steps.some((step) =>
        Math.abs(Math.abs((candidate.y - fix.y) * candidate.zoom) - step) <= PAGE_KEY_TOLERANCE));
    // Half a page either way looks the same: forward is the likelier key.
    return pageKeys.find((candidate) => candidate.y > fix.y) ?? pageKeys[0];
  }

  /**
   * Ends a held movement: the top or the bottom of the PDF when it stopped
   * exactly there, else the page nearest where it began; a held page key
   * step is taken. `undefined` when nothing was held or the place is the
   * same, so the reader's own scrolling of the panel stays.
   */
  settle(): PdfReadingPosition | undefined {
    const keyStep = this.#keyStep;
    if (keyStep) {
      // No frame followed: a key.
      this.#keyStep = undefined;
      this.#keyUndo = { scroll: keyStep.scroll, viewport: keyStep.viewport };
      const result = this.#accept(keyStep.key, keyStep.viewport, 0);
      return result.kind === 'move' ? result.position : undefined;
    }
    const hold = this.#hold;
    if (!hold) return undefined;
    this.#hold = undefined;
    const all = this.#candidates(hold.last);
    if (all.length === 0) return undefined;
    const sameZoom = sameZoomCandidates(all, hold.from, hold.last);
    const candidates = sameZoom.length > 0 ? sameZoom : all;
    // Only a movement (Home, End, a drag) stops at an edge; a lone jump is
    // read like any other.
    const top = hold.frames > 1
      ? candidates.find((candidate) => Math.abs(candidate.y) * candidate.zoom <= PAGE_TOP_EXACT)
      : undefined;
    const bottom = hold.frames > 1 ? this.#atBottom(candidates, hold.last) : undefined;
    // Else where the speed trusted before the hold would have carried the
    // viewer, slowing as a fling does.
    const decay = 0.95;
    const travel = hold.speed * FRAME_MS * decay * (1 - decay ** hold.frames) / (1 - decay);
    const chosen = top ?? bottom ?? nearest(candidates, hold.from.y + travel);
    const result = this.#accept(chosen, hold.last, 0);
    return result.kind === 'move' ? result.position : undefined;
  }

  #candidates(viewport: PdfViewerViewport): Candidate[] {
    const candidates: Candidate[] = [];
    const inside: Candidate[] = [];
    this.#pages.forEach((page, index) => {
      const zoom = viewport.pageWidth / page.width;
      if (!(zoom >= MIN_ZOOM && zoom <= MAX_ZOOM)) return;
      const candidate = { page: index, zoom, y: page.top - viewport.pageY / zoom };
      candidates.push(candidate);
      // The viewer cannot scroll above the top or below the bottom.
      const slack = 2 / zoom;
      const bottom = this.#maximumY(zoom, Math.min(...this.#viewHeights(zoom, viewport)));
      if (candidate.y >= -slack && candidate.y <= bottom + slack) {
        inside.push(candidate);
      }
    });
    // A layout Simul does not model (two pages wide, rotated) still guesses.
    return inside.length > 0 ? inside : candidates;
  }

  /** The largest viewport top at `zoom` for a view `height` tall. */
  #maximumY(zoom: number, height: number): number {
    return Math.max(0, this.#documentHeight - height / zoom);
  }

  #accept(candidate: Candidate, viewport: PdfViewerViewport, speed: number): PdfViewerTrack {
    const previous = this.#fix;
    this.#jumpFrom = previous;
    this.#setFix({ page: candidate.page, y: candidate.y, zoom: candidate.zoom, viewport });
    this.#speed = speed;
    this.#lastStep = previous ? candidate.y - previous.y : 0;
    const moved = Math.abs(this.#lastStep * candidate.zoom);
    this.#lastPageKey = this.#viewHeights(candidate.zoom, viewport).some((height) =>
      Math.abs(moved - PDF_VIEWER_PAGE_KEY_SHARE * height) <= PAGE_KEY_TOLERANCE);
    if (previous && previous.page === candidate.page && Math.abs(previous.y - candidate.y) < 0.01) {
      return { kind: 'same' };
    }
    const position = this.#readingPosition(candidate.y);
    this.#position = position;
    return { kind: 'move', position };
  }

  /**
   * Takes a read report as the viewer's place, and reads how far it is
   * scrolled sideways. Chrome centres each page in the PDF's width and the
   * PDF in the view; scrolled, the page's left edge is that much further
   * left. Pages of one width give one answer whichever of them is named.
   */
  #setFix(fix: Fix): void {
    this.#fix = fix;
    const page = this.#pages[fix.page];
    if (!page || !(fix.zoom > 0)) return;
    const pageLeft = (this.#widestWidth - page.width) / 2 + INSET_LEFT;
    // Never below 0: a PDF narrower than the view is centred, not scrolled.
    const scrollX = Math.max(0, pageLeft - fix.viewport.pageX / fix.zoom);
    if (
      this.#scrollX === undefined ||
      Math.abs(scrollX - this.#scrollX) * fix.zoom >= SAME_LEFT
    ) this.#scrollX = scrollX;
  }

  /** The page under the viewport's top edge and how far down it is. */
  #readingPosition(y: number): PdfReadingPosition {
    const pages = this.#pages;
    let index = 0;
    for (let candidate = 0; candidate < pages.length; candidate += 1) {
      // A page counts from the separator above it, so a gap belongs to the
      // page below it (shown from its top).
      if (pages[candidate]!.top - INSET_TOP - SEPARATOR <= y) index = candidate;
      else break;
    }
    const page = pages[index]!;
    const fraction = page.height > 0 ? (y - page.top) / page.height : 0;
    return { index, fraction: clamp(fraction, 0, 1) };
  }
}

/** Candidates at the fix's zoom while the viewport is unchanged. */
function sameZoomCandidates(
  candidates: readonly Candidate[],
  fix: Fix,
  viewport: PdfViewerViewport,
): Candidate[] {
  const sameViewport = Math.abs(fix.viewport.viewportWidth - viewport.viewportWidth) < 0.5 &&
    Math.abs(fix.viewport.viewportHeight - viewport.viewportHeight) < 0.5;
  return sameViewport
    ? candidates.filter((candidate) => Math.abs(candidate.zoom / fix.zoom - 1) <= SAME_ZOOM)
    : [];
}

function viewerPixels(points: number): number {
  const valid = Number.isFinite(points) && points > 0 ? points : 0;
  // A small allowance keeps 612 × 4/3 at 816, not 815.
  return Math.max(1, Math.trunc((valid * 4) / 3 + 1e-6));
}

function nearest(candidates: readonly Candidate[], y: number): Candidate {
  let best = candidates[0]!;
  for (const candidate of candidates) {
    if (Math.abs(candidate.y - y) < Math.abs(best.y - y)) best = candidate;
  }
  return best;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
