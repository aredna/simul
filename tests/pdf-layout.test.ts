import { describe, expect, it } from 'vitest';

import {
  MAX_DRAWN_PDF_PAGES,
  MAX_PDF_PAGE_PIXELS,
  PDF_POINTS_TO_CSS_PX,
  pdfDrawPlan,
  pdfPageBoxes,
  pdfPageNearView,
  pdfReadingPosition,
  pdfRenderScale,
  pdfScrollLeftAt,
  pdfScrollLeftFor,
  pdfScrollTopFor,
  pdfTextLayersToRemove,
  type PdfLayoutSettings,
  type PdfPageBox,
} from '../lib/pdf/pdf-layout';

const LETTER = { width: 612, height: 792 };
const LANDSCAPE = { width: 792, height: 612 };
const FIT: PdfLayoutSettings = { displayMode: 'fit', zoomPercent: 100, sourceZoomFactor: 1 };
const ACTUAL: PdfLayoutSettings = { displayMode: 'actual', zoomPercent: 100, sourceZoomFactor: 1 };

describe('pdfPageBoxes', () => {
  it('fits the width, shrinking or growing, and keeps each aspect ratio', () => {
    const narrow = pdfPageBoxes([LETTER, LETTER], FIT, 408, 8);
    expect(narrow.boxes[0]).toEqual({ top: 8, left: 8, width: 408, height: 528 });
    expect(narrow.boxes[1]).toEqual({ top: 544, left: 8, width: 408, height: 528 });
    expect(narrow.width).toBe(424);
    expect(narrow.height).toBe(1080);

    const wide = pdfPageBoxes([LETTER], FIT, 1632, 8);
    expect(wide.boxes[0]?.width).toBe(1632);
    expect(wide.boxes[0]?.height).toBe(2112);
    expect(wide.scale).toBeCloseTo(1632 / 612);
  });

  it('shows 1:1 at the size the tab shows, following the tab zoom', () => {
    const plain = pdfPageBoxes([LETTER], ACTUAL, 400, 8);
    expect(plain.boxes[0]?.width).toBeCloseTo(612 * PDF_POINTS_TO_CSS_PX);
    expect(plain.boxes[0]?.height).toBeCloseTo(792 * PDF_POINTS_TO_CSS_PX);
    // Wider than the panel: the content scrolls sideways from the padding.
    expect(plain.boxes[0]?.left).toBe(8);
    expect(plain.width).toBeCloseTo(816 + 16);

    const zoomed = pdfPageBoxes([LETTER], { ...ACTUAL, sourceZoomFactor: 1.25 }, 400, 8);
    expect(zoomed.boxes[0]?.width).toBeCloseTo(816 * 1.25);
  });

  it('multiplies custom zoom by the tab zoom within 0.25–5', () => {
    const custom = pdfPageBoxes(
      [LETTER],
      { displayMode: 'custom', zoomPercent: 150, sourceZoomFactor: 1.25 },
      400,
      0,
    );
    expect(custom.boxes[0]?.width).toBeCloseTo(816 * 1.5 * 1.25);

    const huge = pdfPageBoxes(
      [LETTER],
      { displayMode: 'custom', zoomPercent: 300, sourceZoomFactor: 3 },
      400,
      0,
    );
    expect(huge.boxes[0]?.width).toBeCloseTo(816 * 5);

    const tiny = pdfPageBoxes(
      [LETTER],
      { displayMode: 'custom', zoomPercent: 25, sourceZoomFactor: 0.5 },
      400,
      0,
    );
    expect(tiny.boxes[0]?.width).toBeCloseTo(816 * 0.25);
  });

  it('shares one scale between pages of different sizes and centres the narrower', () => {
    const layout = pdfPageBoxes([LETTER, LANDSCAPE], FIT, 792, 10);

    expect(layout.boxes[1]).toMatchObject({ left: 10, width: 792, height: 612 });
    expect(layout.boxes[0]).toMatchObject({ width: 612, height: 792, left: 10 + 90 });
    expect(layout.boxes[1]?.top).toBe(10 + 792 + 10);
  });

  it('falls back safely on bad sizes, widths and zoom factors', () => {
    const layout = pdfPageBoxes(
      [{ width: 0, height: Number.NaN }],
      { ...ACTUAL, sourceZoomFactor: Number.NaN },
      Number.NaN,
      -4,
    );
    expect(layout.boxes[0]).toEqual({ top: 0, left: 0, width: 816, height: 1056 });
    // Fit with no width to fill shows 1:1.
    expect(pdfPageBoxes([LETTER], FIT, 0, 0).boxes[0]?.width).toBeCloseTo(816);
    expect(pdfPageBoxes([], FIT, 400, 8)).toEqual({
      boxes: [],
      width: 416,
      height: 16,
      scale: PDF_POINTS_TO_CSS_PX,
    });
  });
});

describe('pdfRenderScale', () => {
  it('draws at the CSS width times the device pixel ratio', () => {
    expect(pdfRenderScale(612, 792, 612, 1)).toBe(1);
    expect(pdfRenderScale(612, 792, 408, 2)).toBeCloseTo(816 / 612);
  });

  it('caps a page at 4 MP', () => {
    const scale = pdfRenderScale(612, 792, 4000, 2);
    expect(612 * scale * 792 * scale).toBeCloseTo(MAX_PDF_PAGE_PIXELS);
    expect(pdfRenderScale(612, 792, 4000, 2, 1_000_000)).toBeCloseTo(
      Math.sqrt(1_000_000 / (612 * 792)),
    );
  });

  it('never returns a bad scale', () => {
    for (const scale of [
      pdfRenderScale(Number.NaN, 0, 400, 1),
      pdfRenderScale(612, 792, Number.NaN, Number.NaN),
      pdfRenderScale(612, 792, -3, 0),
    ]) {
      expect(Number.isFinite(scale)).toBe(true);
      expect(scale).toBeGreaterThan(0);
    }
  });
});

function column(count: number, height = 1000, gap = 10): PdfPageBox[] {
  return Array.from({ length: count }, (_, index) => ({
    top: gap + index * (height + gap),
    left: 0,
    width: 700,
    height,
  }));
}

describe('pdfDrawPlan', () => {
  it('draws the pages within a screen of the view, nearest to its middle first', () => {
    const plan = pdfDrawPlan({
      boxes: column(20),
      scrollTop: 5_055,
      viewportHeight: 800,
      drawn: new Set(),
    });

    // The view shows page 5 (0-based); one screen above it reaches page 4
    // and one screen below it reaches page 6.
    expect(plan.wanted).toEqual([5, 4, 6]);
    expect(plan.draw).toEqual([5, 4, 6]);
    expect(plan.release).toEqual([]);
  });

  it('skips pages that failed to draw and keeps them out of the budget', () => {
    const plan = pdfDrawPlan({
      boxes: column(5),
      scrollTop: 0,
      viewportHeight: 1_200,
      drawn: new Set([0, 3]),
      failed: new Set([1]),
      maxDrawn: 3,
    });

    expect(plan.wanted).toEqual([0, 2]);
    expect(plan.draw).toEqual([2]);
    // Two drawn plus one new fits the cap of three: nothing is released for
    // the failed page.
    expect(plan.release).toEqual([]);
  });

  it('skips pages already drawn unless they are stale', () => {
    const plan = pdfDrawPlan({
      boxes: column(5),
      scrollTop: 0,
      viewportHeight: 1_200,
      drawn: new Set([0, 1]),
      stale: new Set([1]),
    });

    expect(plan.wanted).toEqual([0, 1, 2]);
    expect(plan.draw).toEqual([1, 2]);
  });

  it('keeps drawn pages while there is room, then releases the farthest', () => {
    const boxes = column(300);
    const kept = pdfDrawPlan({
      boxes,
      scrollTop: 20_200,
      viewportHeight: 800,
      drawn: new Set([0, 1, 2]),
    });
    expect(kept.release).toEqual([]);

    const drawn = new Set([0, 1, 2, 3, 4, 5, 150]);
    const plan = pdfDrawPlan({ boxes, scrollTop: 20_200, viewportHeight: 800, drawn });
    const after = new Set([...drawn].filter((page) => !plan.release.includes(page)));
    for (const page of plan.draw) after.add(page);

    expect(after.size).toBeLessThanOrEqual(MAX_DRAWN_PDF_PAGES);
    // Farthest first.
    expect(plan.release).toEqual([150, 0]);
  });

  it('never keeps more than the cap drawn while scrolling a long document', () => {
    const boxes = column(300, 400, 8);
    let drawn = new Set<number>();
    for (let scrollTop = 0; scrollTop < 300 * 408; scrollTop += 977) {
      const plan = pdfDrawPlan({ boxes, scrollTop, viewportHeight: 900, drawn });
      drawn = new Set([...drawn].filter((page) => !plan.release.includes(page)));
      for (const page of plan.draw) drawn.add(page);
      expect(drawn.size).toBeLessThanOrEqual(MAX_DRAWN_PDF_PAGES);
      for (const page of plan.wanted) expect(drawn.has(page)).toBe(true);
    }
  });

  it('releases pages outside the window first, the farthest first', () => {
    const boxes = column(30, 100, 0);
    const plan = pdfDrawPlan({
      boxes,
      scrollTop: 1_000,
      viewportHeight: 900,
      // Pages are 100px tall and the window is 100–2800: pages 0 and 29 lie
      // outside it, page 1 inside, and more are wanted than the cap allows.
      drawn: new Set([1, 0, 29]),
      maxDrawn: 3,
    });

    expect(plan.wanted).toEqual([14, 13, 15]);
    expect(plan.release).toEqual([29, 0, 1]);
  });
});

describe('reading position', () => {
  const boxes = column(3, 1000, 10);

  it('finds the page at the top of the view and the share scrolled past', () => {
    expect(pdfReadingPosition(boxes, 0)).toEqual({ index: 0, fraction: 0 });
    expect(pdfReadingPosition(boxes, 1_510)).toEqual({ index: 1, fraction: 0.49 });
    expect(pdfReadingPosition(boxes, 99_999)).toEqual({ index: 2, fraction: 1 });
    expect(pdfReadingPosition([], 50)).toBeUndefined();
  });

  it('counts a page whose top the browser rounded just below the edge as at the top', () => {
    const second = boxes[1]!.top;
    expect(pdfReadingPosition(boxes, second - 0.6)).toEqual({ index: 1, fraction: 0 });
    expect(pdfReadingPosition(boxes, second - 2)?.index).toBe(0);
  });

  it('puts the same place back at the top after a layout change', () => {
    const position = pdfReadingPosition(boxes, 1_510);
    const larger = column(3, 2000, 10);

    expect(pdfScrollTopFor(larger, position)).toBe(2_020 + 980);
    expect(pdfScrollTopFor(larger, undefined)).toBe(0);
    expect(pdfScrollTopFor([], position)).toBe(0);
  });

  it('keeps the middle of a wider page under the middle of the view', () => {
    expect(pdfScrollLeftFor(400, 1_000, 400, 0)).toBe(300);
    expect(pdfScrollLeftFor(1_000, 2_000, 400, 300)).toBe(800);
    expect(pdfScrollLeftFor(1_000, 400, 400, 300)).toBe(0);
  });

  it('scrolls across by a share of the widest page (D115)', () => {
    // 1:1: letter pages (816 px) centred in the landscape page's 1,056 px.
    const layout = pdfPageBoxes([LETTER, LANDSCAPE], ACTUAL, 400, 8);
    expect(layout.boxes[1]).toMatchObject({ left: 8, width: 1056 });
    expect(pdfScrollLeftAt(layout, 416, 0)).toBe(0);
    expect(pdfScrollLeftAt(layout, 416, 0.5)).toBe(528);
    // The view's own ends.
    expect(pdfScrollLeftAt(layout, 416, -1)).toBe(0);
    expect(pdfScrollLeftAt(layout, 416, 3)).toBe(1056 + 16 - 416);
    // Nothing to scroll (Fit), no pages, or no number: the far left.
    expect(pdfScrollLeftAt(pdfPageBoxes([LETTER], FIT, 400, 8), 416, 0.5)).toBe(0);
    expect(pdfScrollLeftAt({ boxes: [], width: 900 }, 416, 0.5)).toBe(0);
    expect(pdfScrollLeftAt(layout, 416, Number.NaN)).toBe(0);
  });
});

describe('text layers near the view', () => {
  it('counts a page within one screen of the view as near', () => {
    const boxes = column(20);
    // The view shows page 5; a screen above reaches page 4, below page 6.
    const near = boxes.map((box) => pdfPageNearView(box, 5_055, 800));
    expect(near.flatMap((isNear, index) => (isNear ? [index] : []))).toEqual([4, 5, 6]);
    expect(pdfPageNearView(undefined, 0, 800)).toBe(false);
  });

  it('removes nothing within the budget', () => {
    const layers = new Map([[0, 40], [1, 40], [9, 40]]);
    expect(pdfTextLayersToRemove({
      boxes: column(20),
      scrollTop: 0,
      viewportHeight: 800,
      layers,
      keep: new Set(),
      maxBlocks: 120,
    })).toEqual([]);
  });

  it('removes the farthest layers first, never a kept page, until within the budget', () => {
    const layers = new Map([[0, 40], [1, 40], [5, 40], [9, 40], [19, 40]]);
    const remove = pdfTextLayersToRemove({
      boxes: column(20),
      scrollTop: 5_055,
      viewportHeight: 800,
      layers,
      // Page 19 is being drawn: it stays although it is the farthest.
      keep: new Set([5, 19]),
      maxBlocks: 100,
    });
    // 200 blocks against 100: three layers must go. From the middle of the
    // view (page 5), page 0 is the farthest, then page 9, then page 1.
    expect(remove).toEqual([0, 9, 1]);
  });

  it('keeps every kept page even over the budget', () => {
    const layers = new Map([[4, 500], [5, 500]]);
    expect(pdfTextLayersToRemove({
      boxes: column(20),
      scrollTop: 5_055,
      viewportHeight: 800,
      layers,
      keep: new Set([4, 5]),
      maxBlocks: 100,
    })).toEqual([]);
  });
});
