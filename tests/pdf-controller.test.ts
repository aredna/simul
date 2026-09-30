import { describe, expect, it, vi } from 'vitest';

import { PdfController } from '../entrypoints/sidepanel/pdf-controller';
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
  type PdfjsOpenErrorKind,
} from '../lib/pdf/pdfjs-runtime';

const URL_UNDER_TEST = 'https://example.com/report.pdf';

function fakeDocument(pageCount = 3) {
  const document = {
    pageCount,
    getPageSize: vi.fn(async (page: number): Promise<PdfPageSize> => ({
      width: 600 + page,
      height: 800,
      transform: [1, 0, 0, -1, 0, 800],
    })),
    getTextContent: vi.fn(),
    hasImages: vi.fn(),
    render: vi.fn(async () => 1),
    releasePage: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
  };
  return document satisfies PdfDocumentHandle;
}

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
  openDocument?: (bytes: Uint8Array, signal: AbortSignal) => Promise<PdfDocumentHandle>;
  openTimeoutMs?: number;
  onDiagnostic?: (diagnostic: unknown) => void;
} = {}) {
  const view = fakeView();
  const documents: ReturnType<typeof fakeDocument>[] = [];
  const diagnostics: unknown[] = [];
  const fetchPdf = vi.fn(options.fetchPdf ?? (async () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])));
  const openDocument = vi.fn(options.openDocument ?? (async () => {
    const document = fakeDocument();
    documents.push(document);
    return document;
  }));
  const controller = new PdfController({
    fetchPdf,
    openDocument,
    view,
    now: () => 0,
    onDiagnostic: options.onDiagnostic ?? ((diagnostic) => diagnostics.push(diagnostic)),
    ...(options.openTimeoutMs ? { openTimeoutMs: options.openTimeoutMs } : {}),
  });
  return { controller, view, documents, fetchPdf, openDocument, diagnostics };
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

    expect(harness.view.mounted.map(({ position }) => position)).toEqual([
      undefined,
      { index: 2, fraction: 0.25 },
      { index: 1, fraction: 0.5 },
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
