import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PdfBlockMeasure } from '../entrypoints/sidepanel/pdf-text-layer';
import { PdfView, type PdfViewDocument } from '../entrypoints/sidepanel/pdf-view';
import type { RgbaPixels } from '../lib/pdf/colour-sample';
import type { PdfSurfaceBlock } from '../lib/pdf/pdf-text-surface';

const LETTER = { width: 612, height: 792 };

interface PendingRender {
  readonly page: number;
  readonly scale: number;
  readonly canvas: HTMLCanvasElement;
  readonly signal: AbortSignal;
  settled: boolean;
  finish(): void;
}

function setup(options: {
  pages?: number;
  maxDrawnPages?: number;
  maxTextLayerBlocks?: number;
  devicePixelRatio?: () => number;
  pageLabel?: (page: number, total: number) => string;
  onReadingPageChange?: (index: number) => void;
  readPixels?: (canvas: HTMLCanvasElement) => RgbaPixels | undefined;
  measureBlock?: PdfBlockMeasure;
} = {}) {
  const { document, window } = parseHTML(
    '<main><section id="pdf-view" hidden></section></main>',
  );
  const element = document.querySelector<HTMLElement>('#pdf-view')!;
  let width = 416;
  Object.defineProperties(element, {
    clientWidth: { configurable: true, get: () => width },
    clientHeight: { configurable: true, value: 600 },
  });
  element.scrollTop = 0;
  element.scrollLeft = 0;
  const frames: Array<() => void> = [];
  let resize: (() => void) | undefined;
  let pixelRatioChanged: (() => void) | undefined;
  const view = new PdfView(element, {
    requestFrame: (callback) => frames.push(callback),
    cancelFrame: () => undefined,
    createResizeObserver: (callback) => {
      resize = callback;
      return { observe: () => undefined, disconnect: () => undefined };
    },
    devicePixelRatio: options.devicePixelRatio ?? (() => 1),
    watchDevicePixelRatio: (callback) => {
      pixelRatioChanged = callback;
      return () => {
        if (pixelRatioChanged === callback) pixelRatioChanged = undefined;
      };
    },
    ...(options.maxDrawnPages ? { maxDrawnPages: options.maxDrawnPages } : {}),
    ...(options.maxTextLayerBlocks !== undefined
      ? { maxTextLayerBlocks: options.maxTextLayerBlocks }
      : {}),
    ...(options.pageLabel ? { pageLabel: options.pageLabel } : {}),
    ...(options.onReadingPageChange ? { onReadingPageChange: options.onReadingPageChange } : {}),
    readPixels: options.readPixels ?? (() => undefined),
    measureBlock: options.measureBlock ?? (() => undefined),
  });
  const pending: PendingRender[] = [];
  const pdf = {
    render: vi.fn((page: number, canvas: HTMLCanvasElement, scale: number, signal?: AbortSignal) =>
      new Promise<number>((resolve, reject) => {
        signal?.addEventListener('abort', () =>
          reject(new DOMException('Render cancelled.', 'AbortError')));
        const render: PendingRender = {
          page,
          scale,
          canvas,
          signal: signal!,
          settled: false,
          finish: () => {
            render.settled = true;
            resolve(scale);
          },
        };
        pending.push(render);
      })),
    releasePage: vi.fn(async (_page: number) => undefined),
    fontFaces: vi.fn(async (_page: number, _fontIds: readonly string[]) =>
      ({ bold: { bold: true, italic: false } }) as Record<string, { bold: boolean; italic: boolean }>),
  } satisfies PdfViewDocument;
  const sizes = Array.from({ length: options.pages ?? 10 }, () => LETTER);
  return {
    window,
    element,
    view,
    pdf,
    sizes,
    pending,
    setWidth: (next: number) => {
      width = next;
    },
    runFrames: () => {
      for (const frame of frames.splice(0)) frame();
    },
    resize: () => resize?.(),
    changePixelRatio: () => pixelRatioChanged?.(),
    /** Finishes the oldest render still running and lets the view continue. */
    finishNext: async () => {
      const next = pending.find((render) => !render.settled && !render.signal.aborted);
      next?.finish();
      await vi.advanceTimersByTimeAsync(0);
      return next;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PdfView', () => {
  it('shows a placeholder per page and draws the near pages one at a time', async () => {
    const harness = setup();

    harness.view.mount(harness.pdf, harness.sizes);

    expect(harness.element.hidden).toBe(false);
    const pages = harness.element.querySelectorAll<HTMLElement>('.pdf-page');
    expect(pages).toHaveLength(10);
    // Fit: 400px of content width at 8px padding.
    expect(pages[0]?.style.width).toBe('400px');
    expect(pages[0]?.style.top).toBe('8px');
    expect(harness.pdf.render).toHaveBeenCalledOnce();
    expect(harness.pending[0]?.page).toBe(1);
    expect(harness.pending[0]?.scale).toBeCloseTo(400 / 612);

    await harness.finishNext();
    expect(pages[0]?.querySelector('canvas')?.getAttribute('aria-hidden')).toBe('true');
    expect(harness.pending.map(({ page }) => page)).toEqual([1, 2]);
    await harness.finishNext();
    await harness.finishNext();
    expect(harness.pending.map(({ page }) => page)).toEqual([1, 2, 3]);
    expect(harness.view.drawnPages).toEqual([1, 2, 3]);
  });

  it('releases far pages beyond the cap as the reader scrolls', async () => {
    const harness = setup({ pages: 30, maxDrawnPages: 2 });
    harness.view.mount(harness.pdf, harness.sizes);
    await harness.finishNext();
    await harness.finishNext();
    expect(harness.view.drawnPages).toEqual([1, 2]);
    const firstCanvas = harness.pending[0]!.canvas;

    harness.element.scrollTop = 20 * 526;
    harness.element.dispatchEvent(new harness.window.Event('scroll'));
    harness.runFrames();
    await harness.finishNext();
    await harness.finishNext();

    expect(harness.view.drawnPages).toHaveLength(2);
    expect(harness.view.drawnPages.every((page) => page > 15)).toBe(true);
    expect(harness.pdf.releasePage).toHaveBeenCalledWith(1);
    expect(harness.pdf.releasePage).toHaveBeenCalledWith(2);
    expect(firstCanvas.width).toBe(0);
    expect(firstCanvas.isConnected).toBe(false);
  });

  it('keeps the reading position on a layout change and redraws once it settles', async () => {
    const harness = setup({ pages: 5 });
    harness.view.mount(harness.pdf, harness.sizes);
    for (let index = 0; index < 3; index += 1) await harness.finishNext();
    const pages = harness.element.querySelectorAll<HTMLElement>('.pdf-page');
    // Halfway down page 2 (0-based 1): Fit pages are 400 × 517.6.
    const pageHeight = (792 * 400) / 612;
    harness.element.scrollTop = 8 + pageHeight + 8 + pageHeight / 2;
    const renders = harness.pdf.render.mock.calls.length;

    harness.view.updateLayout({ displayMode: 'actual', zoomPercent: 100, sourceZoomFactor: 1.25 });

    const actualHeight = 792 * (4 / 3) * 1.25;
    expect(pages[1]?.style.width).toBe('1020px');
    expect(harness.element.scrollTop).toBeCloseTo(8 + actualHeight + 8 + actualHeight / 2, 1);
    // The drawn canvases stretch until the change settles.
    expect(harness.pdf.render.mock.calls.length).toBe(renders);
    await vi.advanceTimersByTimeAsync(150);
    expect(harness.pdf.render.mock.calls.length).toBe(renders + 1);
    expect(harness.pending.at(-1)?.scale).toBeCloseTo(1.25 * (4 / 3));
  });

  it('lays out again when the panel width changes', () => {
    const harness = setup({ pages: 2 });
    harness.view.mount(harness.pdf, harness.sizes);
    const page = harness.element.querySelector<HTMLElement>('.pdf-page');

    harness.setWidth(816);
    harness.resize();
    harness.runFrames();

    expect(page?.style.width).toBe('800px');
  });

  it('opens at a remembered position and reports where the reader is', async () => {
    const harness = setup({ pages: 10 });
    const pageHeight = (792 * 400) / 612;

    harness.view.mount(harness.pdf, harness.sizes, { index: 4, fraction: 0.5 });

    expect(harness.element.scrollTop).toBeCloseTo(8 + 4 * (pageHeight + 8) + pageHeight / 2, 1);
    // The page at the middle of the 600px view (page 6) is drawn first.
    expect(harness.pending[0]?.page).toBe(6);
    const position = harness.view.readingPosition();
    expect(position?.index).toBe(4);
    expect(position?.fraction).toBeCloseTo(0.5, 3);
    harness.view.clear();
    expect(harness.view.readingPosition()).toBeUndefined();
  });

  it('scrolls to the place the viewer followed, and not while empty (D108)', () => {
    const harness = setup({ pages: 10 });
    const pageHeight = (792 * 400) / 612;
    harness.view.followPosition({ index: 3, fraction: 0.25 });
    expect(harness.element.scrollTop).toBe(0);

    harness.view.mount(harness.pdf, harness.sizes);
    harness.view.followPosition({ index: 3, fraction: 0.25 });

    expect(harness.element.scrollTop).toBeCloseTo(8 + 3 * (pageHeight + 8) + pageHeight / 4, 1);
    expect(harness.view.readingPosition()?.index).toBe(3);
  });

  it('follows the viewer sideways and keeps that place through a zoom (D115)', () => {
    const harness = setup({ pages: 3 });
    harness.view.followLeft(0.1);
    expect(harness.element.scrollLeft).toBe(0);

    harness.view.mount(harness.pdf, harness.sizes);
    // Fit: the page is as wide as the view, with nowhere to scroll.
    harness.view.followLeft(0.1);
    expect(harness.element.scrollLeft).toBe(0);
    // 1:1: an 816 px page behind 8 px of padding in a 416 px view. The
    // place followed while fitted is where the view goes.
    harness.view.updateLayout({ displayMode: 'actual', zoomPercent: 100, sourceZoomFactor: 1 });
    expect(harness.element.scrollLeft).toBeCloseTo(0.1 * 816, 1);
    harness.view.followLeft(0.25);
    expect(harness.element.scrollLeft).toBeCloseTo(0.25 * 816, 1);
    // The far left and the far right stay in range.
    harness.view.followLeft(0);
    expect(harness.element.scrollLeft).toBe(0);
    harness.view.followLeft(2);
    expect(harness.element.scrollLeft).toBeCloseTo(816 + 16 - 416, 1);

    // The tab zooms: the view stays scrolled across by the followed share.
    harness.view.followLeft(0.25);
    harness.view.updateLayout({ displayMode: 'actual', zoomPercent: 100, sourceZoomFactor: 1.25 });
    expect(harness.element.scrollLeft).toBeCloseTo(0.25 * 1020, 1);

    // The reader scrolls sideways: a zoom keeps the middle of the view, as
    // before, not the viewer's place.
    harness.element.scrollLeft = 400;
    harness.view.updateLayout({ displayMode: 'actual', zoomPercent: 100, sourceZoomFactor: 1 });
    const middle = (400 + 208) / (1020 + 16);
    expect(harness.element.scrollLeft).toBeCloseTo(middle * (816 + 16) - 208, 1);
    // Until the viewer moves sideways again.
    harness.view.followLeft(0.5);
    expect(harness.element.scrollLeft).toBeCloseTo(0.5 * 816, 1);

    // Following turned off: a zoom keeps the middle again.
    harness.view.releaseFollowedLeft();
    harness.view.updateLayout({ displayMode: 'actual', zoomPercent: 100, sourceZoomFactor: 1.25 });
    const share = (0.5 * 816 + 208) / (816 + 16);
    expect(harness.element.scrollLeft).toBeCloseTo(share * (1020 + 16) - 208, 1);

    // The view grows wider and the browser holds the offset at its end:
    // that is not the reader scrolling, and the place comes back.
    harness.view.followLeft(0.5);
    expect(harness.element.scrollLeft).toBeCloseTo(510, 1);
    harness.setWidth(716);
    Object.defineProperty(harness.element, 'scrollWidth', { configurable: true, value: 1036 });
    harness.element.scrollLeft = 320;
    harness.resize();
    harness.runFrames();
    expect(harness.element.scrollLeft).toBeCloseTo(320, 1);
    harness.setWidth(416);
    harness.resize();
    harness.runFrames();
    expect(harness.element.scrollLeft).toBeCloseTo(510, 1);
  });

  it('leaves a page that failed to draw blank, then retries it after a layout change', async () => {
    const harness = setup({ pages: 3 });
    harness.pdf.render.mockImplementationOnce(async () => {
      throw new Error('Canvas allocation failed');
    });
    harness.view.mount(harness.pdf, harness.sizes);
    await vi.advanceTimersByTimeAsync(0);
    await harness.finishNext();
    await harness.finishNext();
    expect(harness.view.drawnPages).toEqual([2, 3]);

    harness.view.updateLayout({ displayMode: 'actual', zoomPercent: 100, sourceZoomFactor: 1 });
    await vi.advanceTimersByTimeAsync(150);
    const retried = harness.pdf.render.mock.calls.filter(([page]) => page === 1);
    expect(retried.length).toBe(2);
  });

  it('draws again sharp when the screen density changes', async () => {
    let ratio = 1;
    const harness = setup({ pages: 1, devicePixelRatio: () => ratio });
    harness.view.mount(harness.pdf, harness.sizes);
    await harness.finishNext();
    expect(harness.pdf.render).toHaveBeenCalledOnce();

    ratio = 2;
    harness.changePixelRatio();
    harness.runFrames();

    expect(harness.pdf.render).toHaveBeenCalledTimes(2);
    expect(harness.pending.at(-1)?.scale).toBeCloseTo((2 * 400) / 612);
  });

  it('stops drawing, empties and hides on clear', async () => {
    const harness = setup();
    harness.view.mount(harness.pdf, harness.sizes);
    const running = harness.pending[0]!;

    harness.view.clear();
    harness.view.clear();
    await vi.advanceTimersByTimeAsync(0);

    expect(running.signal.aborted).toBe(true);
    expect(harness.element.hidden).toBe(true);
    expect(harness.element.children).toHaveLength(0);
    expect(harness.view.mounted).toBe(false);
    expect(harness.pdf.releasePage).not.toHaveBeenCalled();
    expect(harness.pdf.render).toHaveBeenCalledOnce();
  });
});

function textBlock(
  id: number,
  text: string,
  options: { fontId?: string; top?: number; align?: PdfSurfaceBlock['align'] } = {},
): PdfSurfaceBlock {
  const top = options.top ?? 72;
  const lines = [
    { left: 72, top, width: 306, height: 12 },
    { left: 72, top: top + 14, width: 200, height: 12 },
  ];
  return {
    id,
    text,
    lines,
    box: { left: 72, top, width: 306, height: 26 },
    fontSize: 10,
    lineHeight: 1.4,
    fontFamily: 'serif',
    fontId: options.fontId ?? 'regular',
    align: options.align ?? 'left',
  };
}

/** The font size a block is set to, in the page's own pixels at scale 1. */
function fontPixels(block: HTMLElement): number {
  return Number(/\* ([\d.]+)px/u.exec(block.style.fontSize)?.[1] ?? Number.NaN);
}

/** A page-sized white canvas with black ink everywhere else. */
function whitePixels(): RgbaPixels {
  const width = 612;
  const height = 792;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  return { width, height, data };
}

describe('PdfView text', () => {
  it('names every page and names them again on request', () => {
    let word = 'Page';
    const harness = setup({ pages: 3, pageLabel: (page, total) => `${word} ${page}/${total}` });
    harness.view.mount(harness.pdf, harness.sizes);
    const pages = harness.element.querySelectorAll<HTMLElement>('.pdf-page');

    expect(pages[1]?.getAttribute('role')).toBe('group');
    expect(pages[1]?.getAttribute('aria-label')).toBe('Page 2/3');
    word = 'Seite';
    harness.view.relabelPages();
    expect(pages[2]?.getAttribute('aria-label')).toBe('Seite 3/3');
  });

  it('lays the source text over a page, transparent, in shares of the page', () => {
    const harness = setup({ pages: 2 });
    harness.view.mount(harness.pdf, harness.sizes);

    harness.view.setPageText(1, [textBlock(7, 'Bonjour le monde')]);

    const page = harness.element.querySelectorAll<HTMLElement>('.pdf-page')[1]!;
    const block = page.querySelector<HTMLElement>('.pdf-block')!;
    expect(page.querySelector('.pdf-text-layer')).not.toBeNull();
    expect(block.textContent).toBe('Bonjour le monde');
    expect(block.classList.contains('pdf-block--translated')).toBe(false);
    expect(block.getAttribute('dir')).toBe('auto');
    expect(block.style.left).toBe(`${Math.round((72 / 612) * 100_000) / 1000}%`);
    expect(block.style.width).toBe('50%');
    // Two lines at 1.4 × 10 points: 28 points, a little more than the 26 of the line boxes.
    expect(block.style.height).toBe(`${Math.round((28 / 792) * 100_000) / 1000}%`);
    expect(block.style.fontSize).toBe('calc(var(--pdf-scale, 1) * 10px)');
    expect(block.style.fontFamily).toBe('serif');
    expect(Number(harness.element.querySelector<HTMLElement>('.pdf-view-pages')!.style
      .getPropertyValue('--pdf-scale'))).toBeCloseTo(400 / 612, 6);
  });

  it('shows a translation over covers in the page colours, then the source again', async () => {
    const readPixels = vi.fn(() => whitePixels());
    const harness = setup({ pages: 1, readPixels });
    harness.view.mount(harness.pdf, harness.sizes);
    harness.view.setPageText(0, [textBlock(7, 'Bonjour', { fontId: 'bold' })]);
    await harness.finishNext();
    await vi.advanceTimersByTimeAsync(0);

    harness.view.showTranslation(7, 'Hello', 'en');

    const block = harness.element.querySelector<HTMLElement>('.pdf-block')!;
    expect(block.classList.contains('pdf-block--translated')).toBe(true);
    expect(block.getAttribute('lang')).toBe('en');
    expect(block.querySelector('.pdf-block-text')?.textContent).toBe('Hello');
    const covers = block.querySelectorAll<HTMLElement>('.pdf-block-cover');
    expect(covers).toHaveLength(2);
    expect(covers[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(block.style.getPropertyValue('--pdf-cover')).toBe('rgb(255, 255, 255)');
    expect(readPixels).toHaveBeenCalledOnce();
    expect(harness.pdf.fontFaces).toHaveBeenCalledWith(1, ['bold']);
    expect(block.style.fontWeight).toBe('700');

    harness.view.hideTranslations();
    expect(block.classList.contains('pdf-block--translated')).toBe(false);
    expect(block.textContent).toBe('Bonjour');
    expect(block.hasAttribute('lang')).toBe(false);
  });

  it('shrinks a long translation to fit, but never below half size', async () => {
    const needed = new Map<string, number>([['Short', 20], ['Long', 80], ['Endless', 10_000]]);
    const measured = new Map<string, number>();
    const measureBlock: PdfBlockMeasure = (block, text) => {
      measured.set(text.textContent ?? '', (measured.get(text.textContent ?? '') ?? 0) + 1);
      const scale = Number(/\* ([\d.]+)px/u.exec(block.style.fontSize)?.[1] ?? 10) / 10;
      // Wrapping text needs room with the square of the font scale.
      const height = (needed.get(text.textContent ?? '') ?? 0) * scale * scale;
      return { needed: { width: 100, height }, available: { width: 100, height: 20 } };
    };
    const harness = setup({ pages: 1, measureBlock });
    harness.view.mount(harness.pdf, harness.sizes);
    harness.view.setPageText(0, [
      textBlock(1, 'Un'),
      textBlock(2, 'Deux', { top: 200 }),
      textBlock(3, 'Trois', { top: 400 }),
    ]);
    await harness.finishNext();

    harness.view.showTranslation(1, 'Short', 'en');
    harness.view.showTranslation(2, 'Long', 'en');
    harness.view.showTranslation(3, 'Endless', 'en');
    harness.runFrames();

    const sizes = [...harness.element.querySelectorAll<HTMLElement>('.pdf-block')]
      .map((block) => block.style.fontSize);
    expect(sizes[0]).toBe('calc(var(--pdf-scale, 1) * 10px)');
    expect(sizes[1]).toBe('calc(var(--pdf-scale, 1) * 5px)');
    expect(sizes[2]).toBe('calc(var(--pdf-scale, 1) * 5px)');
    // Still too long at half size: measured at full size and at half, then left.
    expect(measured.get('Endless')).toBe(2);
  });

  it('measures every drawn page before resizing any', async () => {
    const log: Array<[string, number]> = [];
    const measureBlock: PdfBlockMeasure = (block, text) => {
      const size = fontPixels(block);
      log.push([text.textContent ?? '', size]);
      return {
        needed: { width: 100, height: 40 * (size / 10) ** 2 },
        available: { width: 100, height: 20 },
      };
    };
    const harness = setup({ pages: 2, measureBlock });
    harness.view.mount(harness.pdf, harness.sizes);
    harness.view.setPageText(0, [textBlock(1, 'Un')]);
    harness.view.setPageText(1, [textBlock(2, 'Deux')]);
    await harness.finishNext();
    await harness.finishNext();

    harness.view.showTranslation(1, 'Page one', 'en');
    harness.view.showTranslation(2, 'Page two', 'en');
    harness.runFrames();

    // Round one measures both pages at full size before either shrinks;
    // round two measures both at their new size.
    expect(log.slice(0, 2)).toEqual([['Page one', 10], ['Page two', 10]]);
    expect(log.slice(2, 4).map(([text]) => text)).toEqual(['Page one', 'Page two']);
    expect(log.slice(2, 4).every(([, size]) => size < 10)).toBe(true);
  });

  it('fits a block that could not be measured at a later frame', async () => {
    let laidOut = false;
    const measureBlock: PdfBlockMeasure = (block) => laidOut
      ? {
          needed: { width: 100, height: 40 * (fontPixels(block) / 10) ** 2 },
          available: { width: 100, height: 20 },
        }
      : undefined;
    const harness = setup({ pages: 1, measureBlock });
    harness.view.mount(harness.pdf, harness.sizes);
    harness.view.setPageText(0, [textBlock(1, 'Un')]);
    await harness.finishNext();
    const block = harness.element.querySelector<HTMLElement>('.pdf-block')!;

    harness.view.showTranslation(1, 'Longer text', 'en');
    harness.runFrames();
    expect(fontPixels(block)).toBe(10);

    laidOut = true;
    harness.element.dispatchEvent(new harness.window.Event('scroll'));
    harness.runFrames();
    expect(fontPixels(block)).toBeLessThan(7.5);
  });

  it('keeps the alignment of the text it covers', async () => {
    const harness = setup({ pages: 1 });
    harness.view.mount(harness.pdf, harness.sizes);
    harness.view.setPageText(0, [
      textBlock(1, 'Titre', { align: 'center' }),
      textBlock(2, 'Signé', { top: 300, align: 'right' }),
      textBlock(3, 'Texte', { top: 500 }),
    ]);
    harness.view.showTranslation(1, 'Title', 'en');

    expect([...harness.element.querySelectorAll<HTMLElement>('.pdf-block')]
      .map((block) => block.style.textAlign)).toEqual(['center', 'right', 'left']);
  });

  it('settles a line that barely wraps near the largest size that fits', async () => {
    // One line of room; the translation needs 1.1 lines' width at full size,
    // so it wraps to two lines above a scale of 1 / 1.1.
    const measureBlock: PdfBlockMeasure = (block) => {
      const scale = Number(/\* ([\d.]+)px/u.exec(block.style.fontSize)?.[1] ?? 10) / 10;
      const lines = 1.1 * scale > 1 ? 2 : 1;
      return {
        needed: { width: 100, height: lines * 20 * scale },
        available: { width: 100, height: 20 },
      };
    };
    const harness = setup({ pages: 1, measureBlock });
    harness.view.mount(harness.pdf, harness.sizes);
    harness.view.setPageText(0, [textBlock(1, 'Un')]);
    await harness.finishNext();

    harness.view.showTranslation(1, 'A little longer', 'en');
    harness.runFrames();

    const block = harness.element.querySelector<HTMLElement>('.pdf-block')!;
    const size = Number(/\* ([\d.]+)px/u.exec(block.style.fontSize)?.[1]);
    // The square-root estimate alone would stop at 7.07px.
    expect(size).toBeGreaterThan(8.5);
    expect(size).toBeLessThanOrEqual(10 / 1.1);
  });

  it('keeps a translation for a page not drawn yet, and fits it once drawn', async () => {
    const measureBlock = vi.fn<PdfBlockMeasure>(() => undefined);
    const harness = setup({ pages: 10, measureBlock });
    harness.view.mount(harness.pdf, harness.sizes);
    harness.view.setPageText(9, [textBlock(4, 'Fin')]);

    harness.view.showTranslation(4, 'End', 'en');
    harness.runFrames();

    expect(harness.element.querySelectorAll<HTMLElement>('.pdf-page')[9]
      ?.querySelector('.pdf-block-text')?.textContent).toBe('End');
    expect(measureBlock).not.toHaveBeenCalled();
  });

  it('reports the page the reader scrolled to', () => {
    const reading: number[] = [];
    const harness = setup({ pages: 10, onReadingPageChange: (index) => reading.push(index) });
    harness.view.mount(harness.pdf, harness.sizes);
    const pageHeight = (792 * 400) / 612;

    harness.element.scrollTop = 8 + 3 * (pageHeight + 8) + 10;
    harness.element.dispatchEvent(new harness.window.Event('scroll'));
    harness.runFrames();
    harness.element.dispatchEvent(new harness.window.Event('scroll'));
    harness.runFrames();

    expect(reading).toEqual([0, 3]);
  });

  it('builds text layers only near the view once a long PDF passes the budget', async () => {
    // Room for two blocks' worth of layers; every page has one block.
    const harness = setup({ pages: 40, maxTextLayerBlocks: 2 });
    harness.view.mount(harness.pdf, harness.sizes);
    const pageHeight = (792 * 400) / 612;
    const layered = () =>
      [...harness.element.querySelectorAll('.pdf-page')]
        .flatMap((page, index) => (page.querySelector('.pdf-text-layer') ? [index] : []));
    for (let index = 0; index < 40; index += 1) {
      harness.view.setPageText(index, [textBlock(index + 1, `Texte ${index + 1}`)]);
    }
    // The view shows pages 0 and 1; a screen below reaches page 2.
    expect(layered()).toEqual([0, 1, 2]);
    // Translations arrive for every page, with or without a layer.
    for (let index = 0; index < 40; index += 1) {
      harness.view.showTranslation(index + 1, `Text ${index + 1}`, 'en');
    }

    harness.element.scrollTop = 8 + 30 * (pageHeight + 8);
    harness.element.dispatchEvent(new harness.window.Event('scroll'));
    harness.runFrames();
    await vi.advanceTimersByTimeAsync(0);
    harness.element.dispatchEvent(new harness.window.Event('scroll'));
    harness.runFrames();

    // The pages within a screen of the view have layers now, with their
    // translations; the first pages gave theirs up, and their names stay.
    expect(layered()).toEqual([28, 29, 30, 31, 32]);
    const page30 = harness.element.querySelectorAll('.pdf-page')[30]!;
    expect(page30.querySelector('.pdf-block-text')?.textContent).toBe('Text 31');
    expect(page30.querySelector('.pdf-block')?.getAttribute('lang')).toBe('en');
    expect(harness.element.querySelectorAll('.pdf-page')[0]!.getAttribute('aria-label'))
      .toBe('Page 1 of 40');

    // Live source only: kept translations are forgotten too.
    harness.view.hideTranslations();
    harness.element.scrollTop = 0;
    harness.element.dispatchEvent(new harness.window.Event('scroll'));
    harness.runFrames();
    expect(harness.element.querySelectorAll('.pdf-page')[0]!
      .querySelector('.pdf-block-text')?.textContent).toBe('Texte 1');
  });

  it('builds a layer again as it was: translation, font faces, colours from the drawn page', async () => {
    const readPixels = vi.fn(() => whitePixels());
    // One drawn page at a time, so scrolling away releases the first page.
    const harness = setup({ pages: 40, maxTextLayerBlocks: 1, maxDrawnPages: 1, readPixels });
    harness.view.mount(harness.pdf, harness.sizes);
    const pageHeight = (792 * 400) / 612;
    harness.view.setPageText(0, [textBlock(1, 'Bonjour', { fontId: 'bold' })]);
    // A page pdf.js found no text on has no layer at all.
    harness.view.setPageText(1, []);
    harness.view.setPageText(30, [textBlock(2, 'Loin', { fontId: 'bold' })]);
    await harness.finishNext();
    await vi.advanceTimersByTimeAsync(0);
    harness.view.showTranslation(1, 'Hello', 'en');
    const first = harness.element.querySelectorAll<HTMLElement>('.pdf-page')[0]!;
    expect(first.querySelector<HTMLElement>('.pdf-block')?.style.fontWeight).toBe('700');
    expect(harness.element.querySelectorAll('.pdf-page')[1]!.querySelector('.pdf-text-layer'))
      .toBeNull();
    // Over the budget, a drawn page keeps its layer and a far page has none.
    expect(first.querySelector('.pdf-text-layer')).not.toBeNull();
    expect(harness.element.querySelectorAll('.pdf-page')[30]!.querySelector('.pdf-text-layer'))
      .toBeNull();

    // Far away the first page's canvas is released and its layer removed.
    const scrollTo = async (top: number) => {
      harness.element.scrollTop = top;
      for (let pass = 0; pass < 12; pass += 1) {
        harness.element.dispatchEvent(new harness.window.Event('scroll'));
        harness.runFrames();
        await harness.finishNext();
      }
    };
    await scrollTo(8 + 30 * (pageHeight + 8));
    expect(first.querySelector('.pdf-text-layer')).toBeNull();
    expect(harness.element.querySelectorAll('.pdf-page')[30]!
      .querySelector('.pdf-block-text')?.textContent).toBe('Loin');

    // Back again: the same translation and weight, without asking pdf.js for
    // the first page's fonts a second time.
    const asked = harness.pdf.fontFaces.mock.calls.filter(([page]) => page === 1).length;
    await scrollTo(0);
    const block = first.querySelector<HTMLElement>('.pdf-block')!;
    expect(block.querySelector('.pdf-block-text')?.textContent).toBe('Hello');
    expect(block.style.fontWeight).toBe('700');
    expect(block.style.getPropertyValue('--pdf-cover')).toBe('rgb(255, 255, 255)');
    expect(harness.pdf.fontFaces.mock.calls.filter(([page]) => page === 1)).toHaveLength(asked);
  });

  it('leaves a page as drawn when its text layer cannot be built, and draws on', async () => {
    const harness = setup({ pages: 3 });
    harness.view.mount(harness.pdf, harness.sizes);
    const broken = { ...textBlock(1, 'Cassé'), lines: undefined } as unknown as PdfSurfaceBlock;
    expect(() => harness.view.setPageText(0, [broken])).not.toThrow();
    harness.view.setPageText(1, [textBlock(2, 'Deux')]);
    await harness.finishNext();
    await harness.finishNext();

    const pages = harness.element.querySelectorAll('.pdf-page');
    expect(pages[0]!.querySelector('.pdf-text-layer')).toBeNull();
    expect(pages[0]!.querySelector('canvas')).not.toBeNull();
    expect(pages[1]!.querySelector('.pdf-block-text')?.textContent).toBe('Deux');
  });

  it('keeps every layer of a PDF within the budget, and replaces a page read again', () => {
    const harness = setup({ pages: 40 });
    harness.view.mount(harness.pdf, harness.sizes);
    for (let index = 0; index < 40; index += 1) {
      harness.view.setPageText(index, [textBlock(index + 1, `Texte ${index + 1}`)]);
    }
    harness.view.showTranslation(40, 'Text 40', 'en');
    expect(harness.element.querySelectorAll('.pdf-text-layer')).toHaveLength(40);

    // A scanned page read again: new blocks, and the old translation is gone.
    harness.view.setPageText(39, [textBlock(99, 'Lu par OCR')]);
    const last = harness.element.querySelectorAll('.pdf-page')[39]!;
    expect(last.querySelectorAll('.pdf-text-layer')).toHaveLength(1);
    expect(last.querySelector('.pdf-block-text')?.textContent).toBe('Lu par OCR');
    harness.view.showTranslation(40, 'stale', 'en');
    expect(last.querySelector('.pdf-block-text')?.textContent).toBe('Lu par OCR');
  });

  it('keeps the translation of a block that stays when its page is read again', () => {
    const harness = setup({ pages: 2 });
    harness.view.mount(harness.pdf, harness.sizes);
    // A typed header over a scan, already translated when OCR adds the rest.
    harness.view.setPageText(0, [textBlock(1, 'En-tête')]);
    harness.view.showTranslation(1, 'Header', 'en');
    harness.view.setPageText(0, [
      textBlock(1, 'En-tête'),
      textBlock(2, 'Lu par OCR', { top: 200 }),
    ]);
    const texts = () => [...harness.element.querySelectorAll('.pdf-page')[0]!
      .querySelectorAll('.pdf-block-text')].map((text) => text.textContent);
    expect(texts()).toEqual(['Header', 'Lu par OCR']);
    harness.view.showTranslation(2, 'Read by OCR', 'en');
    expect(texts()).toEqual(['Header', 'Read by OCR']);

    // The reading is forgotten (another OCR model): the header stays translated.
    harness.view.setPageText(0, [textBlock(1, 'En-tête')]);
    expect(texts()).toEqual(['Header']);
    harness.view.showTranslation(2, 'stale', 'en');
    expect(texts()).toEqual(['Header']);
  });

  it('names the PDF’s language on its text, and the target language on a translation', () => {
    const harness = setup({ pages: 3 });
    harness.view.mount(harness.pdf, harness.sizes);
    harness.view.setSourceLanguage(' fr ');
    harness.view.setPageText(0, [textBlock(1, 'Bonjour'), textBlock(2, 'Au revoir', { top: 200 })]);
    const page = harness.element.querySelector<HTMLElement>('.pdf-page')!;
    const layer = page.querySelector<HTMLElement>('.pdf-text-layer')!;
    const [block, other] = [...layer.querySelectorAll<HTMLElement>('.pdf-block')];
    // On the text, not on the page: its name is in the panel's language.
    expect(layer.getAttribute('lang')).toBe('fr');
    expect(page.hasAttribute('lang')).toBe(false);
    expect(block!.hasAttribute('lang')).toBe(false);

    harness.view.showTranslation(1, 'Hello', 'en');
    expect(block!.getAttribute('lang')).toBe('en');
    // A translation in an unknown language does not pass for French.
    harness.view.showTranslation(2, 'Goodbye', undefined);
    expect(other!.getAttribute('lang')).toBe('');
    harness.view.hideTranslations();
    expect(block!.hasAttribute('lang')).toBe(false);
    expect(other!.hasAttribute('lang')).toBe(false);

    // Known later (Auto-detect), changed, or unknown again.
    harness.view.setSourceLanguage('de');
    expect(layer.getAttribute('lang')).toBe('de');
    harness.view.setPageText(1, [textBlock(3, 'Zwei')]);
    expect(harness.element.querySelectorAll('.pdf-text-layer')[1]?.getAttribute('lang')).toBe('de');
    harness.view.setSourceLanguage(undefined);
    // Unknown is said so, rather than left to the panel's own language.
    expect(layer.getAttribute('lang')).toBe('');

    // A new PDF starts without the last one's language.
    harness.view.setSourceLanguage('de');
    harness.view.mount(harness.pdf, harness.sizes);
    harness.view.setPageText(0, [textBlock(4, 'Hello')]);
    expect(harness.element.querySelector('.pdf-text-layer')?.getAttribute('lang')).toBe('');
  });

  it('keeps a right-aligned block right-aligned when its translation is right-to-left', () => {
    const harness = setup({ pages: 1 });
    harness.view.mount(harness.pdf, harness.sizes);
    harness.view.setPageText(0, [textBlock(1, 'Signed, the director', { align: 'right' })]);
    harness.view.showTranslation(1, 'وقّعه المدير', 'ar');

    const block = harness.element.querySelector<HTMLElement>('.pdf-block')!;
    expect(block.style.textAlign).toBe('right');
    expect(block.getAttribute('dir')).toBe('auto');
    expect(block.getAttribute('lang')).toBe('ar');
  });

  it('shows translations only on a drawn page whose colours were read', async () => {
    const harness = setup({ pages: 10, readPixels: () => whitePixels() });
    harness.view.mount(harness.pdf, harness.sizes);
    harness.view.setPageText(0, [textBlock(1, 'Un')]);
    harness.view.setPageText(9, [textBlock(2, 'Dix')]);
    harness.view.showTranslation(1, 'One', 'en');
    harness.view.showTranslation(2, 'Ten', 'en');
    const pages = harness.element.querySelectorAll<HTMLElement>('.pdf-page');
    // Page 1 is being drawn, page 10 is far away: neither shows its overlay yet,
    // though both hold the translated text for screen readers.
    expect(pages[0]?.hasAttribute('data-overlays')).toBe(false);
    expect(pages[9]?.hasAttribute('data-overlays')).toBe(false);
    expect(pages[9]?.querySelector('.pdf-block-text')?.textContent).toBe('Ten');

    await harness.finishNext();
    expect(pages[0]?.hasAttribute('data-overlays')).toBe(true);
    expect(pages[9]?.hasAttribute('data-overlays')).toBe(false);
  });

  it('reads the pixels of a page once, and again only after the next draw', async () => {
    const readPixels = vi.fn((): RgbaPixels | undefined => undefined);
    const harness = setup({ pages: 1, readPixels });
    harness.view.mount(harness.pdf, harness.sizes);
    harness.view.setPageText(0, [textBlock(1, 'Un'), textBlock(2, 'Deux', { top: 300 })]);
    await harness.finishNext();

    harness.view.showTranslation(1, 'One', 'en');
    harness.view.showTranslation(2, 'Two', 'en');
    expect(readPixels).toHaveBeenCalledOnce();
    // The read failed: translations show with the default colours.
    const page = harness.element.querySelector<HTMLElement>('.pdf-page')!;
    expect(page.hasAttribute('data-overlays')).toBe(true);

    readPixels.mockImplementation(() => whitePixels());
    harness.view.updateLayout({ displayMode: 'actual', zoomPercent: 100, sourceZoomFactor: 1 });
    await vi.advanceTimersByTimeAsync(150);
    await harness.finishNext();
    expect(readPixels).toHaveBeenCalledTimes(2);
    expect(page.querySelector<HTMLElement>('.pdf-block')!.style.getPropertyValue('--pdf-cover'))
      .toBe('rgb(255, 255, 255)');
  });

  it('forgets the blocks of a page whose text is replaced', () => {
    const harness = setup({ pages: 1 });
    harness.view.mount(harness.pdf, harness.sizes);
    harness.view.setPageText(0, [textBlock(1, 'Ancien')]);
    harness.view.setPageText(0, [textBlock(2, 'Nouveau')]);

    harness.view.showTranslation(1, 'Old', 'en');
    harness.view.showTranslation(2, 'New', 'en');

    const texts = [...harness.element.querySelectorAll('.pdf-block-text')].map((text) => text.textContent);
    expect(texts).toEqual(['New']);
    expect(harness.element.querySelectorAll('.pdf-text-layer')).toHaveLength(1);
  });

  it('asks for font faces again after the next draw when pdf.js refused', async () => {
    const harness = setup({ pages: 1 });
    harness.pdf.fontFaces.mockRejectedValueOnce(new Error('Worker busy'));
    harness.view.mount(harness.pdf, harness.sizes);
    harness.view.setPageText(0, [textBlock(1, 'Titre', { fontId: 'bold' })]);
    await harness.finishNext();
    await vi.advanceTimersByTimeAsync(0);
    const block = harness.element.querySelector<HTMLElement>('.pdf-block')!;
    expect(block.style.fontWeight).toBe('');

    harness.view.updateLayout({ displayMode: 'actual', zoomPercent: 100, sourceZoomFactor: 1 });
    await vi.advanceTimersByTimeAsync(150);
    await harness.finishNext();
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.pdf.fontFaces).toHaveBeenCalledTimes(2);
    expect(block.style.fontWeight).toBe('700');
  });

  it('fits again after a zoom of more than a tenth, not after a smaller one', async () => {
    const measureBlock = vi.fn<PdfBlockMeasure>((block) => ({
      needed: { width: 100, height: 40 * (fontPixels(block) / 10) ** 2 },
      available: { width: 100, height: 20 },
    }));
    const harness = setup({ pages: 1, measureBlock });
    harness.view.mount(harness.pdf, harness.sizes);
    harness.view.setPageText(0, [textBlock(1, 'Un')]);
    await harness.finishNext();
    harness.view.showTranslation(1, 'Longer', 'en');
    harness.runFrames();
    const fitted = measureBlock.mock.calls.length;
    expect(fitted).toBeGreaterThan(0);

    // Fit follows the panel width: 5% wider keeps the fit, 50% wider redoes it.
    harness.setWidth(416 * 1.05);
    harness.resize();
    harness.runFrames();
    expect(measureBlock.mock.calls.length).toBe(fitted);

    harness.setWidth(416 * 1.5);
    harness.resize();
    harness.runFrames();
    expect(measureBlock.mock.calls.length).toBeGreaterThan(fitted);
  });
});
