import { describe, expect, it } from 'vitest';

import type { PdfPagePoints, PdfReadingPosition } from '../lib/pdf/pdf-layout';
import {
  readPdfViewerPortMessage,
  readPdfViewerViewport,
  type PdfViewerViewport,
} from '../lib/pdf/pdf-viewer-protocol';
import {
  PDF_VIEWER_ARROW_STEP,
  PDF_VIEWER_PAGE_KEY_SHARE,
  PdfViewerTracker,
  type PdfViewerTrack,
} from '../lib/pdf/pdf-viewer-tracker';

const LETTER: PdfPagePoints = { width: 612, height: 792 };
const LANDSCAPE: PdfPagePoints = { width: 792, height: 612 };

/**
 * Chrome's viewer, one page wide (Chromium `document_layout.cc`): pages of
 * trunc(points × 4/3) px with insets 3/5/7/5 and 4 px between pages, the
 * most visible page being the one with the largest share of itself shown.
 */
class FakeViewer {
  readonly pages: { width: number; height: number; top: number }[] = [];
  readonly height: number;
  scroll = 0;
  /** How far the viewer is scrolled sideways, in screen pixels. */
  scrollX = 0;
  time = 1_000;
  /**
   * How wide Chrome draws a scrollbar, in screen pixels. The report gives
   * the viewport with its scrollbars, and a PDF wider than the view has
   * one across the bottom.
   */
  scrollbar = 0;
  /** Chrome's own whole number for that width, when not the nearest. */
  scrollbarWhole: number | undefined;

  constructor(
    sizes: readonly PdfPagePoints[],
    public zoom: number,
    public viewportHeight: number,
    public viewportWidth = 800,
    /** The two-page view reports each page this much narrower (px at 100%). */
    public narrower = 0,
  ) {
    let top = 0;
    for (const size of sizes) {
      if (this.pages.length > 0) top += 4;
      const width = Math.trunc((size.width * 4) / 3);
      const height = Math.trunc((size.height * 4) / 3);
      this.pages.push({ width, height, top: top + 3 });
      top += 3 + height + 7;
    }
    this.height = top;
  }

  /** Chrome's rule, with its own whole number for the scrollbar's width. */
  get scrollbarAcross(): boolean {
    const widest = Math.max(...this.pages.map((page) => page.width));
    const whole = this.scrollbarWhole ?? Math.round(this.scrollbar);
    return this.scrollbar > 0 && (widest + 10) * this.zoom > this.viewportWidth - whole + 1e-9;
  }

  get maxScroll(): number {
    const across = this.scrollbarAcross ? this.scrollbar : 0;
    return Math.max(0, this.height * this.zoom - (this.viewportHeight - across));
  }

  scrollTo(scroll: number): void {
    this.scroll = Math.min(this.maxScroll, Math.max(0, scroll));
  }

  mostVisible(): number {
    let best = 0;
    let bestShare = -1;
    this.pages.forEach((page, index) => {
      const top = page.top * this.zoom - this.scroll;
      const bottom = top + page.height * this.zoom;
      const shown = Math.max(0, Math.min(bottom, this.viewportHeight) - Math.max(top, 0));
      const share = shown / (page.height * this.zoom);
      if (share > bestShare) {
        bestShare = share;
        best = index;
      }
    });
    return best;
  }

  /** Chrome centres a page in the view when the PDF fits across it. */
  pageX(width: number): number {
    const widest = Math.max(...this.pages.map((page) => page.width));
    const fits = (widest + 10) * this.zoom <= this.viewportWidth - 14;
    // Too wide to fit: the page centred in the PDF, less the sideways scroll.
    return fits
      ? (this.viewportWidth - 14) / 2 - (width * this.zoom) / 2
      : ((widest - width) / 2 + 5) * this.zoom - this.scrollX;
  }

  report(): PdfViewerViewport {
    const page = this.pages[this.mostVisible()]!;
    return {
      pageX: this.pageX(page.width),
      pageY: page.top * this.zoom - this.scroll,
      pageWidth: (page.width - this.narrower) * this.zoom,
      viewportWidth: this.viewportWidth,
      viewportHeight: this.viewportHeight,
    };
  }

  /** The page under the viewport's top edge, as the panel counts it. */
  topPage(): number {
    const y = this.scroll / this.zoom;
    let index = 0;
    this.pages.forEach((page, candidate) => {
      if (page.top - 7 <= y) index = candidate;
    });
    return index;
  }
}

function send(tracker: PdfViewerTracker, viewer: FakeViewer, gapMs: number): PdfViewerTrack {
  viewer.time += gapMs;
  return tracker.update(viewer.report(), viewer.time);
}

/** A lone key report: read at once, or after the wait for more frames. */
function keyed(tracker: PdfViewerTracker, track: PdfViewerTrack): PdfReadingPosition {
  if (track.kind === 'hold') return tracker.settle()!;
  return moved(track);
}

function moved(track: PdfViewerTrack): PdfReadingPosition {
  expect(track.kind).toBe('move');
  return (track as { position: PdfReadingPosition }).position;
}

function pages(count: number, size = LETTER): PdfPagePoints[] {
  return Array.from({ length: count }, () => size);
}

describe('PdfViewerTracker', () => {
  it('follows smooth scrolling page by page, down and back up', () => {
    const viewer = new FakeViewer(pages(40), 0.7058, 757);
    const tracker = new PdfViewerTracker(pages(40));
    send(tracker, viewer, 1_000);
    for (let step = 0; step < 900; step += 1) {
      viewer.scrollTo(viewer.scroll + 30);
      const track = send(tracker, viewer, 16);
      if (track.kind === 'move') expect(track.position.index).toBe(viewer.topPage());
    }
    expect(tracker.position?.index).toBe(viewer.topPage());
    expect(viewer.topPage()).toBeGreaterThan(30);
    for (let step = 0; step < 600; step += 1) {
      viewer.scrollTo(viewer.scroll - 25);
      send(tracker, viewer, 16);
    }
    expect(tracker.position?.index).toBe(viewer.topPage());
  });

  it('places the viewport top within the page', () => {
    const viewer = new FakeViewer(pages(5), 1, 700);
    const tracker = new PdfViewerTracker(pages(5));
    send(tracker, viewer, 1_000);
    for (let step = 0; step < 50; step += 1) {
      viewer.scrollTo(viewer.scroll + 30);
      send(tracker, viewer, 16);
    }
    // 1,500 px down: page 2 starts at 3 + 1056 + 7 + 4 + 3 = 1,073 px.
    const position = tracker.position!;
    expect(position.index).toBe(1);
    expect(position.fraction).toBeCloseTo((1500 - 1073) / 1056, 3);
  });

  it('reads arrow keys and PageDown as their exact steps', () => {
    // A viewport taller than half a page: PageDown alone is ambiguous.
    const viewer = new FakeViewer(pages(30), 0.7058, 757);
    const tracker = new PdfViewerTracker(pages(30));
    send(tracker, viewer, 1_000);
    for (let press = 0; press < 12; press += 1) {
      viewer.scrollTo(viewer.scroll + PDF_VIEWER_PAGE_KEY_SHARE * viewer.viewportHeight);
      expect(keyed(tracker, send(tracker, viewer, 400)).index).toBe(viewer.topPage());
    }
    for (let press = 0; press < 30; press += 1) {
      viewer.scrollTo(viewer.scroll - PDF_VIEWER_ARROW_STEP);
      const track = send(tracker, viewer, 300);
      expect(tracker.position?.index).toBe(viewer.topPage());
      expect(track.kind).toBe('move');
    }
  });

  it('reads a lone landing on a page top as the next page (ArrowRight)', () => {
    const viewer = new FakeViewer(pages(20), 0.9, 700);
    const tracker = new PdfViewerTracker(pages(20));
    send(tracker, viewer, 1_000);
    for (let step = 0; step < 50; step += 1) {
      viewer.scrollTo(viewer.scroll + 30);
      send(tracker, viewer, 16);
    }
    for (let press = 0; press < 6; press += 1) {
      const next = viewer.mostVisible() + 1;
      viewer.scrollTo(viewer.pages[next]!.top * viewer.zoom - 3 * viewer.zoom);
      expect(moved(send(tracker, viewer, 500)).index).toBe(next);
    }
  });

  it('reads ArrowRight on the last page as that page’s own top', () => {
    const viewer = new FakeViewer(pages(3), 0.9, 700);
    const tracker = new PdfViewerTracker(pages(3));
    send(tracker, viewer, 1_000);
    for (let step = 0; step < 70; step += 1) {
      viewer.scrollTo(viewer.scroll + 30);
      send(tracker, viewer, 16);
    }
    expect(viewer.mostVisible()).toBe(2);
    viewer.scrollTo((viewer.pages[2]!.top - 3) * viewer.zoom);
    expect(moved(send(tracker, viewer, 500))).toEqual({ index: 2, fraction: 0 });
  });

  it('tells ArrowRight from scrolling up to a page top by Chrome’s snapped second report', () => {
    // 1,070 px × 0.7058 is not a whole number, so a jump is snapped at once.
    const viewer = new FakeViewer(pages(20), 0.7058, 757);
    const tracker = new PdfViewerTracker(pages(20));
    send(tracker, viewer, 1_000);
    viewer.scrollTo(200);
    send(tracker, viewer, 16);
    // Within the first screen a page-1 top reads first as the very top…
    viewer.scrollTo((viewer.pages[1]!.top - 3) * viewer.zoom);
    expect(moved(send(tracker, viewer, 500)).index).toBe(0);
    // …until the snapped report a few ms later shows it was a jump.
    viewer.scrollTo(Math.round(viewer.scroll));
    expect(moved(send(tracker, viewer, 3)).index).toBe(1);

    // PageUp, then PageUp again cut short at the very top: no second report.
    viewer.scrollTo(viewer.scroll - PDF_VIEWER_PAGE_KEY_SHARE * viewer.viewportHeight);
    expect(keyed(tracker, send(tracker, viewer, 500)).index).toBe(0);
    viewer.scrollTo(viewer.scroll - PDF_VIEWER_PAGE_KEY_SHARE * viewer.viewportHeight);
    expect(viewer.scroll).toBe(0);
    expect(moved(send(tracker, viewer, 500))).toEqual({ index: 0, fraction: 0 });
  });

  it('waits for more frames before reading a small move as a page key step', () => {
    // 0.875 × 862 ≈ one page pitch (755 px): PageDown looks like a 1 px scroll.
    const viewer = new FakeViewer(pages(20), 0.7058, 862.5);
    const tracker = new PdfViewerTracker(pages(20));
    send(tracker, viewer, 1_000);
    viewer.scrollTo(100);
    send(tracker, viewer, 16);
    viewer.scrollTo(Math.round(viewer.scroll + PDF_VIEWER_PAGE_KEY_SHARE * viewer.viewportHeight));
    expect(send(tracker, viewer, 500).kind).toBe('hold');
    expect(tracker.settle()?.index).toBe(viewer.topPage());
    // A wheel turn's first frame is followed by more frames: a scroll.
    viewer.scrollTo(viewer.scroll + 1);
    send(tracker, viewer, 500);
    for (let frame = 0; frame < 5; frame += 1) {
      viewer.scrollTo(viewer.scroll + 10);
      send(tracker, viewer, 16);
    }
    expect(tracker.position?.index).toBe(viewer.topPage());
  });

  it('holds an animated Home or End and settles at the first or last page', () => {
    const viewer = new FakeViewer(pages(300), 0.7058, 757);
    const tracker = new PdfViewerTracker(pages(300));
    send(tracker, viewer, 1_000);
    const run = (target: number) => {
      const start = viewer.scroll;
      for (let frame = 1; frame <= 10; frame += 1) {
        const share = (1 - Math.cos((Math.PI * frame) / 10)) / 2;
        viewer.scrollTo(start + (target - start) * share);
        send(tracker, viewer, 16);
      }
    };
    run(viewer.maxScroll);
    // The viewport's top edge is in the gap above the last page.
    expect(tracker.settle()?.index).toBe(viewer.topPage());
    expect(viewer.topPage()).toBeGreaterThanOrEqual(298);
    run(0);
    expect(tracker.settle()).toEqual({ index: 0, fraction: 0 });
  });

  it('keeps the place across a viewer zoom and ignores repeats', () => {
    const viewer = new FakeViewer(pages(10), 1, 700);
    const tracker = new PdfViewerTracker(pages(10));
    send(tracker, viewer, 1_000);
    for (let step = 0; step < 120; step += 1) {
      viewer.scrollTo(viewer.scroll + 30);
      send(tracker, viewer, 16);
    }
    const before = tracker.position!;
    // The viewer zooms to 125% keeping the top of the viewport in place.
    const y = viewer.scroll / viewer.zoom;
    viewer.zoom = 1.25;
    viewer.scrollTo(y * viewer.zoom);
    expect(send(tracker, viewer, 600).kind).toBe('same');
    expect(tracker.position).toEqual(before);
    expect(send(tracker, viewer, 10).kind).toBe('same');
    viewer.scrollTo(viewer.scroll + 30);
    expect(moved(send(tracker, viewer, 16)).index).toBe(viewer.topPage());
  });

  it('tells pages of different widths apart after a jump', () => {
    const sizes = [...pages(8), LANDSCAPE, ...pages(8)];
    const viewer = new FakeViewer(sizes, 0.8, 700);
    const tracker = new PdfViewerTracker(sizes);
    send(tracker, viewer, 1_000);
    viewer.scrollTo(viewer.pages[8]!.top * viewer.zoom + 100);
    // A lone jump is read once the viewer is still.
    expect(keyed(tracker, send(tracker, viewer, 800)).index).toBe(8);
  });

  it('starts from the anchor, the panel’s own reading position', () => {
    const viewer = new FakeViewer(pages(20), 1, 700);
    const tracker = new PdfViewerTracker(pages(20));
    tracker.anchor({ index: 7, fraction: 0.5 });
    viewer.scrollTo(viewer.pages[7]!.top + 600);
    expect(moved(send(tracker, viewer, 1_000)).index).toBe(7);
    // An anchor after the first report changes nothing.
    tracker.anchor({ index: 0, fraction: 0 });
    viewer.scrollTo(viewer.scroll + 20);
    expect(moved(send(tracker, viewer, 16)).index).toBe(7);
  });

  it('reads held keys by their repeats, about every 30 ms', () => {
    const viewer = new FakeViewer(pages(60), 0.7058, 757);
    const tracker = new PdfViewerTracker(pages(60));
    send(tracker, viewer, 1_000);
    // PageDown held: the first press, the keyboard's wait, then repeats.
    for (let press = 0; press < 8; press += 1) {
      viewer.scrollTo(Math.round(viewer.scroll + PDF_VIEWER_PAGE_KEY_SHARE * viewer.viewportHeight));
      send(tracker, viewer, press < 2 ? 400 : 33);
    }
    expect((tracker.settle() ?? tracker.position)?.index).toBe(viewer.topPage());
    // ArrowRight held: each repeat is the next page's exact top, then the
    // position snapped to a whole pixel.
    for (let press = 0; press < 6; press += 1) {
      const next = viewer.mostVisible() + 1;
      viewer.scrollTo((viewer.pages[next]!.top - 3) * viewer.zoom);
      send(tracker, viewer, press < 2 ? 400 : 33);
      viewer.scrollTo(Math.round(viewer.scroll));
      send(tracker, viewer, 3);
    }
    expect(tracker.position?.index).toBe(viewer.topPage());
    expect(viewer.topPage()).toBeGreaterThan(11);
  });

  it('reads equal wheel steps as scrolling even when they look like the opposite page key', () => {
    // 100 px down and PageUp (0.875 × 749 px) add up to one page (755 px).
    const viewer = new FakeViewer(pages(40), 0.7058303886925795, 749, 413);
    const tracker = new PdfViewerTracker(pages(40));
    tracker.anchor({ index: 2, fraction: 0 });
    viewer.scrollTo((viewer.pages[2]!.top - 3) * viewer.zoom);
    send(tracker, viewer, 1_000);
    for (let step = 0; step < 12; step += 1) {
      viewer.scrollTo(viewer.scroll + 100);
      send(tracker, viewer, step === 0 ? 3_000 : 50);
    }
    expect((tracker.settle() ?? tracker.position)?.index).toBe(viewer.topPage());
    expect(viewer.topPage()).toBe(3);
  });

  it('reads a key cut short by the end of the PDF as its bottom', () => {
    const viewer = new FakeViewer(pages(12), 0.7058, 757);
    const tracker = new PdfViewerTracker(pages(12));
    send(tracker, viewer, 1_000);
    for (let press = 0; press < 20; press += 1) {
      viewer.scrollTo(Math.round(viewer.scroll + PDF_VIEWER_PAGE_KEY_SHARE * viewer.viewportHeight));
      const track = send(tracker, viewer, 400);
      if (track.kind === 'hold') tracker.settle();
    }
    expect(viewer.scroll).toBe(viewer.maxScroll);
    expect(tracker.position?.index).toBe(viewer.topPage());
  });

  it('goes to the page after the most visible one when several pages are in view', () => {
    // At 30% a 1,000 px view shows four pages; Chrome may name any whole one.
    const viewer = new FakeViewer(pages(40), 0.3, 1000);
    const tracker = new PdfViewerTracker(pages(40));
    send(tracker, viewer, 1_000);
    for (let step = 0; step < 100; step += 1) {
      viewer.scrollTo(viewer.scroll + 20);
      send(tracker, viewer, 16);
    }
    const next = viewer.mostVisible() + 1;
    viewer.scrollTo((viewer.pages[next]!.top - 3) * viewer.zoom);
    // The report names a page further down that is also wholly in view.
    const named = viewer.pages[next + 1]!;
    const track = tracker.update({
      ...viewer.report(),
      pageY: named.top * viewer.zoom - viewer.scroll,
    }, (viewer.time += 500));
    expect(moved(track)).toEqual({ index: next, fraction: 0 });
  });

  it('stays put for a sideways scroll, a zoom that keeps the place, and the two-page view', () => {
    const viewer = new FakeViewer(pages(20), 1.5, 700);
    const tracker = new PdfViewerTracker(pages(20));
    send(tracker, viewer, 1_000);
    // At a page top, where a lone unmoved report would read as ArrowRight.
    viewer.scrollTo((viewer.pages[3]!.top - 3) * viewer.zoom);
    tracker.settle();
    send(tracker, viewer, 400);
    tracker.settle();
    const place = tracker.position;
    const sideways = { ...viewer.report(), pageX: -120 };
    expect(tracker.update(sideways, (viewer.time += 500)).kind).toBe('same');
    expect(tracker.update({ ...sideways, pageX: -260 }, (viewer.time += 500)).kind).toBe('same');
    expect(tracker.position).toEqual(place);

    // The side panel is resized: fit-to-width changes the zoom, and Chrome
    // snaps the same place to a whole pixel.
    const y = viewer.scroll / viewer.zoom;
    viewer.zoom = 1.31;
    viewer.viewportWidth = 700;
    viewer.scrollTo(Math.round(y * viewer.zoom));
    expect(send(tracker, viewer, 500).kind).toBe('same');

    // Two pages side by side: the page sits beside the middle of the view.
    const narrow = new FakeViewer(pages(20), 0.4, 700);
    const beside = new PdfViewerTracker(pages(20));
    send(beside, narrow, 1_000);
    narrow.scrollTo(900);
    const left = { ...narrow.report(), pageX: 393 - narrow.pages[0]!.width * narrow.zoom - 4 };
    expect(beside.update(left, (narrow.time += 500)).kind).toBe('same');
    expect(beside.position).toEqual({ index: 0, fraction: 0 });

    // In a narrow window the left page sits where a single page would; the
    // switch shows as a page reported 4 px narrower at the same zoom.
    const wide = new FakeViewer(pages(20), 1.5, 700);
    const switched = new PdfViewerTracker(pages(20));
    send(switched, wide, 1_000);
    wide.scrollTo(300);
    send(switched, wide, 16);
    const before = switched.position;
    const twoPage = (scroll: number) => ({
      ...wide.report(),
      pageWidth: (wide.pages[0]!.width - 4) * wide.zoom,
      pageY: wide.pages[0]!.top * wide.zoom - scroll,
    });
    expect(switched.update(twoPage(300), (wide.time += 500)).kind).toBe('same');
    expect(switched.update(twoPage(700), (wide.time += 500)).kind).toBe('same');
    expect(switched.position).toEqual(before);
    // One page wide again: followed from there.
    wide.scrollTo(700);
    expect(send(switched, wide, 500).kind).not.toBe('same');
  });

  it('reads how far the viewer is scrolled sideways (D115)', () => {
    // Letter at 200% is 1,632 px wide in an 800 px view.
    const viewer = new FakeViewer(pages(20), 2, 700);
    const tracker = new PdfViewerTracker(pages(20));
    expect(tracker.left).toBeUndefined();
    send(tracker, viewer, 1_000);
    expect(tracker.left).toBe(0);

    // Sideways only: the same place down the PDF, a new place across it.
    const place = tracker.position;
    viewer.scrollX = 300;
    expect(send(tracker, viewer, 500).kind).toBe('same');
    expect(tracker.position).toEqual(place);
    expect(tracker.left).toBeCloseTo(150 / 816, 6);

    // Down only: the place across stays exactly.
    const across = tracker.left;
    viewer.scrollTo(viewer.scroll + 40);
    expect(send(tracker, viewer, 500).kind).toBe('move');
    expect(tracker.left).toBe(across);

    // Both at once, in a stream of frames.
    for (let frame = 0; frame < 5; frame += 1) {
      viewer.scrollX += 30;
      viewer.scrollTo(viewer.scroll + 30);
      send(tracker, viewer, 16);
    }
    tracker.settle();
    expect(tracker.left).toBeCloseTo(225 / 816, 6);
  });

  it('stays at the far left while the PDF fits the viewer, and through a zoom', () => {
    const viewer = new FakeViewer(pages(20), 0.7, 700);
    const tracker = new PdfViewerTracker(pages(20));
    send(tracker, viewer, 1_000);
    expect(tracker.left).toBe(0);
    // A page centred in the view is not scrolled, at any zoom or width.
    viewer.zoom = 0.5;
    viewer.viewportWidth = 900;
    expect(send(tracker, viewer, 500).kind).toBe('same');
    expect(tracker.left).toBe(0);

    // Zoomed past the view's width, Chrome keeps the place across, snapped
    // to a whole pixel: the same place.
    const wide = new FakeViewer(pages(20), 2, 700);
    const zoomed = new PdfViewerTracker(pages(20));
    wide.scrollX = 301;
    send(zoomed, wide, 1_000);
    const before = zoomed.left;
    expect(before).toBeCloseTo(150.5 / 816, 6);
    wide.zoom = 1.5;
    wide.scrollX = Math.round(301 * 0.75);
    send(zoomed, wide, 500);
    expect(zoomed.left).toBe(before);
    // A real move across at the new zoom is read.
    wide.scrollX += 60;
    send(zoomed, wide, 500);
    expect(zoomed.left).toBeCloseTo(286 / 1.5 / 816, 6);
  });

  it('measures sideways across the widest page, whichever page is named', () => {
    // Letter pages with one landscape page: Chrome centres each page in the
    // widest page's width (1,056 px at 100%).
    const sizes = [...pages(3), LANDSCAPE, ...pages(3)];
    const viewer = new FakeViewer(sizes, 2, 700);
    const tracker = new PdfViewerTracker(sizes);
    viewer.scrollX = 400;
    send(tracker, viewer, 1_000);
    expect(viewer.mostVisible()).toBe(0);
    expect(tracker.left).toBeCloseTo(200 / 1056, 6);
    const across = tracker.left;
    // Onto the landscape page: its left edge is elsewhere, the place is not.
    viewer.scrollTo(viewer.pages[3]!.top * viewer.zoom);
    tracker.settle();
    send(tracker, viewer, 800);
    tracker.settle();
    expect(viewer.mostVisible()).toBe(3);
    expect(tracker.left).toBe(across);
  });

  it('guesses the nearest page for a lone jump it cannot place', () => {
    const viewer = new FakeViewer(pages(50), 1, 700);
    const tracker = new PdfViewerTracker(pages(50));
    send(tracker, viewer, 1_000);
    viewer.scrollTo(viewer.pages[30]!.top + 500);
    const guess = keyed(tracker, send(tracker, viewer, 800));
    // Uniform pages: the report fits every page; the nearest is page 1.
    expect(guess.index).toBe(0);
  });

  it('reads a report that arrives after a held movement without a settle', () => {
    const viewer = new FakeViewer(pages(100), 0.7, 757);
    const tracker = new PdfViewerTracker(pages(100));
    send(tracker, viewer, 1_000);
    for (let frame = 1; frame <= 6; frame += 1) {
      viewer.scrollTo(viewer.maxScroll * (frame / 6));
      send(tracker, viewer, 16);
    }
    viewer.scrollTo(viewer.scroll - PDF_VIEWER_ARROW_STEP);
    const track = send(tracker, viewer, 400);
    expect(track.kind).toBe('move');
    expect(tracker.position?.index).toBe(viewer.topPage());
  });
});

describe('PdfViewerTracker doubts (D133)', () => {
  /** A jump as Chrome reports it: the place, and again a millisecond later. */
  function jump(tracker: PdfViewerTracker, viewer: FakeViewer, scroll: number): void {
    viewer.scrollTo(scroll);
    send(tracker, viewer, 800);
    send(tracker, viewer, 1);
    tracker.settle();
  }

  it('doubts the first report and takes the page it is told', () => {
    const viewer = new FakeViewer(pages(50), 1, 700);
    const tracker = new PdfViewerTracker(pages(50));
    expect(tracker.doubt).toBeUndefined();
    // Simul opens with the viewer on page 41, a quarter down it.
    viewer.scrollTo(viewer.pages[40]!.top + 264);
    send(tracker, viewer, 1_000);

    const doubt = tracker.doubt!;
    expect(doubt.page).toBe(0);
    expect(doubt.pages).toHaveLength(50);
    expect(doubt.viewport).toEqual(viewer.report());
    const placed = tracker.place(doubt, 40)!;
    expect(placed.index).toBe(40);
    expect(placed.fraction).toBeCloseTo(0.25, 2);
    expect(tracker.position).toEqual(placed);
    expect(tracker.doubt).toBeUndefined();
    // Scrolling on from there is followed from the page it was told.
    for (let step = 0; step < 30; step += 1) {
      viewer.scrollTo(viewer.scroll + 30);
      send(tracker, viewer, 16);
    }
    expect(viewer.topPage()).toBe(41);
    expect(tracker.position?.index).toBe(41);
  });

  it('ends a doubt without moving when the guess was right', () => {
    const viewer = new FakeViewer(pages(50), 1, 700);
    const tracker = new PdfViewerTracker(pages(50));
    send(tracker, viewer, 1_000);
    const before = tracker.position;

    expect(tracker.place(tracker.doubt!, 0)).toBeUndefined();
    expect(tracker.position).toBe(before);
    expect(tracker.doubt).toBeUndefined();
  });

  it('does not doubt scrolling, arrows and page keys from a known place', () => {
    const viewer = new FakeViewer(pages(50), 0.7058, 757);
    const tracker = new PdfViewerTracker(pages(50));
    send(tracker, viewer, 1_000);
    tracker.place(tracker.doubt!, 0);
    for (let step = 0; step < 200; step += 1) {
      viewer.scrollTo(viewer.scroll + 30);
      send(tracker, viewer, 16);
    }
    expect(tracker.doubt).toBeUndefined();
    viewer.scrollTo(viewer.scroll + PDF_VIEWER_ARROW_STEP);
    send(tracker, viewer, 400);
    expect(tracker.doubt).toBeUndefined();
    viewer.scrollTo(viewer.scroll + PDF_VIEWER_PAGE_KEY_SHARE * 757);
    keyed(tracker, send(tracker, viewer, 400));
    expect(tracker.doubt).toBeUndefined();
    // A lone wheel step.
    viewer.scrollTo(viewer.scroll + 100);
    send(tracker, viewer, 400);
    expect(tracker.doubt).toBeUndefined();
    expect(tracker.position?.index).toBe(viewer.topPage());
  });

  it('doubts a jump, and a jump that looks like a small scroll', () => {
    const viewer = new FakeViewer(pages(300), 1, 700);
    const tracker = new PdfViewerTracker(pages(300));
    send(tracker, viewer, 1_000);
    tracker.place(tracker.doubt!, 0);

    // The page box to page 200, part-way down it.
    jump(tracker, viewer, viewer.pages[199]!.top + 300);
    const far = tracker.doubt!;
    expect(far.page).not.toBe(199);
    expect(tracker.place(far, 199)).toMatchObject({ index: 199 });

    // A link to page 41, about as far down its page: the report is that of
    // a wheel step, but it comes twice.
    viewer.scrollTo(viewer.pages[40]!.top + 360);
    expect(moved(send(tracker, viewer, 800)).index).toBe(199);
    expect(tracker.doubt).toBeUndefined();
    send(tracker, viewer, 1);
    const near = tracker.doubt!;
    expect(near.page).toBe(199);
    expect(near.episode).toBeGreaterThan(far.episode);
    expect(tracker.place(near, 40)).toMatchObject({ index: 40 });
    expect(tracker.position!.fraction).toBeCloseTo(360 / 1056, 2);
  });

  it('doubts a jump to a page top, which reads as ArrowRight', () => {
    const viewer = new FakeViewer(pages(300), 1, 700);
    const tracker = new PdfViewerTracker(pages(300));
    send(tracker, viewer, 1_000);
    tracker.place(tracker.doubt!, 0);
    jump(tracker, viewer, viewer.pages[20]!.top + 300);
    tracker.place(tracker.doubt!, 20);

    // The page box to page 200: read as the next page, as before.
    jump(tracker, viewer, viewer.pages[199]!.top - 3);
    expect(tracker.position).toEqual({ index: 21, fraction: 0 });
    expect(tracker.place(tracker.doubt!, 199)).toEqual({ index: 199, fraction: 0 });
  });

  it('doubts a held jump to a page top, which reads as the top of the PDF', () => {
    // Landscape pages among portrait ones: a jump onto the top of one fits
    // the landscape first page at the very top.
    const sizes = [LANDSCAPE, ...pages(10), LANDSCAPE, LANDSCAPE, ...pages(10)];
    const viewer = new FakeViewer(sizes, 0.5, 700);
    const tracker = new PdfViewerTracker(sizes);
    viewer.scrollTo(viewer.pages[4]!.top * viewer.zoom + 100);
    send(tracker, viewer, 1_000);
    tracker.place(tracker.doubt!, 4);

    jump(tracker, viewer, (viewer.pages[12]!.top - 3) * viewer.zoom);
    expect(tracker.position).toEqual({ index: 0, fraction: 0 });
    const doubt = tracker.doubt!;
    expect(doubt.pages).toEqual([0, 11, 12]);
    expect(tracker.place(doubt, 12)).toEqual({ index: 12, fraction: 0 });
  });

  it('doubts a lone report at a page top: ArrowRight, or a jump anywhere', () => {
    const viewer = new FakeViewer(pages(60), 0.9, 700);
    const tracker = new PdfViewerTracker(pages(60));
    send(tracker, viewer, 1_000);
    tracker.place(tracker.doubt!, 0);
    for (let step = 0; step < 80; step += 1) {
      viewer.scrollTo(viewer.scroll + 30);
      send(tracker, viewer, 16);
    }
    expect(tracker.position?.index).toBe(2);
    expect(tracker.doubt).toBeUndefined();

    // One report at the top of page 6: read as the page after this one.
    viewer.scrollTo((viewer.pages[5]!.top - 3) * viewer.zoom);
    expect(moved(send(tracker, viewer, 800)).index).toBe(3);
    expect(tracker.doubt?.page).toBe(3);
    expect(tracker.place(tracker.doubt!, 5)).toEqual({ index: 5, fraction: 0 });
  });

  it('does not doubt Home and End', () => {
    const viewer = new FakeViewer(pages(100), 0.7, 757);
    const tracker = new PdfViewerTracker(pages(100));
    send(tracker, viewer, 1_000);
    tracker.place(tracker.doubt!, 0);
    for (let frame = 1; frame <= 10; frame += 1) {
      viewer.scrollTo(viewer.maxScroll * (frame / 10));
      send(tracker, viewer, 16);
    }
    expect(tracker.settle()?.index).toBe(viewer.topPage());
    expect(viewer.topPage()).toBeGreaterThanOrEqual(98);
    expect(tracker.doubt).toBeUndefined();

    // A doubt ends at the top or bottom of the PDF.
    jump(tracker, viewer, viewer.pages[40]!.top * viewer.zoom + 200);
    expect(tracker.doubt).toBeDefined();
    for (let frame = 9; frame >= 0; frame -= 1) {
      viewer.scrollTo(viewer.scroll * (frame / 10));
      send(tracker, viewer, 16);
    }
    expect(tracker.settle()?.index).toBe(0);
    expect(tracker.doubt).toBeUndefined();
  });

  /** End, as Chrome animates it: ten frames to `target`, then still. */
  const runTo = (tracker: PdfViewerTracker, viewer: FakeViewer, target: number) => {
    const start = viewer.scroll;
    for (let frame = 1; frame <= 10; frame += 1) {
      viewer.scrollTo(start + (target - start) * (frame / 10));
      send(tracker, viewer, 16);
    }
    return tracker.settle();
  };

  it('reads End on a PDF wider than the view by the scrollbar the tab draws (D134)', () => {
    // Linux, a wider one, screens scaled by 125% and 110%, and a wide system scrollbar.
    for (const scrollbar of [15, 17, 15.2, 15.455, 25]) {
      // 816 px at 125% is wider than a view of 593 px.
      const viewer = new FakeViewer(pages(300), 1.25, 749, 593);
      viewer.scrollbar = scrollbar;
      const tracker = new PdfViewerTracker(pages(300));
      tracker.setScrollbarWidth(scrollbar);
      send(tracker, viewer, 1_000);
      tracker.place(tracker.doubt!, 0);
      expect(runTo(tracker, viewer, viewer.maxScroll)?.index).toBe(viewer.topPage());
      expect(viewer.topPage()).toBeGreaterThanOrEqual(298);
      expect(tracker.doubt).toBeUndefined();
      // And Home from there.
      expect(runTo(tracker, viewer, 0)).toEqual({ index: 0, fraction: 0 });
    }
  });

  it('allows for a scrollbar of 15 px, or none, until the tab says how wide it draws one (D134)', () => {
    const run = (scrollbar: number, told: number | undefined | 'nothing', short = 0) => {
      const viewer = new FakeViewer(pages(300), 1.25, 749, 593);
      viewer.scrollbar = scrollbar;
      const tracker = new PdfViewerTracker(pages(300));
      if (told !== 'nothing') tracker.setScrollbarWidth(told);
      send(tracker, viewer, 1_000);
      tracker.place(tracker.doubt!, 0);
      runTo(tracker, viewer, viewer.maxScroll - short);
      return { index: tracker.position!.index, last: viewer.topPage() };
    };
    for (const told of ['nothing', undefined, -1, Number.NaN, 1_000] as const) {
      // With a scrollbar of 15 px across, and with none.
      for (const scrollbar of [15, 0]) {
        const { index, last } = run(scrollbar, told);
        expect(index).toBe(last);
        expect(last).toBeGreaterThanOrEqual(298);
      }
    }
    // A scrollbar of another width than the tracker allows for is not the bottom.
    expect(run(25, 'nothing').index).toBeLessThan(10);
    expect(run(15, 25).index).toBeLessThan(10);
    // Untold, a PDF only a little wider than the view less 15 px has one too.
    const viewer = new FakeViewer(pages(300), (593 - 15 + 10) / 826, 749, 593);
    viewer.scrollbar = 15;
    expect(viewer.scrollbarAcross).toBe(true);
    const tracker = new PdfViewerTracker(pages(300));
    send(tracker, viewer, 1_000);
    tracker.place(tracker.doubt!, 0);
    expect(runTo(tracker, viewer, viewer.maxScroll)?.index).toBe(viewer.topPage());
    expect(viewer.topPage()).toBeGreaterThanOrEqual(298);
  });

  it('looks for one bottom once the tab has said how wide a scrollbar is (D134)', () => {
    const run = (told: number | 'nothing', short: number) => {
      const viewer = new FakeViewer(pages(300), 1.25, 749, 593);
      viewer.scrollbar = 15;
      const tracker = new PdfViewerTracker(pages(300));
      if (told !== 'nothing') tracker.setScrollbarWidth(told);
      send(tracker, viewer, 1_000);
      tracker.place(tracker.doubt!, 0);
      runTo(tracker, viewer, viewer.maxScroll - short);
      return tracker.position!.index;
    };
    // A fast movement that stops where the bottom would be without the
    // scrollbar across, 15 px above the real one, is not End once the
    // width is known; untold, it could be.
    expect(run(15, 15)).toBeLessThan(10);
    expect(run('nothing', 15)).toBeGreaterThanOrEqual(298);
    expect(run(15, 0)).toBeGreaterThanOrEqual(298);
  });

  it('looks for no scrollbar across in fit to width (D134)', () => {
    // Chrome fits the widest page into the view less its scrollbar's whole
    // number of px: exactly as wide, and none lies across.
    for (const scrollbar of [15, 15.2, 14.857]) {
      const start = () => {
        const viewer = new FakeViewer(pages(300), (593 - 15) / 826, 749, 593);
        viewer.scrollbar = scrollbar;
        expect(viewer.scrollbarAcross).toBe(false);
        const tracker = new PdfViewerTracker(pages(300));
        tracker.setScrollbarWidth(scrollbar);
        send(tracker, viewer, 1_000);
        tracker.place(tracker.doubt!, 0);
        return { viewer, tracker };
      };
      const end = start();
      expect(runTo(end.tracker, end.viewer, end.viewer.maxScroll)?.index).toBe(end.viewer.topPage());
      expect(end.viewer.topPage()).toBeGreaterThanOrEqual(298);
      // That share of the view less the scrollbar is no step Chrome takes
      // here: a large move like any other, held until the viewer is still.
      const { viewer, tracker } = start();
      viewer.scrollTo(Math.round(PDF_VIEWER_PAGE_KEY_SHARE * (viewer.viewportHeight - scrollbar)));
      expect(send(tracker, viewer, 400).kind).toBe('hold');
    }
  });

  it('looks for both bottoms where Chrome\'s whole number for the scrollbar is unsure (D134)', () => {
    // A width measured as 15.45 px may be 15 or 16 to Chrome. In fit to
    // width by either number no scrollbar lies across; half a pixel wider
    // than that, one does.
    for (const whole of [15, 16]) {
      for (const wider of [0, 0.5]) {
        const viewer = new FakeViewer(pages(300), (593 - whole + wider) / 826, 749, 593);
        viewer.scrollbar = 15.45;
        viewer.scrollbarWhole = whole;
        expect(viewer.scrollbarAcross).toBe(wider > 0);
        const tracker = new PdfViewerTracker(pages(300));
        tracker.setScrollbarWidth(15.45);
        send(tracker, viewer, 1_000);
        tracker.place(tracker.doubt!, 0);
        expect(runTo(tracker, viewer, viewer.maxScroll)?.index).toBe(viewer.topPage());
        expect(viewer.topPage()).toBeGreaterThanOrEqual(298);
      }
    }
  });

  it('reads End where scrollbars lie over the page and take no room (D134)', () => {
    // macOS by default: the tab says 0, and the bottom is the one reported.
    const viewer = new FakeViewer(pages(300), 1.25, 749, 593);
    const tracker = new PdfViewerTracker(pages(300));
    tracker.setScrollbarWidth(0);
    send(tracker, viewer, 1_000);
    tracker.place(tracker.doubt!, 0);
    expect(runTo(tracker, viewer, viewer.maxScroll)?.index).toBe(viewer.topPage());
    expect(viewer.topPage()).toBeGreaterThanOrEqual(298);
    expect(runTo(tracker, viewer, 0)).toEqual({ index: 0, fraction: 0 });
  });

  it('reads a page key and a click on the scrollbar\'s track, with a scrollbar across (D134)', () => {
    // Wider than the view. A key steps by 87.5% of the height Chrome
    // reports; a click on the track of the scrollbar down the side steps by
    // that share of the view less the scrollbar across. Each step is more
    // than half a page here, so read as a scroll it lands a page off.
    for (const less of [0, 15]) {
      const viewer = new FakeViewer(pages(30), 1, 749, 593);
      viewer.scrollbar = 15;
      expect(viewer.scrollbarAcross).toBe(true);
      const tracker = new PdfViewerTracker(pages(30));
      tracker.setScrollbarWidth(15);
      send(tracker, viewer, 1_000);
      tracker.place(tracker.doubt!, 0);
      for (let press = 0; press < 12; press += 1) {
        viewer.scrollTo(
          Math.round(viewer.scroll + PDF_VIEWER_PAGE_KEY_SHARE * (viewer.viewportHeight - less)),
        );
        expect(keyed(tracker, send(tracker, viewer, 400)).index).toBe(viewer.topPage());
      }
      expect(viewer.topPage()).toBeGreaterThan(5);
    }
  });

  it('takes the bottom within three quarters of a pixel, and within two on a screen scaled by a fraction (D134)', () => {
    const run = (short: number, scale: number | undefined | 'nothing') => {
      const viewer = new FakeViewer(pages(300), 0.7058, 757);
      const tracker = new PdfViewerTracker(pages(300));
      if (scale !== 'nothing') tracker.setScreenScale(scale);
      send(tracker, viewer, 1_000);
      tracker.place(tracker.doubt!, 0);
      runTo(tracker, viewer, viewer.maxScroll - short);
      return { index: tracker.position!.index, last: viewer.topPage() };
    };
    const atEnd = (short: number, scale: number | undefined | 'nothing') => {
      const { index, last } = run(short, scale);
      expect(last).toBeGreaterThanOrEqual(298);
      return index === last;
    };
    // A screen scaled by a whole number, or one the tab has not told of:
    // Chrome's rounding is within half a pixel. A wider allowance would
    // take more stops of a fast movement for End.
    for (const scale of ['nothing', undefined, 1, 2, 3, 1.004, Number.NaN] as const) {
      for (const short of [0, 0.5, 0.7]) expect(atEnd(short, scale)).toBe(true);
      for (const short of [0.9, 1.85, 6]) expect(atEnd(short, scale)).toBe(false);
    }
    // Scaled by a fraction, Chrome stops up to 1.85 px short of the bottom.
    for (const scale of [1.25, 1.33, 1.5, 1.75, 2.5]) {
      for (const short of [0, 0.83, 1.85]) expect(atEnd(short, scale)).toBe(true);
      for (const short of [2.6, 6]) expect(atEnd(short, scale)).toBe(false);
    }
  });

  it('keeps a doubt through scrolling, and takes no page for a report that has passed', () => {
    const viewer = new FakeViewer(pages(300), 1, 700);
    const tracker = new PdfViewerTracker(pages(300));
    send(tracker, viewer, 1_000);
    tracker.place(tracker.doubt!, 0);
    jump(tracker, viewer, viewer.pages[100]!.top + 300);
    const first = tracker.doubt!;

    // The viewer scrolls on before the panel has found the page.
    viewer.scrollTo(viewer.scroll + 100);
    send(tracker, viewer, 400);
    expect(tracker.place(first, 100)).toBeUndefined();
    const second = tracker.doubt!;
    expect(second.episode).toBe(first.episode);
    expect(second.viewport).not.toBe(first.viewport);
    expect(tracker.place(second, 100)).toMatchObject({ index: 100 });
    expect(tracker.position!.fraction).toBeCloseTo(400 / 1056, 2);
  });

  it('has no doubt to look into while a jump is held', () => {
    const viewer = new FakeViewer(pages(100), 0.7, 757);
    const tracker = new PdfViewerTracker(pages(100));
    send(tracker, viewer, 1_000);
    const doubt = tracker.doubt!;
    tracker.place(doubt, 0);
    viewer.scrollTo(viewer.pages[50]!.top * viewer.zoom + 350);
    expect(send(tracker, viewer, 800).kind).toBe('hold');
    // Chrome's second report of the jump, a millisecond on.
    expect(send(tracker, viewer, 1).kind).toBe('hold');

    expect(tracker.doubt).toBeUndefined();
    expect(tracker.place(doubt, 3)).toBeUndefined();
    tracker.settle();
    expect(tracker.doubt).toBeDefined();
  });

  it('does not doubt scrolling, however far or fast: a fling, a drag, one big step of the wheel', () => {
    // A look after scrolling within a page could find a number typed into
    // the page box and not entered; a jump always replaces it.
    const viewer = new FakeViewer(pages(300), 1, 700);
    const tracker = new PdfViewerTracker(pages(300));
    send(tracker, viewer, 1_000);
    tracker.place(tracker.doubt!, 0);

    // One step of a free-spinning wheel: 300 px in one report, no second.
    viewer.scrollTo(viewer.scroll + 300);
    expect(send(tracker, viewer, 800).kind).toBe('hold');
    tracker.settle();
    expect(tracker.doubt).toBeUndefined();

    // A scrollbar drag: 37 pages in ten frames, then it slows to a stop,
    // its last frames a pixel apart or less, two of them handed over
    // together.
    const start = viewer.scroll;
    for (let frame = 1; frame <= 10; frame += 1) {
      viewer.scrollTo(start + (frame / 10) * 37.3 * 1070);
      send(tracker, viewer, 16);
    }
    for (const [step, gap] of [[40, 16], [12, 16], [3, 16], [1, 16], [0.5, 16], [0.5, 1]] as const) {
      viewer.scrollTo(viewer.scroll + step);
      send(tracker, viewer, gap);
    }
    tracker.settle();
    expect(viewer.topPage()).toBeGreaterThan(30);
    expect(tracker.doubt).toBeUndefined();

    // A jump is doubted all the same.
    jump(tracker, viewer, viewer.pages[200]!.top + 300);
    expect(tracker.doubt).toBeDefined();
  });

  it('does not doubt one step of the wheel that moves a third of a page, zoomed far out', () => {
    // 30%: 100 px is more than a fifth of a page, less than a held jump.
    const viewer = new FakeViewer(pages(300), 0.3, 700);
    const tracker = new PdfViewerTracker(pages(300));
    tracker.setViewerZoom(0.3);
    send(tracker, viewer, 1_000);
    // Two pages show whole: the page box holds the one the viewer names.
    tracker.place(tracker.doubt!, viewer.mostVisible());
    expect(tracker.doubt).toBeUndefined();
    viewer.scrollTo(viewer.scroll + 100);
    send(tracker, viewer, 800);
    tracker.settle();
    viewer.scrollTo(viewer.scroll + 100);
    send(tracker, viewer, 800);
    tracker.settle();

    expect(tracker.position?.index).toBe(viewer.topPage());
    expect(tracker.doubt).toBeUndefined();
  });

  it('lists the pages that fit the report at the tab\'s zoom give or take its lag', () => {
    // Thirty pages, each 2 pt wider than the last (cropped scans are like
    // this). Fit to width after a small resize: the viewer is at 71.4%, the
    // tab still says 71.8%. At exactly the tab's zoom another page would be
    // the only one as wide as the report says.
    const sizes = Array.from({ length: 30 }, (_, index) => ({ width: 560 + index * 2, height: 792 }));
    const viewerZoom = 0.714;
    const viewer = new FakeViewer(sizes, viewerZoom, 749, 900);
    const tracker = new PdfViewerTracker(sizes);
    tracker.setViewerZoom(0.718);
    send(tracker, viewer, 1_000);
    tracker.place(tracker.doubt!, 0);
    jump(tracker, viewer, viewer.pages[20]!.top * viewerZoom + 120);

    const doubt = tracker.doubt!;
    expect(viewer.mostVisible()).toBe(20);
    expect(doubt.pages).toContain(20);
    expect(doubt.pages.length).toBeGreaterThan(1);
    // Every page listed is within the lag of the report's width.
    for (const page of doubt.pages) {
      const width = Math.trunc((sizes[page]!.width * 4) / 3);
      expect(Math.abs(doubt.viewport.pageWidth - width * 0.718)).toBeLessThanOrEqual(0.0101 * width + 0.3);
    }
    tracker.place(doubt, 20);
    expect(tracker.position?.index).toBe(20);
    expect(tracker.doubt).toBeUndefined();
  });

  it('has no doubt to look into until Chrome has told of the zoom a report was made at', () => {
    const viewer = new FakeViewer(pages(60), 0.8, 700);
    const tracker = new PdfViewerTracker(pages(60));
    // The tab still says 100%: a page 653 px wide is no page there.
    tracker.setViewerZoom(1);
    send(tracker, viewer, 1_000);
    jump(tracker, viewer, viewer.pages[30]!.top * 0.8 + 100);
    expect(tracker.doubt).toBeUndefined();

    tracker.setViewerZoom(0.8);
    const doubt = tracker.doubt!;
    expect(doubt.pages).toHaveLength(60);
    expect(tracker.place(doubt, 30)).toMatchObject({ index: 30 });
  });

  it('says when the latest report fits no page at the zoom told (D146)', () => {
    const viewer = new FakeViewer(pages(60), 0.8, 700);
    const tracker = new PdfViewerTracker(pages(60));
    expect(tracker.zoomUnfitted).toBe(false);
    // No zoom told: nothing to compare with.
    send(tracker, viewer, 1_000);
    expect(tracker.zoomUnfitted).toBe(false);
    // The tab still says 100%: a page 653 px wide is no page there.
    tracker.setViewerZoom(1);
    expect(tracker.zoomUnfitted).toBe(true);
    expect(tracker.doubt).toBeUndefined();
    // Told, and within the lag of a fit mode: it fits.
    tracker.setViewerZoom(0.8);
    expect(tracker.zoomUnfitted).toBe(false);
    expect(tracker.doubt).toBeDefined();
    tracker.setViewerZoom(0.809);
    expect(tracker.zoomUnfitted).toBe(false);
    tracker.setViewerZoom(0.82);
    expect(tracker.zoomUnfitted).toBe(true);
    // A view turned a quarter fits no page upright either.
    tracker.setViewerZoom(0.8);
    const turned = new FakeViewer(pages(60).map((size) => ({ width: size.height, height: size.width })), 0.8, 700, 1_200);
    turned.time = viewer.time;
    send(tracker, turned, 1_500);
    expect(tracker.zoomUnfitted).toBe(true);
    expect(tracker.doubt).toBeUndefined();
  });

  it('has no doubt after the two-page view while it holds the zoom of the fit before (D146)', () => {
    // The round D134's recheck saw go wrong once on Chrome 138: the viewer
    // at 50% after fit to height (71%), and the panel never told of it. The
    // reports are those Chrome 154 sent for the two-page view switched off.
    const sizes = pages(300).map((size, index) => (index === 149 ? { width: 842, height: 595 } : size));
    const at = (pageY: number, pageX: number, pageWidth = 408): PdfViewerViewport =>
      ({ pageX, pageY, pageWidth, viewportWidth: 593, viewportHeight: 749 });
    const viewer = new FakeViewer(sizes, 0.5, 749, 593);
    const tracker = new PdfViewerTracker(sizes);
    tracker.setViewerZoom(0.7101);
    send(tracker, viewer, 1_000);
    for (let step = 0; step < 12; step += 1) {
      viewer.scrollTo(viewer.scroll + 100);
      send(tracker, viewer, 50);
    }
    let time = viewer.time + 1_800;
    tracker.update(at(-132.5, 155.5, 406), time);
    tracker.update(at(1.5, 2.5, 406), time + 5.7);
    time += 4_500;
    tracker.update(at(213.5, -60.5), time);
    tracker.update(at(1.5, 92.5), time + 3.7);
    tracker.update(at(1.5, 92.5), time + 6.2);
    tracker.settle();
    // Read as the top of the PDF, 16 pages off, and nothing to look into.
    expect(tracker.position).toEqual({ index: 0, fraction: 0 });
    expect(tracker.doubt).toBeUndefined();
    expect(tracker.zoomUnfitted).toBe(true);

    // Chrome asked for the tab's zoom: the guess can be looked into.
    tracker.setViewerZoom(0.5);
    expect(tracker.zoomUnfitted).toBe(false);
    expect(tracker.place(tracker.doubt!, 16)).toEqual({ index: 16, fraction: 0 });
  });

  it('takes only a page the report fits', () => {
    const sizes = [...pages(5), LANDSCAPE, ...pages(5)];
    const viewer = new FakeViewer(sizes, 0.5, 700);
    const tracker = new PdfViewerTracker(sizes);
    send(tracker, viewer, 1_000);
    const doubt = tracker.doubt!;

    // The last page cannot be the most visible one at the very top of the view.
    expect(doubt.pages).toEqual([0, 1, 2, 3, 4, 6, 7, 8, 9]);
    expect(tracker.place(doubt, 5)).toBeUndefined();
    expect(tracker.place(doubt, 99)).toBeUndefined();
    expect(tracker.doubt).toBeDefined();
  });

  it('names the one page a report fits: a page of a width of its own', () => {
    const sizes = [...pages(5), LANDSCAPE, ...pages(5)];
    const viewer = new FakeViewer(sizes, 0.5, 700);
    const tracker = new PdfViewerTracker(sizes);
    send(tracker, viewer, 1_000);
    jump(tracker, viewer, viewer.pages[5]!.top * viewer.zoom + 40);

    expect(tracker.position?.index).toBe(5);
    // Reading the doubt changes nothing; taking the page ends it.
    const doubt = tracker.doubt!;
    expect(doubt.pages).toEqual([5]);
    expect(tracker.doubt).toEqual(doubt);
    expect(tracker.place(doubt, 5)).toBeUndefined();
    expect(tracker.doubt).toBeUndefined();
    expect(tracker.position?.index).toBe(5);
  });

  it('lists the pages as wide as the report says at the viewer\'s zoom', () => {
    // US Letter and A4 pages: 816 and 793 px wide at 100%.
    const a4: PdfPagePoints = { width: 595.28, height: 841.89 };
    const sizes = [LETTER, a4, LETTER, a4, a4, LETTER];
    const viewer = new FakeViewer(sizes, 0.75, 700);
    const tracker = new PdfViewerTracker(sizes);
    send(tracker, viewer, 1_000);
    tracker.place(tracker.doubt!, 0);
    // A zoom and a jump onto an A4 page at once: the report fits a Letter
    // page at another zoom too.
    viewer.zoom = 0.5;
    viewer.scrollTo(viewer.pages[3]!.top * viewer.zoom + 100);
    send(tracker, viewer, 800);
    send(tracker, viewer, 1);
    tracker.settle();

    tracker.setViewerZoom(0.5);
    const doubt = tracker.doubt!;
    expect(doubt.pages).toEqual([1, 3, 4]);
    expect(tracker.place(doubt, 3)).toMatchObject({ index: 3 });

    // One page of that width: the doubt names it alone.
    const single = [LETTER, LETTER, a4, LETTER];
    const other = new FakeViewer(single, 0.75, 700);
    const lone = new PdfViewerTracker(single);
    send(lone, other, 1_000);
    lone.place(lone.doubt!, 0);
    other.zoom = 0.5;
    other.scrollTo(other.pages[2]!.top * other.zoom + 100);
    send(lone, other, 800);
    send(lone, other, 1);
    lone.settle();
    lone.setViewerZoom(0.5);
    const only = lone.doubt!;
    expect(only.pages).toEqual([2]);
    lone.place(only, 2);
    expect(lone.position?.index).toBe(2);
    expect(lone.doubt).toBeUndefined();
  });

  it('does not doubt a zoom, though Chrome reports it twice at once as it does a jump', () => {
    const viewer = new FakeViewer(pages(60), 1, 700);
    const tracker = new PdfViewerTracker(pages(60));
    send(tracker, viewer, 1_000);
    tracker.place(tracker.doubt!, 0);
    jump(tracker, viewer, viewer.pages[39]!.top + 300);
    tracker.place(tracker.doubt!, 39);
    const before = tracker.position;

    // Each zoom keeps the place: one report, and the same again 3 ms later.
    for (const zoom of [1.1, 1.25, 1.5, 1.25, 1, 0.9, 0.75, 0.5, 1]) {
      const place = viewer.scroll / viewer.zoom;
      viewer.zoom = zoom;
      viewer.scrollTo(Math.round(place * zoom));
      expect(send(tracker, viewer, 1_500).kind, `zoom ${zoom}`).toBe('same');
      expect(send(tracker, viewer, 3).kind, `zoom ${zoom}`).toBe('same');
      expect(tracker.doubt, `zoom ${zoom}`).toBeUndefined();
    }
    expect(tracker.position).toBe(before);
    // A jump at the zoom it now has is doubted as ever.
    jump(tracker, viewer, viewer.pages[9]!.top + 300);
    expect(tracker.doubt).toBeDefined();
    // And so is a jump right after a zoom, with the zoom's own pair between.
    tracker.place(tracker.doubt!, 9);
    viewer.zoom = 0.8;
    viewer.scrollTo(Math.round((viewer.pages[9]!.top + 300) * 0.8));
    send(tracker, viewer, 1_500);
    send(tracker, viewer, 3);
    expect(tracker.doubt).toBeUndefined();
    jump(tracker, viewer, (viewer.pages[29]!.top + 300) * 0.8);
    expect(tracker.doubt).toBeDefined();
  });

  it('takes no page once the viewer has sent a report that was not read', () => {
    // The two-page view: pages 4 px narrower, side by side, not followed.
    const viewer = new FakeViewer(pages(40), 0.5, 700, 1200);
    const tracker = new PdfViewerTracker(pages(40));
    send(tracker, viewer, 1_000);
    jump(tracker, viewer, viewer.pages[19]!.top * 0.5 + 100);
    const doubt = tracker.doubt!;
    const before = tracker.position;
    viewer.time += 2_000;
    const twoPage = { ...viewer.report(), pageWidth: (816 - 4) * 0.5, pageX: 180, pageY: -40 };
    expect(tracker.update(twoPage, viewer.time).kind).toBe('same');

    // The capture that answers the doubt shows another view by now.
    expect(tracker.doubt).toBeUndefined();
    expect(tracker.place(doubt, 30)).toBeUndefined();
    expect(tracker.position).toBe(before);

    // A page laid beside another (a report the layout does not fit): the same.
    const other = new PdfViewerTracker(pages(40));
    const again = new FakeViewer(pages(40), 0.5, 700, 1200);
    again.scrollTo(150);
    send(other, again, 1_000);
    const first = other.doubt!;
    again.time += 2_000;
    expect(other.update({ ...again.report(), pageX: 900 }, again.time).kind).toBe('same');
    expect(other.doubt).toBeUndefined();
    expect(other.place(first, 12)).toBeUndefined();
    // A report that is read again brings a doubt of its own back.
    send(other, again, 2_000);
    expect(other.doubt?.viewport).toEqual(again.report());
    expect(other.place(other.doubt!, 0)).toBeUndefined();
    expect(other.doubt).toBeUndefined();
  });

  it('doubts a jump from a page top to a page top that also moves sideways', () => {
    // A link whose target sits a few pixels across: only `pageX` changes.
    const viewer = new FakeViewer(pages(40), 1, 700, 600);
    const tracker = new PdfViewerTracker(pages(40));
    send(tracker, viewer, 1_000);
    tracker.place(tracker.doubt!, 0);
    viewer.scrollTo(viewer.pages[9]!.top - 3);
    viewer.scrollX = 8;
    expect(send(tracker, viewer, 800).kind).toBe('same');
    send(tracker, viewer, 1);

    expect(tracker.place(tracker.doubt!, 9)).toEqual({ index: 9, fraction: 0 });
  });

  it('has no doubt while the view is turned, and one once it is upright again', () => {
    const turned = pages(40).map((size) => ({ width: size.height, height: size.width }));
    const viewer = new FakeViewer(pages(40), 0.8, 700);
    const tracker = new PdfViewerTracker(pages(40));
    tracker.setViewerZoom(0.8);
    send(tracker, viewer, 1_000);
    tracker.place(tracker.doubt!, 0);
    viewer.scrollTo(1_500);
    send(tracker, viewer, 800);
    expect(tracker.doubt).toBeUndefined();

    // Ctrl+]: the same zoom, pages 1,056 px wide where they were 816.
    const rotated = new FakeViewer(turned, 0.8, 700);
    rotated.time = viewer.time;
    rotated.scrollTo(rotated.pages[1]!.top * 0.8);
    send(tracker, rotated, 800);
    rotated.scrollTo(rotated.scroll + 100);
    send(tracker, rotated, 400);
    expect(tracker.doubt).toBeUndefined();

    // Upright again: followed from a guess, which the panel may look into.
    viewer.time = rotated.time;
    viewer.scrollTo(viewer.pages[7]!.top * 0.8);
    send(tracker, viewer, 800);
    tracker.settle();
    const doubt = tracker.doubt!;
    expect(doubt.pages).toContain(7);
    expect(tracker.place(doubt, 7)?.index).toBe(7);
    expect(tracker.doubt).toBeUndefined();
  });

  it('doubts the place after a turn back that reads as the top of the PDF', () => {
    // As Chrome 154 reported it at 100%, in a view narrower than the page,
    // for a PDF with one wider page: the turn back comes as the page where
    // the view was scrolled while turned, then the top of that page twice.
    // Read as a movement that stopped at the top of the PDF, which Home is.
    const sizes = pages(300).map((size, index) => (index === 149 ? { width: 842, height: 595 } : size));
    const turned = sizes.map((size) => ({ width: size.height, height: size.width }));
    const back = (pageY: number, pageX: number): PdfViewerViewport =>
      ({ pageX, pageY, pageWidth: 816, viewportWidth: 593, viewportHeight: 749 });
    const turnedBack = (snap: number | undefined) => {
      const viewer = new FakeViewer(sizes, 1, 749, 593);
      const tracker = new PdfViewerTracker(sizes);
      tracker.setViewerZoom(1);
      send(tracker, viewer, 1_000);
      tracker.place(tracker.doubt!, 0);
      for (let step = 0; step < 12; step += 1) {
        viewer.scrollTo(viewer.scroll + 100);
        send(tracker, viewer, 50);
      }
      expect(tracker.position?.index).toBe(1);
      const rotated = new FakeViewer(turned, 1, 749, 593);
      rotated.time = viewer.time;
      rotated.scrollTo(rotated.pages[4]!.top + 617);
      expect(send(tracker, rotated, 1_500).kind).toBe('same');
      expect(tracker.doubt).toBeUndefined();

      const time = rotated.time + 1_500;
      expect(tracker.update(back(-617, 158), time).kind).toBe('hold');
      expect(tracker.update(back(3, 5), time + 3.5).kind).toBe('hold');
      if (snap !== undefined) {
        expect(tracker.update(back(3, 5), time + 3.5 + snap).kind).toBe('hold');
      }
      tracker.settle();
      // The fake viewer where Chrome's is: page 5, its left edge in view.
      viewer.time = time + 4 + (snap ?? 0);
      viewer.scrollX = 153;
      viewer.scrollTo(viewer.pages[4]!.top - 3);
      return { tracker, viewer };
    };

    // The second of the two reports came 0.1 ms after the first. Late, from
    // a busy viewer, or not at all, the place is a guess all the same.
    for (const snap of [0.1, 120, undefined]) {
      const { tracker, viewer } = turnedBack(snap);
      expect(tracker.position).toEqual({ index: 0, fraction: 0 });
      const doubt = tracker.doubt!;
      // Every page but the wide one.
      expect(doubt.pages).toHaveLength(299);
      expect(tracker.place(doubt, 4)).toEqual({ index: 4, fraction: 0 });

      // Home after that is the top of the PDF, as ever.
      for (let frame = 9; frame >= 0; frame -= 1) {
        viewer.scrollTo(viewer.scroll * (frame / 10));
        send(tracker, viewer, frame === 9 ? 2_000 : 16);
      }
      expect(tracker.settle()).toEqual({ index: 0, fraction: 0 });
      expect(tracker.doubt).toBeUndefined();
    }
  });

  it('doubts the place after a turn back in fit to height that reads as an end of the PDF', () => {
    // As Chrome 154 reported it, the tab's new zoom told first: where the
    // page sat while turned (twice), then the top of the page (twice). In
    // fit to height the top of any page is where the PDF's first page shows
    // at its top and its last page at its bottom.
    const sizes = pages(300).map((size, index) => (index === 149 ? { width: 842, height: 595 } : size));
    const zoom = 0.702626641651032;
    const at = (pageY: number, pageX: number, pageWidth = 816 * zoom): PdfViewerViewport =>
      ({ pageX, pageY, pageWidth, viewportWidth: 593, viewportHeight: 749 });
    for (const snapped of [true, false]) {
      const viewer = new FakeViewer(sizes, zoom, 749, 593);
      viewer.scrollX = 108;
      const tracker = new PdfViewerTracker(sizes);
      tracker.setViewerZoom(zoom);
      send(tracker, viewer, 1_000);
      tracker.place(tracker.doubt!, 0);
      for (let step = 0; step < 12; step += 1) {
        viewer.scrollTo(viewer.scroll + 100);
        send(tracker, viewer, 50);
      }
      expect(tracker.position?.index).toBe(1);
      // Ctrl+]: fit to height turns at 90.7%, a page 957.6 px wide.
      tracker.setViewerZoom(0.9067796610169492);
      let time = viewer.time + 1_800;
      expect(tracker.update(at(2.97, 4.53, 1056 * 0.9067796610169492), time).kind).toBe('same');
      expect(tracker.doubt).toBeUndefined();

      // Ctrl+[.
      time += 4_500;
      tracker.setViewerZoom(zoom);
      expect(tracker.update(at(270.42, 111.02), time).kind).toBe('move');
      expect(tracker.update(at(270.16, 111.02), time + 2.2).kind).toBe('move');
      expect(tracker.update(at(2.11, 3.51), time + 5.2).kind).toBe('hold');
      if (snapped) expect(tracker.update(at(1.97, 3.02), time + 5.2).kind).toBe('hold');
      tracker.settle();
      // The snapped report is 0.14 px off the top: the bottom, then.
      expect(tracker.position).toEqual({ index: snapped ? 299 : 0, fraction: 0 });
      expect(tracker.place(tracker.doubt!, 6)).toEqual({ index: 6, fraction: 0 });
    }
  });

  it('doubts the place after the two-page view when it reads as the top of the PDF', () => {
    // As Chrome 154 reported it at 50% for the same PDF: the two-page view
    // switched off comes as a page somewhere across the view, then the top
    // of a page twice, 2.5 ms apart.
    const sizes = pages(300).map((size, index) => (index === 149 ? { width: 842, height: 595 } : size));
    const at = (pageY: number, pageX: number, pageWidth = 408): PdfViewerViewport =>
      ({ pageX, pageY, pageWidth, viewportWidth: 593, viewportHeight: 749 });
    for (const snapped of [true, false]) {
      const viewer = new FakeViewer(sizes, 0.5, 749, 593);
      const tracker = new PdfViewerTracker(sizes);
      tracker.setViewerZoom(0.5);
      send(tracker, viewer, 1_000);
      tracker.place(tracker.doubt!, 0);
      for (let step = 0; step < 12; step += 1) {
        viewer.scrollTo(viewer.scroll + 100);
        send(tracker, viewer, 50);
      }
      expect(tracker.position?.index).toBe(2);
      // Two pages wide: each page 4 px narrower at 100%. Not followed.
      let time = viewer.time + 1_800;
      expect(tracker.update(at(-132.5, 155.5, 406), time).kind).toBe('same');
      expect(tracker.update(at(1.5, 2.5, 406), time + 5.7).kind).toBe('same');
      expect(tracker.doubt).toBeUndefined();

      time += 4_500;
      expect(tracker.update(at(213.5, -60.5), time).kind).toBe('same');
      expect(tracker.update(at(1.5, 92.5), time + 3.7).kind).toBe('hold');
      if (snapped) expect(tracker.update(at(1.5, 92.5), time + 6.2).kind).toBe('hold');
      tracker.settle();
      expect(tracker.position).toEqual({ index: 0, fraction: 0 });
      expect(tracker.place(tracker.doubt!, 16)).toEqual({ index: 16, fraction: 0 });
    }
  });

  it('does not doubt Home after a turn back that was read at once', () => {
    const turned = pages(40).map((size) => ({ width: size.height, height: size.width }));
    const viewer = new FakeViewer(pages(40), 0.8, 700);
    const tracker = new PdfViewerTracker(pages(40));
    tracker.setViewerZoom(0.8);
    send(tracker, viewer, 1_000);
    tracker.place(tracker.doubt!, 0);
    viewer.scrollTo(1_500);
    send(tracker, viewer, 800);
    tracker.settle();
    const rotated = new FakeViewer(turned, 0.8, 700);
    rotated.time = viewer.time;
    rotated.scrollTo(rotated.pages[1]!.top * 0.8);
    send(tracker, rotated, 800);

    // Upright again a little further down: a small move, read at once.
    viewer.time = rotated.time;
    viewer.scrollTo(1_530);
    expect(send(tracker, viewer, 800).kind).toBe('move');
    expect(tracker.doubt).toBeDefined();

    for (let frame = 9; frame >= 0; frame -= 1) {
      viewer.scrollTo(viewer.scroll * (frame / 10));
      send(tracker, viewer, frame === 9 ? 2_000 : 16);
    }
    expect(tracker.settle()).toEqual({ index: 0, fraction: 0 });
    expect(tracker.doubt).toBeUndefined();

    // Turned and back again, far from where it was: one report, held. Home
    // pressed before the tracker has read it is the top of the PDF as well.
    rotated.time = viewer.time;
    send(tracker, rotated, 800);
    viewer.time = rotated.time;
    viewer.scrollTo(viewer.pages[20]!.top * 0.8 + 300);
    expect(send(tracker, viewer, 800).kind).toBe('hold');
    for (let frame = 9; frame >= 0; frame -= 1) {
      viewer.scrollTo(viewer.scroll * (frame / 10));
      send(tracker, viewer, frame === 9 ? 120 : 16);
    }
    expect(tracker.settle()).toEqual({ index: 0, fraction: 0 });
    expect(tracker.doubt).toBeUndefined();
  });

  it('doubts a jump made while the viewer still scrolls', () => {
    const viewer = new FakeViewer(pages(300), 1, 700);
    const tracker = new PdfViewerTracker(pages(300));
    send(tracker, viewer, 1_000);
    tracker.place(tracker.doubt!, 0);

    // An outline entry clicked before a wheel turn has stopped: the top of
    // page 200, and the same place again a millisecond later.
    for (let frame = 0; frame < 12; frame += 1) {
      viewer.scrollTo(viewer.scroll + 30);
      send(tracker, viewer, frame === 0 ? 800 : 16);
    }
    expect(tracker.doubt).toBeUndefined();
    viewer.scrollTo(viewer.pages[199]!.top - 3);
    expect(send(tracker, viewer, 30).kind).toBe('hold');
    expect(send(tracker, viewer, 1).kind).toBe('hold');
    tracker.settle();
    // Read as the top of the PDF, as before, and doubted.
    expect(tracker.position).toEqual({ index: 0, fraction: 0 });
    expect(tracker.place(tracker.doubt!, 199)).toEqual({ index: 199, fraction: 0 });

    // A link followed during a scrollbar drag that is held (3.73 pages a
    // frame): part-way down page 41.
    const start = viewer.scroll;
    for (let frame = 1; frame <= 6; frame += 1) {
      viewer.scrollTo(start - (frame / 10) * 37.3 * 1070);
      expect(send(tracker, viewer, frame === 1 ? 800 : 16).kind).toBe('hold');
    }
    viewer.scrollTo(viewer.pages[40]!.top + 420);
    expect(send(tracker, viewer, 16).kind).toBe('hold');
    expect(send(tracker, viewer, 1).kind).toBe('hold');
    tracker.settle();
    expect(tracker.place(tracker.doubt!, 40)).toMatchObject({ index: 40 });
    expect(tracker.position!.fraction).toBeCloseTo(420 / 1056, 2);
  });

  it('doubts a jump made mid-scroll that lands where the scrolling was heading (D146)', () => {
    // As Chrome 154 reported it at 86%, a view 593 by 749: wheel steps of
    // 100 px every 50 ms from the top of page 67, and a jump to the top of
    // page 256 made 35 ms after the last. The jump is 125 px on from the
    // last step, which is where the next step would be: followed as a
    // frame of the scrolling. Its place comes again 1.5 ms later.
    const tracker = new PdfViewerTracker(pages(300));
    tracker.setViewerZoom(0.8648409893992933);
    const at = (pageY: number, pageX = 4.644876325088347): PdfViewerViewport =>
      ({ pageX, pageY, pageWidth: 705.7102473498234, viewportWidth: 593, viewportHeight: 749 });
    tracker.update(at(2.59452296819788, 4.324204946996474), 1_000);
    tracker.update(at(2.67), 1_001);
    tracker.place(tracker.doubt!, 66);
    expect(tracker.position).toMatchObject({ index: 66 });
    const frames: [number, number][] = [
      [0, -97.33480565370701], [50, -197.334805653707], [100, -297.334805653707],
      [149.8, -397.334805653707], [199.9, -497.334805653707], [251, 328.04505300353776],
      [299.9, 228.04505300353776], [349.8, 128.04505300353776],
    ];
    for (const [time, pageY] of frames) {
      expect(tracker.update(at(pageY), 3_000 + time).kind).toBe('move');
    }
    expect(tracker.doubt).toBeUndefined();
    // The jump, read as a frame, and its place again.
    expect(tracker.update(at(2.594522968196543, 4.324204946996474), 3_385.3).kind).toBe('move');
    expect(tracker.position).toMatchObject({ index: 67 });
    expect(tracker.doubt).toBeUndefined();
    tracker.update(at(3.0053003533685114), 3_386.8);
    expect(tracker.doubt?.page).toBe(67);
    // A wheel step still on its way: the doubt stays through it.
    expect(tracker.update(at(-96.99469964663149), 3_404.5).kind).toBe('move');
    const doubt = tracker.doubt!;
    expect(doubt.pages).toContain(255);
    expect(tracker.place(doubt, 255)).toMatchObject({ index: 255 });
  });

  it('doubts no frame of a movement that repeats a place late or after a small step (D146)', () => {
    const viewer = new FakeViewer(pages(300), 1, 700);
    const tracker = new PdfViewerTracker(pages(300));
    send(tracker, viewer, 1_000);
    tracker.place(tracker.doubt!, 0);
    // A movement slowing to a stop: steps under 8 px, and the last place
    // reported again a millisecond later.
    for (const [index, step] of [30, 30, 30, 20, 12, 6, 4, 2].entries()) {
      viewer.scrollTo(viewer.scroll + step);
      send(tracker, viewer, index === 0 ? 800 : 16);
    }
    viewer.time += 1;
    tracker.update(viewer.report(), viewer.time);
    expect(tracker.doubt).toBeUndefined();
    // And once more with the very same time, as Chrome's reports can have.
    tracker.update(viewer.report(), viewer.time);
    expect(tracker.doubt).toBeUndefined();

    // A frame that moved a whole page reports the same place too, on
    // another page: a frame later, not at once.
    for (let frame = 0; frame < 6; frame += 1) {
      viewer.scrollTo(viewer.scroll + 30);
      send(tracker, viewer, frame === 0 ? 800 : 16);
    }
    viewer.scrollTo(viewer.scroll + 1_070);
    send(tracker, viewer, 16);
    expect(tracker.doubt).toBeUndefined();
    // The same a step of 30 px on, 9 ms later: later than a jump's second report.
    viewer.scrollTo(viewer.scroll + 30);
    send(tracker, viewer, 16);
    viewer.scrollTo(viewer.scroll + 1_070);
    send(tracker, viewer, 9);
    expect(tracker.doubt).toBeUndefined();
    // And at once: taken for a jump, and looked into.
    viewer.scrollTo(viewer.scroll + 30);
    send(tracker, viewer, 16);
    viewer.scrollTo(viewer.scroll + 1_070);
    send(tracker, viewer, 2);
    expect(tracker.doubt).toBeDefined();

    // In a movement held as too fast to follow: as far down again at once,
    // and 5 px across, is another place.
    const held = new FakeViewer(pages(300), 1, 700);
    const other = new PdfViewerTracker(pages(300));
    send(other, held, 1_000);
    other.place(other.doubt!, 0);
    for (let frame = 1; frame <= 4; frame += 1) {
      held.scrollTo(frame * 3.73 * 1_070);
      expect(send(other, held, frame === 1 ? 800 : 16).kind).toBe('hold');
    }
    held.scrollTo(held.pages[40]!.top + 420);
    expect(send(other, held, 16).kind).toBe('hold');
    held.scrollX = 5;
    expect(send(other, held, 1).kind).toBe('hold');
    other.settle();
    expect(other.doubt).toBeUndefined();
  });

  it('doubts a jump whose second report a slow viewer sends late (D146)', () => {
    const viewer = new FakeViewer(pages(300), 1, 700);
    const tracker = new PdfViewerTracker(pages(300));
    send(tracker, viewer, 1_000);
    tracker.place(tracker.doubt!, 0);
    jump(tracker, viewer, viewer.pages[199]!.top + 300);
    tracker.place(tracker.doubt!, 199);

    // A link to page 41, about as far down its page: read as a wheel step.
    // The same place again 31 ms later, as a viewer slowed 8 times sent it.
    viewer.scrollTo(viewer.pages[40]!.top + 328);
    expect(moved(send(tracker, viewer, 800)).index).toBe(199);
    expect(tracker.doubt).toBeUndefined();
    send(tracker, viewer, 31);
    expect(tracker.place(tracker.doubt!, 40)).toMatchObject({ index: 40 });

    // The page box to a place far down another page: held as a lone jump,
    // and the same place again 40 ms later (a PDF of 11,111 pages).
    viewer.scrollTo(viewer.pages[119]!.top + 900);
    expect(send(tracker, viewer, 800).kind).toBe('hold');
    expect(send(tracker, viewer, 40).kind).toBe('hold');
    tracker.settle();
    // The page after it is the most visible there.
    expect(viewer.mostVisible()).toBe(120);
    expect(tracker.place(tracker.doubt!, 120)).toMatchObject({ index: 119 });

    // The same place again once the burst is over is a report of its own.
    viewer.scrollTo(viewer.pages[20]!.top + 870);
    send(tracker, viewer, 800);
    expect(tracker.doubt).toBeUndefined();
    send(tracker, viewer, 150);
    expect(tracker.doubt).toBeUndefined();

    // A link to a place as far down another page and 12 px across: it reads
    // as scrolling sideways, and is somewhere else than the report before it.
    viewer.scrollTo(viewer.pages[70]!.top + 870);
    viewer.scrollX = 12;
    expect(send(tracker, viewer, 800).kind).toBe('same');
    expect(tracker.doubt).toBeUndefined();
    send(tracker, viewer, 31);
    expect(viewer.mostVisible()).toBe(71);
    expect(tracker.place(tracker.doubt!, 71)).toMatchObject({ index: 70 });
  });

  it('takes no key for a jump where the viewer cannot move: one place again every 30 ms (D146)', () => {
    // Chrome's viewer reports every arrow, Page Down and Space press, also
    // when nothing moves. At the end of the PDF: one press, the keyboard's
    // wait, then the same place again every 30 ms.
    const viewer = new FakeViewer(pages(120), 0.865, 749, 979);
    const tracker = new PdfViewerTracker(pages(120));
    tracker.setViewerZoom(0.865);
    viewer.scrollTo(viewer.maxScroll);
    send(tracker, viewer, 1_000);
    tracker.place(tracker.doubt!, viewer.mostVisible());
    const atEnd = tracker.position;
    const again = (gapMs: number): void => {
      viewer.time += gapMs;
      tracker.update(viewer.report(), viewer.time);
      tracker.settle();
      expect(tracker.doubt, `after ${gapMs} ms`).toBeUndefined();
      expect(tracker.position).toEqual(atEnd);
    };
    again(800);
    again(400);
    for (let repeat = 0; repeat < 10; repeat += 1) again(30);
    // Two presses 70 ms apart, and a key held again.
    again(800);
    again(70);
    again(900);
    again(400);
    for (let repeat = 0; repeat < 6; repeat += 1) again(33);

    // Arrow Left at the far left of a page wider than the view, mid-page.
    const wide = new FakeViewer(pages(120), 1.5, 749, 979);
    const other = new PdfViewerTracker(pages(120));
    other.setViewerZoom(1.5);
    wide.scrollTo(wide.pages[39]!.top * 1.5 + 300);
    send(other, wide, 1_000);
    other.place(other.doubt!, 39);
    for (const gapMs of [800, 400, 30, 30, 30, 30, 800, 80]) {
      wide.time += gapMs;
      other.update(wide.report(), wide.time);
      expect(other.doubt, `far left, after ${gapMs} ms`).toBeUndefined();
    }
    expect(other.position).toMatchObject({ index: 39 });
  });

  it('still takes a jump to the place the report before it named, when its second report comes at once (D146)', () => {
    // From one page's top left corner to another's: both reports name the
    // place the viewer rested at. Told from a key only by how soon the
    // second comes: within the 20 ms of D133, where a key repeats in 30.
    const corner = (viewer: FakeViewer, page: number): void => {
      viewer.scrollTo(viewer.pages[page]!.top * viewer.zoom);
      viewer.scrollX = 5 * viewer.zoom;
    };
    for (const [gapMs, jump] of [[2, true], [19, true], [31, false]] as const) {
      const viewer = new FakeViewer(pages(120), 1.5, 749, 593);
      const tracker = new PdfViewerTracker(pages(120));
      tracker.setViewerZoom(1.5);
      corner(viewer, 9);
      send(tracker, viewer, 1_000);
      tracker.place(tracker.doubt!, 9);
      corner(viewer, 49);
      expect(send(tracker, viewer, 800).kind).toBe('same');
      expect(tracker.doubt).toBeUndefined();
      send(tracker, viewer, gapMs);
      expect(tracker.doubt !== undefined, `second report after ${gapMs} ms`).toBe(jump);
      if (jump) expect(tracker.place(tracker.doubt!, 49)).toMatchObject({ index: 49 });
    }
  });

  it('takes no steps of a whole page for a jump (D146)', () => {
    // The zoom at which Page Down moves one page exactly: every press names
    // the place the one before it named, on the next page.
    const zoom = 0.5769;
    const pitch = 1_070 * zoom;
    const viewer = new FakeViewer(pages(300), zoom, pitch / PDF_VIEWER_PAGE_KEY_SHARE, 979);
    const tracker = new PdfViewerTracker(pages(300));
    tracker.setViewerZoom(zoom);
    viewer.scrollTo(viewer.pages[20]!.top * zoom + 120);
    send(tracker, viewer, 1_000);
    tracker.place(tracker.doubt!, viewer.mostVisible());
    const step = (gapMs: number): void => {
      viewer.scrollTo(viewer.scroll + pitch);
      const track = send(tracker, viewer, gapMs);
      if (track.kind === 'hold') tracker.settle();
      expect(tracker.doubt, `after ${gapMs} ms`).toBeUndefined();
    };
    // Page Down held: a press, the keyboard's wait, repeats every 30 ms.
    step(800);
    step(400);
    for (let repeat = 0; repeat < 6; repeat += 1) step(30);
    // Two presses 70 ms apart, then wheel steps of one page 50 ms apart.
    step(800);
    step(70);
    step(900);
    for (let repeat = 0; repeat < 3; repeat += 1) step(50);
    expect(viewer.topPage()).toBe(34);
  });

  it('takes half a pixel for another place on a screen scaled by 2 after a lone report too (D146)', () => {
    // A lone report half a CSS pixel on is somewhere else there: its place
    // again 31 ms later is a slow viewer's second report.
    const viewer = new FakeViewer(pages(300), 1, 700);
    const tracker = new PdfViewerTracker(pages(300));
    tracker.setScreenScale(2);
    viewer.scrollTo(viewer.pages[39]!.top + 300);
    send(tracker, viewer, 1_000);
    tracker.place(tracker.doubt!, 39);
    viewer.scrollTo(viewer.scroll + 0.5);
    send(tracker, viewer, 800);
    expect(tracker.doubt).toBeUndefined();
    send(tracker, viewer, 31);
    expect(tracker.doubt).toBeDefined();
  });

  it('doubts an outline entry that sets a zoom: a zoom, then another place twice at once (D146)', () => {
    // As Chrome 154 reported "page 50 at 150%" from the top of page 1 at
    // 100% (80 pages, a view 593 by 749): the zoom at the same place, then
    // the top left corner of the page gone to, four times, and that snapped.
    // The place is 4.5 px down and 7.5 px across from the zoom's: it reads
    // as a small scroll within the page.
    const tracker = new PdfViewerTracker(pages(80));
    tracker.setViewerZoom(1);
    const at = (pageX: number, pageY: number, pageWidth = 1_224): PdfViewerViewport =>
      ({ pageX, pageY, pageWidth, viewportWidth: 593, viewportHeight: 749 });
    tracker.update(at(5, 3, 816), 1_000);
    tracker.place(tracker.doubt!, 0);
    expect(tracker.update(at(7.5, 4.5), 3_000).kind).toBe('same');
    tracker.update(at(0, 0), 3_000.1);
    expect(tracker.doubt).toBeUndefined();
    tracker.update(at(0, 0), 3_000.1);
    tracker.update(at(0, 0), 3_000.3);
    // Chrome tells of the zoom apart from the viewer's reports.
    tracker.setViewerZoom(1.5);
    tracker.update(at(0, 0), 3_000.8);
    tracker.update(at(-0.5, -0.5), 3_000.9);
    expect(tracker.position).toMatchObject({ index: 0 });
    const doubt = tracker.doubt!;
    expect(doubt.pages).toHaveLength(80);
    expect(tracker.place(doubt, 49)).toMatchObject({ index: 49 });
  });

  it('does not doubt scrolling that begins straight after a zoom (D146)', () => {
    const viewer = new FakeViewer(pages(60), 1, 700);
    const tracker = new PdfViewerTracker(pages(60));
    send(tracker, viewer, 1_000);
    tracker.place(tracker.doubt!, 0);
    jump(tracker, viewer, viewer.pages[39]!.top + 300);
    tracker.place(tracker.doubt!, 39);
    // The zoom's own pair, then frames of scrolling at once: no place twice.
    viewer.zoom = 1.25;
    viewer.scrollTo(Math.round((viewer.pages[39]!.top + 300) * 1.25));
    expect(send(tracker, viewer, 1_500).kind).toBe('same');
    for (let frame = 0; frame < 8; frame += 1) {
      viewer.scrollTo(viewer.scroll + 5);
      send(tracker, viewer, frame === 0 ? 2 : 16);
    }
    expect(tracker.doubt).toBeUndefined();
    expect(tracker.position?.index).toBe(39);
    // A zoom whose second report is the first snapped to whole pixels is none either.
    const place = viewer.scroll / viewer.zoom;
    viewer.zoom = 1.1;
    viewer.scrollTo(place * 1.1);
    send(tracker, viewer, 1_500);
    viewer.scrollTo(Math.round(viewer.scroll));
    send(tracker, viewer, 1);
    expect(tracker.doubt).toBeUndefined();
  });

  it('takes two reports for one place only under a pixel of the screen apart (D146)', () => {
    // On a screen scaled by 2 the viewer scrolls by half a CSS pixel: the
    // first frames of a slow scroll are no place reported twice.
    const slowScroll = (scale: number | undefined, step: number) => {
      const viewer = new FakeViewer(pages(300), 1, 700);
      const tracker = new PdfViewerTracker(pages(300));
      tracker.setScreenScale(scale);
      viewer.scrollTo(viewer.pages[39]!.top + 300);
      send(tracker, viewer, 1_000);
      tracker.place(tracker.doubt!, 39);
      for (let frame = 0; frame < 6; frame += 1) {
        viewer.scrollTo(viewer.scroll + step);
        send(tracker, viewer, frame === 0 ? 800 : 16);
      }
      return tracker.doubt;
    };
    expect(slowScroll(2, 0.5)).toBeUndefined();
    expect(slowScroll(1.5, 1 / 1.5)).toBeUndefined();
    expect(slowScroll(1.25, 0.8)).toBeUndefined();
    expect(slowScroll(1, 1)).toBeUndefined();
    // A scale under 1 is taken for 1: a whole CSS pixel is a step there too.
    expect(slowScroll(0.5, 1)).toBeUndefined();
    // Not told the scale, half a CSS pixel is the same place, as it was.
    expect(slowScroll(undefined, 0.5)).toBeDefined();

    // A jump's second report is its first snapped to a pixel of the screen:
    // 0.26 CSS px at most at a scale of 2 (Chrome 154), 0.35 at 1.5, 0.41 at 1.25.
    for (const [scale, snap] of [[2, 0.256], [1.5, 0.349], [1.25, 0.407], [1, 0.5]] as const) {
      const viewer = new FakeViewer(pages(300), 1, 700);
      const tracker = new PdfViewerTracker(pages(300));
      tracker.setScreenScale(scale);
      send(tracker, viewer, 1_000);
      tracker.place(tracker.doubt!, 0);
      viewer.scrollTo(viewer.pages[199]!.top + 20.3);
      send(tracker, viewer, 800);
      expect(tracker.doubt, `scale ${scale}`).toBeUndefined();
      viewer.scrollTo(viewer.scroll + snap);
      send(tracker, viewer, 1.5);
      expect(tracker.place(tracker.doubt!, 199), `scale ${scale}`).toMatchObject({ index: 199 });
    }

    // Straight after a zoom, a place more than a pixel of the screen from
    // the zoom's is another place: reported twice at once, a jump.
    {
      const viewer = new FakeViewer(pages(60), 1, 700);
      const tracker = new PdfViewerTracker(pages(60));
      tracker.setScreenScale(2);
      send(tracker, viewer, 1_000);
      tracker.place(tracker.doubt!, 0);
      viewer.zoom = 1.25;
      expect(send(tracker, viewer, 1_500).kind).toBe('same');
      viewer.scrollTo(viewer.scroll + 0.6);
      send(tracker, viewer, 0.1);
      expect(tracker.doubt).toBeUndefined();
      send(tracker, viewer, 0.1);
      expect(tracker.doubt).toBeDefined();
    }

    // Within a movement the tracker holds, too: a jump at a scale of 2, and
    // no jump for a frame half a CSS pixel on from a step.
    for (const [again, jumped] of [[0.25, true], [0.5, false]] as const) {
      const viewer = new FakeViewer(pages(300), 1, 700);
      const tracker = new PdfViewerTracker(pages(300));
      tracker.setScreenScale(2);
      send(tracker, viewer, 1_000);
      tracker.place(tracker.doubt!, 0);
      const start = viewer.scroll;
      for (let frame = 1; frame <= 4; frame += 1) {
        viewer.scrollTo(start + frame * 3.73 * 1_070);
        expect(send(tracker, viewer, frame === 1 ? 800 : 16).kind).toBe('hold');
      }
      viewer.scrollTo(viewer.pages[40]!.top + 420);
      expect(send(tracker, viewer, 16).kind).toBe('hold');
      viewer.scrollTo(viewer.scroll + again);
      expect(send(tracker, viewer, 1).kind).toBe('hold');
      tracker.settle();
      expect(tracker.doubt !== undefined, `again ${again}`).toBe(jumped);
    }
  });

  it('has no doubt to look into when Simul opens on a turned view', () => {
    // Fit to width; the tab's zoom comes after the first report.
    const turned = pages(40).map((size) => ({ width: size.height, height: size.width }));
    const rotated = new FakeViewer(turned, 0.5563, 749, 593);
    const tracker = new PdfViewerTracker(pages(40));
    tracker.setViewerZoom(0.718);
    send(tracker, rotated, 1_000);
    expect(tracker.doubt).toBeDefined();

    tracker.setViewerZoom(0.5563);
    expect(tracker.doubt).toBeUndefined();
    // Still turned when the tab's zoom is not known any more.
    tracker.setViewerZoom(undefined);
    expect(tracker.doubt).toBeUndefined();
  });
});

describe('PdfViewerTracker and a view turned a quarter (D123)', () => {
  const turned = (sizes: readonly PdfPagePoints[]) =>
    sizes.map((size) => ({ width: size.height, height: size.width }));

  /** Scrolls the way a wheel does, a frame at a time. */
  function scroll(tracker: PdfViewerTracker, viewer: FakeViewer, frames: number, step = 30): void {
    for (let frame = 0; frame < frames; frame += 1) {
      viewer.scrollTo(viewer.scroll + step);
      send(tracker, viewer, 16);
    }
  }

  /** Home: an animated movement to the top, which the tracker reads exactly. */
  function home(tracker: PdfViewerTracker, viewer: FakeViewer): void {
    const start = viewer.scroll;
    for (let frame = 1; frame <= 10; frame += 1) {
      viewer.scrollTo(start * (1 + Math.cos((Math.PI * frame) / 10)) / 2);
      send(tracker, viewer, 16);
    }
    tracker.settle();
  }

  it('stops following while the view is turned, at a set zoom', () => {
    const viewer = new FakeViewer(pages(40), 0.8, 700);
    const tracker = new PdfViewerTracker(pages(40));
    tracker.setViewerZoom(0.8);
    send(tracker, viewer, 1_000);
    scroll(tracker, viewer, 60);
    expect(tracker.position?.index).toBe(viewer.topPage());
    const before = tracker.position;

    // Ctrl+]: the same zoom, pages 1,056 px wide where they were 816.
    const rotated = new FakeViewer(turned(pages(40)), 0.8, 700);
    rotated.time = viewer.time;
    rotated.scrollTo(rotated.pages[1]!.top * 0.8);
    expect(send(tracker, rotated, 800).kind).toBe('same');
    for (let step = 0; step < 40; step += 1) {
      rotated.scrollTo(rotated.scroll + 100);
      expect(send(tracker, rotated, 40).kind).toBe('same');
    }
    // A key or a jump while turned is not read either.
    rotated.scrollTo(rotated.scroll + PDF_VIEWER_ARROW_STEP);
    expect(send(tracker, rotated, 400).kind).toBe('same');
    rotated.scrollTo(rotated.pages[30]!.top * 0.8);
    expect(send(tracker, rotated, 800).kind).toBe('same');
    expect(tracker.settle()).toBeUndefined();
    expect(tracker.position).toBe(before);

    // Ctrl+[: upright again and followed. Where the viewer is after the
    // turn back is a guess; Home puts the panel right.
    viewer.time = rotated.time;
    viewer.scrollTo(viewer.pages[7]!.top * 0.8 + 200);
    send(tracker, viewer, 800);
    tracker.settle();
    home(tracker, viewer);
    expect(tracker.position).toEqual({ index: 0, fraction: 0 });
    scroll(tracker, viewer, 50);
    expect(tracker.position?.index).toBe(viewer.topPage());
    expect(viewer.topPage()).toBeGreaterThan(0);
  });

  it('notices a turn in a fit mode once Chrome tells of the zoom', () => {
    // Fit to width: the zoom changes with the turn (0.718 to 0.556 here).
    const viewer = new FakeViewer(pages(40), 0.718, 749, 593);
    const tracker = new PdfViewerTracker(pages(40));
    tracker.setViewerZoom(0.718);
    send(tracker, viewer, 1_000);
    const rotated = new FakeViewer(turned(pages(40)), 0.5563, 749, 593);
    rotated.time = viewer.time;

    // The report comes before the zoom: read as a zoom, as before.
    send(tracker, rotated, 800);
    tracker.settle();
    tracker.setViewerZoom(0.5563);
    const before = tracker.position;
    for (let step = 0; step < 20; step += 1) {
      rotated.scrollTo(rotated.scroll + 100);
      expect(send(tracker, rotated, 40).kind).toBe('same');
    }
    expect(tracker.position).toBe(before);

    // Ctrl+[: the zoom goes back with the turn, its report first again.
    viewer.time = rotated.time;
    expect(send(tracker, viewer, 800).kind).not.toBe('hold');
    tracker.setViewerZoom(0.718);
    scroll(tracker, viewer, 40);
    home(tracker, viewer);
    expect(tracker.position).toEqual({ index: 0, fraction: 0 });
    scroll(tracker, viewer, 40);
    expect(tracker.position?.index).toBe(viewer.topPage());
  });

  it('drops a movement it holds when the zoom shows a turn', () => {
    // Fit to width while scrolling: the turn's report comes within the
    // movement and is held; the zoom Chrome tells of next shows the turn.
    const viewer = new FakeViewer(pages(40), 0.718, 749, 593);
    const tracker = new PdfViewerTracker(pages(40));
    tracker.setViewerZoom(0.718);
    send(tracker, viewer, 1_000);
    scroll(tracker, viewer, 20);
    const before = tracker.position;
    const rotated = new FakeViewer(turned(pages(40)), 0.5563, 749, 593);
    const report = { ...rotated.report(), pageY: -245 };
    expect(tracker.update(report, (viewer.time += 16)).kind).toBe('hold');

    tracker.setViewerZoom(0.5563);
    expect(tracker.settle()).toBeUndefined();
    expect(tracker.position).toBe(before);
    // Still turned while the zoom is not known.
    tracker.setViewerZoom(undefined);
    rotated.scrollTo(rotated.scroll + 300);
    expect(tracker.update(rotated.report(), (viewer.time += 400)).kind).toBe('same');
    expect(tracker.position).toBe(before);
  });

  it('follows again after a turn in fit to width that left a page looking 4 px narrower', () => {
    // US Legal, 816 × 1,344 px at 100%, fit to width in a view 800 px
    // wide: 95.2% upright, 58.1% turned. The turn's first report comes
    // before its zoom and reads as a zoom to 95.6%, at which the page turned
    // back is 4 px narrower than a page, as in the two-page view.
    const legal = pages(40, { width: 612, height: 1008 });
    const upright = 786 / 826;
    const sideways = 786 / 1354;
    const viewer = new FakeViewer(legal, upright, 600);
    const tracker = new PdfViewerTracker(legal);
    tracker.setViewerZoom(upright);
    send(tracker, viewer, 1_000);
    scroll(tracker, viewer, 40);
    expect(tracker.position?.index).toBe(viewer.topPage());

    const rotated = new FakeViewer(turned(legal), sideways, 600);
    rotated.time = viewer.time;
    rotated.scrollTo(viewer.scroll * (sideways / upright));
    send(tracker, rotated, 800);
    tracker.settle();
    tracker.setViewerZoom(sideways);
    const before = tracker.position;
    scroll(tracker, rotated, 10);
    expect(tracker.position).toBe(before);

    // Ctrl+[: the report first, then the zoom; then followed again.
    viewer.time = rotated.time;
    expect(send(tracker, viewer, 800).kind).toBe('same');
    tracker.setViewerZoom(upright);
    viewer.scrollTo(viewer.scroll + 30);
    expect(send(tracker, viewer, 400).kind).toBe('move');
    home(tracker, viewer);
    scroll(tracker, viewer, 80);
    expect(tracker.position?.index).toBe(viewer.topPage());
    expect(viewer.topPage()).toBeGreaterThan(0);
  });

  it('keeps following when the tab\'s zoom lags the viewer\'s after a resize in fit to width', () => {
    // Chrome passes the viewer's zoom on to the tab only when it changed by
    // more than 0.01. The window 3 px narrower in fit to width leaves the
    // tab at 593/826 with the viewer at 590/826, where a Letter page is as
    // wide as one 4 px narrower at the tab's zoom: the two-page view's mark.
    const told = 593 / 826;
    const before = new FakeViewer(pages(40), told, 749, 593);
    const tracker = new PdfViewerTracker(pages(40));
    tracker.setViewerZoom(told);
    send(tracker, before, 1_000);
    const viewer = new FakeViewer(pages(40), 590 / 826, 749, 590);
    viewer.time = before.time;
    send(tracker, viewer, 400);
    scroll(tracker, viewer, 120);
    tracker.settle();
    expect(viewer.topPage()).toBeGreaterThan(2);
    expect(tracker.position?.index).toBe(viewer.topPage());
  });

  it('keeps following when the lag makes a Letter page as wide as a landscape page is tall', () => {
    // Letter pages and one landscape page 606.75 pt tall (809 px at 100%)
    // that sets fit to width: with the tab's zoom 0.9% above the viewer's, a
    // Letter page is as wide on screen as the landscape page is tall at the
    // tab's zoom. Within the lag of a page width, it is upright.
    const sizes = [...pages(15), { width: 792, height: 606.75 }, ...pages(15)];
    const told = 593 / 1066;
    const actual = (told * 809) / 816;
    const before = new FakeViewer(sizes, told, 749, 607);
    const tracker = new PdfViewerTracker(sizes);
    tracker.setViewerZoom(told);
    send(tracker, before, 1_000);
    const viewer = new FakeViewer(sizes, actual, 749, 602);
    viewer.time = before.time;
    send(tracker, viewer, 400);
    scroll(tracker, viewer, 120);
    tracker.settle();
    expect(viewer.topPage()).toBeGreaterThan(2);
    expect(tracker.position?.index).toBe(viewer.topPage());
  });

  it('follows again after the two-page view in fit to width, which halves the zoom', () => {
    for (const noticeFirst of [true, false]) {
      const one = new FakeViewer(pages(40), 593 / 826, 749, 593);
      const tracker = new PdfViewerTracker(pages(40));
      tracker.setViewerZoom(one.zoom);
      send(tracker, one, 1_000);
      scroll(tracker, one, 20);
      tracker.settle();
      const before = tracker.position;
      // Two pages side by side, at about half the zoom: each 4 px narrower,
      // the left one reported left of the middle.
      const two = new FakeViewer(pages(40), 0.36071, 749, 593, 4);
      const left = (gapMs: number) => {
        two.time += gapMs;
        const report = two.report();
        tracker.update({ ...report, pageX: (593 - 14) / 2 - report.pageWidth - 2 }, two.time);
      };
      two.time = one.time;
      two.scrollTo(one.scroll * (two.zoom / one.zoom));
      if (noticeFirst) tracker.setViewerZoom(two.zoom);
      left(300);
      if (!noticeFirst) tracker.setViewerZoom(two.zoom);
      for (let frame = 0; frame < 30; frame += 1) {
        two.scrollTo(two.scroll + 30);
        left(16);
      }
      tracker.settle();
      expect(tracker.position, `notice first: ${noticeFirst}`).toBe(before);

      // One page wide again: the zoom goes back; End, Home, then wheel steps.
      one.time = two.time;
      if (noticeFirst) tracker.setViewerZoom(one.zoom);
      send(tracker, one, 300);
      if (!noticeFirst) tracker.setViewerZoom(one.zoom);
      tracker.settle();
      for (const target of [one.maxScroll, 0]) {
        const start = one.scroll;
        for (let frame = 1; frame <= 12; frame += 1) {
          one.scrollTo(start + ((target - start) * (1 - Math.cos((Math.PI * frame) / 12))) / 2);
          send(tracker, one, frame === 1 ? 600 : 16);
        }
        tracker.settle();
      }
      scroll(tracker, one, 80);
      tracker.settle();
      expect(one.topPage(), `notice first: ${noticeFirst}`).toBeGreaterThan(1);
      expect(tracker.position?.index, `notice first: ${noticeFirst}`).toBe(one.topPage());
    }
  });

  it('stays put when Simul opens on a view already turned', () => {
    const rotated = new FakeViewer(turned(pages(40)), 0.5563, 749, 593);
    rotated.scrollTo(3_000);
    const tracker = new PdfViewerTracker(pages(40));
    tracker.setViewerZoom(0.5563);
    expect(send(tracker, rotated, 1_000).kind).toBe('same');
    rotated.scrollTo(rotated.scroll + 100);
    expect(send(tracker, rotated, 40).kind).toBe('same');
    expect(tracker.position).toBeUndefined();

    // The tab's zoom told after the first report: read as a guess, then
    // noticed as turned when the zoom comes.
    const late = new PdfViewerTracker(pages(40));
    late.setViewerZoom(0.718);
    expect(send(late, rotated, 1_000).kind).toBe('move');
    const guess = late.position;
    late.setViewerZoom(0.5563);
    for (let step = 0; step < 10; step += 1) {
      rotated.scrollTo(rotated.scroll + 100);
      expect(send(late, rotated, 40).kind).toBe('same');
    }
    expect(late.position).toBe(guess);
  });

  it('takes for a turn only a page exactly as wide as a page is tall', () => {
    // 100%: a page 1,040 px wide is no page turned (1,056), but a zoom to 127%.
    const viewer = new FakeViewer(pages(40), 1, 700, 1400);
    const tracker = new PdfViewerTracker(pages(40));
    tracker.setViewerZoom(1);
    send(tracker, viewer, 1_000);
    viewer.scrollTo(600);
    send(tracker, viewer, 800);

    viewer.zoom = 1040 / 816;
    viewer.scrollTo(600 * viewer.zoom);
    send(tracker, viewer, 800);
    viewer.scrollTo(viewer.scroll + 100);
    expect(moved(send(tracker, viewer, 400)).fraction)
      .toBeCloseTo((viewer.scroll / viewer.zoom - 3) / 1056, 2);
  });

  it('does not notice a turn without the viewer\'s zoom', () => {
    const viewer = new FakeViewer(pages(40), 0.8, 700);
    const tracker = new PdfViewerTracker(pages(40));
    send(tracker, viewer, 1_000);
    const rotated = new FakeViewer(turned(pages(40)), 0.8, 700);
    rotated.time = viewer.time;
    rotated.scrollTo(600);

    send(tracker, rotated, 800);
    tracker.settle();
    rotated.scrollTo(700);
    expect(send(tracker, rotated, 400).kind).toBe('move');
  });

  it('keeps following a PDF of portrait and landscape pages of one size', () => {
    // A landscape page is as wide as a portrait page is tall.
    const sizes = [...pages(4), LANDSCAPE, LANDSCAPE, ...pages(4)];
    const viewer = new FakeViewer(sizes, 0.5, 700);
    const tracker = new PdfViewerTracker(sizes);
    tracker.setViewerZoom(0.5);
    send(tracker, viewer, 1_000);
    for (let step = 0; step < 150; step += 1) {
      viewer.scrollTo(viewer.scroll + 30);
      const track = send(tracker, viewer, 16);
      if (track.kind === 'move') expect(track.position.index).toBe(viewer.topPage());
    }
    expect(viewer.topPage()).toBeGreaterThan(5);
    expect(tracker.position?.index).toBe(viewer.topPage());
  });

  it('does not take a zoom for a turn, even when Chrome tells of it late', () => {
    // 4:3 slides, 960 × 720 px at 100%.
    const slides = pages(30, { width: 720, height: 540 });
    const viewer = new FakeViewer(slides, 1, 700, 1200);
    const tracker = new PdfViewerTracker(slides);
    tracker.setViewerZoom(1);
    send(tracker, viewer, 1_000);
    scroll(tracker, viewer, 30);

    // 100% to 125%: nothing at the old zoom is 1,200 px wide or tall.
    viewer.zoom = 1.25;
    viewer.scrollTo(900 * 1.25);
    send(tracker, viewer, 800);
    tracker.setViewerZoom(1.25);
    viewer.scrollTo(viewer.scroll + 100);
    expect(moved(send(tracker, viewer, 400)).index).toBe(viewer.topPage());

    // 100% to 75%: a slide is then as wide as it was tall at 100%. The
    // report alone looks like a turn; the zoom that follows says it is not.
    const again = new FakeViewer(slides, 1, 700, 1200);
    const late = new PdfViewerTracker(slides);
    late.setViewerZoom(1);
    send(late, again, 1_000);
    scroll(late, again, 30);
    again.zoom = 0.75;
    again.scrollTo(900 * 0.75);
    expect(send(late, again, 800).kind).toBe('same');
    late.setViewerZoom(0.75);
    again.scrollTo(again.scroll + 100);
    expect(moved(send(late, again, 400)).index).toBe(again.topPage());
  });

  it('does not take a zoom for a turn when Chrome tells of it before the viewer reports', () => {
    // 4:3 slides, 960 × 720 px at 100%: at 75% a slide is 720 px wide, as
    // wide as it is tall at 100%; so it is from 50% to 67% and 150% to 200%.
    const slides = pages(30, { width: 720, height: 540 });
    for (const [from, to] of [[0.75, 1], [0.5, 2 / 3], [1.5, 2], [1, 0.75], [2, 1.5]] as const) {
      const viewer = new FakeViewer(slides, from, 700, 2200);
      const tracker = new PdfViewerTracker(slides);
      tracker.setViewerZoom(from);
      send(tracker, viewer, 1_000);
      scroll(tracker, viewer, 30);
      expect(tracker.position?.index, `${from} to ${to}`).toBe(viewer.topPage());
      const before = tracker.position;

      // The tab's zoom first: the last report is of the zoom before.
      tracker.setViewerZoom(to);
      const y = viewer.scroll / viewer.zoom;
      viewer.zoom = to;
      viewer.scrollTo(y * to);
      expect(send(tracker, viewer, 5).kind, `${from} to ${to}`).toBe('same');
      expect(send(tracker, viewer, 3).kind, `${from} to ${to}`).toBe('same');
      expect(tracker.position, `${from} to ${to}`).toBe(before);
      // Followed on: it was a zoom.
      viewer.scrollTo(viewer.scroll + 60);
      expect(moved(send(tracker, viewer, 400)).index, `${from} to ${to}`).toBe(viewer.topPage());
    }

    // A jump held at 75% when Chrome tells of 100%: still read as a jump.
    const viewer = new FakeViewer(slides, 0.75, 700, 2200);
    const tracker = new PdfViewerTracker(slides);
    tracker.setViewerZoom(0.75);
    send(tracker, viewer, 1_000);
    viewer.scrollTo(viewer.pages[12]!.top * 0.75 + 200);
    expect(send(tracker, viewer, 800).kind).toBe('hold');
    tracker.setViewerZoom(1);
    expect(tracker.settle()).toBeDefined();
  });
});

describe('PDF viewer reports', () => {
  it('accepts the five numbers and nothing else', () => {
    const report = {
      type: 'viewport',
      pageX: 5,
      pageY: -297,
      pageWidth: 794,
      viewportWidth: 593,
      viewportHeight: 749,
      extra: 'text',
    };
    expect(readPdfViewerViewport(report)).toEqual({
      pageX: 5,
      pageY: -297,
      pageWidth: 794,
      viewportWidth: 593,
      viewportHeight: 749,
    });
    for (const bad of [
      null,
      'viewport',
      { ...report, pageY: Number.NaN },
      { ...report, pageWidth: 0 },
      { ...report, viewportHeight: -1 },
      { ...report, pageX: '5' },
      { ...report, pageY: 1e9 },
    ]) {
      expect(readPdfViewerViewport(bad)).toBeUndefined();
    }
  });

  it('takes bridge messages only of the viewport kind with a time', () => {
    const message = {
      kind: 'viewport',
      pageX: 5,
      pageY: 3,
      pageWidth: 816,
      viewportWidth: 800,
      viewportHeight: 700,
      time: 12_345_678,
    };
    expect(readPdfViewerPortMessage(message)).toEqual(message);
    expect(readPdfViewerPortMessage({ ...message, kind: 'text' })).toBeUndefined();
    expect(readPdfViewerPortMessage({ ...message, time: Number.POSITIVE_INFINITY })).toBeUndefined();
  });

  it('takes the scrollbar\'s width with a report, and a report without one (D134)', () => {
    const message = {
      kind: 'viewport',
      pageX: 5,
      pageY: 3,
      pageWidth: 816,
      viewportWidth: 800,
      viewportHeight: 700,
      time: 12_345_678,
    };
    for (const scrollbar of [0, 15, 15.2, 17, 64]) {
      expect(readPdfViewerPortMessage({ ...message, scrollbar })).toEqual({ ...message, scrollbar });
    }
    for (const scrollbar of [-1, 65, Number.NaN, Number.POSITIVE_INFINITY, '15', null, {}]) {
      expect(readPdfViewerPortMessage({ ...message, scrollbar })).toEqual(message);
    }
  });

  it('takes the screen\'s scale with a report, and a report without one (D134)', () => {
    const message = {
      kind: 'viewport',
      pageX: 5,
      pageY: 3,
      pageWidth: 816,
      viewportWidth: 800,
      viewportHeight: 700,
      time: 12_345_678,
    };
    for (const scale of [0.5, 1, 1.25, 1.5, 3, 16]) {
      expect(readPdfViewerPortMessage({ ...message, scale })).toEqual({ ...message, scale });
    }
    for (const scale of [0, -1, 0.1, 17, Number.NaN, Number.POSITIVE_INFINITY, '1.5', null]) {
      expect(readPdfViewerPortMessage({ ...message, scale })).toEqual(message);
    }
    expect(readPdfViewerPortMessage({ ...message, scale: 1.5, scrollbar: 15.333 }))
      .toEqual({ ...message, scale: 1.5, scrollbar: 15.333 });
  });
});
