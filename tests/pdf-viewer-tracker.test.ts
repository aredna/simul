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
});
