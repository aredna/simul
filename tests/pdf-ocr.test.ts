import { describe, expect, it, vi } from 'vitest';

import type {
  ImageRecognitionResult,
  ImageRecognitionRoute,
} from '../lib/ocr/image-analysis-coordinator';
import type { AcquiredImagePixels } from '../lib/ocr/pixel-acquisition';
import { MAX_OCR_INPUT_PIXELS } from '../lib/ocr/pixel-acquisition';
import { TESSERACT_MODEL_VERSION } from '../lib/ocr/providers/tesseract/language-catalog';
import {
  PDF_OCR_MAX_DPI,
  pdfOcrRoute,
  isScannedPage,
  probeScannedLanguage,
  readScannedPage,
  type PdfOcrCanvas,
  type PdfOcrDocument,
  type PdfOcrEnvironment,
} from '../lib/pdf/pdf-ocr';
import type { ReplicaSourceDocumentIdentity } from '../lib/replica/source-identity';

const DOCUMENT: ReplicaSourceDocumentIdentity = {
  sessionId: 'session-1',
  pageEpoch: 1,
  generation: 1,
  documentId: 'doc-1',
  frameId: 0,
};
const LETTER = { width: 612, height: 792 };

function fakeDocument(options: {
  hasImages?: (page: number) => boolean;
  /** The share of the page its pictures cover; by default all of it. */
  imageCoverage?: (page: number) => number | Promise<number>;
  render?: (page: number, canvas: PdfOcrCanvas, scale: number) => void;
} = {}) {
  const scales: number[] = [];
  const released: number[] = [];
  const document: PdfOcrDocument = {
    hasImages: vi.fn(async (page: number) => options.hasImages?.(page) ?? true),
    imageCoverage: vi.fn(async (page: number) => options.imageCoverage?.(page) ?? 1),
    render: vi.fn(async (page, canvas, scale) => {
      scales.push(scale);
      const target = canvas as unknown as PdfOcrCanvas;
      if (options.render) options.render(page, target, scale);
      else {
        target.width = Math.floor(LETTER.width * scale);
        target.height = Math.floor(LETTER.height * scale);
      }
      return scale;
    }),
    releasePage: vi.fn(async (page: number) => {
      released.push(page);
    }),
  };
  return { document, scales, released };
}

function complete(
  regions: readonly { text: string; x: number; y: number; width: number; height: number }[],
  transcriptConfidence?: number,
): ImageRecognitionResult {
  return {
    status: 'complete',
    cacheHit: false,
    result: {
      providerId: 'tesseract',
      bitmapWidth: 1000,
      bitmapHeight: 1000,
      transcript: regions.map((region) => region.text).join('\n'),
      ...(transcriptConfidence !== undefined ? { transcriptConfidence } : {}),
      regions: regions.map(({ text, x, y, width, height }) => ({
        text,
        confidence: 0.95,
        boundingBox: { x, y, width, height },
      })),
    },
  };
}

function environment(
  recognize: (pixels: AcquiredImagePixels, route: ImageRecognitionRoute) =>
    Promise<ImageRecognitionResult> | ImageRecognitionResult,
  extra: Partial<PdfOcrEnvironment> = {},
) {
  const canvases: PdfOcrCanvas[] = [];
  const seen: { pixels: AcquiredImagePixels; route: ImageRecognitionRoute }[] = [];
  let drawn = 0;
  const value: PdfOcrEnvironment = {
    createCanvas: () => {
      const canvas = { width: 0, height: 0 };
      canvases.push(canvas);
      return canvas;
    },
    render: {
      createSurface: () => ({
        getContext: () => ({ drawImage: () => undefined }),
        // Each drawing encodes to different bytes, so each page hashes apart.
        convertToBlob: async () => new Blob([`page-${(drawn += 1)}`]),
      }),
      digest: (bytes) => crypto.subtle.digest('SHA-256', bytes),
    },
    recognize: vi.fn(async (pixels, route) => {
      seen.push({ pixels, route });
      const answer = await recognize(pixels, route);
      // As the offscreen protocol requires, a result names the bitmap it read.
      return answer.status === 'complete'
        ? {
            ...answer,
            result: {
              ...answer.result,
              bitmapWidth: pixels.bitmapWidth,
              bitmapHeight: pixels.bitmapHeight,
            },
          }
        : answer;
    }),
    wait: async () => undefined,
    ...extra,
  };
  return { environment: value, canvases, seen };
}

const ROUTE = pdfOcrRoute('fr', ['tesseract'], 0.65);
if (ROUTE.status !== 'ready') throw new Error('French has an OCR model.');

describe('pdfOcrRoute', () => {
  it('reads in the language’s Tesseract group with the saved methods', () => {
    expect(ROUTE).toEqual({
      status: 'ready',
      group: 'fra',
      route: {
        providerOrder: ['tesseract'],
        sourceLanguage: 'fr',
        languageGroup: 'fra',
        modelVersion: TESSERACT_MODEL_VERSION,
        minimumConfidence: 0.65,
      },
    });
  });

  it('says why a page cannot be read', () => {
    expect(pdfOcrRoute('fr', [], 0.65)).toEqual({ status: 'no-method' });
    // TextDetector reports no confidence: alone it passes nothing.
    expect(pdfOcrRoute('fr', ['chrome-text-detector'], 0.65)).toEqual({ status: 'no-method' });
    expect(pdfOcrRoute('fr', ['chrome-text-detector', 'tesseract'], 0.65).status).toBe('ready');
    expect(pdfOcrRoute('th', ['tesseract'], 0.65)).toEqual({ status: 'unsupported' });
  });
});

describe('readScannedPage', () => {
  it('draws the page under 4 MP, reads it and places its lines in page points', async () => {
    const { document, scales, released } = fakeDocument();
    const { environment: env, canvases, seen } = environment((pixels) =>
      complete([
        { text: 'Bonjour à tous', x: pixels.bitmapWidth / 10, y: 100, width: 400, height: 40 },
      ]));
    const result = await readScannedPage(
      document,
      { index: 2, size: LETTER, document: DOCUMENT, route: ROUTE.route },
      env,
      new AbortController().signal,
    );
    expect(result.status).toBe('read');
    const scale = Math.sqrt(MAX_OCR_INPUT_PIXELS / (LETTER.width * LETTER.height));
    expect(scales).toEqual([scale]);
    const { pixels, route } = seen[0]!;
    expect(pixels.bitmapWidth * pixels.bitmapHeight).toBeLessThanOrEqual(MAX_OCR_INPUT_PIXELS);
    expect(pixels.pixelHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(pixels.descriptor).toMatchObject({
      document: DOCUMENT,
      nodeId: 3,
      sourceKind: 'img',
      contentRevision: 1,
      observationRevision: 1,
      connected: true,
    });
    expect(route).toBe(ROUTE.route);
    if (result.status !== 'read') return;
    const pixelsPerPoint = pixels.bitmapWidth / LETTER.width;
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]!.text).toBe('Bonjour à tous');
    expect(result.blocks[0]!.box.left).toBeCloseTo(pixels.bitmapWidth / 10 / pixelsPerPoint);
    expect(result.blocks[0]!.box.top).toBeCloseTo(100 / pixelsPerPoint);
    expect(result.blocks[0]!.fontSize).toBeCloseTo(40 / pixelsPerPoint);
    // The drawing's memory goes back, and so does pdf.js's page.
    expect(canvases[0]).toEqual({ width: 0, height: 0 });
    expect(released).toEqual([3]);
  });

  it('draws a small page at no more than 300 dpi', async () => {
    const small = { width: 100, height: 100 };
    const { document, scales } = fakeDocument({
      render: (_page, canvas, scale) => {
        canvas.width = Math.floor(small.width * scale);
        canvas.height = Math.floor(small.height * scale);
      },
    });
    const { environment: env } = environment(() => complete([]));
    await readScannedPage(
      document,
      { index: 0, size: small, document: DOCUMENT, route: ROUTE.route },
      env,
      new AbortController().signal,
    );
    expect(scales).toEqual([PDF_OCR_MAX_DPI / 72]);
  });

  it('leaves out lines that repeat the page\'s typed text', async () => {
    const { document } = fakeDocument();
    const box = { left: 61.2, top: 20, width: 200, height: 12 };
    const typed = [{
      text: 'Case 17',
      lines: [box],
      box,
      fontSize: 10,
      lineHeight: 1.2,
      fontFamily: 'serif' as const,
      fontId: 'f1',
      align: 'left' as const,
    }];
    const lines = (pixels: AcquiredImagePixels) => {
      const pixelsPerPoint = pixels.bitmapWidth / LETTER.width;
      return complete([
        // The typed header, read as drawn.
        {
          text: 'Case l7',
          x: 61.2 * pixelsPerPoint,
          y: 20 * pixelsPerPoint,
          width: 200 * pixelsPerPoint,
          height: 12 * pixelsPerPoint,
        },
        { text: 'Bonjour à tous', x: pixels.bitmapWidth / 10, y: 400, width: 400, height: 40 },
      ]);
    };
    const request = { index: 0, size: LETTER, document: DOCUMENT, route: ROUTE.route };

    const stamped = await readScannedPage(
      document, { ...request, typed }, environment(lines).environment, new AbortController().signal,
    );
    expect(stamped.status === 'read' && stamped.blocks.map((block) => block.text))
      .toEqual(['Bonjour à tous']);
    // Without typed text, every line is the scan's own.
    const plain = await readScannedPage(
      document, request, environment(lines).environment, new AbortController().signal,
    );
    expect(plain.status === 'read' && plain.blocks.map((block) => block.text))
      .toEqual(['Case l7', 'Bonjour à tous']);
  });

  it('does not check the images of a page just found to be a scan', async () => {
    const fake = fakeDocument({ hasImages: () => false });
    const env = environment(() => complete([
      { text: 'Bonjour à tous', x: 100, y: 400, width: 400, height: 40 },
    ]));
    const request = { index: 0, size: LETTER, document: DOCUMENT, route: ROUTE.route };
    const signal = new AbortController().signal;

    expect(await readScannedPage(fake.document, request, env.environment, signal))
      .toEqual({ status: 'no-image' });
    const read = await readScannedPage(
      fake.document, { ...request, confirmed: true }, env.environment, signal,
    );
    expect(read.status).toBe('read');
    expect(fake.document.hasImages).toHaveBeenCalledOnce();
    expect(fake.document.imageCoverage).not.toHaveBeenCalled();
  });

  it('tells whether a page with a little text is a scan, in time', async () => {
    const signal = new AbortController().signal;
    const env = environment(() => complete([]), { pageTimeoutMs: 5 }).environment;
    const scan = fakeDocument({ imageCoverage: () => 0.8 });
    expect(await isScannedPage(scan.document, 2, env, signal)).toBe(true);
    // pdf.js decoded the page's pictures for the look: they are freed.
    expect(scan.released).toEqual([3]);
    expect(scan.document.hasImages).not.toHaveBeenCalled();
    expect(await isScannedPage(fakeDocument({ imageCoverage: () => 0.79 }).document, 0, env, signal))
      .toBe(false);
    expect(await isScannedPage(fakeDocument({ imageCoverage: () => Number.NaN }).document, 0, env, signal))
      .toBe(false);
    expect(await isScannedPage(fakeDocument({
      imageCoverage: () => {
        throw new Error('Bad content stream');
      },
    }).document, 0, env, signal)).toBe(false);
    expect(await isScannedPage(fakeDocument({
      imageCoverage: () => new Promise<number>(() => undefined),
    }).document, 0, env, signal)).toBe(false);

    const stopped = new AbortController();
    stopped.abort();
    await expect(isScannedPage(scan.document, 0, env, stopped.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not read a page without images', async () => {
    const { document, released } = fakeDocument({ hasImages: () => false });
    const { environment: env, seen } = environment(() => complete([]));
    const result = await readScannedPage(
      document,
      { index: 0, size: LETTER, document: DOCUMENT, route: ROUTE.route },
      env,
      new AbortController().signal,
    );
    expect(result).toEqual({ status: 'no-image' });
    expect(seen).toHaveLength(0);
    expect(document.render).not.toHaveBeenCalled();
    expect(released).toEqual([1]);
  });

  it('asks a busy OCR host once more, fails a page OCR cannot read, and cannot draw a broken one', async () => {
    const { document } = fakeDocument();
    const answers: ImageRecognitionResult[] = [
      { status: 'failed', code: 'host-overflow' },
      complete([{ text: 'Enfin', x: 10, y: 10, width: 100, height: 30 }]),
    ];
    const { environment: env } = environment(() => answers.shift()!);
    const read = await readScannedPage(
      document,
      { index: 0, size: LETTER, document: DOCUMENT, route: ROUTE.route },
      env,
      new AbortController().signal,
    );
    expect(read.status).toBe('read');

    const failing = environment(() => ({ status: 'failed', code: 'host-overflow' }));
    expect(await readScannedPage(
      document,
      { index: 0, size: LETTER, document: DOCUMENT, route: ROUTE.route },
      failing.environment,
      new AbortController().signal,
    )).toEqual({ status: 'failed' });
    expect(failing.seen).toHaveLength(2);

    const broken = fakeDocument({
      render: () => {
        throw new Error('pdf.js could not draw it');
      },
    });
    expect(await readScannedPage(
      broken.document,
      { index: 0, size: LETTER, document: DOCUMENT, route: ROUTE.route },
      environment(() => complete([])).environment,
      new AbortController().signal,
    )).toEqual({ status: 'unreadable' });
    expect(broken.released).toEqual([1]);
  });

  it('gives up on a page that takes too long to check or draw', async () => {
    const stuck: PdfOcrDocument = {
      // pdf.js never answers, and takes no signal.
      hasImages: () => new Promise<boolean>(() => undefined),
      imageCoverage: () => new Promise<number>(() => undefined),
      render: vi.fn(),
      releasePage: vi.fn(async () => undefined),
    };
    const { environment: env, seen } = environment(() => complete([]), { pageTimeoutMs: 5 });
    expect(await readScannedPage(
      stuck,
      { index: 0, size: LETTER, document: DOCUMENT, route: ROUTE.route },
      env,
      new AbortController().signal,
    )).toEqual({ status: 'unreadable' });
    expect(seen).toHaveLength(0);
  });

  it('rejects with an AbortError when stopped', async () => {
    const { document } = fakeDocument();
    const controller = new AbortController();
    const { environment: env } = environment(() => {
      controller.abort();
      return complete([{ text: 'Trop tard', x: 10, y: 10, width: 100, height: 30 }]);
    });
    await expect(readScannedPage(
      document,
      { index: 0, size: LETTER, document: DOCUMENT, route: ROUTE.route },
      env,
      controller.signal,
    )).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('probeScannedLanguage', () => {
  const pages = [0, 1, 2, 3].map((index) => ({ index, size: LETTER }));
  const request = {
    pages,
    document: DOCUMENT,
    providerOrder: ['tesseract'] as const,
    minimumConfidence: 0.65 as const,
  };

  it('finds Japanese from one page in its strong script', async () => {
    const { document } = fakeDocument();
    const { environment: env, seen } = environment((_pixels, route) =>
      route.sourceLanguage === 'ja'
        ? complete([{ text: 'これはにほんごのぶんしょうです', x: 10, y: 10, width: 500, height: 30 }], 0.95)
        : complete([]));
    const language = await probeScannedLanguage(
      document,
      request,
      env,
      new AbortController().signal,
    );
    expect(language).toBe('ja');
    expect(seen[0]!.route).toMatchObject({
      sourceLanguage: 'ja',
      languageGroup: 'jpn+jpn_vert',
      // The probe asks for at least its own confidence.
      minimumConfidence: 0.8,
    });
    expect(document.render).toHaveBeenCalledTimes(1);
  });

  it('needs two pages to agree on a Latin language', async () => {
    const french = 'Ceci est une page numérisée en français';
    const detectLanguage = vi.fn(async () => ({
      isReliable: true,
      languages: [{ language: 'fr', percentage: 96 }],
    }));
    const { document } = fakeDocument();
    const { environment: env } = environment(
      (_pixels, route) => route.sourceLanguage === 'en'
        ? complete([{ text: french, x: 10, y: 10, width: 500, height: 30 }], 0.92)
        : complete([]),
      { detectLanguage },
    );
    expect(await probeScannedLanguage(
      document,
      request,
      env,
      new AbortController().signal,
    )).toBe('fr');
    expect(document.render).toHaveBeenCalledTimes(2);

    const single = fakeDocument();
    expect(await probeScannedLanguage(
      single.document,
      { ...request, pages: pages.slice(0, 1) },
      environment(
        (_pixels, route) => route.sourceLanguage === 'en'
          ? complete([{ text: french, x: 10, y: 10, width: 500, height: 30 }], 0.92)
          : complete([]),
        { detectLanguage },
      ).environment,
      new AbortController().signal,
    )).toBeUndefined();
  });

  it('asks a busy OCR host once more', async () => {
    const { document } = fakeDocument();
    let busy = true;
    const { environment: env, seen } = environment((_pixels, route) => {
      if (busy) {
        busy = false;
        return { status: 'failed', code: 'host-overflow' };
      }
      return route.sourceLanguage === 'ja'
        ? complete([{ text: 'これはにほんごのぶんしょうです', x: 10, y: 10, width: 500, height: 30 }], 0.95)
        : complete([]);
    });
    expect(await probeScannedLanguage(document, request, env, new AbortController().signal))
      .toBe('ja');
    expect(seen.map(({ route }) => route.sourceLanguage).slice(0, 2)).toEqual(['ja', 'ja']);
  });

  it('ends at its time budget, even during a recognition, and a cancel still rejects', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { document } = fakeDocument();
      let started = 0;
      const hanging = (_pixels: AcquiredImagePixels, _route: ImageRecognitionRoute, signal: AbortSignal) => {
        started += 1;
        return new Promise<ImageRecognitionResult>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      };
      const { environment: env } = environment(() => complete([]), {
        now: () => 0,
        recognize: hanging,
      });
      const settle = async () => {
        for (let turn = 0; turn < 200 && started === 0; turn += 1) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      };
      const probing = probeScannedLanguage(document, request, env, new AbortController().signal);
      await settle();
      expect(started).toBe(1);
      await vi.advanceTimersByTimeAsync(20_001);
      await expect(probing).resolves.toBeUndefined();
      expect(started).toBe(1);

      started = 0;
      const controller = new AbortController();
      const cancelled = probeScannedLanguage(fakeDocument().document, request, env, controller.signal);
      await settle();
      controller.abort();
      await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('draws at most three pages and gives up without a method', async () => {
    const { document } = fakeDocument();
    const { environment: env } = environment(() => complete([]));
    expect(await probeScannedLanguage(
      document,
      request,
      env,
      new AbortController().signal,
    )).toBeUndefined();
    expect(document.render).toHaveBeenCalledTimes(3);

    const none = fakeDocument();
    expect(await probeScannedLanguage(
      none.document,
      { ...request, providerOrder: [] },
      env,
      new AbortController().signal,
    )).toBeUndefined();
    expect(await probeScannedLanguage(
      none.document,
      { ...request, providerOrder: ['chrome-text-detector'] },
      env,
      new AbortController().signal,
    )).toBeUndefined();
    expect(none.document.render).not.toHaveBeenCalled();
  });
});
