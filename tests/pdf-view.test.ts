import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PdfView, type PdfViewDocument } from '../entrypoints/sidepanel/pdf-view';

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
  devicePixelRatio?: () => number;
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
