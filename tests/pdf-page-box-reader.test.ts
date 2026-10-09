import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createCanvas, loadImage, type Canvas } from '@napi-rs/canvas';
import Tesseract from 'tesseract.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  PDF_CAPTURE_REFUSED,
  PDF_CAPTURE_UNWANTED,
  PDF_LOCATE_STOP,
  PdfPageBoxReader,
  captureChromePdfTab,
  type PdfLocateDiagnostic,
  type PdfPageBoxPicture,
  type PdfPageBoxRequest,
  type PdfTabCapture,
  type PdfTabCaptureEnvironment,
} from '../entrypoints/sidepanel/pdf-page-box-reader';
import { SourceTabCaptureError } from '../lib/ocr/pixel-acquisition';
import { PDF_PAGE_BOX_INK_HEIGHTS, PDF_TOOLBAR_HEIGHT } from '../lib/pdf/pdf-page-box';
import type { PdfViewerDoubt } from '../lib/pdf/pdf-viewer-tracker';

interface StripFixture {
  readonly file: string;
  readonly scale: number;
  readonly pageCount: number;
  readonly page: number;
  readonly box: string;
}

const directory = resolve('tests/fixtures/pdf-toolbar');
const { strips } = JSON.parse(readFileSync(resolve(directory, 'strips.json'), 'utf8')) as {
  strips: StripFixture[];
};
const fixture = (file: string) => strips.find((strip) => strip.file === file)!;
const VIEW_HEIGHT = 600;

/** A capture of a tab whose top is the strip: the toolbar, then the viewer's view. */
async function captureOf(
  strip: Pick<StripFixture, 'file' | 'scale'>,
  below = VIEW_HEIGHT,
): Promise<PdfTabCapture & { image: Canvas & { close: ReturnType<typeof vi.fn> } }> {
  const toolbar = await loadImage(resolve(directory, strip.file));
  const height = toolbar.height + Math.round(below * strip.scale);
  const canvas = createCanvas(toolbar.width, height);
  const context = canvas.getContext('2d');
  // The viewer's grey ground, where a page would be.
  context.fillStyle = 'rgb(82, 86, 89)';
  context.fillRect(0, 0, toolbar.width, height);
  context.drawImage(toolbar, 0, 0);
  const image = Object.assign(canvas, { close: vi.fn() });
  return {
    image,
    tabWidth: toolbar.width / strip.scale,
    tabHeight: PDF_TOOLBAR_HEIGHT + below,
  };
}

function doubtOf(pageCount: number, viewportHeight = VIEW_HEIGHT): PdfViewerDoubt {
  return {
    viewport: { pageX: 100, pageY: -40, pageWidth: 700, viewportWidth: 900, viewportHeight },
    page: 0,
    pages: Array.from({ length: pageCount }, (_, index) => index),
    episode: 1,
  };
}

/** The canvas as a PNG, as the panel's own canvas gives it. */
function pngOf(canvas: Canvas): Blob {
  return new Blob([new Uint8Array(canvas.toBuffer('image/png'))], { type: 'image/png' });
}

let worker: Awaited<ReturnType<typeof Tesseract.createWorker>>;

beforeAll(async () => {
  // The model the extension ships, in the block mode its OCR host reads in.
  worker = await Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
    langPath: resolve('vendor/ocr/tesseract/lang'),
    gzip: true,
    cacheMethod: 'none',
  });
  await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK });
}, 120_000);

afterAll(async () => {
  await worker?.terminate();
});

/** Reads a picture as the extension's OCR host does. */
async function tesseract(picture: PdfPageBoxPicture): Promise<string | undefined> {
  const png = Buffer.from(await picture.encoded.arrayBuffer());
  const { data } = await worker.recognize(png, {}, { text: true });
  const text = data.text.trim();
  return text === '' ? undefined : text;
}

/**
 * A reader over a capture, taken as `captureChromePdfTab` takes it: not at
 * all when the tab's size is not wanted.
 */
function readerFor(capture: PdfTabCapture | typeof PDF_CAPTURE_REFUSED | undefined) {
  const diagnostics: PdfLocateDiagnostic[] = [];
  const taken = vi.fn();
  const clock = { now: 0 };
  const reader = new PdfPageBoxReader({
    capture: async (_tabId, _signal, wanted) => {
      if (capture && capture !== PDF_CAPTURE_REFUSED && !wanted(capture.tabWidth, capture.tabHeight)) {
        return PDF_CAPTURE_UNWANTED;
      }
      taken();
      return capture;
    },
    createCanvas: (width, height) => createCanvas(width, height) as never,
    encode: (canvas) => pngOf(canvas as unknown as Canvas),
    now: () => clock.now,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  return { reader, diagnostics, taken, clock };
}

function requestFor(
  strip: Pick<StripFixture, 'pageCount'>,
  overrides: Partial<PdfPageBoxRequest> = {},
): PdfPageBoxRequest {
  return {
    tabId: 7,
    doubt: doubtOf(strip.pageCount),
    pageCount: strip.pageCount,
    read: tesseract,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('PdfPageBoxReader on pictures of Chrome\'s toolbar, read by the bundled Tesseract (D133)', () => {
  const readable = strips.filter((strip) => !/selected|caret|more-menu/u.test(strip.file));

  it.each(readable.map((strip) => [strip.file, strip] as const))(
    'reads the page box of %s',
    async (_file, strip) => {
      const capture = await captureOf(strip);
      const { reader, diagnostics } = readerFor(capture);

      // What the box shows: the viewer's page, but for a number typed and
      // not entered, which the viewer has not gone to yet.
      expect(await reader.locate(requestFor(strip))).toBe(Number(strip.box) - 1);
      expect(diagnostics).toEqual([{ stage: 'locate', outcome: 'read', milliseconds: 0 }]);
      expect(capture.image.close).toHaveBeenCalledTimes(1);
    },
    60_000,
  );

  it.each([
    ['state-1x-selected.png'],
    ['state-2x-selected.png'],
    ['state-1x-typed-caret.png'],
    ['state-2x-typed-caret.png'],
    ['state-1x-more-menu.png'],
  ])('keeps the guess for %s, without reading anything', async (file) => {
    const strip = fixture(file);
    const read = vi.fn(tesseract);
    const { reader, diagnostics } = readerFor(await captureOf(strip));

    expect(await reader.locate(requestFor(strip, { read }))).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ outcome: 'kept' });
    expect(['box', 'count', 'number']).toContain(diagnostics[0]!.why);
  });
});

describe('PdfPageBoxReader keeps the guess unless everything fits (D133)', () => {
  const strip = fixture('own-1x-55-of-300.png');
  /** A reading that says what the test wants, whatever the picture shows. */
  const says = (...texts: (string | undefined)[]) => {
    const read = vi.fn(async (): Promise<string | undefined> => texts[Math.min(read.mock.calls.length, texts.length) - 1]);
    return read;
  };

  it('reads the picture at each size, and lets the capture go before the first reading', async () => {
    const capture = await captureOf(strip);
    const { reader } = readerFor(capture);
    const sizes: number[] = [];
    const read = vi.fn(async (picture: PdfPageBoxPicture) => {
      expect(capture.image.close).toHaveBeenCalledTimes(1);
      sizes.push(picture.height);
      return '55 / 300';
    });

    expect(await reader.locate(requestFor(strip, { read }))).toBe(54);
    expect(read).toHaveBeenCalledTimes(PDF_PAGE_BOX_INK_HEIGHTS.length);
    // The same picture, larger: a few times the digits' height each.
    expect(sizes[1]! / sizes[0]!).toBeCloseTo(PDF_PAGE_BOX_INK_HEIGHTS[1] / PDF_PAGE_BOX_INK_HEIGHTS[0], 1);
    expect(sizes[0]).toBeGreaterThan(PDF_PAGE_BOX_INK_HEIGHTS[0] * 2);
    expect(sizes[0]).toBeLessThan(PDF_PAGE_BOX_INK_HEIGHTS[0] * 4);
  });

  it('takes no page when two readings differ', async () => {
    const { reader, diagnostics } = readerFor(await captureOf(strip));

    expect(await reader.locate(requestFor(strip, { read: says('55 / 300', '95 / 300') })))
      .toBeUndefined();
    expect(diagnostics).toEqual([{ stage: 'locate', outcome: 'kept', why: 'differ', milliseconds: 0 }]);
  });

  it('takes no page when a reading is not this PDF\'s count, or not as many digits as the box holds', async () => {
    for (const text of ['55 / 800', '5 / 300', '555 / 300', '55 300', 'SS / 300']) {
      const { reader, diagnostics } = readerFor(await captureOf(strip));
      const read = says(text);

      expect(await reader.locate(requestFor(strip, { read })), text).toBeUndefined();
      // Once for the number spaced out, once as it stands.
      expect(read, text).toHaveBeenCalledTimes(2);
      expect(diagnostics[0], text).toMatchObject({ outcome: 'kept', why: 'text' });
    }
  });

  it('reads the number as it stands when it is not read spaced out', async () => {
    // "5 / 12" in Chrome's own font: spaced out, Tesseract reads the 5 as a
    // section sign at the smaller size.
    const twelve = fixture('own-1x-5-of-12.png');
    const { reader, diagnostics } = readerFor(await captureOf(twelve));
    const widths: number[] = [];
    const read = vi.fn(async (picture: PdfPageBoxPicture) => {
      widths.push(picture.width);
      return tesseract(picture);
    });

    expect(await reader.locate(requestFor(twelve, { read }))).toBe(4);
    expect(diagnostics).toEqual([{ stage: 'locate', outcome: 'read', milliseconds: 0 }]);
    // Spaced out at the first size, then as it stands at both.
    expect(read).toHaveBeenCalledTimes(3);
    expect(widths[0]).toBeGreaterThan(widths[1]!);
    expect(widths[2]).toBeGreaterThan(widths[1]!);
  }, 60_000);

  it('takes a page from the readings of one picture only', async () => {
    // Spaced out: one size reads, the other does not. As it stands: nothing.
    const one = readerFor(await captureOf(strip));
    const lone = says('55 / 300', 'SS / 300', '55 300');
    expect(await one.reader.locate(requestFor(strip, { read: lone }))).toBeUndefined();
    expect(lone).toHaveBeenCalledTimes(3);
    expect(one.diagnostics[0]).toMatchObject({ outcome: 'kept', why: 'text' });

    // As it stands both sizes read, and agree.
    const other = readerFor(await captureOf(strip));
    const plain = says('SS / 300', '55 / 300', '55 / 300');
    expect(await other.reader.locate(requestFor(strip, { read: plain }))).toBe(54);
    expect(plain).toHaveBeenCalledTimes(3);

    // Two readings of the spaced picture that differ end the look.
    const third = readerFor(await captureOf(strip));
    const differing = says('55 / 300', '95 / 300', '55 / 300', '55 / 300');
    expect(await third.reader.locate(requestFor(strip, { read: differing }))).toBeUndefined();
    expect(differing).toHaveBeenCalledTimes(2);
    expect(third.diagnostics[0]).toMatchObject({ outcome: 'kept', why: 'differ' });
  });

  it('takes no page when nothing is read, or reading fails', async () => {
    const nothing = readerFor(await captureOf(strip));
    expect(await nothing.reader.locate(requestFor(strip, { read: says(undefined) }))).toBeUndefined();
    expect(nothing.diagnostics[0]).toMatchObject({ outcome: 'kept', why: 'unread' });

    const failing = readerFor(await captureOf(strip));
    const read = vi.fn(async () => {
      throw new Error('The OCR host is gone.');
    });
    expect(await failing.reader.locate(requestFor(strip, { read }))).toBeUndefined();
    expect(failing.diagnostics[0]).toMatchObject({ outcome: 'kept', why: 'unread' });
  });

  it('takes only a page that is where the viewer reports the page', async () => {
    const { reader, diagnostics } = readerFor(await captureOf(strip));
    // The report fits pages 1 to 20 only (a PDF whose later pages are wider).
    const doubt = { ...doubtOf(300), pages: Array.from({ length: 20 }, (_, index) => index) };

    expect(await reader.locate(requestFor(strip, { doubt }))).toBeUndefined();
    expect(diagnostics[0]).toMatchObject({ outcome: 'kept', why: 'page' });
  });

  it('does not capture a tab whose toolbar is hidden: the top of the tab is the PDF\'s page', async () => {
    // Presenting, or `#toolbar=0`: the viewer's view is as tall as the tab.
    const capture = await captureOf(strip);
    const read = vi.fn(tesseract);
    for (const viewportHeight of [VIEW_HEIGHT + PDF_TOOLBAR_HEIGHT, VIEW_HEIGHT + 20, VIEW_HEIGHT - 20]) {
      const { reader, diagnostics, taken } = readerFor(capture);

      expect(await reader.locate(requestFor(strip, { read, doubt: doubtOf(300, viewportHeight) })))
        .toBeUndefined();
      expect(diagnostics[0], String(viewportHeight)).toMatchObject({ outcome: 'kept', why: 'toolbar' });
      expect(taken, String(viewportHeight)).not.toHaveBeenCalled();
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('does not read a capture that came all the same from a tab without a toolbar', async () => {
    // A capture function that does not ask first: the reader checks again.
    const capture = await captureOf(strip);
    const diagnostics: PdfLocateDiagnostic[] = [];
    const reader = new PdfPageBoxReader({
      capture: async () => capture,
      createCanvas: (width, height) => createCanvas(width, height) as never,
      encode: (canvas) => pngOf(canvas as unknown as Canvas),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const read = vi.fn(tesseract);

    expect(await reader.locate(requestFor(strip, {
      read,
      doubt: doubtOf(300, VIEW_HEIGHT + PDF_TOOLBAR_HEIGHT),
    }))).toBeUndefined();
    expect(diagnostics[0]).toMatchObject({ outcome: 'kept', why: 'toolbar' });
    expect(read).not.toHaveBeenCalled();
    expect(capture.image.close).toHaveBeenCalledTimes(1);
  });

  it('does not read a capture that is not the tab\'s size', async () => {
    const capture = await captureOf(strip);
    // Half as wide as the tab says: one scale across, another down.
    const { reader, diagnostics } = readerFor({ ...capture, tabWidth: capture.tabWidth * 2 });

    expect(await reader.locate(requestFor(strip))).toBeUndefined();
    expect(diagnostics[0]).toMatchObject({ outcome: 'kept', why: 'size' });
    expect(capture.image.close).toHaveBeenCalledTimes(1);
  });

  it('pauses capturing a toolbar that showed no page box three looks running', async () => {
    // A tab too narrow for Chrome's toolbar to hold a page box.
    const narrow = { file: 'no-page-box-narrow-tab.png', scale: 1 };
    const capture = await captureOf(narrow);
    const { reader, diagnostics, taken, clock } = readerFor(capture);
    const request = requestFor({ pageCount: 300 });

    for (let look = 1; look <= 5; look += 1) {
      clock.now += 2_000;
      expect(await reader.locate(request)).toBeUndefined();
    }
    expect(taken).toHaveBeenCalledTimes(3);
    expect(diagnostics.map((entry) => `${entry.outcome}:${entry.why}`))
      .toEqual(Array.from({ length: 5 }, () => 'kept:box'));

    // A minute after the last of them it is looked at once more.
    clock.now += 60_000;
    expect(await reader.locate(request)).toBeUndefined();
    expect(taken).toHaveBeenCalledTimes(4);
    clock.now += 2_000;
    expect(await reader.locate(request)).toBeUndefined();
    expect(taken).toHaveBeenCalledTimes(4);
  });

  it('looks again at once when the tab has changed size, or shows another PDF', async () => {
    const narrow = await captureOf({ file: 'no-page-box-narrow-tab.png', scale: 1 });
    const wide = await captureOf(strip);
    let showing = narrow;
    const taken = vi.fn();
    const reader = new PdfPageBoxReader({
      capture: async (_tabId, _signal, wanted) => {
        if (!wanted(showing.tabWidth, showing.tabHeight)) return PDF_CAPTURE_UNWANTED;
        taken();
        return showing;
      },
      createCanvas: (width, height) => createCanvas(width, height) as never,
      encode: (canvas) => pngOf(canvas as unknown as Canvas),
      now: () => 0,
    });
    const request = requestFor({ pageCount: 300 });
    for (let look = 1; look <= 4; look += 1) await reader.locate(request);
    expect(taken).toHaveBeenCalledTimes(3);

    // Another PDF in the tab: its count is another.
    await reader.locate(requestFor({ pageCount: 40 }));
    expect(taken).toHaveBeenCalledTimes(4);
    // The first PDF again, until its toolbar is left alone once more.
    for (let look = 1; look <= 4; look += 1) await reader.locate(request);
    expect(taken).toHaveBeenCalledTimes(7);
    // The window made wider: the toolbar holds a page box now.
    showing = wide;
    expect(await reader.locate(request)).toBe(54);
    // A page box found starts the count again: two looks without one, a
    // look with one, and two more without are all taken.
    const before = taken.mock.calls.length;
    showing = narrow;
    await reader.locate(request);
    await reader.locate(request);
    showing = wide;
    await reader.locate(request);
    showing = narrow;
    await reader.locate(request);
    await reader.locate(request);
    expect(taken.mock.calls.length - before).toBe(5);
  });

  it('goes on looking at a page box whose number is only busy: a caret after typed digits', async () => {
    const typing = fixture('state-1x-typed-caret.png');
    const { reader, taken, diagnostics } = readerFor(await captureOf(typing));

    for (let look = 1; look <= 5; look += 1) {
      expect(await reader.locate(requestFor(typing))).toBeUndefined();
    }
    expect(diagnostics.every((entry) => entry.why === 'number')).toBe(true);
    expect(taken).toHaveBeenCalledTimes(5);
  });

  it('says looking again is no use when Chrome does not allow the capture', async () => {
    const refused = readerFor(PDF_CAPTURE_REFUSED);
    expect(await refused.reader.locate(requestFor(strip))).toBe(PDF_LOCATE_STOP);
    expect(refused.diagnostics).toEqual([{ stage: 'locate', outcome: 'refused', milliseconds: 0 }]);

    const none = readerFor(undefined);
    expect(await none.reader.locate(requestFor(strip))).toBeUndefined();
    expect(none.diagnostics).toEqual([{ stage: 'locate', outcome: 'no-capture', milliseconds: 0 }]);
  });

  it('takes no page once it is stopped, and lets the capture go', async () => {
    const capture = await captureOf(strip);
    const { reader, diagnostics } = readerFor(capture);
    const stop = new AbortController();
    const read = vi.fn(async () => {
      stop.abort();
      return '55 / 300';
    });

    expect(await reader.locate(requestFor(strip, { read, signal: stop.signal }))).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual([]);
    expect(capture.image.close).toHaveBeenCalledTimes(1);

    const before = await captureOf(strip);
    const stopped = new AbortController();
    stopped.abort();
    const early = readerFor(before);
    expect(await early.reader.locate(requestFor(strip, { read, signal: stopped.signal }))).toBeUndefined();
    expect(before.image.close).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('a failing diagnostic changes nothing', async () => {
    const reader = new PdfPageBoxReader({
      capture: async () => captureOf(strip),
      createCanvas: (width, height) => createCanvas(width, height) as never,
    encode: (canvas) => pngOf(canvas as unknown as Canvas),
      onDiagnostic: () => {
        throw new Error('The log is full.');
      },
    });

    expect(await reader.locate(requestFor(strip, { read: says('55 / 300') }))).toBe(54);
  });
});

describe('captureChromePdfTab', () => {
  const image = { width: 894, height: 805 };
  function environment(overrides: Partial<PdfTabCaptureEnvironment> = {}): PdfTabCaptureEnvironment & {
    capture: ReturnType<typeof vi.fn>;
  } {
    return {
      getTab: async () => ({ active: true, windowId: 3, width: 894, height: 805 }),
      windowState: async () => 'normal',
      capture: vi.fn(async () => 'data:image/png;base64,AAAA'),
      decode: async () => image,
      ...overrides,
    } as PdfTabCaptureEnvironment & { capture: ReturnType<typeof vi.fn> };
  }
  const signal = new AbortController().signal;
  const any = () => true;

  it('captures the tab that shows, with its size in CSS pixels', async () => {
    const chrome = environment();

    expect(await captureChromePdfTab(7, signal, any, chrome))
      .toEqual({ image, tabWidth: 894, tabHeight: 805 });
    expect(chrome.capture).toHaveBeenCalledWith(7, 3, signal);
  });

  it('does not capture a tab that is not the one showing, or whose size is unknown', async () => {
    for (const tab of [
      { active: false, windowId: 3, width: 894, height: 805 },
      { active: true, width: 894, height: 805 },
      { active: true, windowId: 3, height: 805 },
      { active: true, windowId: 3, width: 894, height: 0 },
    ]) {
      const chrome = environment({ getTab: async () => tab });
      expect(await captureChromePdfTab(7, signal, any, chrome), JSON.stringify(tab)).toBeUndefined();
      expect(chrome.capture).not.toHaveBeenCalled();
    }
  });

  it('asks Chrome for nothing when the tab\'s size is not wanted', async () => {
    const chrome = environment();
    const wanted = vi.fn(() => false);

    expect(await captureChromePdfTab(7, signal, wanted, chrome)).toBe(PDF_CAPTURE_UNWANTED);
    expect(wanted).toHaveBeenCalledWith(894, 805);
    expect(chrome.capture).not.toHaveBeenCalled();
  });

  it('does not capture a minimized window: Chrome would answer only when it is back', async () => {
    const chrome = environment({ windowState: async () => 'minimized' });

    expect(await captureChromePdfTab(7, signal, any, chrome)).toBeUndefined();
    expect(chrome.capture).not.toHaveBeenCalled();
  });

  it('says so when Chrome does not allow the capture, and nothing for any other failure', async () => {
    const refused = environment({
      capture: vi.fn(async () => {
        throw new SourceTabCaptureError('permission');
      }),
    });
    expect(await captureChromePdfTab(7, signal, any, refused)).toBe(PDF_CAPTURE_REFUSED);
    for (const code of ['inactive', 'quota', 'api'] as const) {
      const failing = environment({
        capture: vi.fn(async () => {
          throw new SourceTabCaptureError(code);
        }),
      });
      expect(await captureChromePdfTab(7, signal, any, failing), code).toBeUndefined();
    }
    expect(await captureChromePdfTab(7, signal, any, environment({
      getTab: async () => {
        throw new Error('No tab with id 7.');
      },
    }))).toBeUndefined();
    expect(await captureChromePdfTab(7, signal, any, environment({ capture: vi.fn(async () => 'about:blank') })))
      .toBeUndefined();
  });
});
