import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DOMMatrix, ImageData, Path2D, createCanvas, type Canvas } from '@napi-rs/canvas';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  MAX_RENDER_PIXELS,
  PdfjsOpenError,
  chromePdfjsEnvironment,
  openPdfDocument,
  type PdfDocumentHandle,
  type PdfjsEnvironment,
} from '../lib/pdf/pdfjs-runtime';

const vendorDirectory = resolve('vendor/pdfjs');
// Node reads pdf.js data files from disk, so the data base is a path and the
// worker (which Node runs in-process) does not fetch them itself.
const nodeEnvironment: PdfjsEnvironment = {
  moduleBase: `${pathToFileURL(vendorDirectory).href}/`,
  dataBase: `${vendorDirectory}/`,
  workerFetch: false,
};
const opened: PdfDocumentHandle[] = [];
// Every data file pdf.js reads in this file. In Node it reads them itself,
// with fs/promises, from the paths the runtime builds from `dataBase`.
const dataReads = new Set<string>();

beforeAll(() => {
  const fs = process.getBuiltinModule('fs/promises');
  const readFile = fs.readFile.bind(fs);
  vi.spyOn(fs, 'readFile').mockImplementation(((path: unknown, ...rest: unknown[]) => {
    if (typeof path === 'string') dataReads.add(path);
    return (readFile as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readFile);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(opened.splice(0).map((document) => document.destroy()));
});

async function open(name: string): Promise<PdfDocumentHandle> {
  const bytes = new Uint8Array(await readFile(resolve('tests/fixtures/pdf', name)));
  const document = await openPdfDocument(bytes, nodeEnvironment);
  opened.push(document);
  return document;
}

describe('pdfjs-runtime with the packaged pdf.js', () => {
  it.each([
    ['text.pdf', 1, 14, false],
    ['text-untagged.pdf', 1, 14, false],
    ['text-two-col.pdf', 1, 71, false],
    ['multi-page.pdf', 4, 85, false],
    ['image.pdf', 1, 0, true],
    ['scanned.pdf', 1, 0, true],
    ['features.pdf', 1, 0, true],
    ['resources.pdf', 1, 3, true],
  ])('opens %s', async (name, pageCount, firstPageItems, firstPageImages) => {
    const document = await open(name);

    expect(document.pageCount).toBe(pageCount);
    const size = await document.getPageSize(1);
    expect(size.width).toBeGreaterThan(100);
    expect(size.height).toBeGreaterThan(100);
    expect(size.transform).toHaveLength(6);
    const text = await document.getTextContent(1);
    expect(text.items.filter((item) => item.str)).toHaveLength(firstPageItems);
    expect(await document.hasImages(1)).toBe(firstPageImages);
  });

  it('reports text runs with pdf.js fields, line ends, and font styles', async () => {
    const document = await open('text-two-col.pdf');
    const { items, styles } = await document.getTextContent(1);
    const words = items.map((item) => item.str).join(' ');

    expect(words).toContain('Quarterly Harbor Report');
    expect(items.some((item) => item.hasEOL)).toBe(true);
    for (const item of items) {
      expect(item.transform).toHaveLength(6);
      expect(styles[item.fontName]).toMatchObject({
        fontFamily: expect.any(String),
        ascent: expect.any(Number),
      });
    }
  });

  it('reads Shift-JIS text through the packaged CMaps and Symbol through its encoding', async () => {
    const document = await open('resources.pdf');
    const words = (await document.getTextContent(1)).items.map((item) => item.str);

    // Without cmaps/90ms-RKSJ-H.bcmap and Adobe-Japan1-UCS2.bcmap the
    // Japanese run is missing entirely.
    expect(words).toEqual(expect.arrayContaining(['日本語', 'αβγ']));
  });

  it('draws a JPX image and a Type 4 function shading at the given scale', async () => {
    stubCanvasGlobals();
    const document = await open('features.pdf');
    const canvas = createCanvas(1, 1);

    await expect(document.render(1, asCanvas(canvas), 1.5)).resolves.toBe(1.5);

    const size = await document.getPageSize(1);
    expect(canvas.width).toBe(Math.floor(size.width * 1.5));
    const context = canvas.getContext('2d');
    // The research fixture puts a JPX image and a shading in these areas.
    expect(countInk(context.getImageData(108, 138, 300, 150).data)).toBeGreaterThan(1000);
    expect(countInk(context.getImageData(108, 438, 300, 150).data)).toBeGreaterThan(1000);
  });

  it('draws a CCITT image through jbig2.wasm', async () => {
    stubCanvasGlobals();
    const document = await open('resources.pdf');
    const canvas = createCanvas(1, 1);

    await document.render(1, asCanvas(canvas), 1);

    // Blank without jbig2.wasm: this build has no JavaScript fallback.
    const context = canvas.getContext('2d');
    expect(countInk(context.getImageData(40, 240, 160, 60).data)).toBeGreaterThan(500);
  });

  it('draws a page smaller than asked rather than past the canvas limit', async () => {
    stubCanvasGlobals();
    const document = await open('text.pdf');
    const canvas = createCanvas(1, 1);

    const drawn = await document.render(1, asCanvas(canvas), 100);

    expect(drawn).toBeLessThan(100);
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(MAX_RENDER_PIXELS);
    await expect(document.render(1, asCanvas(canvas), 0)).rejects.toThrow(RangeError);
    await expect(document.render(1, asCanvas(canvas), Number.NaN)).rejects.toThrow(RangeError);
  });

  it('lets a new render of the same canvas replace the one in progress', async () => {
    stubCanvasGlobals();
    const document = await open('text-two-col.pdf');
    const canvas = createCanvas(1, 1);

    const first = document.render(1, asCanvas(canvas), 1);
    const second = document.render(1, asCanvas(canvas), 1.5);

    await expect(first).rejects.toMatchObject({ name: 'RenderingCancelledException' });
    await expect(second).resolves.toBe(1.5);
    expect(countInk(canvas.getContext('2d').getImageData(0, 0, canvas.width, 200).data))
      .toBeGreaterThan(1000);
  });

  it('asks for a password instead of opening an encrypted PDF', async () => {
    await expect(open('password.pdf')).rejects.toMatchObject({
      name: 'PdfjsOpenError',
      kind: 'password',
    });
  });

  it('reports bytes that are not a PDF as unreadable', async () => {
    await expect(
      openPdfDocument(new TextEncoder().encode('<html>not a pdf</html>'), nodeEnvironment),
    ).rejects.toMatchObject({ kind: 'unreadable' });
  });

  it('read CMaps, standard fonts and Wasm from the packaged folders', () => {
    // Runs after the fixtures above have been parsed and drawn.
    for (const file of [
      'cmaps/90ms-RKSJ-H.bcmap',
      'cmaps/Adobe-Japan1-UCS2.bcmap',
      'standard_fonts/FoxitSymbol.pfb',
      'standard_fonts/FoxitDingbats.pfb',
      'wasm/jbig2.wasm',
      'wasm/openjpeg.wasm',
    ]) {
      expect(dataReads, file).toContain(`${vendorDirectory}/${file}`);
    }
  });

  it('stops a render when its signal aborts, before or during drawing', async () => {
    stubCanvasGlobals();
    const document = await open('multi-page.pdf');
    const before = new AbortController();
    before.abort();

    await expect(
      document.render(1, asCanvas(createCanvas(1, 1)), 1, before.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // Abort the moment pdf.js takes the drawing context, so its render task
    // is running and must be cancelled.
    const during = new AbortController();
    const canvas = createCanvas(1, 1);
    const getContext = canvas.getContext.bind(canvas);
    canvas.getContext = ((...args: Parameters<typeof getContext>) => {
      during.abort();
      return getContext(...args);
    }) as typeof canvas.getContext;
    await expect(
      document.render(1, asCanvas(canvas), 1, during.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('pdfjs-runtime boundaries', () => {
  it('loads the shim before pdf.js and points the worker at the shimmed entry', async () => {
    const loaded: string[] = [];
    const fake = fakePdfjs(() => new Promise(() => {}));
    const environment: PdfjsEnvironment = {
      moduleBase: 'chrome-extension://id/pdfjs/',
      dataBase: 'chrome-extension://id/pdfjs/',
      workerFetch: true,
      importModule: async (url) => {
        loaded.push(url);
        return url.endsWith('pdf.min.mjs') ? fake.module : {};
      },
    };
    const controller = new AbortController();
    const opening = openPdfDocument(new Uint8Array(4), environment, controller.signal);
    await vi.waitFor(() => expect(fake.getDocument).toHaveBeenCalledOnce());

    expect(loaded).toEqual([
      'chrome-extension://id/pdfjs/simul-shim.mjs',
      'chrome-extension://id/pdfjs/pdf.min.mjs',
    ]);
    expect(fake.module.GlobalWorkerOptions.workerSrc).toBe(
      'chrome-extension://id/pdfjs/simul-worker.mjs',
    );
    expect(fake.getDocument.mock.calls[0]?.[0]).toMatchObject({
      cMapUrl: 'chrome-extension://id/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'chrome-extension://id/pdfjs/standard_fonts/',
      wasmUrl: 'chrome-extension://id/pdfjs/wasm/',
      iccUrl: 'chrome-extension://id/pdfjs/iccs/',
      useWorkerFetch: true,
      enableXfa: false,
    });

    controller.abort();
    await expect(opening).rejects.toMatchObject({ kind: 'aborted' });
    expect(fake.destroy).toHaveBeenCalled();
  });

  it('builds the extension environment from the packaged folder URL', () => {
    expect(chromePdfjsEnvironment((path) => `chrome-extension://id${path}`)).toEqual({
      moduleBase: 'chrome-extension://id/pdfjs/',
      dataBase: 'chrome-extension://id/pdfjs/',
      workerFetch: true,
    });
  });

  it('reports a pdf.js that cannot start as a runtime fault, not a bad file', async () => {
    const workerFailure = fakePdfjs(() =>
      Promise.reject(new Error('Setting up fake worker failed: "import failed".')),
    );
    const syncFailure = fakePdfjs(() => new Promise(() => {}));
    syncFailure.getDocument.mockImplementation(() => {
      throw new Error('Invalid parameter object');
    });
    for (const fake of [workerFailure, syncFailure]) {
      await expect(
        openPdfDocument(new Uint8Array(4), {
          ...nodeEnvironment,
          moduleBase: `memory://${fake === workerFailure ? 'worker' : 'sync'}/`,
          importModule: async (url) => (url.endsWith('pdf.min.mjs') ? fake.module : {}),
        }),
      ).rejects.toMatchObject({ kind: 'runtime' });
    }
  });

  it('retries a failed pdf.js load on the next open', async () => {
    let attempts = 0;
    const fake = fakePdfjs(() => Promise.reject(new Error('corrupt')));
    const environment: PdfjsEnvironment = {
      ...nodeEnvironment,
      moduleBase: 'memory://retry/',
      importModule: async (url) => {
        if (url.endsWith('pdf.min.mjs')) {
          attempts += 1;
          if (attempts === 1) throw new Error('network');
          return fake.module;
        }
        return {};
      },
    };

    await expect(openPdfDocument(new Uint8Array(4), environment)).rejects.toMatchObject({
      kind: 'runtime',
    });
    await expect(openPdfDocument(new Uint8Array(4), environment)).rejects.toMatchObject({
      kind: 'unreadable',
    });
    expect(attempts).toBe(2);
    expect(fake.getDocument).toHaveBeenCalledOnce();
  });

  it('never loads pdf.js for an already cancelled open', async () => {
    const importModule = vi.fn();
    const controller = new AbortController();
    controller.abort();

    await expect(
      openPdfDocument(
        new Uint8Array(4),
        { ...nodeEnvironment, importModule },
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(PdfjsOpenError);
    expect(importModule).not.toHaveBeenCalled();
  });
});

function fakePdfjs(documentPromise: () => Promise<unknown>) {
  const destroy = vi.fn(async () => {});
  const getDocument = vi.fn((_options: unknown) => ({
    promise: documentPromise(),
    destroy,
  }));
  return {
    destroy,
    getDocument,
    module: {
      GlobalWorkerOptions: { workerSrc: '' },
      OPS: {},
      VerbosityLevel: { ERRORS: 0 },
      getDocument,
    },
  };
}

function stubCanvasGlobals(): void {
  // Browsers have these; pdf.js's Node (legacy) build adds them the same way.
  vi.stubGlobal('DOMMatrix', DOMMatrix);
  vi.stubGlobal('ImageData', ImageData);
  vi.stubGlobal('Path2D', Path2D);
}

function asCanvas(canvas: Canvas): OffscreenCanvas {
  return canvas as unknown as OffscreenCanvas;
}

function countInk(data: Uint8ClampedArray): number {
  let ink = 0;
  for (let index = 0; index < data.length; index += 4) {
    const [red, green, blue] = [data[index]!, data[index + 1]!, data[index + 2]!];
    if (Math.min(red, green, blue) < 200) ink += 1;
  }
  return ink;
}
