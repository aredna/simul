import { describe, expect, it } from 'vitest';

import type { PdfPagePoints } from '../lib/pdf/pdf-layout';
import { PdfViewerTracker } from '../lib/pdf/pdf-viewer-tracker';

/** A seeded generator, so every run reads the same viewers. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * Chrome's viewer as the probes saw it: one page wide, trunc(points × 4/3)
 * px pages with 3/5/7/5 insets and 4 px between them, scroll positions
 * snapped to whole pixels, and a report only when the position changed.
 */
class SnappedViewer {
  readonly pages: { width: number; height: number; top: number }[] = [];
  readonly height: number;
  scroll = 0;
  time = 1_000;
  readonly viewportWidth = 800;

  constructor(sizes: readonly PdfPagePoints[], readonly zoom: number, readonly viewportHeight: number) {
    let top = 0;
    for (const [index, size] of sizes.entries()) {
      if (index > 0) top += 4;
      const width = Math.trunc((size.width * 4) / 3);
      const height = Math.trunc((size.height * 4) / 3);
      this.pages.push({ width, height, top: top + 3 });
      top += 10 + height;
    }
    this.height = top;
  }

  get maxScroll(): number {
    return Math.max(0, this.height * this.zoom - this.viewportHeight);
  }

  scrollTo(scroll: number, snap = true): void {
    const clamped = Math.min(this.maxScroll, Math.max(0, scroll));
    this.scroll = snap ? Math.round(clamped) : clamped;
  }

  /** Chrome centres a page in the view when the PDF fits across it. */
  pageX(width: number): number {
    const widest = Math.max(...this.pages.map((page) => page.width));
    const fits = (widest + 10) * this.zoom <= this.viewportWidth - 14;
    // Too wide to fit: not scrolled sideways, the page centred in the PDF.
    return fits
      ? (this.viewportWidth - 14) / 2 - (width * this.zoom) / 2
      : ((widest - width) / 2 + 5) * this.zoom;
  }

  report() {
    let best = 0;
    let bestShare = -1;
    this.pages.forEach((page, index) => {
      const top = page.top * this.zoom - this.scroll;
      const shown = Math.max(0, Math.min(top + page.height * this.zoom, this.viewportHeight) -
        Math.max(top, 0));
      const share = shown / (page.height * this.zoom);
      if (share > bestShare) {
        bestShare = share;
        best = index;
      }
    });
    const page = this.pages[best]!;
    return {
      pageX: this.pageX(page.width),
      pageY: page.top * this.zoom - this.scroll,
      pageWidth: page.width * this.zoom,
      viewportWidth: this.viewportWidth,
      viewportHeight: this.viewportHeight,
    };
  }

  topPage(): number {
    const y = this.scroll / this.zoom;
    let index = 0;
    this.pages.forEach((page, candidate) => {
      if (page.top - 7 <= y) index = candidate;
    });
    return index;
  }
}

type Action =
  | 'wheel'
  | 'fling'
  | 'arrow'
  | 'pageKey'
  | 'arrowRight'
  | 'homeEnd'
  | 'heldArrow'
  | 'heldPageKey'
  | 'heldArrowRight';

// Chrome's zoom presets, where page tops often fall on whole pixels.
const PRESET_ZOOMS = [0.5, 0.75, 0.9, 1, 1.25, 1.5];

describe('PdfViewerTracker on simulated reading sessions', () => {
  it('places the page after nearly every action', () => {
    const next = random(42);
    const counts = new Map<Action, { right: number; total: number }>();
    for (let session = 0; session < 80; session += 1) {
      const size = next() < 0.5 ? { width: 612, height: 792 } : { width: 595.28, height: 841.89 };
      const count = 20 + Math.floor(next() * 400);
      // A quarter of the PDFs mix in a landscape page every 17 pages.
      const mixed = next() < 0.25;
      const sizes = Array.from({ length: count }, (_, index) =>
        mixed && index % 17 === 16 ? { width: size.height, height: size.width } : size);
      // Presets, low zooms that show many pages at once, and anything else.
      const kind = next();
      const zoom = kind < 0.3
        ? PRESET_ZOOMS[Math.floor(next() * PRESET_ZOOMS.length)]!
        : kind < 0.45
          ? 0.25 + next() * 0.15
          : 0.4 + next() * 1.4;
      const viewer = new SnappedViewer(sizes, zoom, 450 + next() * 700);
      let tracker = new PdfViewerTracker(sizes);
      let reported = Number.NaN;
      const send = (gapMs: number) => {
        viewer.time += gapMs;
        if (Math.abs(viewer.scroll - reported) < 1e-9) return;
        reported = viewer.scroll;
        tracker.update(viewer.report(), viewer.time);
      };
      const check = (action: Action) => {
        viewer.time += 300;
        const position = tracker.settle() ?? tracker.position;
        const tally = counts.get(action) ?? { right: 0, total: 0 };
        tally.total += 1;
        if (position?.index === viewer.topPage()) {
          tally.right += 1;
        } else {
          // Count each mistake once: start again from the true page.
          tracker = new PdfViewerTracker(sizes);
          tracker.anchor({ index: viewer.topPage(), fraction: 0.5 });
          reported = Number.NaN;
          send(0);
          viewer.time += 300;
        }
        counts.set(action, tally);
      };
      send(1_000);
      viewer.time += 300;
      for (let step = 0; step < 100; step += 1) {
        const pick = next();
        if (pick < 0.35) {
          // A wheel turn: 100 px a notch, eased over ten frames.
          const direction = next() < 0.7 ? 1 : -1;
          const start = viewer.scroll;
          const amount = 100 * (1 + Math.floor(next() * 3));
          for (let frame = 1; frame <= 10; frame += 1) {
            viewer.scrollTo(start + direction * amount * (1 - (1 - frame / 10) ** 3));
            send(16);
          }
          check('wheel');
        } else if (pick < 0.5) {
          // A trackpad fling of up to 250 px a frame, slowing down.
          let speed = (next() < 0.5 ? -1 : 1) * (40 + next() * 210);
          let ramp = 0;
          for (let frame = 0; frame < 60 && Math.abs(speed) > 1; frame += 1) {
            ramp = Math.min(1, ramp + 0.34);
            viewer.scrollTo(viewer.scroll + speed * ramp);
            speed *= 0.95;
            send(16);
          }
          check('fling');
        } else if (pick < 0.65) {
          viewer.scrollTo(viewer.scroll + (next() < 0.7 ? 40 : -40));
          send(300);
          check('arrow');
        } else if (pick < 0.8) {
          viewer.scrollTo(viewer.scroll + (next() < 0.8 ? 1 : -1) * 0.875 * viewer.viewportHeight);
          send(300);
          check('pageKey');
        } else if (pick < 0.92) {
          // ArrowRight: the next page's exact top, then the snapped position.
          const target = Math.min(viewer.pages.length - 1, report(viewer) + 1);
          viewer.scrollTo((viewer.pages[target]!.top - 3) * viewer.zoom, false);
          send(300);
          viewer.scrollTo(viewer.scroll);
          send(3);
          check('arrowRight');
        } else if (pick < 0.97) {
          // A key held down: the first press, the keyboard's wait before
          // repeating, then repeats every 33 ms.
          const which = next();
          const repeats = 3 + Math.floor(next() * 8);
          for (let press = 0; press <= repeats; press += 1) {
            const gap = press === 0 ? 300 : press === 1 ? 400 : 33;
            if (which < 0.34) {
              viewer.scrollTo(viewer.scroll + 40);
              send(gap);
            } else if (which < 0.67) {
              viewer.scrollTo(viewer.scroll + 0.875 * viewer.viewportHeight);
              send(gap);
            } else {
              const target = Math.min(viewer.pages.length - 1, report(viewer) + 1);
              viewer.scrollTo((viewer.pages[target]!.top - 3) * viewer.zoom, false);
              send(gap);
              viewer.scrollTo(viewer.scroll);
              send(3);
            }
          }
          check(which < 0.34 ? 'heldArrow' : which < 0.67 ? 'heldPageKey' : 'heldArrowRight');
        } else {
          // Home or End: eased over about ten frames.
          const target = next() < 0.5 ? viewer.maxScroll : 0;
          const start = viewer.scroll;
          const frames = 8 + Math.floor(next() * 7);
          for (let frame = 1; frame <= frames; frame += 1) {
            viewer.scrollTo(start + ((target - start) * (1 - Math.cos((Math.PI * frame) / frames))) / 2);
            send(16);
          }
          check('homeEnd');
        }
      }
    }
    const share = (action: Action) => {
      const tally = counts.get(action)!;
      return tally.right / tally.total;
    };
    // Measured 2026-10-01 over 80 sessions (zooms 25% to 180%, presets,
    // mixed sizes): arrows and held arrows or page keys 100%, wheel turns
    // 99.9%, page keys 99.8%, Home and End 99.6%, flings 99.1%, ArrowRight
    // 97.9% and held 97.2% (at zooms where page tops fall on whole pixels,
    // ArrowRight can look like scrolling up to a page top).
    expect(share('wheel')).toBeGreaterThanOrEqual(0.998);
    expect(share('arrow')).toBeGreaterThanOrEqual(0.998);
    expect(share('heldArrow')).toBeGreaterThanOrEqual(0.99);
    expect(share('pageKey')).toBeGreaterThanOrEqual(0.995);
    expect(share('heldPageKey')).toBeGreaterThanOrEqual(0.98);
    expect(share('fling')).toBeGreaterThanOrEqual(0.985);
    expect(share('homeEnd')).toBeGreaterThanOrEqual(0.98);
    expect(share('arrowRight')).toBeGreaterThanOrEqual(0.97);
    expect(share('heldArrowRight')).toBeGreaterThanOrEqual(0.95);
  });
});

/** The viewer's most visible page, as its report names it by geometry. */
function report(viewer: SnappedViewer): number {
  const { pageY } = viewer.report();
  const scrollTop = viewer.scroll;
  return viewer.pages.findIndex((page) => Math.abs(page.top * viewer.zoom - scrollTop - pageY) < 1e-6);
}
