import { describe, expect, it, vi } from 'vitest';

import { PdfController, type PdfControllerOcr } from '../entrypoints/sidepanel/pdf-controller';
import type { ImageRecognitionResult } from '../lib/ocr/image-analysis-coordinator';
import type { PdfOcrCanvas } from '../lib/pdf/pdf-ocr';
import type { PdfViewDocument, PdfViewSurface } from '../entrypoints/sidepanel/pdf-view';
import { UI_STRINGS } from '../lib/companion-ui-strings';
import { PageAccessError } from '../lib/page-identity';
import { PdfFetchError } from '../lib/pdf/pdf-fetch';
import type {
  PdfLayoutSettings,
  PdfPagePoints,
  PdfReadingPosition,
} from '../lib/pdf/pdf-layout';
import {
  PdfjsOpenError,
  type PdfDocumentHandle,
  type PdfPageSize,
  type PdfTextContent,
  type PdfjsOpenErrorKind,
} from '../lib/pdf/pdfjs-runtime';
import { PdfTextSurface } from '../lib/pdf/pdf-text-surface';
import type { ReplicaSourceDocumentIdentity } from '../lib/replica/source-identity';
import { englishUiText } from '../lib/ui-text';

const URL_UNDER_TEST = 'https://example.com/report.pdf';

function fakeDocument(pageCount = 3) {
  const document = {
    pageCount,
    getPageSize: vi.fn(async (page: number): Promise<PdfPageSize> => ({
      width: 600 + page,
      height: 800,
      transform: [1, 0, 0, -1, 0, 800],
    })),
    getTextContent: vi.fn(async (page: number): Promise<PdfTextContent> => pageText(page)),
    hasImages: vi.fn(),
    imageCoverage: vi.fn(async (_page: number) => 0),
    render: vi.fn(async (_page: number, _canvas: unknown, _scale: number) => 1),
    fontFaces: vi.fn(async () => ({})),
    releasePage: vi.fn(async (_page: number) => undefined),
    destroy: vi.fn(async () => undefined),
  };
  return document satisfies PdfDocumentHandle;
}

/** One line of text per page, "Page n", from a PDF whose /Lang is French. */
function pageText(page: number): PdfTextContent {
  return {
    items: [{
      str: `Page ${page}`,
      dir: 'ltr',
      transform: [10, 0, 0, 10, 50, 700],
      width: 30,
      height: 10,
      fontName: 'f1',
      hasEOL: false,
    }],
    styles: { f1: { fontFamily: 'serif', ascent: 0.8, descent: -0.2, vertical: false } },
    lang: 'fr',
  };
}

const SOURCE_DOCUMENT: ReplicaSourceDocumentIdentity = {
  sessionId: 'session',
  pageEpoch: 1,
  generation: 1,
  documentId: 'DOC',
  frameId: 0,
};

function fakeView() {
  const mounted: Array<{
    document: PdfViewDocument;
    sizes: readonly PdfPagePoints[];
    position: PdfReadingPosition | undefined;
  }> = [];
  const view = {
    mounted,
    /** Where the fake reader is now. */
    position: undefined as PdfReadingPosition | undefined,
    mount: vi.fn((
      document: PdfViewDocument,
      sizes: readonly PdfPagePoints[],
      position?: PdfReadingPosition,
    ) => {
      mounted.push({ document, sizes, position });
    }),
    readingPosition: vi.fn((): PdfReadingPosition | undefined => view.position),
    clear: vi.fn(),
    updateLayout: vi.fn((_settings: PdfLayoutSettings) => undefined),
  } satisfies PdfViewSurface & { mounted: unknown; position: unknown };
  return view;
}

function setup(options: {
  fetchPdf?: (url: string, signal: AbortSignal) => Promise<Uint8Array>;
  readFile?: (file: Blob, signal: AbortSignal) => Promise<Uint8Array>;
  openDocument?: (bytes: Uint8Array, signal: AbortSignal) => Promise<PdfDocumentHandle>;
  openTimeoutMs?: number;
  onDiagnostic?: (diagnostic: unknown) => void;
  withText?: boolean;
  priorityDelayMs?: number;
  pageTextTimeoutMs?: number;
  ocr?: PdfControllerOcr;
} = {}) {
  const view = fakeView();
  const viewerFollower = { start: vi.fn(), stop: vi.fn(), following: false };
  const documents: ReturnType<typeof fakeDocument>[] = [];
  const diagnostics: unknown[] = [];
  const fetchPdf = vi.fn(options.fetchPdf ?? (async () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])));
  const openDocument = vi.fn(options.openDocument ?? (async () => {
    const document = fakeDocument();
    documents.push(document);
    return document;
  }));
  const pagesSet: number[] = [];
  const sink = {
    setPageText: vi.fn((index: number) => {
      pagesSet.push(index);
    }),
    showTranslation: () => undefined,
    hideTranslations: () => undefined,
  };
  const surface = new PdfTextSurface(sink);
  const onPriorityChange = vi.fn();
  const controller = new PdfController({
    fetchPdf,
    ...(options.readFile ? { readFile: options.readFile } : {}),
    openDocument,
    view,
    viewerFollower,
    now: () => 0,
    onDiagnostic: options.onDiagnostic ?? ((diagnostic) => diagnostics.push(diagnostic)),
    ...(options.openTimeoutMs ? { openTimeoutMs: options.openTimeoutMs } : {}),
    ...(options.withText
      ? {
          surface,
          onPriorityChange,
          priorityDelayMs: options.priorityDelayMs ?? 0,
          ...(options.pageTextTimeoutMs ? { pageTextTimeoutMs: options.pageTextTimeoutMs } : {}),
          ...(options.ocr ? { ocr: options.ocr } : {}),
        }
      : {}),
  });
  return {
    controller, view, documents, fetchPdf, openDocument, diagnostics,
    surface, sink, pagesSet, onPriorityChange, viewerFollower,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected a rejection.');
    },
    (error: unknown) => error,
  );
}

describe('PdfController', () => {
  it('opens the PDF, reads every page size, and only then shows it', async () => {
    const harness = setup();
    const signal = new AbortController().signal;

    await expect(harness.controller.show(URL_UNDER_TEST, signal)).resolves.toEqual({ pageCount: 3 });

    expect(harness.fetchPdf).toHaveBeenCalledWith(URL_UNDER_TEST, signal);
    expect(harness.controller.shown).toBe(true);
    expect(harness.view.mount).toHaveBeenCalledOnce();
    expect(harness.view.mounted[0]?.document).toBe(harness.documents[0]);
    expect(harness.view.mounted[0]?.sizes).toEqual([
      { width: 601, height: 800 },
      { width: 602, height: 800 },
      { width: 603, height: 800 },
    ]);
    expect(harness.documents[0]?.getPageSize).toHaveBeenCalledTimes(3);
    expect(harness.diagnostics).toEqual([
      { stage: 'shown', pages: 3, bytes: 5, milliseconds: 0 },
    ]);
    expect(JSON.stringify(harness.diagnostics)).not.toContain('example.com');
  });

  it('swaps in a new document and then destroys the previous one', async () => {
    const harness = setup();
    const signal = new AbortController().signal;
    await harness.controller.show(URL_UNDER_TEST, signal);
    const first = harness.documents[0]!;

    await harness.controller.show(URL_UNDER_TEST, signal);

    expect(harness.view.mount).toHaveBeenCalledTimes(2);
    expect(harness.view.mounted[1]?.document).toBe(harness.documents[1]);
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(harness.documents[1]?.destroy).not.toHaveBeenCalled();
    expect(harness.view.clear).not.toHaveBeenCalled();
  });

  it.each<[string, () => Error, string]>([
    ['too large', () => new PdfFetchError('too-large', 'x'), UI_STRINGS.statusPdfTooLarge],
    ['a failed download', () => new PdfFetchError('failed', 'x'), UI_STRINGS.statusPdfDownloadFailed],
    ['not a PDF', () => new PdfFetchError('not-pdf', 'x'), UI_STRINGS.statusPdfUnreadable],
    ['an unexpected fetch error', () => new TypeError('boom'), UI_STRINGS.statusPdfDownloadFailed],
  ])('reports %s and keeps what was shown', async (_name, makeError, status) => {
    let fail = false;
    const harness = setup({
      fetchPdf: async () => {
        if (fail) throw makeError();
        return new Uint8Array(5);
      },
    });
    const signal = new AbortController().signal;
    await harness.controller.show(URL_UNDER_TEST, signal);
    fail = true;

    const error = await rejection(harness.controller.show(URL_UNDER_TEST, signal));

    expect(error).toBeInstanceOf(PageAccessError);
    expect((error as Error).message).toBe(status);
    expect(harness.view.mount).toHaveBeenCalledOnce();
    expect(harness.controller.shown).toBe(true);
    expect(harness.documents[0]?.destroy).not.toHaveBeenCalled();
  });

  it.each<[PdfjsOpenErrorKind, string]>([
    ['password', UI_STRINGS.statusPdfPassword],
    ['unreadable', UI_STRINGS.statusPdfUnreadable],
    ['runtime', UI_STRINGS.statusPdfReaderFailed],
  ])('reports a %s open failure without mounting anything', async (kind, status) => {
    const harness = setup({
      openDocument: async () => {
        throw new PdfjsOpenError(kind, 'x');
      },
    });

    const error = await rejection(harness.controller.show(URL_UNDER_TEST, new AbortController().signal));

    expect(error).toBeInstanceOf(PageAccessError);
    expect((error as Error).message).toBe(status);
    expect(harness.view.mount).not.toHaveBeenCalled();
    expect(harness.controller.shown).toBe(false);
    expect(harness.diagnostics).toEqual([{ stage: 'failed', step: 'open', kind }]);
  });

  it('gives a page it cannot measure the size of its neighbour', async () => {
    const partly = fakeDocument(3);
    partly.getPageSize.mockImplementation(async (page: number) => {
      if (page !== 2) return { width: 600 + page, height: 800, transform: [] };
      throw new Error('Bad page dictionary');
    });
    const harness = setup({ openDocument: async () => partly });

    await harness.controller.show(URL_UNDER_TEST, new AbortController().signal);

    expect(harness.view.mounted[0]?.sizes).toEqual([
      { width: 601, height: 800 },
      { width: 601, height: 800 },
      { width: 603, height: 800 },
    ]);
  });

  it('reports a PDF with no measurable page as unreadable and destroys the new task', async () => {
    const broken = fakeDocument(2);
    broken.getPageSize.mockRejectedValue(new Error('Bad page tree'));
    const harness = setup({ openDocument: async () => broken });

    const error = await rejection(harness.controller.show(URL_UNDER_TEST, new AbortController().signal));

    expect((error as Error).message).toBe(UI_STRINGS.statusPdfUnreadable);
    expect(broken.destroy).toHaveBeenCalledOnce();
    expect(harness.view.mount).not.toHaveBeenCalled();
  });

  it('gives up on a PDF that takes too long to open or measure', async () => {
    vi.useFakeTimers();
    try {
      const stalled = fakeDocument(2);
      stalled.getPageSize.mockImplementation(() => new Promise(() => {}));
      const harness = setup({ openDocument: async () => stalled, openTimeoutMs: 1_000 });
      const pending = rejection(harness.controller.show(URL_UNDER_TEST, new AbortController().signal));

      await vi.advanceTimersByTimeAsync(1_000);

      expect((await pending as Error).message).toBe(UI_STRINGS.statusPdfUnreadable);
      expect(stalled.destroy).toHaveBeenCalledOnce();
      expect(harness.diagnostics).toEqual([{ stage: 'failed', step: 'pages', kind: 'timeout' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops at once when cancelled while pdf.js has not answered', async () => {
    const stalled = fakeDocument(2);
    stalled.getPageSize.mockImplementation(() => new Promise(() => {}));
    const harness = setup({ openDocument: async () => stalled });
    const controller = new AbortController();
    const pending = rejection(harness.controller.show(URL_UNDER_TEST, controller.signal));
    await vi.waitFor(() => expect(stalled.getPageSize).toHaveBeenCalled());

    controller.abort();

    expect(await pending).toMatchObject({ name: 'AbortError' });
    expect(stalled.destroy).toHaveBeenCalledOnce();
  });

  it('opens a PDF shown again where the reader left it', async () => {
    const harness = setup();
    const signal = new AbortController().signal;
    await harness.controller.show(`${URL_UNDER_TEST}#page=1`, signal);
    harness.view.position = { index: 2, fraction: 0.25 };

    // A Refresh swaps in the same file; closing and coming back does too.
    await harness.controller.show(URL_UNDER_TEST, signal);
    harness.view.position = { index: 1, fraction: 0.5 };
    harness.controller.close();
    await harness.controller.show(URL_UNDER_TEST, signal);
    await harness.controller.show('https://example.com/other.pdf', signal);

    // The first opens at the page its address names, as Chrome's viewer does.
    expect(harness.view.mounted.map(({ position }) => position)).toEqual([
      { index: 0, fraction: 0 },
      { index: 2, fraction: 0.25 },
      { index: 1, fraction: 0.5 },
      undefined,
    ]);
  });

  it('opens at the page the address names, when nothing is remembered', async () => {
    const harness = setup();
    const signal = new AbortController().signal;
    await harness.controller.show(`${URL_UNDER_TEST}#zoom=50&page=3`, signal);
    await harness.controller.show('https://example.com/other.pdf#page=9', signal);

    expect(harness.view.mounted.map(({ position }) => position)).toEqual([
      { index: 2, fraction: 0 },
      // Past the last page: the top.
      undefined,
    ]);
  });

  it('does not reuse a position when the page count changed', async () => {
    let pages = 3;
    const harness = setup({ openDocument: async () => fakeDocument(pages) });
    const signal = new AbortController().signal;
    await harness.controller.show(URL_UNDER_TEST, signal);
    harness.view.position = { index: 2, fraction: 0 };
    pages = 5;

    await harness.controller.show(URL_UNDER_TEST, signal);

    expect(harness.view.mounted[1]?.position).toBeUndefined();
  });

  it('keeps a shown PDF when the diagnostics hook throws', async () => {
    const harness = setup({
      onDiagnostic: () => {
        throw new Error('Logging failed');
      },
    });

    await expect(harness.controller.show(URL_UNDER_TEST, new AbortController().signal))
      .resolves.toEqual({ pageCount: 3 });
    expect(harness.controller.shown).toBe(true);
    expect(harness.view.clear).not.toHaveBeenCalled();
  });

  it('shows nothing, rather than a stale document, when mounting fails', async () => {
    const harness = setup();
    const signal = new AbortController().signal;
    await harness.controller.show(URL_UNDER_TEST, signal);
    harness.view.mount.mockImplementationOnce(() => {
      throw new Error('DOM failure');
    });

    const error = await rejection(harness.controller.show(URL_UNDER_TEST, signal));

    expect((error as Error).message).toBe(UI_STRINGS.statusPdfReaderFailed);
    expect(harness.controller.shown).toBe(false);
    expect(harness.view.clear).toHaveBeenCalledOnce();
    expect(harness.documents[0]?.destroy).toHaveBeenCalledOnce();
    expect(harness.documents[1]?.destroy).toHaveBeenCalledOnce();
  });

  it('stops quietly when cancelled during the download', async () => {
    const controller = new AbortController();
    const harness = setup({
      fetchPdf: (_url, signal) => new Promise((_, reject) => {
        signal.addEventListener('abort', () =>
          reject(new PdfFetchError('aborted', 'The PDF download was cancelled.')));
      }),
    });
    const pending = rejection(harness.controller.show(URL_UNDER_TEST, controller.signal));

    controller.abort();

    expect(await pending).toMatchObject({ name: 'AbortError' });
    expect(harness.openDocument).not.toHaveBeenCalled();
    expect(harness.view.mount).not.toHaveBeenCalled();
    expect(harness.diagnostics).toEqual([]);
  });

  it('destroys the new task when cancelled while opening or measuring', async () => {
    const opening = new AbortController();
    const harness = setup({
      openDocument: async () => {
        const document = fakeDocument();
        harness.documents.push(document);
        opening.abort();
        return document;
      },
    });
    const error = await rejection(harness.controller.show(URL_UNDER_TEST, opening.signal));
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(harness.documents[0]?.destroy).toHaveBeenCalledOnce();

    const measuring = new AbortController();
    const slow = fakeDocument(40);
    slow.getPageSize.mockImplementation(async (page: number) => {
      if (page === 20) measuring.abort();
      return { width: 600, height: 800, transform: [] };
    });
    const second = setup({ openDocument: async () => slow });
    expect(await rejection(second.controller.show(URL_UNDER_TEST, measuring.signal)))
      .toMatchObject({ name: 'AbortError' });
    expect(slow.destroy).toHaveBeenCalledOnce();
    expect(second.view.mount).not.toHaveBeenCalled();
    expect(slow.getPageSize.mock.calls.length).toBeLessThan(40);
  });

  it('never fetches for an already cancelled load', async () => {
    const harness = setup();
    const controller = new AbortController();
    controller.abort();

    expect(await rejection(harness.controller.show(URL_UNDER_TEST, controller.signal)))
      .toMatchObject({ name: 'AbortError' });
    expect(harness.fetchPdf).not.toHaveBeenCalled();
  });

  it('closes idempotently: destroys the document once and clears the view', async () => {
    const harness = setup();
    await harness.controller.show(URL_UNDER_TEST, new AbortController().signal);

    harness.controller.close();
    harness.controller.close();

    expect(harness.controller.shown).toBe(false);
    expect(harness.documents[0]?.destroy).toHaveBeenCalledOnce();
    expect(harness.view.clear).toHaveBeenCalledTimes(2);
  });

  it('follows the tab’s viewer while its PDF shows (D108)', async () => {
    const harness = setup();
    const signal = new AbortController().signal;
    const viewer = { tabId: 7, documentId: 'DOC' };

    // A newly opened tab: Chrome's viewer is at the top.
    await harness.controller.show(URL_UNDER_TEST, signal, SOURCE_DOCUMENT, viewer);
    expect(harness.viewerFollower.start).toHaveBeenCalledWith(viewer, [
      { width: 601, height: 800 },
      { width: 602, height: 800 },
      { width: 603, height: 800 },
    ], { index: 0, fraction: 0 });

    // A PDF chosen on this computer has no viewer to follow.
    harness.viewerFollower.start.mockClear();
    harness.viewerFollower.stop.mockClear();
    await harness.controller.show({ file: new Blob(['%PDF-']), key: 'local-file:1' }, signal);
    expect(harness.viewerFollower.stop).toHaveBeenCalled();
    expect(harness.viewerFollower.start).not.toHaveBeenCalled();

    harness.controller.close();
    expect(harness.viewerFollower.stop).toHaveBeenCalledTimes(2);
  });

  it('starts a reloaded or newly opened tab from the viewer’s start, not a remembered place', async () => {
    const harness = setup();
    const signal = new AbortController().signal;
    const first = { tabId: 7, documentId: 'DOC-1' };
    await harness.controller.show(URL_UNDER_TEST, signal, SOURCE_DOCUMENT, first);
    harness.view.position = { index: 2, fraction: 0.5 };

    // Refresh: the same tab document keeps the reader's place and the guess.
    await harness.controller.show(URL_UNDER_TEST, signal, SOURCE_DOCUMENT, first);
    expect(harness.view.mounted[1]?.position).toEqual({ index: 2, fraction: 0.5 });
    expect(harness.viewerFollower.start.mock.calls[1]?.[2]).toBeUndefined();

    // The tab reloads (or the PDF opens in another tab) while following is
    // on: the viewer starts at its `#page=2`, and so does the view.
    harness.viewerFollower.following = true;
    const reloaded = { tabId: 7, documentId: 'DOC-2' };
    await harness.controller.show(`${URL_UNDER_TEST}#page=2`, signal, SOURCE_DOCUMENT, reloaded);
    expect(harness.view.mounted[2]?.position).toEqual({ index: 1, fraction: 0 });
    expect(harness.viewerFollower.start.mock.calls[2]?.[2]).toEqual({ index: 1, fraction: 0 });

    // With following off, the view opens where the reader left it, and the
    // guess still starts from the viewer's start.
    harness.viewerFollower.following = false;
    harness.view.position = { index: 2, fraction: 0.25 };
    const again = { tabId: 9, documentId: 'DOC-3' };
    await harness.controller.show(URL_UNDER_TEST, signal, SOURCE_DOCUMENT, again);
    expect(harness.view.mounted[3]?.position).toEqual({ index: 2, fraction: 0.25 });
    expect(harness.viewerFollower.start.mock.calls[3]?.[2]).toEqual({ index: 0, fraction: 0 });
  });

  it('keeps following the shown PDF when its replacement fails to load', async () => {
    let fail = false;
    const harness = setup({
      fetchPdf: async () => {
        if (fail) throw new PdfFetchError('failed', 'x');
        return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
      },
    });
    const signal = new AbortController().signal;
    await harness.controller.show(URL_UNDER_TEST, signal, SOURCE_DOCUMENT, { tabId: 7, documentId: 'DOC' });
    harness.viewerFollower.stop.mockClear();
    fail = true;
    await rejection(harness.controller.show(URL_UNDER_TEST, signal, SOURCE_DOCUMENT, {
      tabId: 7,
      documentId: 'DOC',
    }));
    expect(harness.viewerFollower.stop).not.toHaveBeenCalled();
    expect(harness.viewerFollower.start).toHaveBeenCalledOnce();
  });

  it('passes layout changes to the view', () => {
    const harness = setup();
    const settings: PdfLayoutSettings = {
      displayMode: 'actual',
      zoomPercent: 100,
      sourceZoomFactor: 1.25,
    };

    harness.controller.updateLayout(settings);

    expect(harness.view.updateLayout).toHaveBeenCalledWith(settings);
  });
});

describe('PdfController text', () => {
  it('shows the pages with an empty surface, then reads every page in order', async () => {
    const harness = setup({ withText: true });
    const signal = new AbortController().signal;

    await harness.controller.show(URL_UNDER_TEST, signal, SOURCE_DOCUMENT);
    // Nothing is read before the first paint, and nothing is published yet.
    expect(harness.documents[0]?.getTextContent).not.toHaveBeenCalled();
    expect(harness.surface.snapshot()).toBeUndefined();
    expect(harness.controller.textDocument).toEqual(SOURCE_DOCUMENT);

    await expect(harness.controller.readText(signal)).resolves.toEqual({ hasText: true });
    const shown = harness.surface.snapshot()!;
    expect(shown.documentLanguage).toBe('fr');
    expect(shown.records.map((record) => record.source)).toEqual(['Page 1', 'Page 2', 'Page 3']);
    expect(harness.pagesSet).toEqual([0, 1, 2]);
    expect(harness.diagnostics).toContainEqual({
      stage: 'text',
      pages: 3,
      pagesWithText: 3,
      blocks: 3,
      milliseconds: 0,
    });
    expect(JSON.stringify(harness.diagnostics)).not.toContain('Page');
  });

  it('reads on from the page the reader moved to, and asks for a new order', async () => {
    const answers = new Map<number, () => void>();
    const document = fakeDocument(6);
    document.getTextContent.mockImplementation((page: number) => new Promise((resolve) => {
      answers.set(page, () => resolve(pageText(page)));
    }));
    const harness = setup({ withText: true, openDocument: async () => document });
    const signal = new AbortController().signal;
    await harness.controller.show(URL_UNDER_TEST, signal, SOURCE_DOCUMENT);
    const reading = harness.controller.readText(signal);
    await vi.waitFor(() => expect(answers.has(1)).toBe(true));
    answers.get(1)!();
    await vi.waitFor(() => expect(answers.has(2)).toBe(true));

    harness.controller.handleReadingPage(4);
    expect(harness.surface.readingPage).toBe(4);
    await vi.waitFor(() => expect(harness.onPriorityChange).toHaveBeenCalledOnce());
    harness.controller.handleReadingPage(4);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(harness.onPriorityChange).toHaveBeenCalledOnce();
    for (const page of [2, 5, 6, 4, 3]) {
      await vi.waitFor(() => expect(answers.has(page)).toBe(true));
      answers.get(page)!();
    }
    await reading;

    expect(document.getTextContent.mock.calls.map(([page]) => page)).toEqual([1, 2, 5, 6, 4, 3]);
  });

  it('reorders translation only once the reader stops on a page', async () => {
    vi.useFakeTimers();
    try {
      const harness = setup({ withText: true, priorityDelayMs: 250 });
      await harness.controller.show(URL_UNDER_TEST, new AbortController().signal, SOURCE_DOCUMENT);
      await vi.advanceTimersByTimeAsync(300);
      harness.onPriorityChange.mockClear();

      for (const page of [1, 2, 1, 2]) {
        harness.controller.handleReadingPage(page);
        // The reading order follows at once; the reordering waits.
        expect(harness.surface.readingPage).toBe(page);
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(harness.onPriorityChange).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(250);
      expect(harness.onPriorityChange).toHaveBeenCalledOnce();

      harness.controller.handleReadingPage(0);
      harness.controller.close();
      await vi.advanceTimersByTimeAsync(500);
      expect(harness.onPriorityChange).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts a page whose text never comes as a page without text', async () => {
    const document = fakeDocument(3);
    document.getTextContent.mockImplementation((page: number) =>
      page === 2 ? new Promise<never>(() => undefined) : Promise.resolve(pageText(page)));
    const harness = setup({ withText: true, pageTextTimeoutMs: 20, openDocument: async () => document });
    const signal = new AbortController().signal;
    await harness.controller.show(URL_UNDER_TEST, signal, SOURCE_DOCUMENT);

    await expect(harness.controller.readText(signal)).resolves.toEqual({ hasText: true });
    expect(harness.surface.snapshot()!.records.map((record) => record.source))
      .toEqual(['Page 1', 'Page 3']);
  });

  it('clears the surface when a PDF is shown with no document to translate for', async () => {
    const harness = setup({ withText: true });
    const signal = new AbortController().signal;
    await harness.controller.show(URL_UNDER_TEST, signal, SOURCE_DOCUMENT);
    await harness.controller.readText(signal);
    expect(harness.surface.snapshot()).toBeDefined();

    await harness.controller.show(URL_UNDER_TEST, signal);

    expect(harness.surface.snapshot()).toBeUndefined();
    expect(harness.surface.document).toBeUndefined();
    expect(harness.controller.textDocument).toBeUndefined();
  });

  it('starts from the page a PDF shown again was left at', async () => {
    const harness = setup({ withText: true });
    const signal = new AbortController().signal;
    await harness.controller.show(URL_UNDER_TEST, signal, SOURCE_DOCUMENT);
    harness.view.position = { index: 2, fraction: 0.5 };

    await harness.controller.show(URL_UNDER_TEST, signal, SOURCE_DOCUMENT);
    expect(harness.surface.readingPage).toBe(2);
    await harness.controller.readText(signal);

    expect(harness.documents[1]?.getTextContent.mock.calls.map(([page]) => page))
      .toEqual([3, 2, 1]);
  });

  it.each(['close', 'abort', 'show'] as const)('stops reading on %s', async (stop) => {
    let release!: () => void;
    const document = fakeDocument(4);
    document.getTextContent.mockImplementation(async (page: number) => {
      if (page === 2) await new Promise<void>((done) => { release = done; });
      return pageText(page);
    });
    const harness = setup({ withText: true, openDocument: async () => document });
    const controller = new AbortController();
    await harness.controller.show(URL_UNDER_TEST, controller.signal, SOURCE_DOCUMENT);
    const reading = harness.controller.readText(controller.signal);
    await vi.waitFor(() => expect(release).toBeDefined());

    if (stop === 'close') harness.controller.close();
    if (stop === 'abort') controller.abort();
    if (stop === 'show') {
      await harness.controller.show(URL_UNDER_TEST, new AbortController().signal, SOURCE_DOCUMENT);
    }
    release();

    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(document.getTextContent).toHaveBeenCalledTimes(2);
    expect(harness.pagesSet).toEqual([0]);
  });

  it('goes on reading when the surface or view throws on a page', async () => {
    const harness = setup({ withText: true });
    harness.sink.setPageText.mockImplementationOnce(() => {
      throw new Error('Layout failed');
    });
    const signal = new AbortController().signal;
    await harness.controller.show(URL_UNDER_TEST, signal, SOURCE_DOCUMENT);

    await expect(harness.controller.readText(signal)).resolves.toEqual({ hasText: true });
    expect(harness.surface.snapshot()!.records).toHaveLength(3);
    expect(harness.sink.setPageText).toHaveBeenCalledTimes(3);
  });

  it('counts a page pdf.js cannot read as a page without text', async () => {
    const document = fakeDocument(3);
    document.getTextContent.mockImplementation(async (page: number) => {
      if (page !== 2) throw new Error('Bad content stream');
      return pageText(page);
    });
    const harness = setup({ withText: true, openDocument: async () => document });
    const signal = new AbortController().signal;
    await harness.controller.show(URL_UNDER_TEST, signal, SOURCE_DOCUMENT);

    await expect(harness.controller.readText(signal)).resolves.toEqual({ hasText: true });
    expect(harness.surface.snapshot()!.records.map((record) => record.source)).toEqual(['Page 2']);
  });

  it('reports a PDF without any text', async () => {
    const document = fakeDocument(2);
    document.getTextContent.mockImplementation(async () => ({ items: [], styles: {}, lang: null }));
    const harness = setup({ withText: true, openDocument: async () => document });
    const signal = new AbortController().signal;
    await harness.controller.show(URL_UNDER_TEST, signal, SOURCE_DOCUMENT);

    await expect(harness.controller.readText(signal)).resolves.toEqual({ hasText: false });
  });

  it('has nothing to read without a shown PDF or a surface', async () => {
    const withText = setup({ withText: true });
    await expect(withText.controller.readText(new AbortController().signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    const plain = setup();
    await plain.controller.show(URL_UNDER_TEST, new AbortController().signal, SOURCE_DOCUMENT);
    await expect(plain.controller.readText(new AbortController().signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(plain.documents[0]?.getTextContent).not.toHaveBeenCalled();
  });

  it('destroys the previous document even when starting the surface throws', async () => {
    const harness = setup({ withText: true });
    const signal = new AbortController().signal;
    await harness.controller.show(URL_UNDER_TEST, signal, SOURCE_DOCUMENT);
    const first = harness.documents[0]!;
    vi.spyOn(harness.surface, 'mount').mockImplementationOnce(() => {
      throw new Error('Surface failed');
    });

    await expect(harness.controller.show(URL_UNDER_TEST, signal, SOURCE_DOCUMENT))
      .rejects.toBeInstanceOf(PageAccessError);

    expect(first.destroy).toHaveBeenCalledOnce();
    expect(harness.documents[1]?.destroy).toHaveBeenCalledOnce();
    expect(harness.controller.shown).toBe(false);
  });
});

describe('PdfController scanned pages', () => {
  /** Page 1 has text; pages 2 to 5 are scanned. OCR reads "Scan <page>". */
  function scanned(options: {
    providerOrder?: readonly ('tesseract' | 'chrome-text-detector')[];
    recognize?: (page: number) => ImageRecognitionResult | Promise<ImageRecognitionResult>;
  } = {}) {
    const read: number[] = [];
    const recognize = vi.fn(async (pixels: {
      descriptor: { nodeId: number };
      bitmapWidth: number;
      bitmapHeight: number;
    }): Promise<ImageRecognitionResult> => {
      const page = pixels.descriptor.nodeId;
      read.push(page);
      if (options.recognize) {
        const answer = await options.recognize(page);
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
      }
      return {
        status: 'complete',
        cacheHit: false,
        result: {
          providerId: 'tesseract',
          bitmapWidth: pixels.bitmapWidth,
          bitmapHeight: pixels.bitmapHeight,
          transcript: `Scan ${page}`,
          regions: [{
            text: `Scan ${page}`,
            confidence: 0.9,
            boundingBox: { x: 20, y: 20, width: 200, height: 30 },
          }],
        },
      } satisfies ImageRecognitionResult;
    });
    const ocr: PdfControllerOcr = {
      environment: {
        createCanvas: () => ({ width: 0, height: 0 }),
        render: {
          createSurface: () => ({
            getContext: () => ({ drawImage: () => undefined }),
            convertToBlob: async () => new Blob([String(Math.random())]),
          }),
          digest: (bytes) => crypto.subtle.digest('SHA-256', bytes),
        },
        recognize: recognize as unknown as PdfControllerOcr['environment']['recognize'],
        wait: async () => undefined,
      },
      providerOrder: () => options.providerOrder ?? ['tesseract'],
      minimumConfidence: () => 0.65,
    };
    const harness = setup({
      withText: true,
      ocr,
      openDocument: async () => {
        const document = fakeDocument(5);
        document.getTextContent.mockImplementation(async (page: number) =>
          page === 1 ? pageText(1) : { items: [], styles: {}, lang: null });
        document.hasImages.mockResolvedValue(true);
        document.render.mockImplementation(async (_page: number, canvas: unknown, scale: number) => {
          const target = canvas as PdfOcrCanvas;
          target.width = Math.floor(600 * scale);
          target.height = Math.floor(800 * scale);
          return scale;
        });
        harness.documents.push(document);
        return document;
      },
    });
    return { ...harness, read, recognize };
  }

  async function shown(harness: ReturnType<typeof scanned>) {
    await harness.controller.show(URL_UNDER_TEST, new AbortController().signal, SOURCE_DOCUMENT);
    await harness.controller.readText(new AbortController().signal);
  }

  it('reads scanned pages from the reading page, following the reader, into the surface', async () => {
    const harness = scanned();
    await shown(harness);
    // Page 1 has little text: perhaps a scan, until its pictures say no.
    expect(harness.surface.unreadScannedPages()).toEqual([0, 1, 2, 3, 4]);
    expect(harness.surface.isUnconfirmedScan(0)).toBe(true);
    harness.surface.readingPage = 2;
    const progress: Array<[number, number]> = [];
    let moved = false;
    harness.recognize.mockImplementationOnce(async (pixels) => {
      harness.read.push(pixels.descriptor.nodeId);
      // The reader goes back to page 2 while page 3 is read.
      harness.surface.readingPage = 1;
      moved = true;
      return {
        status: 'complete',
        cacheHit: false,
        result: {
          providerId: 'tesseract',
          bitmapWidth: pixels.bitmapWidth,
          bitmapHeight: pixels.bitmapHeight,
          transcript: 'Scan 3',
          regions: [{ text: 'Scan 3', confidence: 0.9, boundingBox: { x: 20, y: 20, width: 200, height: 30 } }],
        },
      };
    });

    const outcome = await harness.controller.readScannedPages(
      'fr',
      new AbortController().signal,
      (done, total) => progress.push([done, total]),
    );

    expect(moved).toBe(true);
    expect(outcome).toEqual({ kind: 'complete' });
    expect(harness.read).toEqual([3, 2, 4, 5]);
    expect(progress).toEqual([[0, 4], [1, 4], [2, 4], [3, 4], [4, 4]]);
    expect(harness.surface.unreadScannedPages('fra')).toEqual([]);
    expect(harness.surface.snapshot()?.records.map((record) => record.source)).toEqual([
      'Page 1', 'Scan 2', 'Scan 3', 'Scan 4', 'Scan 5',
    ]);
    expect(harness.surface.isReading()).toBe(false);
    expect(harness.controller.scannedPagesNote()).toBeUndefined();
    expect(harness.diagnostics.at(-1)).toEqual({
      stage: 'ocr',
      pages: 4,
      pagesWithText: 4,
      failed: 0,
      stopped: false,
      milliseconds: 0,
    });
  });

  it('does not take a page whose text read failed for a scanned page, and one with little text only perhaps', async () => {
    const harness = scanned();
    harness.documents.length = 0;
    const rotated = {
      items: [{
        str: 'Sideways',
        dir: 'ltr',
        transform: [0, 10, -10, 0, 100, 100],
        width: 60,
        height: 10,
        fontName: 'f1',
        hasEOL: false,
      }],
      styles: { f1: { fontFamily: 'serif', ascent: 0.8, descent: -0.2, vertical: false } },
      lang: null,
    };
    await harness.controller.show(URL_UNDER_TEST, new AbortController().signal, SOURCE_DOCUMENT);
    const document = harness.documents.at(-1)!;
    document.getTextContent.mockImplementation(async (page: number) => {
      if (page === 2) throw new Error('Bad content stream');
      if (page === 3) return rotated;
      return page === 1 ? pageText(1) : { items: [], styles: {}, lang: null };
    });
    await harness.controller.readText(new AbortController().signal);
    // Pages 4 and 5 (0-based 3 and 4) are truly empty; the page with one
    // line and the page with only rotated text may be scans under a stamp.
    expect(harness.surface.unreadScannedPages()).toEqual([0, 2, 3, 4]);
    expect([0, 2, 3, 4].filter((index) => harness.surface.isUnconfirmedScan(index))).toEqual([0, 2]);
  });

  describe('with a little typed text over the scan', () => {
    /** Forty full lines: far more text than a stamp. */
    const bodyText = (): PdfTextContent => ({
      ...pageText(1),
      items: Array.from({ length: 40 }, (_, line) => ({
        ...pageText(1).items[0]!,
        str: `Body line ${line + 1}`,
        transform: [12, 0, 0, 12, 50, 760 - line * 18],
        width: 400,
        height: 12,
      })),
    });

    /** Five pages, each "Page n" over whatever `coverage` says its pictures cover. */
    async function stamped(
      coverage: (page: number) => Promise<number>,
      options: Parameters<typeof scanned>[0] & { text?: (page: number) => PdfTextContent } = {},
    ) {
      const harness = scanned(options);
      harness.documents.length = 0;
      await harness.controller.show(URL_UNDER_TEST, new AbortController().signal, SOURCE_DOCUMENT);
      const document = harness.documents.at(-1)!;
      document.getTextContent.mockImplementation(async (page: number) =>
        (options.text ?? pageText)(page));
      document.imageCoverage.mockImplementation(coverage);
      await harness.controller.readText(new AbortController().signal);
      return { ...harness, document };
    }
    const sources = (harness: Awaited<ReturnType<typeof stamped>>) =>
      harness.surface.snapshot()?.records.map((record) => record.source);

    it('reads the text without looking at the pictures, and takes little text for perhaps a scan', async () => {
      const harness = await stamped(async () => 1);
      expect(harness.document.imageCoverage).not.toHaveBeenCalled();
      expect(harness.surface.unreadScannedPages()).toEqual([0, 1, 2, 3, 4]);
      expect(harness.surface.typedText(0).map((block) => block.text)).toEqual(['Page 1']);
      expect(sources(harness)).toEqual(['Page 1', 'Page 2', 'Page 3', 'Page 4', 'Page 5']);
      expect(harness.controller.textOnScannedPagesOnly).toBe(true);
      // They may be read: a run waits for the answer.
      expect(harness.controller.scannedPagesState('fr')).toBe('readable');
      expect(harness.controller.scannedPagesState(undefined)).toBe('readable');
      harness.controller.close();
      expect(harness.controller.textOnScannedPagesOnly).toBe(false);

      // A page with plenty of text is a text page, whatever its pictures.
      const body = await stamped(async () => 1, { text: bodyText });
      expect(body.surface.unreadScannedPages()).toEqual([]);
      expect(body.controller.textOnScannedPagesOnly).toBe(false);
    });

    it('reads the pages whose pictures cover most of them, and lets the others be', async () => {
      const harness = await stamped(async (page) => {
        // A scan, a figure, a page that cannot be told, a picture just large enough, a scan.
        if (page === 2) return 0.5;
        if (page === 3) throw new Error('Bad content stream');
        return page === 4 ? 0.8 : 1;
      });
      const progress: Array<[number, number]> = [];

      const outcome = await harness.controller.readScannedPages(
        'fr',
        new AbortController().signal,
        (done, total) => progress.push([done, total]),
      );

      expect(outcome).toEqual({ kind: 'complete' });
      expect(harness.read).toEqual([1, 4, 5]);
      expect(sources(harness)).toEqual([
        'Scan 1', 'Page 1', 'Page 2', 'Page 3', 'Scan 4', 'Page 4', 'Scan 5', 'Page 5',
      ]);
      expect(harness.surface.scannedPages()).toEqual([0, 3, 4]);
      expect(harness.surface.unreadScannedPages('fra')).toEqual([]);
      // Counted from the first scan, before it is read: it and the four like
      // it, less the two that were not.
      expect(progress).toEqual([
        [0, 5], [1, 5], [1, 4], [1, 3], [1, 3], [2, 3], [2, 3], [3, 3],
      ]);
      expect(harness.diagnostics.at(-1)).toMatchObject({ stage: 'ocr', pages: 3, pagesWithText: 3 });
      // Read again in another language: the scans only, without a second look.
      harness.document.imageCoverage.mockClear();
      harness.document.hasImages.mockClear();
      await harness.controller.readScannedPages('en', new AbortController().signal);
      expect(harness.read).toEqual([1, 4, 5, 1, 4, 5]);
      expect(harness.document.imageCoverage).not.toHaveBeenCalled();
      expect(harness.document.hasImages).toHaveBeenCalledTimes(3);
    });

    it('never says it reads scanned pages when none is a scan', async () => {
      const harness = await stamped(async () => 0.2);
      const progress: Array<[number, number]> = [];
      const ocrBefore = harness.diagnostics.filter((entry) =>
        (entry as { stage: string }).stage === 'ocr').length;

      const outcome = await harness.controller.readScannedPages(
        'fr',
        new AbortController().signal,
        (done, total) => progress.push([done, total]),
      );

      expect(outcome).toEqual({ kind: 'complete' });
      expect(harness.read).toEqual([]);
      expect(progress).toEqual([]);
      expect(harness.surface.unreadScannedPages()).toEqual([]);
      expect(harness.controller.scannedPagesState('fr')).toBe('none');
      expect(harness.controller.scannedPagesNote()).toBeUndefined();
      expect(sources(harness)).toEqual(['Page 1', 'Page 2', 'Page 3', 'Page 4', 'Page 5']);
      expect(harness.diagnostics.filter((entry) =>
        (entry as { stage: string }).stage === 'ocr')).toHaveLength(ocrBefore);
      // pdf.js decoded each page's pictures for the check: they are freed.
      expect(harness.document.releasePage.mock.calls.map(([page]) => page)).toEqual([1, 2, 3, 4, 5]);
    });

    it('says nothing of pages it never looked at when it cannot read scans', async () => {
      // No reading method: the pictures are not looked at.
      const harness = await stamped(async () => 1, { providerOrder: [] });
      expect(harness.controller.scannedPagesState('fr')).toBe('none');
      expect(harness.controller.scannedPagesState(undefined)).toBe('none');
      expect(englishUiText(harness.controller.noTextStatus('fr')))
        .toBe(englishUiText(UI_STRINGS.statusPdfNoText));

      expect(await harness.controller.readScannedPages('fr', new AbortController().signal))
        .toEqual({ kind: 'complete' });
      expect(harness.surface.isReading()).toBe(false);
      expect(harness.document.imageCoverage).not.toHaveBeenCalled();
      expect(harness.controller.scannedPagesNote()).toBeUndefined();
      // Still perhaps scans, for when a method is on.
      expect(harness.surface.unreadScannedPages()).toEqual([0, 1, 2, 3, 4]);

      // A language without an OCR model: the same.
      const thai = await stamped(async () => 1);
      expect(await thai.controller.readScannedPages('th', new AbortController().signal))
        .toEqual({ kind: 'complete' });
      expect(thai.controller.scannedPagesState('th')).toBe('none');
      expect(thai.document.imageCoverage).not.toHaveBeenCalled();

      // A page without any text beside them is a scan it cannot read.
      const mixed = await stamped(async () => 1, {
        providerOrder: [],
        text: (page) => (page === 5 ? { items: [], styles: {}, lang: null } : pageText(page)),
      });
      expect(mixed.controller.scannedPagesState('fr')).toBe('no-method');
      expect(await mixed.controller.readScannedPages('fr', new AbortController().signal))
        .toEqual({ kind: 'no-method' });
      expect(mixed.document.imageCoverage).not.toHaveBeenCalled();
    });

    it('stops while it looks at a page\'s pictures', async () => {
      let release: (coverage: number) => void = () => undefined;
      const harness = await stamped(() => new Promise<number>((resolve) => {
        release = resolve;
      }));
      const reading = rejection(
        harness.controller.readScannedPages('fr', new AbortController().signal),
      );
      await vi.waitFor(() => expect(harness.document.imageCoverage).toHaveBeenCalledOnce());
      expect(harness.surface.isReading()).toBe(true);
      harness.controller.stopScannedReading();
      release(1);
      expect(await reading).toMatchObject({ name: 'AbortError' });
      expect(harness.surface.isReading()).toBe(false);
      expect(harness.read).toEqual([]);
      // Not looked at to the end: still perhaps a scan.
      expect(harness.surface.isUnconfirmedScan(0)).toBe(true);
    });

    it('reports the last dismissal once it counts scans', async () => {
      const harness = await stamped(async (page) => (page <= 2 ? 1 : 0));
      const progress: Array<[number, number]> = [];
      await harness.controller.readScannedPages(
        'fr',
        new AbortController().signal,
        (done, total) => progress.push([done, total]),
      );
      expect(harness.read).toEqual([1, 2]);
      expect(progress.at(-1)).toEqual([2, 2]);
      expect(progress).toEqual([[0, 5], [1, 5], [1, 5], [2, 5], [2, 4], [2, 3], [2, 2]]);
    });

    it('looks at the nearest pages for the language probe, and remembers what it saw', async () => {
      // No scan among them: every page is a text page from then on.
      const text = await stamped(async () => 0);
      expect(await text.controller.probeLanguage(new AbortController().signal)).toBeUndefined();
      expect(text.document.imageCoverage.mock.calls.map(([page]) => page)).toEqual([1, 2, 3, 4, 5]);
      expect(text.read).toEqual([]);
      expect(text.surface.unreadScannedPages()).toEqual([]);
      // The answer is the PDF's: asking again looks at nothing.
      text.document.imageCoverage.mockClear();
      await text.controller.probeLanguage(new AbortController().signal);
      expect(text.document.imageCoverage).not.toHaveBeenCalled();

      // Scans: three are enough for the probe, which draws no more.
      const scans = await stamped(async () => 1);
      scans.surface.readingPage = 1;
      await scans.controller.probeLanguage(new AbortController().signal);
      expect(scans.document.imageCoverage.mock.calls.map(([page]) => page)).toEqual([2, 3, 4]);
      expect([0, 1, 2, 3, 4].filter((index) => scans.surface.isUnconfirmedScan(index)))
        .toEqual([0, 4]);
      expect(new Set(scans.read)).toEqual(new Set([2, 3, 4]));
      // The reader does not look at them again.
      scans.document.imageCoverage.mockClear();
      await scans.controller.readScannedPages('fr', new AbortController().signal);
      expect(scans.document.imageCoverage.mock.calls.map(([page]) => page)).toEqual([5, 1]);
    });

    it('does not take no answer for the PDF\'s while pages are left unlooked at', async () => {
      // Twenty sparse pages: the twelve nearest are text pages, the rest scans.
      const harness = scanned();
      const document = fakeDocument(20);
      document.getTextContent.mockImplementation(async (page: number) => pageText(page));
      document.imageCoverage.mockImplementation(async (page: number) => (page > 12 ? 1 : 0));
      document.hasImages.mockResolvedValue(true);
      document.render.mockImplementation(async (_page: number, canvas: unknown, scale: number) => {
        const target = canvas as PdfOcrCanvas;
        target.width = Math.floor(600 * scale);
        target.height = Math.floor(800 * scale);
        return scale;
      });
      harness.openDocument.mockImplementationOnce(async () => document);
      const signal = new AbortController().signal;
      await harness.controller.show(URL_UNDER_TEST, signal, SOURCE_DOCUMENT);
      await harness.controller.readText(signal);

      expect(await harness.controller.probeLanguage(signal)).toBeUndefined();
      expect(document.imageCoverage).toHaveBeenCalledTimes(12);
      expect(harness.read).toEqual([]);
      // Asked again, it looks further and reads the scans it finds.
      await harness.controller.probeLanguage(signal);
      expect(document.imageCoverage.mock.calls.slice(12).map(([page]) => page)).toEqual([13, 14, 15]);
      expect(new Set(harness.read)).toEqual(new Set([13, 14, 15]));
    });
  });

  it('reads the scan under typed text and leaves out the lines that repeat it', async () => {
    const pixelsPerPoint = (width: number) => width / 601;
    const harness = scanned();
    harness.recognize.mockImplementation(async (pixels) => {
      harness.read.push(pixels.descriptor.nodeId);
      const scale = pixelsPerPoint(pixels.bitmapWidth);
      return {
        status: 'complete',
        cacheHit: false,
        result: {
          providerId: 'tesseract',
          bitmapWidth: pixels.bitmapWidth,
          bitmapHeight: pixels.bitmapHeight,
          transcript: '',
          regions: pixels.descriptor.nodeId === 1
            ? [
                // OCR read the typed "Page 1" as drawn, and the scan below it.
                {
                  text: 'Page l',
                  confidence: 0.9,
                  boundingBox: { x: 50 * scale, y: 92 * scale, width: 30 * scale, height: 10 * scale },
                },
                {
                  text: 'Le port et la ville',
                  confidence: 0.9,
                  boundingBox: { x: 100, y: 600, width: 500, height: 40 },
                },
              ]
            : [],
        },
      };
    });
    harness.documents.length = 0;
    await harness.controller.show(URL_UNDER_TEST, new AbortController().signal, SOURCE_DOCUMENT);
    harness.documents.at(-1)!.imageCoverage.mockResolvedValue(1);
    await harness.controller.readText(new AbortController().signal);

    await harness.controller.readScannedPages('fr', new AbortController().signal);

    expect(harness.read[0]).toBe(1);
    expect(harness.surface.snapshot()?.records.map((record) => record.source))
      .toEqual(['Page 1', 'Le port et la ville']);
  });

  it('marks a page it cannot draw as read, counts it, and does not draw it again', async () => {
    const harness = scanned();
    await shown(harness);
    const document = harness.documents.at(-1)!;
    document.render.mockImplementation(async (page: number, canvas: unknown, scale: number) => {
      if (page === 3) throw new Error('pdf.js could not draw it');
      const target = canvas as PdfOcrCanvas;
      target.width = Math.floor(600 * scale);
      target.height = Math.floor(800 * scale);
      return scale;
    });
    expect(await harness.controller.readScannedPages('fr', new AbortController().signal))
      .toEqual({ kind: 'failed', pages: 1 });
    expect(harness.surface.unreadScannedPages('fra')).toEqual([]);
    expect(englishUiText(harness.controller.scannedPagesNote()!))
      .toBe('Scanned pages that could not be read: 1.');
    document.render.mockClear();
    expect(await harness.controller.readScannedPages('fr', new AbortController().signal))
      .toEqual({ kind: 'complete' });
    expect(document.render).not.toHaveBeenCalled();
  });

  it('forgets pages read with another model even when this language cannot be read', async () => {
    const harness = scanned();
    await shown(harness);
    await harness.controller.readScannedPages('fr', new AbortController().signal);
    expect(harness.surface.snapshot()?.records).toHaveLength(5);
    expect(await harness.controller.readScannedPages('th', new AbortController().signal))
      .toEqual({ kind: 'unsupported', language: 'th' });
    // Text read as French is never translated as Thai.
    expect(harness.surface.snapshot()?.records.map((record) => record.source)).toEqual(['Page 1']);
    expect(harness.controller.scannedPagesState('th')).toBe('unsupported');
  });

  it('reports a reading that stops early', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = scanned({
      recognize: async () => {
        await held;
        return { status: 'failed', code: 'recognition-failed' };
      },
    });
    await shown(harness);
    const reading = harness.controller.readScannedPages('fr', new AbortController().signal);
    await vi.waitFor(() => expect(harness.read).toHaveLength(1));
    harness.controller.stopScannedReading();
    release();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(harness.diagnostics.at(-1)).toMatchObject({ stage: 'ocr', stopped: true });
  });

  it('reads only unread pages, and again in another model group', async () => {
    const harness = scanned();
    await shown(harness);
    await harness.controller.readScannedPages('fr', new AbortController().signal);
    harness.read.length = 0;
    await harness.controller.readScannedPages('fr', new AbortController().signal);
    expect(harness.read).toEqual([]);
    expect(harness.surface.unreadScannedPages('fra')).toEqual([]);
    expect(harness.surface.unreadScannedPages('deu')).toEqual([1, 2, 3, 4]);
    await harness.controller.readScannedPages('de', new AbortController().signal);
    expect(harness.read).toEqual([2, 3, 4, 5]);
  });

  it('keeps a page OCR could not read unread, and says how many', async () => {
    const harness = scanned({
      recognize: (page) => page === 3
        ? { status: 'failed', code: 'recognition-failed' }
        : {
            status: 'complete',
            cacheHit: false,
            result: {
              providerId: 'tesseract',
              bitmapWidth: 100,
              bitmapHeight: 100,
              transcript: '',
              regions: [],
            },
          },
    });
    await shown(harness);
    const outcome = await harness.controller.readScannedPages('fr', new AbortController().signal);
    expect(outcome).toEqual({ kind: 'failed', pages: 1 });
    expect(harness.surface.unreadScannedPages('fra')).toEqual([2]);
    expect(harness.controller.scannedPagesState('fr')).toBe('readable');
    expect(englishUiText(harness.controller.scannedPagesNote()!))
      .toBe('Scanned pages that could not be read: 1.');
  });

  it('says when no method is on or the language has no OCR model', async () => {
    const off = scanned({ providerOrder: [] });
    await shown(off);
    expect(await off.controller.readScannedPages('fr', new AbortController().signal))
      .toEqual({ kind: 'no-method' });
    expect(off.read).toEqual([]);
    expect(off.controller.scannedPagesState('fr')).toBe('no-method');
    expect(off.controller.scannedPagesNote()).toBe(UI_STRINGS.statusPdfScannedNoMethod);
    expect(off.controller.noTextStatus('fr')).toBe(UI_STRINGS.statusPdfScannedNoMethod);

    const thai = scanned();
    await shown(thai);
    expect(await thai.controller.readScannedPages('th', new AbortController().signal))
      .toEqual({ kind: 'unsupported', language: 'th' });
    expect(thai.controller.scannedPagesState('th')).toBe('unsupported');
    expect(englishUiText(thai.controller.noTextStatus('th')))
      .toBe('Scanned pages were not read: Simul has no OCR model for Thai.');
    expect(thai.controller.scannedPagesState('fr')).toBe('readable');
    expect(thai.controller.noTextStatus('fr')).toBe(UI_STRINGS.statusPdfNoText);
  });

  it('stops on abort, on close and on the next show', async () => {
    // Every page waits until the test lets the OCR answers go.
    let release!: () => void;
    let held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = scanned({
      recognize: async () => {
        await held;
        return { status: 'failed', code: 'recognition-failed' };
      },
    });
    const releaseAll = () => {
      const previous = release;
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      previous();
    };
    await shown(harness);
    const controller = new AbortController();
    const reading = harness.controller.readScannedPages('fr', controller.signal);
    await vi.waitFor(() => expect(harness.read).toHaveLength(1));
    expect(harness.surface.isReading()).toBe(true);
    controller.abort();
    releaseAll();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(harness.read).toHaveLength(1);
    expect(harness.surface.isReading()).toBe(false);

    const closing = harness.controller.readScannedPages('fr', new AbortController().signal);
    await vi.waitFor(() => expect(harness.read).toHaveLength(2));
    harness.controller.close();
    releaseAll();
    await expect(closing).rejects.toMatchObject({ name: 'AbortError' });
    expect(harness.read).toHaveLength(2);
    expect(harness.controller.scannedPagesNote()).toBeUndefined();

    await shown(harness);
    const replaced = harness.controller.readScannedPages('fr', new AbortController().signal);
    await vi.waitFor(() => expect(harness.read).toHaveLength(3));
    await harness.controller.show(URL_UNDER_TEST, new AbortController().signal, SOURCE_DOCUMENT);
    releaseAll();
    await expect(replaced).rejects.toMatchObject({ name: 'AbortError' });
    expect(harness.read).toHaveLength(3);
  });

  it('probes the scanned pages from the reading page on', async () => {
    const harness = scanned();
    await shown(harness);
    harness.surface.readingPage = 3;
    await harness.controller.probeLanguage(new AbortController().signal);
    // Three pages at most, reading page first, then onwards, then back.
    expect([...new Set(harness.read)]).toEqual([4, 5, 3]);
    // Asked again with the same methods, it reads nothing.
    harness.read.length = 0;
    await harness.controller.probeLanguage(new AbortController().signal);
    expect(harness.read).toEqual([]);
  });

  it('keeps probing when a translation run settles', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = scanned({
      recognize: async (page) => {
        await held;
        return {
          status: 'complete',
          cacheHit: false,
          result: {
            providerId: 'tesseract',
            bitmapWidth: 1,
            bitmapHeight: 1,
            transcript: `ページ${page}のにほんごのぶんしょうです`,
            transcriptConfidence: 0.95,
            regions: [{
              text: `ページ${page}のにほんごのぶんしょうです`,
              confidence: 0.95,
              boundingBox: { x: 0, y: 0, width: 1, height: 1 },
            }],
          },
        };
      },
    });
    await shown(harness);
    const probing = harness.controller.probeLanguage(new AbortController().signal);
    await vi.waitFor(() => expect(harness.read).toHaveLength(1));
    // A run settling stops its reading, never the probe.
    harness.controller.stopScannedReading();
    release();
    await expect(probing).resolves.toBe('ja');
  });
});

describe('PdfController files chosen on this computer', () => {
  const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

  it('reads the chosen file instead of downloading, and opens it', async () => {
    const readFile = vi.fn(async () => PDF_BYTES);
    const harness = setup({ readFile, withText: true });
    const file = new Blob([PDF_BYTES]);
    const signal = new AbortController().signal;

    await expect(harness.controller.show({ file, key: 'local-file:1' }, signal, SOURCE_DOCUMENT))
      .resolves.toEqual({ pageCount: 3 });

    expect(readFile).toHaveBeenCalledWith(file, signal);
    expect(harness.fetchPdf).not.toHaveBeenCalled();
    expect(harness.openDocument).toHaveBeenCalledWith(PDF_BYTES, expect.anything());
    expect(harness.controller.textDocument).toEqual(SOURCE_DOCUMENT);
    expect(harness.diagnostics).toEqual([
      { stage: 'shown', pages: 3, bytes: 5, milliseconds: 0 },
    ]);
  });

  it('reads the file itself by default, with the PDF check', async () => {
    const harness = setup();
    const signal = new AbortController().signal;

    await harness.controller.show({ file: new Blob([PDF_BYTES]), key: 'local-file:1' }, signal);
    const error = await rejection(harness.controller.show(
      { file: new Blob(['not a pdf']), key: 'local-file:2' },
      signal,
    ));

    expect(harness.controller.shown).toBe(true);
    expect(error).toBeInstanceOf(PageAccessError);
    expect((error as Error).message).toBe(UI_STRINGS.statusPdfUnreadable);
  });

  it.each([
    ['a file that moved or changed', () => new PdfFetchError('failed', 'x'), UI_STRINGS.statusPdfFileReadFailed, 'failed'],
    ['an unexpected read error', () => new TypeError('boom'), UI_STRINGS.statusPdfFileReadFailed, 'other'],
    ['a file over the cap', () => new PdfFetchError('too-large', 'x'), UI_STRINGS.statusPdfTooLarge, 'too-large'],
    ['a file that is not a PDF', () => new PdfFetchError('not-pdf', 'x'), UI_STRINGS.statusPdfUnreadable, 'not-pdf'],
  ])('reports %s with its own status and the read step', async (_label, makeError, status, kind) => {
    const harness = setup({ readFile: async () => { throw makeError(); } });

    const error = await rejection(harness.controller.show(
      { file: new Blob([PDF_BYTES]), key: 'local-file:1' },
      new AbortController().signal,
    ));

    expect(error).toBeInstanceOf(PageAccessError);
    expect((error as Error).message).toBe(status);
    expect(harness.openDocument).not.toHaveBeenCalled();
    expect(harness.diagnostics).toEqual([{ stage: 'failed', step: 'read', kind }]);
  });

  it('opens the same chosen file again where the reader left it, and another from the start', async () => {
    const harness = setup({ readFile: async () => PDF_BYTES });
    const signal = new AbortController().signal;
    const chosen = { file: new Blob([PDF_BYTES]), key: 'local-file:1' };
    await harness.controller.show(chosen, signal);
    harness.view.position = { index: 2, fraction: 0.25 };

    await harness.controller.show(chosen, signal);
    await harness.controller.show({ file: chosen.file, key: 'local-file:2' }, signal);

    expect(harness.view.mounted.map(({ position }) => position)).toEqual([
      undefined,
      { index: 2, fraction: 0.25 },
      undefined,
    ]);
  });
});
