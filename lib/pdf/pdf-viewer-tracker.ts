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
// The viewer's own scrollbar, in screen px, while the tab has not said how
// wide it draws one: Chrome measures it (`getScrollbarWidth`), 15 on Linux,
// a fraction more or less on a scaled screen, another width on other
// systems, 0 where scrollbars lie over the page.
const UNTOLD_SCROLLBAR_WIDTH = 15;
const MAX_SCROLLBAR_WIDTH = 64;
// Chrome gives the viewer a scrollbar across when the PDF is wider than the
// view less the scrollbar down its side, which it measures in whole px. In
// fit to width the PDF is exactly as wide, give or take the arithmetic
// (this much, screen px), and has none.
const WIDE_EXACT = 1e-6;
// A measured width this near half way between two whole px may be either
// to Chrome.
const WHOLE_UNSURE = 0.1;
// Chrome 158 fits a PDF to width beside a scrollbar a pixel narrower than
// the one the tab measures, and the PDF is then that many screen px of the
// view less the tab's scrollbar, to within this (0.0001 recorded, D184).
const FIT_NARROWER_EXACT = 0.01;
// While the width is not told, a PDF within this (screen px) of the view
// less the usual scrollbar may have one across or not.
const UNTOLD_WIDE_MARGIN = 1;
// How far (screen px) a page may be from where the one-page-wide layout
// puts it before the report is taken to be from another layout.
const BESIDE_OFFSET = 8;
// In the two-page view Chrome reports each page this much narrower
// (viewer pixels at 100%): its insets there are 5 and 1, not 5 and 5.
const TWO_PAGE_NARROWER = 4;
const TWO_PAGE_WIDTH_TOLERANCE = 0.3;
// How close (screen px) a reported width must be to a page's height at the
// viewer's zoom to be that page turned a quarter.
const TURNED_WIDTH_TOLERANCE = 0.3;
// Chrome turns the view a quarter in one burst: a report of the new width
// where the view was, then, within this (ms), the top of the page it was
// on and its snapped report: 1 to 33 ms in Chrome for Testing 158 (D197),
// the later as more of the PDF was drawn.
const TURN_SNAP_MS = 50;
// And a page top is within this (screen px) of its inset.
const TURN_PAGE_TOP = 1;
// Chrome's viewer passes its zoom on to the tab only when it changed by more
// than 0.01 (its MIN_ZOOM_DELTA), so in a fit mode the tab's zoom, which the
// panel has, can be that far from the viewer's (a little more for rounding).
const MIN_ZOOM_DELTA = 0.0101;
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
// A page top this far (screen px) from a whole pixel is snapped by Chrome,
// which sends a second report (D196).
const SNAPPED_TOP = 0.01;
// The snapped report of a jump to the next page (ArrowRight) follows its
// first report within this time; a held key repeats more slowly (about every
// 30 ms). So does the second report of a jump to the place the report
// before it named (from a page's corner to another page's): later than this
// it is not told from a key pressed again where the viewer cannot move.
const SNAP_REPORT_MS = 20;
// A jump's second report is within this of its first, in the screen's own
// pixels: the snap to whole pixels moves it by about half a pixel at most,
// and scrolling by one or more. On a screen scaled by 2 a pixel of the
// screen is half a CSS pixel, and a slow scroll steps by that (D146).
const REPEATED_REPORT = 0.9;
// Within a movement, a report this far (screen px) from the one before it
// is a step, not a frame of scrolling that slows to a stop: the same place
// again at once is then a jump made while the viewer still scrolled.
const JUMP_STEP = 8;
// And "at once" is then within this time, under a frame at 60 Hz: the next
// frame of a movement that moved whole pages reports the same place too, on
// another page. Chrome 154's snapped report came 0.1 to 2.5 ms after the
// first; Chrome 138's, with the companion window and other work on the
// machine, 1.6 to 18.8 ms. 8 ms (D133) missed some; 12 catches most (D177),
// and takes a frame of a very fast movement on a screen of 90 Hz or more
// that repeats a place for a jump, which a capture then confirms.
// After a lone report that went somewhere else than the report before it,
// little but its own snapped report repeats its place, so there "at once"
// is the rest of the burst (`PDF_VIEWER_STREAM_GAP_MS`): a viewer slowed 8
// times sent it up to 31 ms late (55 ms on Chrome 138), and one showing
// 11,111 pages up to 40 ms (D146).
const SNAP_IN_MOVEMENT_MS = 12;
// A zoom sends two reports of one place. An outline entry or a link that
// sets a zoom and goes from a page's corner or top to another's sends this
// many or more, each naming one place too, as a zoom (D177): 4 or 6 where
// each of 74 plain zooms sent exactly 2.
const ZOOM_JUMP_REPORTS = 4;
// A held ArrowRight's report barely differs from the last (the snapping).
const HELD_PAGE_TOP_MOVE = 0.75;
// One animation frame.
const FRAME_MS = 1000 / 60;
// Two reports closer than this are of one frame, however far apart their
// places: Chrome 138 handed two frames of a wheel scroll over 0.3 ms apart,
// 10 px apart, which read as 10 px a millisecond and put the frames after
// it two pages on (D174). Reports of frames in turn are 8 ms or more apart
// even at 120 Hz.
const SAME_FRAME_MS = 4;
// Chrome snaps the scroll position to whole pixels: a sideways place this
// close (screen px) to the last is the same place, kept through a zoom.
const SAME_LEFT = 0.75;
// How close (screen px) a held movement must stop to the bottom of the PDF.
// Chrome rounds the PDF's height on screen up to a whole pixel: on a
// screen scaled by a whole number the viewer stopped within 0.5 px of the
// bottom worked out here (Chrome 154 and 138, D134). No wider there: every
// pixel allowed is a place in each page where a movement that stops there
// reads as the end of the PDF, and far zoomed out each turn of the wheel
// is such a movement.
const EDGE_TOLERANCE = 0.75;
// On a screen scaled by a fraction Chrome lays the viewer out in device
// pixels and reports whole CSS pixels: the viewer stopped up to 0.85 px
// from the bottom worked out at 125% to 250% and 0.9 to 1.85 px short of
// it at 133%, so End was not read there.
const SCALED_EDGE_TOLERANCE = 2;
// A scale this near a whole number is one.
const WHOLE_SCALE = 0.01;
const MAX_SPEED = 50; // viewer pixels per ms
// A held movement whose every step, read as the place nearest the one
// before, is shorter than this share of a page is read by its steps (D177):
// the wheel while Chrome does not animate scrolling. Every report fits a
// page within half a page of any place, so a longer step may have been any
// length.
const HELD_STEP_SHARE = 0.4;
// And whose reports came at least this far apart (ms), a frame and a half
// at 60 Hz: Chrome sends an animated movement's reports one a frame.
const HELD_STEP_GAP_MS = 1.5 * (1000 / 60);
// And whose steps differ in length by no more than this (screen px): a
// wheel's notches are of one length; the frames of an animated movement
// are not, which keeps out one that goes whole pages a frame and only looks
// like short steps.
const HELD_STEP_SAME_PX = 1.5;

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
  /** The last report held was a step away from the one before it. */
  stepped: boolean;
  /**
   * A place reached in one step came twice at once: a jump, wherever it
   * stopped (D133).
   */
  jump: boolean;
  /**
   * The movement read by its own steps (D177): each report as the place
   * nearest the one before, from where the hold began. `undefined` once a
   * step could not be read so (another zoom, no candidate).
   */
  steps: Candidate | undefined;
  /** The longest of those steps, as a share of the page it ended on. */
  longestStep: number;
  /** How many of those steps, and the shortest and longest in screen pixels. */
  stepRange: { count: number; min: number; max: number };
  /** The shortest time between two of the held reports, in ms. */
  shortestGap: number;
}

/** A lone report that is either a small scroll or a page key step. */
interface KeyStep {
  readonly key: Candidate;
  readonly scroll: Candidate;
  readonly viewport: PdfViewerViewport;
  /**
   * `key` is the top or the bottom of the PDF: Home or End where Chrome
   * does not animate scrolling, taken as a guess (D174).
   */
  readonly edge?: boolean;
}

/**
 * A reading that could be whole pages off (D133): the report says where a
 * page sits, and every page in `pages` fits it. The panel may find out
 * which page it is some other way and say so with `place`.
 */
export interface PdfViewerDoubt {
  /** The report as the tracker read it. */
  readonly viewport: PdfViewerViewport;
  /** The page (0-based) the tracker took the report to show. */
  readonly page: number;
  /** Every page the report fits, the tracker's own among them. */
  readonly pages: readonly number[];
  /** Counts the guesses: a later guess is another doubt. */
  readonly episode: number;
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
 * not followed, and so is a view turned a quarter (D123).
 *
 * A reading that could be whole pages off is a `doubt` (D133): the first
 * report, a report that came twice at once (a jump: the page box, an
 * outline entry, a link; also one made while the viewer still scrolled,
 * and one that sets a zoom), a lone report at a page top (ArrowRight, a
 * page key in fit to page), and what the viewer reports as a turned view
 * or the two-page view ends, however that is read. Scrolling is never one, however fast. A doubt stays
 * through the scrolling that follows, until the panel says which page it
 * was (`place`) or the viewer goes to the top or bottom of the PDF.
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
   * another page, or Home or End without animation (D174): a scroll sends
   * more frames at once, a key nothing more.
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
  /** Every distinct page height, in viewer pixels at 100%. */
  readonly #heights: readonly number[];
  /** The viewer's zoom as Chrome reports the tab's, when the panel knows it. */
  #viewerZoom: number | undefined;
  /** Whether the viewer shows its pages turned a quarter. */
  #turned = false;
  /**
   * The view was turned by a burst only a turn sends, or as the page box
   * said (D197), where a width can be a page upright and another turned (a
   * Letter PDF with a landscape page): it stays turned until such a burst,
   * a lone report of another width at a page top or the page box turns it
   * back, not by its width alone.
   */
  #turnedByBurst = false;
  /**
   * The view was turned or turned back by a burst, or by a lone report at a
   * page top of another width while turned so (D197): where every width is
   * a page upright and another turned, a burst can be missed (a turn from a
   * page top sends one report there, as a jump does), so the page box
   * decides. The page it names fits the report upright, or turned only.
   */
  #orientationLook = false;
  /**
   * A lone report of a new width that may start a turn's burst, with the
   * reports of its place that came at once after it (D197).
   */
  #turnPending: { readonly reports: { readonly viewport: PdfViewerViewport; readonly elapsed: number }[] } | undefined;
  /**
   * The width of a turn's burst that came before the zoom it changed (a fit
   * mode): the turn is taken when Chrome tells of that zoom (D197).
   */
  #burstWidth: number | undefined;
  /** The first report of what may be such a burst, read as before meanwhile. */
  #burstFirst: { readonly viewport: PdfViewerViewport; readonly before: Fix | undefined } | undefined;
  /**
   * Where the panel goes back to when the page box says the view is turned
   * after all: the place before the burst or the report of another width
   * that was read upright (D197).
   */
  #lookFrom: Fix | undefined;
  /**
   * The page top of such a burst read upright, and whether the reading was
   * a guess before it: a frame that moves on after it makes the burst a
   * scroll after all, which the page box need not settle (D197).
   */
  #signTop: { readonly viewport: PdfViewerViewport; readonly unsure: boolean } | undefined;
  /**
   * The last report Chrome told of a zoom after (D205): the panel's answer
   * to its own ask (`zoomUnfitted`), or a zoom change. A report that fits
   * no page upright even then is at the zoom held, give or take its lag.
   */
  #zoomToldAfter: PdfViewerViewport | undefined;
  /** The report such a look was taken for, which is not looked into again. */
  #laggedLooked: PdfViewerViewport | undefined;
  /** The latest report, read or not. */
  #lastReport: PdfViewerViewport | undefined;
  /** Whether the place could be whole pages off, and how many guesses there were. */
  #unsure = false;
  #episode = 0;
  /**
   * The view is followed again (upright, one page wide) and what it came
   * back with is still being read: a guess from where the place was, even
   * when it reads as the top or the bottom of the PDF. Chrome puts a view
   * turned back at the top of its page, which looks like either.
   */
  #returned = false;
  /**
   * The last report was read as a zoom or a resize at the same place.
   * Chrome reports a zoom twice at once, as it does a jump: the second
   * report is then no jump.
   */
  #zoomed = false;
  /**
   * The report read as a zoom, and how many reports of its burst have named
   * its place, it included: a jump that sets a zoom sends more than a zoom
   * does (D177).
   */
  #zoomBurst: { readonly viewport: PdfViewerViewport; count: number } | undefined;
  /**
   * Within how long (ms) the same place again makes the last report a
   * jump: a place reached in one step and reported again at once.
   * `undefined` when the last report was no step.
   */
  #snapWithin: number | undefined;
  /** How wide the viewer's scrollbars are, in screen px, once the tab has said. */
  #scrollbar: number | undefined;
  /** Whether the tab has said its screen is scaled by a fraction. */
  #scaledByFraction = false;
  /** The screen's device pixels per CSS pixel, once the tab has said; else 1. */
  #screenScale = 1;

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
    this.#heights = [...new Set(pages.map((page) => page.height))];
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

  /**
   * The viewer's zoom as the tab's (D104): 1 at 100%; in a fit mode it can
   * lag the viewer's by up to 0.01. With it a view turned a quarter shows,
   * because the page's width on screen is then one of the PDF's page
   * heights at that zoom and none of its widths (D123). Chrome tells the
   * panel of a zoom apart from the viewer's reports, so when the zoom
   * changes the latest report is looked at again, unless it was an upright
   * report of the zoom before.
   */
  setViewerZoom(zoom: number | undefined): void {
    const before = this.#viewerZoom;
    this.#viewerZoom = zoom !== undefined && zoom >= MIN_ZOOM && zoom <= MAX_ZOOM
      ? zoom
      : undefined;
    const report = this.#lastReport;
    if (this.#viewerZoom !== undefined) this.#zoomToldAfter = report;
    if (!report || this.#viewerZoom === before) return;
    // A turn's burst came before this zoom (D197): taken where the width
    // cannot tell, now that it is told.
    const zoomNow = this.#viewerZoom;
    if (
      this.#burstWidth !== undefined &&
      zoomNow !== undefined &&
      Math.abs(report.pageWidth - this.#burstWidth) < 0.01 &&
      (!this.#turned || this.#turnedByBurst) &&
      this.#upright(report, zoomNow) &&
      this.#fitsSomeTurned(report, zoomNow)
    ) {
      this.#turnNow();
      if (this.#turned) this.#orientationLook = true;
      return;
    }
    this.#burstWidth = undefined;
    // An upright report that fitted the zoom it came at belongs to that
    // zoom, and the report of the new zoom is on its way. Read at the new
    // zoom it could pass for a turn: a slide 960 by 720 is as wide at 75%
    // as it is tall at 100%.
    if (
      !this.#turned &&
      before !== undefined &&
      this.#fitsLength(report, this.#widths, before)
    ) return;
    this.#quarterTurned(report);
  }

  /**
   * How wide the tab draws a scrollbar, in screen px, which is how wide the
   * viewer's are (D134); 0 where scrollbars lie over the page. The viewer
   * reports its viewport with its scrollbars: a PDF wider than the view
   * has one across the bottom, and the viewer scrolls down only as far as
   * that leaves. Until it is told (`undefined`: the tab could not tell),
   * the tracker allows for one of 15 px or none.
   */
  setScrollbarWidth(width: number | undefined): void {
    this.#scrollbar = width !== undefined && width >= 0 && width <= MAX_SCROLLBAR_WIDTH
      ? width
      : undefined;
  }

  /**
   * The screen's device pixels per CSS pixel in the tab (D134): 1.25 on a
   * screen scaled by 125%. On a screen scaled by a fraction the bottom of
   * the PDF is taken within 2 px, not 0.75: Chrome's own rounding moves it
   * that far there. And two reports are of one place when they are under a
   * pixel of the screen apart, which is less than a CSS pixel on a scaled
   * screen (D146). `undefined` (the tab could not tell) is a scale of 1.
   */
  setScreenScale(scale: number | undefined): void {
    const known = scale !== undefined && Number.isFinite(scale) && scale > 0;
    this.#screenScale = known ? scale : 1;
    this.#scaledByFraction = known && Math.abs(scale - Math.round(scale)) > WHOLE_SCALE;
  }

  /**
   * The reading the tracker is unsure of, while the viewer is still;
   * `undefined` when the place is known, or when the viewer has sent a
   * report since that is not read yet (a movement or a key step held) or
   * never will be (a view that is not followed). A view turned by a burst
   * is doubted too, for the page box to tell which way it stands (D197).
   *
   * `pages` are the pages as wide as the report says at the viewer's zoom,
   * which is the tab's give or take its lag (`MIN_ZOOM_DELTA`): no tighter,
   * or a page a little wider or narrower than its neighbours would pass
   * for the only one that fits after a small resize in a fit mode. None
   * fits while Chrome has not told of a zoom yet: then there is no doubt to
   * look into until it has (`zoomUnfitted` says so). Without the tab's zoom
   * they are the pages as wide as the page guessed. With them come the
   * pages as tall as the report is wide and no page fits upright: the page
   * box naming one says the view is turned (D197).
   */
  get doubt(): PdfViewerDoubt | undefined {
    const fix = this.#fix;
    const last = this.#lastReport;
    const zoomHeld = this.#viewerZoom;
    const lagged = this.#laggedTurnPages();
    if (lagged.length > 0) {
      // A view turned while the tab's zoom lags the viewer's (D205): the page
      // box tells.
      return { viewport: last!, page: fix?.page ?? 0, pages: lagged, episode: this.#episode };
    }
    if (this.#turned && this.#orientationLook && last && zoomHeld !== undefined && this.#turnPending === undefined) {
      // Which way the view stands, which the page box tells (D197).
      const pages = this.#pages.flatMap((size, page) =>
        this.#fitsUpright(last, size.width, zoomHeld) || this.#fitsTurned(last, size.height, zoomHeld) ? [page] : []);
      return pages.length > 0
        ? { viewport: last, page: fix?.page ?? 0, pages, episode: this.#episode }
        : undefined;
    }
    if (
      !this.#unsure ||
      !fix ||
      fix.viewport !== this.#lastReport ||
      this.#turnPending !== undefined ||
      this.#turned ||
      this.#twoPageZoom !== undefined
    ) return undefined;
    const all = this.#candidates(fix.viewport);
    const zoom = this.#viewerZoom;
    const fitting = zoom === undefined
      ? all.filter((candidate) => Math.abs(candidate.zoom / fix.zoom - 1) <= SAME_ZOOM)
      : all.filter((candidate) => {
          const width = this.#pages[candidate.page]!.width;
          return Math.abs(fix.viewport.pageWidth - width * zoom) <=
            MIN_ZOOM_DELTA * width + TURNED_WIDTH_TOLERANCE;
        });
    if (fitting.length === 0) return undefined;
    // And the pages it fits turned, where a page's height is another's
    // width: the page box naming one says the view is turned (D197).
    const turnedPages = zoom === undefined
      ? []
      : this.#pages.flatMap((size, page) =>
          this.#fitsTurned(fix.viewport, size.height, zoom) && !this.#fitsUpright(fix.viewport, size.width, zoom)
            ? [page]
            : []);
    return {
      viewport: fix.viewport,
      page: fix.page,
      pages: [...fitting.map((candidate) => candidate.page), ...turnedPages],
      episode: this.#episode,
    };
  }

  /**
   * The pages the latest report could be turned, where D123 cannot say: in
   * a fit mode just after a small resize the tab's zoom lags the viewer's
   * by up to 0.01 (`MIN_ZOOM_DELTA`), so a turned width is a page's height
   * only within that lag, too loose to take a turn by. Only for a report
   * that fits no page upright even after Chrome was asked for the zoom
   * (D205); none while turned or unasked.
   */
  #laggedTurnPages(): number[] {
    const last = this.#lastReport;
    const zoom = this.#viewerZoom;
    if (
      this.#turned || !last || zoom === undefined || this.#zoomToldAfter !== last ||
      this.#twoPageZoom !== undefined ||
      this.#turnPending !== undefined || this.#upright(last, zoom) || this.#laggedLooked === last
    ) return [];
    return this.#pages.flatMap((size, page) =>
      Math.abs(last.pageWidth - size.height * zoom) <= MIN_ZOOM_DELTA * size.height + TURNED_WIDTH_TOLERANCE
        ? [page]
        : []);
  }

  #fitsUpright(viewport: PdfViewerViewport, width: number, zoom: number): boolean {
    return Math.abs(viewport.pageWidth - width * zoom) <= MIN_ZOOM_DELTA * width + TURNED_WIDTH_TOLERANCE;
  }

  /**
   * Whether the report is a page of `height` turned, give or take the tab's
   * lag as for an upright page (D205): in a fit mode just after a small
   * resize the tab's zoom lags the viewer's, and where turning leaves the
   * zoom as it was (pages of both shapes, fitted to the widest) Chrome
   * tells of no new one. The page box, or a turn's burst, decides; D123's
   * own rule keeps its 0.3 px.
   */
  #fitsTurned(viewport: PdfViewerViewport, height: number, zoom: number): boolean {
    return Math.abs(viewport.pageWidth - height * zoom) <= MIN_ZOOM_DELTA * height + TURNED_WIDTH_TOLERANCE;
  }

  /** Whether the report is some page turned, give or take the lag (D205). */
  #fitsSomeTurned(viewport: PdfViewerViewport, zoom: number): boolean {
    return this.#heights.some((height) => this.#fitsTurned(viewport, height, zoom));
  }

  /**
   * Whether the latest report fits no page at the zoom the panel was told,
   * upright and give or take the zoom's lag (D146). The viewer is then at
   * a zoom the panel has not heard of, or shows its pages turned. While
   * that lasts a guess has no pages to look into, and a zoom can pass for a
   * turn; Chrome tells of a zoom apart from the viewer's reports, so the
   * panel may ask Chrome for the tab's zoom itself. `false` while the panel
   * knows no zoom.
   */
  get zoomUnfitted(): boolean {
    const report = this.#lastReport;
    const zoom = this.#viewerZoom;
    return report !== undefined && zoom !== undefined && !this.#upright(report, zoom);
  }

  /**
   * Whether the panel knows the viewer's zoom. Without it a view turned a
   * quarter cannot be told from an upright one (D123), so a doubted report
   * must not be looked into: a turned view is captured only to tell which
   * way it stands (D197).
   */
  get zoomKnown(): boolean {
    return this.#viewerZoom !== undefined;
  }

  /**
   * Takes `page` (0-based) as the page the doubted report shows. Returns
   * the new place when that moves it; `undefined` when the place was right
   * already, when the viewer has reported since (the doubt stays; a report
   * held or not read counts, so a view that is not followed is not
   * placed), or when the page does not fit the report.
   */
  place(doubt: PdfViewerDoubt, page: number): PdfReadingPosition | undefined {
    const size = this.#pages[page];
    const zoom = this.#viewerZoom;
    if (this.#lastReport !== doubt.viewport || !size || zoom === undefined && this.#turned) return undefined;
    if (this.#laggedTurnPages().length > 0) {
      // Turned while the tab's zoom lags (D205): the page named is as wide
      // as the report turned and not upright. The place read since the
      // width changed was none; the panel goes back to the place before.
      this.#laggedLooked = doubt.viewport;
      if (!doubt.pages.includes(page)) return undefined;
      this.#turned = true;
      this.#hold = undefined;
      this.#keyStep = undefined;
      this.#keyUndo = undefined;
      const from = this.#lookFrom;
      if (!from) return undefined;
      this.#setFix(from);
      this.#jumpFrom = undefined;
      this.#position = this.#readingPosition(from.y);
      return this.#position;
    }
    if (this.#turned) {
      // Which way the view stands (D197): upright if the page fits the
      // report upright, and read from there; turned if only turned.
      if (!this.#orientationLook || !doubt.pages.includes(page)) return undefined;
      this.#orientationLook = false;
      if (!this.#fitsUpright(doubt.viewport, size.width, zoom!) || this.#fitsTurned(doubt.viewport, size.height, zoom!)) {
        return undefined;
      }
      this.#turned = false;
      this.#turnedByBurst = false;
      this.#guess();
      this.#returned = true;
      const before = this.#position;
      this.#take(doubt.viewport, Number.POSITIVE_INFINITY);
      this.settle();
      const upright = this.doubt;
      const placed = upright?.pages.includes(page) ? this.place(upright, page) : undefined;
      return placed ?? (this.#position !== before ? this.#position : undefined);
    }
    const fix = this.#fix;
    if (!fix || fix.viewport !== doubt.viewport) return undefined;
    if (
      zoom !== undefined &&
      doubt.pages.includes(page) &&
      this.#fitsTurned(doubt.viewport, size.height, zoom) &&
      !this.#fitsUpright(doubt.viewport, size.width, zoom)
    ) {
      // The page box names a page the report fits only turned: a turn the
      // tracker missed, from a page top (D197), or a wrong turn back. The
      // place read since was none; the panel goes back to the place before.
      this.#unsure = false;
      const from = this.#lookFrom;
      this.#turnNow();
      if (!from) return undefined;
      this.#setFix(from);
      this.#jumpFrom = undefined;
      this.#position = this.#readingPosition(from.y);
      return this.#position;
    }
    const candidate = doubt.pages.includes(page)
      ? this.#candidates(fix.viewport).find((entry) => entry.page === page)
      : undefined;
    if (!candidate) return undefined;
    this.#unsure = false;
    if (candidate.page === fix.page) return undefined;
    this.#setFix({
      page: candidate.page,
      y: candidate.y,
      zoom: candidate.zoom,
      viewport: fix.viewport,
    });
    // What was read before belongs to the place that was wrong.
    this.#speed = 0;
    this.#lastStep = 0;
    this.#jumpFrom = undefined;
    this.#jumpInstead = false;
    this.#keyUndo = undefined;
    this.#lastPageKey = false;
    this.#position = this.#readingPosition(candidate.y);
    return this.#position;
  }

  update(viewport: PdfViewerViewport, time: number): PdfViewerTrack {
    if (this.#pages.length === 0) return { kind: 'same' };
    const elapsed = this.#lastTime === undefined || !Number.isFinite(time)
      ? Number.POSITIVE_INFINITY
      : time - this.#lastTime;
    this.#lastTime = time;
    if (
      this.#burstWidth !== undefined &&
      Math.abs(viewport.pageWidth - this.#burstWidth) >= 0.01
    ) this.#burstWidth = undefined;
    // A quarter turn's burst (D197): the report of the new width where the
    // view was, maybe that place again, then within `TURN_SNAP_MS` the top
    // of the page it was on. The first is held until that top comes, and
    // read as before if it does not.
    const pending = this.#turnPending;
    this.#turnPending = undefined;
    if (pending) {
      // The held burst is this rule's own.
      this.#burstFirst = undefined;
      const first = pending.reports[0]!.viewport;
      const burst = elapsed >= 0 && elapsed <= TURN_SNAP_MS &&
        Math.abs(viewport.pageWidth - first.pageWidth) < 0.01;
      if (burst && this.#atTurnPageTop(viewport)) return this.#turnByBurst(viewport, pending.reports[0]!.elapsed);
      if (
        burst &&
        Math.max(Math.abs(viewport.pageY - first.pageY), Math.abs(viewport.pageX - first.pageX)) < this.#samePlace()
      ) {
        this.#turnPending = { reports: [...pending.reports, { viewport, elapsed }] };
        return { kind: 'hold', wait: PDF_VIEWER_SETTLE_MS };
      }
      return this.#takeAll([...pending.reports, { viewport, elapsed }]);
    }
    const zoomHeld = this.#viewerZoom;
    const previous = this.#lastReport;
    const widthChanged = previous !== undefined &&
      Math.abs(viewport.pageWidth - previous.pageWidth) > TURNED_WIDTH_TOLERANCE;
    if (widthChanged) this.#lookFrom = this.#fix;
    // Turned by a burst, a lone report of another width is a turn back (or
    // on, from a page top, which sends one report there), or a page of the
    // other shape: read upright, a guess the page box settles (D197).
    if (
      this.#turned && this.#turnedByBurst && zoomHeld !== undefined && widthChanged &&
      elapsed > PDF_VIEWER_STREAM_GAP_MS &&
      this.#upright(viewport, zoomHeld)
    ) {
      this.#turnNow();
      return this.#take(viewport, elapsed);
    }
    // A lone report off a page top, maybe that place again, then within the
    // burst a page top elsewhere: what a turn sends, whatever the widths
    // (the page most in view may change with the turn), and little else
    // (D197). Where the page box can tell, it looks.
    const sign = this.#signTop;
    this.#signTop = undefined;
    if (
      sign && elapsed >= 0 && elapsed <= TURN_SNAP_MS &&
      Math.max(Math.abs(viewport.pageY - sign.viewport.pageY), Math.abs(viewport.pageX - sign.viewport.pageX)) >=
        this.#samePlace()
    ) {
      this.#unsure = sign.unsure;
      this.#lookFrom = undefined;
    } else if (sign && elapsed >= 0 && elapsed <= TURN_SNAP_MS) {
      this.#signTop = sign;
    }
    const first = this.#burstFirst;
    this.#burstFirst = undefined;
    if (first && zoomHeld !== undefined && elapsed >= 0 && elapsed <= TURN_SNAP_MS) {
      const moved = Math.max(
        Math.abs(viewport.pageY - first.viewport.pageY),
        Math.abs(viewport.pageX - first.viewport.pageX),
      );
      const sameWidth = Math.abs(viewport.pageWidth - first.viewport.pageWidth) <= TURNED_WIDTH_TOLERANCE;
      if (this.#atTurnPageTop(viewport) && (moved >= this.#samePlace() || !sameWidth)) {
        const turnTrack = this.#turnSign(viewport, elapsed, first.before, zoomHeld);
        if (turnTrack) return turnTrack;
      } else if (sameWidth && moved < this.#samePlace()) {
        this.#burstFirst = first;
      }
    } else if (
      zoomHeld !== undefined &&
      elapsed > PDF_VIEWER_STREAM_GAP_MS &&
      !this.#atTurnPageTop(viewport)
    ) {
      this.#burstFirst = { viewport, before: this.#fix };
    }
    if (this.#startsTurn(viewport, elapsed)) {
      this.#turnPending = { reports: [{ viewport, elapsed }] };
      return { kind: 'hold', wait: PDF_VIEWER_SETTLE_MS };
    }
    return this.#take(viewport, elapsed);
  }

  /**
   * A page top came as a turn sends it (D197). Turned by a burst, the view
   * is read upright; upright, the top is read; either way where the top
   * is a page upright and another turned, a guess the page box settles,
   * from the place before the burst. A width that fits no page at the zoom
   * held waits for the zoom Chrome tells of (`setViewerZoom`).
   */
  #turnSign(
    top: PdfViewerViewport,
    elapsed: number,
    before: Fix | undefined,
    zoom: number,
  ): PdfViewerTrack | undefined {
    const upright = this.#upright(top, zoom);
    if (!upright && !this.#fitsSomeTurned(top, zoom)) {
      this.#burstWidth = top.pageWidth;
      this.#lookFrom = before;
      return undefined;
    }
    if (!upright || !this.#fitsSomeTurned(top, zoom)) return undefined;
    if (this.#turned) {
      if (!this.#turnedByBurst) return undefined;
      this.#turnNow();
      this.#lookFrom = before;
      return this.#take(top, elapsed);
    }
    const track = this.#take(top, elapsed);
    if (this.#turned) return track;
    this.#signTop = { viewport: top, unsure: this.#unsure };
    this.#guess();
    this.#lookFrom = before;
    return track;
  }

  /** Reads reports in turn; a move any of them made is the result. */
  #takeAll(reports: readonly { readonly viewport: PdfViewerViewport; readonly elapsed: number }[]): PdfViewerTrack {
    const before = this.#position;
    let track: PdfViewerTrack = { kind: 'same' };
    for (const report of reports) track = this.#take(report.viewport, report.elapsed);
    if (track.kind === 'same' && this.#position !== before && this.#position) {
      return { kind: 'move', position: this.#position };
    }
    return track;
  }

  /**
   * Whether a report may be the first of a quarter turn's burst (D197): lone,
   * of another width than the report before, not at a page top, and the
   * view upright (turned by a burst, any such report is read upright). At the
   * viewer's zoom its width is one a page has both upright and turned,
   * which the width alone cannot tell (D123 tells the rest): it is held.
   */
  #startsTurn(viewport: PdfViewerViewport, elapsed: number): boolean {
    const zoom = this.#viewerZoom;
    const before = this.#lastReport;
    if (
      zoom === undefined ||
      !before ||
      elapsed <= PDF_VIEWER_STREAM_GAP_MS ||
      Math.abs(viewport.pageWidth - before.pageWidth) <= TURNED_WIDTH_TOLERANCE ||
      this.#atTurnPageTop(viewport)
    ) return false;
    if (this.#turned) return false;
    return this.#upright(viewport, zoom) && this.#fitsSomeTurned(viewport, zoom);
  }

  #atTurnPageTop(viewport: PdfViewerViewport): boolean {
    const zoom = this.#viewerZoom;
    return zoom !== undefined && Math.abs(viewport.pageY - INSET_TOP * zoom) <= TURN_PAGE_TOP;
  }

  /**
   * A turn's burst came where the width cannot tell (D197): the view is
   * turned a quarter, or back.
   */
  #turnByBurst(top: PdfViewerViewport, elapsed: number): PdfViewerTrack {
    this.#turnNow();
    if (this.#turned) this.#orientationLook = true;
    this.#lastReport = top;
    if (this.#turned) return { kind: 'same' };
    // Upright again: the page top is read as the first report of the view,
    // a guess, as after D123's turn back.
    return this.#take(top, elapsed);
  }

  #turnNow(): void {
    this.#hold = undefined;
    this.#keyStep = undefined;
    this.#keyUndo = undefined;
    this.#burstWidth = undefined;
    if (this.#turned) {
      // Upright again; the place is guessed from where it was.
      this.#turned = false;
      this.#turnedByBurst = false;
      this.#orientationLook = false;
      this.#guess();
      this.#returned = true;
      return;
    }
    this.#turned = true;
    this.#turnedByBurst = true;
  }

  #take(viewport: PdfViewerViewport, elapsed: number): PdfViewerTrack {
    // A new movement, with all that the view came back with read (a report
    // held or not read is not).
    if (
      !(elapsed >= 0 && elapsed <= PDF_VIEWER_STREAM_GAP_MS) &&
      this.#fix?.viewport === this.#lastReport
    ) this.#returned = false;
    const reportBefore = this.#lastReport;
    this.#lastReport = viewport;
    // A view turned a quarter has other page positions: not followed.
    if (this.#quarterTurned(viewport)) return { kind: 'same' };
    // The two-page view puts pages beside each other: not followed.
    if (this.#twoPageView(viewport) || this.#beside(viewport)) return { kind: 'same' };
    const lone = !(elapsed >= 0 && elapsed <= PDF_VIEWER_STREAM_GAP_MS);
    const previousLone = this.#previousLone;
    this.#previousLone = lone;
    const zoomed = this.#zoomed;
    this.#zoomed = false;
    const snapWithin = this.#snapWithin;
    this.#snapWithin = this.#stepAllowance(viewport, reportBefore, lone, zoomed);
    const before = this.#position;
    const keyUndo = this.#keyUndo;
    this.#keyUndo = undefined;
    if (keyUndo && !lone) this.#accept(keyUndo.scroll, keyUndo.viewport, 0);
    if (this.#hold) {
      const within = this.#hold.frames > 1 ? PDF_VIEWER_MOVEMENT_SETTLE_MS : PDF_VIEWER_STREAM_GAP_MS;
      if (elapsed >= 0 && elapsed <= within) {
        const hold = this.#hold;
        const movedY = Math.abs(viewport.pageY - hold.last.pageY);
        const movedX = Math.abs(viewport.pageX - hold.last.pageX);
        // A jump is a place reached in one step and reported again at
        // once, alone or while the viewer still scrolled (an outline entry
        // clicked during a fling): after a lone report anywhere in its
        // burst, within a movement in half a frame. The last frames of a
        // movement that slows to a stop come as close together, each a
        // small step on from the one before, and are none; nor is a frame
        // that moved whole pages.
        if (
          hold.stepped &&
          (hold.frames === 1 || elapsed <= SNAP_IN_MOVEMENT_MS) &&
          Math.max(movedY, movedX) < this.#samePlace()
        ) hold.jump = true;
        hold.stepped = movedY > JUMP_STEP || movedX > JUMP_STEP;
        hold.last = viewport;
        hold.frames += 1;
        hold.shortestGap = Math.min(hold.shortestGap, elapsed);
        this.#stepHold(hold, sameZoomCandidates(this.#candidates(viewport), hold.from, viewport));
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
      const key = lone ||
        (!keyStep.edge && this.#lastPageKey && this.#repeatsKey(keyStep, viewport, elapsed));
      if (key && keyStep.edge) this.#guess();
      this.#accept(key ? keyStep.key : keyStep.scroll, keyStep.viewport, 0);
    }
    const track = this.#read(viewport, elapsed, lone, previousLone, zoomed, snapWithin);
    this.#countZoomReports(viewport, lone);
    // A held movement or key read just now moved the place even when this
    // report did not.
    if (track.kind === 'same' && this.#position !== before && this.#position) {
      return { kind: 'move', position: this.#position };
    }
    return track;
  }

  /**
   * Counts the reports of a burst that name the place of the one read as a
   * zoom; at `ZOOM_JUMP_REPORTS` the place is a guess: an outline entry or
   * link that set a zoom and went from a page's corner or top to another's
   * (D177). A report elsewhere, or a new burst, ends the count.
   */
  #countZoomReports(viewport: PdfViewerViewport, lone: boolean): void {
    const burst = this.#zoomBurst;
    if (this.#zoomed) {
      this.#zoomBurst = { viewport, count: 1 };
      return;
    }
    if (
      !burst ||
      lone ||
      viewport.pageWidth !== burst.viewport.pageWidth ||
      Math.max(
        Math.abs(viewport.pageY - burst.viewport.pageY),
        Math.abs(viewport.pageX - burst.viewport.pageX),
      ) >= this.#samePlace()
    ) {
      this.#zoomBurst = undefined;
      return;
    }
    burst.count += 1;
    if (burst.count === ZOOM_JUMP_REPORTS) this.#guess();
  }

  #read(
    viewport: PdfViewerViewport,
    elapsed: number,
    lone: boolean,
    previousLone: boolean,
    zoomed: boolean,
    snapWithin: number | undefined,
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
      // The viewer may have been scrolled before the panel opened.
      this.#guess();
      return this.#accept(nearest(alike.length > 0 ? alike : all, this.#anchorY), viewport, 0);
    }

    const sameZoom = sameZoomCandidates(all, fix, viewport);
    const candidates = sameZoom.length > 0 ? sameZoom : all;
    // A jump (the page box, an outline entry, a link, a thumbnail) reports
    // twice at once: its place, then that place snapped to whole pixels.
    // Scrolling never repeats a place. Wherever the first report was read
    // to be, the page could be any (D133). A zoom reports twice too, and
    // keeps its page. The first report is a place reached in one step: a
    // lone report, a step within a movement the tracker follows (a jump
    // made while the viewer still scrolled), or a place other than the
    // zoom's straight after a zoom (an outline entry that sets a zoom).
    if (
      !zoomed &&
      snapWithin !== undefined &&
      elapsed <= snapWithin &&
      sameZoom.length > 0 &&
      Math.max(
        Math.abs(viewport.pageY - fix.viewport.pageY),
        Math.abs(viewport.pageX - fix.viewport.pageX),
      ) < this.#samePlace()
    ) this.#guess();
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
      if (jump) {
        // ArrowRight, or the page box, an outline entry or a link.
        this.#guess();
        return this.#accept(jump, viewport, 0);
      }
    }

    if (lone && sameZoom.length > 0) {
      const exact = this.#readLone(candidates, fix, viewport);
      if (exact) return this.#accept(exact, viewport, 0);
      // A page key step to another page than the nearest reading: a
      // scroll sends more frames at once, a key nothing more.
      const scroll = nearest(candidates, fix.y);
      const key = this.#pageKeyStep(candidates, fix, viewport);
      // A page key's place that fits the top or the bottom of the PDF too
      // may be Home or End, one report each where Chrome does not animate
      // scrolling: a guess that a look settles (D177; the bottom fitted a
      // page key's step from the place before in 3 of 4 runs of End at a
      // default zoom of 120%).
      const keyOrEdge = key ? this.#atEdge(candidates, viewport) : undefined;
      if (key && keyOrEdge && keyOrEdge !== key) this.#guess();
      if (key && key !== scroll) {
        this.#keyStep = { key, scroll, viewport };
        return { kind: 'hold', wait: PDF_VIEWER_SETTLE_MS };
      }
      if (key) return this.#accept(key, viewport, 0);
      const far = Math.abs(scroll.y - fix.y) * scroll.zoom > LARGE_MOVE;
      // Exactly at the top or the bottom of the PDF: Home or End where
      // Chrome does not animate scrolling, one report each, or a scroll
      // whose place fits the end too. A scroll sends more frames at once,
      // Home and End nothing more (D174). Far from the last place it is
      // held below, and read at the end the same way.
      const edge = far ? undefined : this.#atEdge(candidates, viewport);
      if (edge && edge !== scroll) {
        this.#keyStep = { key: edge, scroll, viewport, edge: true };
        return { kind: 'hold', wait: PDF_VIEWER_SETTLE_MS };
      }
      if (far) {
        this.#hold = {
          from: fix,
          speed: 0,
          last: viewport,
          frames: 1,
          stepped: true,
          jump: false,
          steps: { page: fix.page, zoom: fix.zoom, y: fix.y },
          longestStep: 0,
          stepRange: { count: 0, min: Number.POSITIVE_INFINITY, max: 0 },
          shortestGap: Number.POSITIVE_INFINITY,
        };
        this.#stepHold(this.#hold, candidates);
        return { kind: 'hold', wait: PDF_VIEWER_SETTLE_MS };
      }
    }

    if (!lone && sameZoom.length > 0 && elapsed > SNAP_REPORT_MS) {
      const held = this.#readHeldKey(candidates, fix, viewport);
      if (held) return this.#accept(held, viewport, 0);
    }

    // A movement's second frame has no speed yet: its first frame's step,
    // one frame on, is the other guess (a wheel turn starts at full speed).
    // Only up to two frames on, as on a slow machine: a report later than
    // that is a step of its own (the wheel where Chrome does not animate
    // scrolling), whose length the time does not tell, and is held and read
    // by its steps (D177).
    const predictions = lone ? [fix.y] : [fix.y + this.#speed * elapsed];
    if (!lone && previousLone && elapsed < 2.5 * FRAME_MS) {
      predictions.push(fix.y + (this.#lastStep * elapsed) / FRAME_MS);
    }
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
        this.#zoomed = true;
        return { kind: 'same' };
      }
      // Two reports a fraction of a millisecond apart are one frame's
      // step, not a speed (D174).
      const speed = lone
        ? 0
        : (best.y - fix.y) / (elapsed < SAME_FRAME_MS ? FRAME_MS : Math.max(1, elapsed));
      return this.#accept(best, viewport, clamp(speed, -MAX_SPEED, MAX_SPEED));
    }
    // A lone report somewhere else: nearest is the best reading. A jump
    // (page box, outline, link, find) reports again at once and is doubted
    // then; a single step of the wheel does not, and is not.
    if (lone) return this.#accept(best, viewport, 0);
    // A movement's second frame has only its first frame's step for speed.
    const speed = previousLone ? this.#lastStep / FRAME_MS : this.#speed;
    this.#hold = {
      from: fix,
      speed: clamp(speed, -MAX_SPEED, MAX_SPEED),
      last: viewport,
      frames: 2,
      stepped: Math.abs(viewport.pageY - fix.viewport.pageY) > JUMP_STEP ||
        Math.abs(viewport.pageX - fix.viewport.pageX) > JUMP_STEP,
      jump: false,
      steps: { page: fix.page, zoom: fix.zoom, y: fix.y },
      longestStep: 0,
      stepRange: { count: 0, min: Number.POSITIVE_INFINITY, max: 0 },
      shortestGap: elapsed,
    };
    this.#stepHold(this.#hold, sameZoom);
    return { kind: 'hold', wait: PDF_VIEWER_MOVEMENT_SETTLE_MS };
  }

  /**
   * Within how long (ms) the same place again would make `viewport` a jump;
   * `undefined` when it is no step. A lone report somewhere else than the
   * report before it is a step whatever follows in its burst; one where
   * the report before it was is a step for `SNAP_REPORT_MS` only (a key
   * the viewer cannot follow, a step of whole pages: D146, after the
   * review). Within a burst a report is a step when it is more than
   * `JUMP_STEP` from the one before it, or, straight after a report read
   * as a zoom at the same place, anywhere else than that report: a zoom's
   * own second report repeats its place, and nothing was scrolling.
   */
  #stepAllowance(
    viewport: PdfViewerViewport,
    before: PdfViewerViewport | undefined,
    lone: boolean,
    zoomed: boolean,
  ): number | undefined {
    // The first report is a guess as it is.
    if (!before) return undefined;
    const moved = Math.max(
      Math.abs(viewport.pageY - before.pageY),
      Math.abs(viewport.pageX - before.pageX),
    );
    if (lone) {
      // Where the report before it was already, the viewer did not move, or
      // moved by whole pages: Chrome reports every arrow, Page Down and
      // Space press, also where the viewer cannot go on (the end of the
      // PDF, the far side of a wide page), and a held key says the same
      // place again about every 30 ms. There the place again is a jump only
      // within the 20 ms of D133, sooner than a key repeats.
      return moved < this.#samePlace() ? SNAP_REPORT_MS : PDF_VIEWER_STREAM_GAP_MS;
    }
    return (zoomed ? moved >= this.#samePlace() : moved > JUMP_STEP)
      ? SNAP_IN_MOVEMENT_MS
      : undefined;
  }

  /**
   * How far apart (CSS px) two reports of one place can be: under a pixel
   * of the screen. A jump's second report is its first snapped to a whole
   * pixel of the screen (0.52 of one at most, at scales of 1 to 2), and
   * scrolling moves by one or more: half a CSS pixel on a screen scaled by
   * 2, where 0.9 CSS px took the first frames of a slow scroll for a jump.
   */
  #samePlace(): number {
    return REPEATED_REPORT / Math.max(1, this.#screenScale);
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
    const viewerZoom = this.#viewerZoom;
    if (twoPageZoom !== undefined) {
      // In a fit mode Chrome changes the zoom with the view (two pages fit
      // the width at half the zoom): the viewer's zoom tells the way back.
      if (fits(twoPageZoom, 0) || (viewerZoom !== undefined && fits(viewerZoom, 0))) {
        // One page wide again; the place is guessed from where it was.
        this.#twoPageZoom = undefined;
        this.#guess();
        this.#returned = true;
        return false;
      }
      // Zoomed while two pages wide: still two pages wide.
      if (!fits(twoPageZoom, TWO_PAGE_NARROWER)) {
        this.#twoPageZoom = viewport.pageWidth / (this.#usualWidth - TWO_PAGE_NARROWER);
      }
      return true;
    }
    const fix = this.#fix;
    if (!fix) return false;
    // The last place's zoom and, when the panel knows it, the viewer's
    // (D123). A report one page wide at either is not the two-page view:
    // in a fit mode a turn's report read as a zoom can leave the last place
    // at a zoom where a page turned back looks 4 px narrower (US Legal in
    // fit to width), and the tab's zoom can lag the viewer's by 0.01.
    const zooms = viewerZoom === undefined ? [fix.zoom] : [fix.zoom, viewerZoom];
    const zoom = zooms.find((candidate) => fits(candidate, TWO_PAGE_NARROWER));
    if (
      Math.abs(fix.viewport.viewportWidth - viewport.viewportWidth) >= 0.5 ||
      Math.abs(fix.viewport.viewportHeight - viewport.viewportHeight) >= 0.5 ||
      zooms.some((candidate) => fits(candidate, 0)) ||
      zoom === undefined
    ) return false;
    this.#twoPageZoom = zoom;
    this.#hold = undefined;
    this.#keyStep = undefined;
    return true;
  }

  /**
   * Whether the viewer shows its pages turned a quarter (Ctrl+[ and Ctrl+],
   * the toolbar's rotate button): the page reported is then as wide as one
   * of the PDF's pages is tall, at the viewer's zoom, and as wide as none.
   * Chrome keeps the zoom through a turn at a set zoom and changes it in
   * its fit modes, so the report's own numbers do not tell; the tab's zoom
   * does. Noticed only while the panel knows that zoom, until a report is
   * upright again. A width within the tab zoom's lag of a page width is
   * upright: a missed turn is followed as before D123, a false one would
   * stop following. So a PDF with a page about as wide as another is tall
   * (within 1%, as portrait and landscape pages of one size) is not
   * noticed.
   */
  #quarterTurned(viewport: PdfViewerViewport): boolean {
    const zoom = this.#viewerZoom;
    if (zoom === undefined) return this.#turned;
    const upright = this.#upright(viewport, zoom);
    if (this.#turned) {
      // A width that fits nothing is a zoom Chrome has not told of yet.
      if (!upright) return true;
      // Turned by a burst: upright only by the burst back, unless no page
      // turned could be this wide (D197).
      if (this.#turnedByBurst && this.#fitsSomeTurned(viewport, zoom)) return true;
      this.#turnedByBurst = false;
      // Upright again; the place is guessed from where it was.
      this.#turned = false;
      this.#guess();
      this.#returned = true;
      return false;
    }
    if (upright || !this.#fitsLength(viewport, this.#heights, zoom)) return false;
    this.#turned = true;
    this.#hold = undefined;
    this.#keyStep = undefined;
    this.#keyUndo = undefined;
    return true;
  }

  /** Whether the reported page is as wide on screen as one of `lengths` at `zoom`. */
  #fitsLength(viewport: PdfViewerViewport, lengths: readonly number[], zoom: number): boolean {
    return lengths.some((length) =>
      Math.abs(viewport.pageWidth - length * zoom) <= TURNED_WIDTH_TOLERANCE);
  }

  /** Whether the reported page is a page's width at `zoom`, give or take its lag. */
  #upright(viewport: PdfViewerViewport, zoom: number): boolean {
    return this.#widths.some((width) =>
      Math.abs(viewport.pageWidth - width * zoom) <= MIN_ZOOM_DELTA * width + TURNED_WIDTH_TOLERANCE);
  }

  /** The reading that follows could be whole pages off. */
  #guess(): void {
    this.#unsure = true;
    this.#episode += 1;
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
      for (const scrollbar of [0, this.#scrollbar ?? UNTOLD_SCROLLBAR_WIDTH]) {
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
      if (next && next !== arrow) {
        this.#jumpInstead = true;
        this.#guess();
      }
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
      if (next && next !== documentTop) {
        this.#jumpInstead = true;
        this.#guess();
      }
      return documentTop;
    }
    // Home where Chrome does not animate scrolling sends one report at the
    // top of the PDF, which on a PDF of one page size fits the next page's
    // top too. Where that top is not a whole pixel on screen, ArrowRight and
    // a jump report the place again at once, snapped (D146); Home's top is
    // whole and is not. There the top, unless the snap report comes (D196):
    // a guess either way, which a look settles. On whole pixels nothing
    // tells them apart, and ArrowRight is the likelier.
    const nextTop = next ? next.y * next.zoom : 0;
    if (
      documentTop &&
      next &&
      next !== documentTop &&
      fromTop > 1e-6 &&
      Math.abs(nextTop - Math.round(nextTop)) > SNAPPED_TOP
    ) {
      this.#jumpInstead = true;
      this.#guess();
      return documentTop;
    }
    // ArrowRight goes here; so do the page box, an outline entry and a link
    // to a page top, wherever that page is.
    if (next) {
      this.#guess();
      return next;
    }
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

  /** The candidate at the very top of the PDF, else at its bottom, if any. */
  #atEdge(candidates: readonly Candidate[], viewport: PdfViewerViewport): Candidate | undefined {
    return candidates.find((candidate) =>
      Math.abs(candidate.y) * candidate.zoom <= PAGE_TOP_EXACT) ??
      this.#atBottom(candidates, viewport);
  }

  /**
   * The candidate at the very bottom of the PDF, if the report fits one.
   * The most visible page there is the last, or, when two pages fit whole,
   * the one before it.
   */
  #atBottom(candidates: readonly Candidate[], viewport: PdfViewerViewport): Candidate | undefined {
    const tolerance = this.#scaledByFraction ? SCALED_EDGE_TOLERANCE : EDGE_TOLERANCE;
    return candidates.find((candidate) =>
      this.#viewHeights(candidate.zoom, viewport).some((height) =>
        Math.abs(candidate.y - this.#maximumY(candidate.zoom, height)) * candidate.zoom <=
          tolerance));
  }

  /**
   * The height of the view the viewer scrolls down to the bottom of the
   * PDF by: its viewport as reported, or that less the scrollbar across it
   * when the PDF is wider than the view (the report counts the scrollbars
   * in; Chrome 138 and 154). Both where it cannot be told which: every
   * height is one more place in each page where a movement that stops
   * there reads as the end of the PDF.
   */
  #viewHeights(zoom: number, viewport: PdfViewerViewport): number[] {
    const scrollbar = this.#scrollbar;
    const full = viewport.viewportHeight;
    // How much wider the PDF is than the view less a scrollbar of `whole` px.
    const wider = (whole: number) =>
      (this.#widestWidth + INSET_LEFT + INSET_RIGHT) * zoom - (viewport.viewportWidth - whole);
    if (scrollbar === undefined) {
      // Not told: with one of the usual width, or with none.
      return wider(UNTOLD_SCROLLBAR_WIDTH) > -UNTOLD_WIDE_MARGIN
        ? [full, full - UNTOLD_SCROLLBAR_WIDTH]
        : [full];
    }
    if (!(scrollbar > 0)) return [full];
    // Chrome 158 stops a pixel lower than the scrollbar the tab draws
    // (14 px of the tab's 15 on Linux, at zooms of 125% to 300%), where
    // Chrome 138 and 154 left the scrollbar's width (D177).
    const across = [full - scrollbar, full - scrollbar + 1];
    // Chrome's own whole number for the scrollbar: the nearest, or either
    // when the width measured is about half way between two.
    const low = Math.round(scrollbar - WHOLE_UNSURE);
    const high = Math.round(scrollbar + WHOLE_UNSURE);
    if (wider(high) <= WIDE_EXACT) return [full];
    // Chrome 158 fits a PDF to width beside a scrollbar a pixel narrower:
    // 965 px of PDF in a view of 979 where the tab measures 15, at default
    // zooms of 120% to 200% (D184). It has none across, and taking both
    // bottoms there read a wheel step at 150% as a PageUp.
    if (Math.abs(wider(low - 1)) <= FIT_NARROWER_EXACT) return [full];
    if (Math.abs(wider(high - 1)) <= FIT_NARROWER_EXACT) return [full];
    // A PDF up to a pixel wider than the view less the scrollbar has none
    // on Chrome 158 and one on Chrome 154 (D184).
    if (wider(low - 1) > WIDE_EXACT) return across;
    return [full, ...across];
  }

  /**
   * The steps Chrome pages by, in screen px: a share of the viewport as
   * reported for PageUp, PageDown and Space, and the same share of the view
   * less the scrollbar across it for a click on the track of the scrollbar
   * down the side (Chrome 138 and 154, D134).
   */
  #pageSteps(zoom: number, viewport: PdfViewerViewport): number[] {
    const heights = new Set([viewport.viewportHeight, ...this.#viewHeights(zoom, viewport)]);
    return [...heights].map((height) => PDF_VIEWER_PAGE_KEY_SHARE * height);
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
    const steps = this.#pageSteps(fix.zoom, viewport);
    const pageKeys = candidates.filter((candidate) =>
      steps.some((step) =>
        Math.abs(Math.abs((candidate.y - fix.y) * candidate.zoom) - step) <= PAGE_KEY_TOLERANCE));
    // Half a page either way looks the same: forward is the likelier key.
    return pageKeys.find((candidate) => candidate.y > fix.y) ?? pageKeys[0];
  }

  /**
   * Reads the held movement's latest report by its step: the place nearest
   * the one the steps before it reached, among `candidates` at the zoom the
   * hold began at (D177).
   */
  #stepHold(hold: Hold, candidates: readonly Candidate[]): void {
    const before = hold.steps;
    if (!before || candidates.length === 0) {
      hold.steps = undefined;
      return;
    }
    const next = nearest(candidates, before.y);
    const page = this.#pages[next.page]!;
    const pitch = page.height + INSET_TOP + INSET_BOTTOM + SEPARATOR;
    const step = Math.abs(next.y - before.y);
    hold.longestStep = Math.max(hold.longestStep, step / pitch);
    hold.stepRange.count += 1;
    hold.stepRange.min = Math.min(hold.stepRange.min, step * next.zoom);
    hold.stepRange.max = Math.max(hold.stepRange.max, step * next.zoom);
    hold.steps = next;
  }

  /**
   * Ends a held movement: the top or the bottom of the PDF when it stopped
   * exactly there (a guess after one report), else the page nearest where
   * it began; a held page key step is taken. `undefined` when nothing was
   * held or the place is the same, so the reader's own scrolling of the
   * panel stays.
   */
  settle(): PdfReadingPosition | undefined {
    const pending = this.#turnPending;
    if (pending) {
      // No page top followed: no turn, and the report is read as before.
      this.#turnPending = undefined;
      const track = this.#takeAll(pending.reports);
      if (track.kind === 'hold') return this.settle();
      return track.kind === 'move' ? track.position : undefined;
    }
    const keyStep = this.#keyStep;
    if (keyStep) {
      // No frame followed: a key, or Home or End, which a capture confirms.
      this.#keyStep = undefined;
      this.#keyUndo = { scroll: keyStep.scroll, viewport: keyStep.viewport };
      if (keyStep.edge) this.#guess();
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
    // A movement (Home, End, a drag) that stops at an edge is there. So
    // may a lone report be: where Chrome does not animate scrolling (its
    // smooth scrolling switched off, or the system's animations) End and
    // Home are one report each. But a jump to the last page sends that
    // report too, and a wheel step or a click on the scrollbar's track may
    // stop there, so a lone report is taken for the end only as a guess
    // that a capture confirms (D174).
    // A movement of reports that came apart and are steps of one length (two
    // steps or more, so that the length is seen twice),
    // none further than `HELD_STEP_SHARE` of a page from the place before
    // it, is read by its own steps (D177): the wheel where Chrome does not
    // animate scrolling, one report a notch. Its last place is then known,
    // also on a page top, which looks like the top of the PDF too. A
    // movement Chrome animates (Home, End, a drag, a fling) reports every
    // frame, each of another length, and may go whole pages between two
    // (on a slow machine a frame can take 33 ms); it is read as before.
    const steps = hold.stepRange.count > 1 &&
        !hold.jump &&
        !this.#returned &&
        hold.shortestGap >= HELD_STEP_GAP_MS &&
        hold.longestStep < HELD_STEP_SHARE &&
        hold.stepRange.max - hold.stepRange.min <= HELD_STEP_SAME_PX
      ? hold.steps
      : undefined;
    const edge = steps ? undefined : this.#atEdge(candidates, hold.last);
    // Else where the speed trusted before the hold would have carried the
    // viewer, slowing as a fling does.
    const decay = 0.95;
    const travel = hold.speed * FRAME_MS * decay * (1 - decay ** hold.frames) / (1 - decay);
    const chosen = steps ?? edge ?? nearest(candidates, hold.from.y + travel);
    // A jump, wherever it stopped, is a guess: a jump to any page top looks
    // like the top of the PDF. So is what a view came back with. The ends
    // of the PDF are places of their own when a movement stopped there
    // (Home, End). A movement that stopped anywhere else (the wheel, a
    // fling, a scrollbar drag) is read as it always was and is no new
    // doubt: a look then could find a number typed into the page box and
    // not entered, which scrolling within a page leaves there.
    if (hold.jump || this.#returned || (edge && hold.frames === 1)) this.#guess();
    else if (edge) this.#unsure = false;
    this.#returned = false;
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
    this.#lastPageKey = this.#pageSteps(candidate.zoom, viewport).some((step) =>
      Math.abs(moved - step) <= PAGE_KEY_TOLERANCE);
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
