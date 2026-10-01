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

  constructor(
    sizes: readonly PdfPagePoints[],
    public zoom: number,
    public viewportHeight: number,
    public viewportWidth = 800,
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

  get maxScroll(): number {
    return Math.max(0, this.height * this.zoom - this.viewportHeight);
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
      pageWidth: page.width * this.zoom,
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
});
