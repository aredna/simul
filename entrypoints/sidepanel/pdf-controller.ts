import { UI_STRINGS } from '../../lib/companion-ui-strings';
import { PageAccessError } from '../../lib/page-identity';
import { PdfFetchError } from '../../lib/pdf/pdf-fetch';
import type {
  PdfLayoutSettings,
  PdfPagePoints,
  PdfReadingPosition,
} from '../../lib/pdf/pdf-layout';
import { PdfjsOpenError, type PdfDocumentHandle } from '../../lib/pdf/pdfjs-runtime';
import type { PdfViewSurface } from './pdf-view';

/** Content-free: stages, counts, sizes and times only. */
export type PdfDiagnostic =
  | {
      readonly stage: 'shown';
      readonly pages: number;
      readonly bytes: number;
      readonly milliseconds: number;
    }
  | { readonly stage: 'failed'; readonly step: PdfLoadStep; readonly kind: string };

type PdfLoadStep = 'download' | 'open' | 'pages' | 'show';

export interface PdfControllerDependencies {
  readonly fetchPdf: (url: string, signal: AbortSignal) => Promise<Uint8Array>;
  readonly openDocument: (bytes: Uint8Array, signal: AbortSignal) => Promise<PdfDocumentHandle>;
  readonly view: PdfViewSurface;
  readonly now?: () => number;
  readonly onDiagnostic?: (diagnostic: PdfDiagnostic) => void;
  /** How long opening the file and reading its page sizes may take. */
  readonly openTimeoutMs?: number;
}

/**
 * Opening and measuring a PDF that takes longer than this is treated as
 * unreadable, so a stalled pdf.js worker cannot hold the capture forever.
 */
export const PDF_OPEN_TIMEOUT_MS = 60_000;
// Page sizes are read this many at a time; pdf.js answers each from its worker.
const PAGE_SIZE_BATCH = 16;
// Reading positions are remembered for this many recently shown PDFs.
const REMEMBERED_POSITIONS = 16;

/**
 * Loads the followed tab's PDF and shows it in the PDF view. Like the
 * mirror's last good replica, the shown document stays until its
 * replacement has opened and every page size is known; only then is it
 * swapped in and the old pdf.js task destroyed, so nothing is half drawn.
 * A failed load leaves what was shown as it was.
 */
export class PdfController {
  readonly #dependencies: PdfControllerDependencies;
  #document: PdfDocumentHandle | undefined;
  /** The shown PDF's address without its fragment. */
  #shownKey: string | undefined;
  // Memory only: where the reader was in recently shown PDFs, so a Refresh
  // or a return to the tab opens at the same place.
  readonly #positions = new Map<string, {
    readonly pageCount: number;
    readonly position: PdfReadingPosition;
  }>();

  constructor(dependencies: PdfControllerDependencies) {
    this.#dependencies = dependencies;
  }

  get shown(): boolean {
    return this.#document !== undefined;
  }

  /**
   * Resolves once the PDF at `url` is shown. Failures reject with a
   * `PageAccessError` whose message is the status to show; a cancelled load
   * rejects with an `AbortError` and shows nothing.
   */
  async show(url: string, signal: AbortSignal): Promise<{ readonly pageCount: number }> {
    const { fetchPdf, openDocument, view } = this.#dependencies;
    const now = this.#dependencies.now ?? (() => performance.now());
    const started = now();
    const key = documentKey(url);
    let step: PdfLoadStep = 'download';
    let opened: PdfDocumentHandle | undefined;
    // Opening and measuring end on the caller's cancel or on the time limit.
    const bounded = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => bounded.abort(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    let shown: { readonly pages: number; readonly bytes: number };
    try {
      signal.throwIfAborted();
      const bytes = await fetchPdf(url, signal);
      const byteCount = bytes.byteLength;
      signal.throwIfAborted();
      timer = setTimeout(() => {
        timedOut = true;
        bounded.abort();
      }, this.#dependencies.openTimeoutMs ?? PDF_OPEN_TIMEOUT_MS);
      step = 'open';
      // pdf.js takes the bytes over; they are not used after this.
      opened = await openDocument(bytes, bounded.signal);
      bounded.signal.throwIfAborted();
      step = 'pages';
      const pageSizes = await readPageSizes(opened, bounded.signal);
      bounded.signal.throwIfAborted();
      step = 'show';
      this.#rememberPosition();
      const remembered = this.#positions.get(key);
      const previous = this.#document;
      view.mount(
        opened,
        pageSizes,
        remembered?.pageCount === pageSizes.length ? remembered.position : undefined,
      );
      this.#document = opened;
      this.#shownKey = key;
      opened = undefined;
      if (previous) void previous.destroy().catch(() => {});
      shown = { pages: pageSizes.length, bytes: byteCount };
    } catch (error) {
      if (opened) void opened.destroy().catch(() => {});
      // A mount that failed part-way has already emptied the view.
      if (step === 'show') this.close();
      if (signal.aborted) {
        throw new DOMException('Loading the PDF was cancelled.', 'AbortError');
      }
      if (timedOut) {
        this.#report({ stage: 'failed', step, kind: 'timeout' });
        throw new PageAccessError(UI_STRINGS.statusPdfUnreadable);
      }
      if (isAbortError(error)) {
        throw new DOMException('Loading the PDF was cancelled.', 'AbortError');
      }
      this.#report({ stage: 'failed', step, kind: errorKind(error) });
      throw new PageAccessError(statusFor(error, step));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
    }
    this.#report({
      stage: 'shown',
      pages: shown.pages,
      bytes: shown.bytes,
      milliseconds: Math.max(0, Math.round(now() - started)),
    });
    return { pageCount: shown.pages };
  }

  /** Destroys the shown document and empties and hides the view. Idempotent. */
  close(): void {
    this.#rememberPosition();
    this.#dependencies.view.clear();
    const document = this.#document;
    this.#document = undefined;
    this.#shownKey = undefined;
    if (document) void document.destroy().catch(() => {});
  }

  /** Notes where the reader is in the shown PDF before it goes away. */
  #rememberPosition(): void {
    const key = this.#shownKey;
    const document = this.#document;
    if (key === undefined || !document) return;
    const position = this.#dependencies.view.readingPosition();
    if (!position) return;
    this.#positions.delete(key);
    this.#positions.set(key, { pageCount: document.pageCount, position });
    while (this.#positions.size > REMEMBERED_POSITIONS) {
      const oldest = this.#positions.keys().next().value;
      if (oldest === undefined) break;
      this.#positions.delete(oldest);
    }
  }

  /** Diagnostics never disturb what is shown. */
  #report(diagnostic: PdfDiagnostic): void {
    try {
      this.#dependencies.onDiagnostic?.(diagnostic);
    } catch {
      // A failing log line is not a failing PDF.
    }
  }

  updateLayout(settings: PdfLayoutSettings): void {
    this.#dependencies.view.updateLayout(settings);
  }
}

/**
 * Every page's size. A page pdf.js cannot measure takes the size of the page
 * before it (or the first page that could be measured), as its placeholder;
 * only a PDF with no measurable page at all is unreadable. A cancel ends the
 * wait at once, even while pdf.js is still answering.
 */
async function readPageSizes(
  document: PdfDocumentHandle,
  signal: AbortSignal,
): Promise<PdfPagePoints[]> {
  if (!Number.isInteger(document.pageCount) || document.pageCount < 1) {
    throw new PdfjsOpenError('unreadable', 'The PDF has no pages.');
  }
  const measured: (PdfPagePoints | undefined)[] = [];
  for (let first = 1; first <= document.pageCount; first += PAGE_SIZE_BATCH) {
    const last = Math.min(document.pageCount, first + PAGE_SIZE_BATCH - 1);
    const batch = await untilAborted(Promise.all(
      Array.from({ length: last - first + 1 }, (_, offset) =>
        document.getPageSize(first + offset).then(
          ({ width, height }): PdfPagePoints => ({ width, height }),
          () => undefined,
        )),
    ), signal);
    measured.push(...batch);
  }
  let previous = measured.find((size) => size !== undefined);
  if (!previous) throw new PdfjsOpenError('unreadable', 'No page of the PDF could be read.');
  return measured.map((size) => {
    previous = size ?? previous!;
    return previous;
  });
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** A PDF's address without its fragment: `#page=3` is the same file. */
function documentKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return url;
  }
}

function statusFor(error: unknown, step: PdfLoadStep): string {
  if (error instanceof PdfFetchError) {
    if (error.kind === 'too-large') return UI_STRINGS.statusPdfTooLarge;
    if (error.kind === 'not-pdf') return UI_STRINGS.statusPdfUnreadable;
    return UI_STRINGS.statusPdfDownloadFailed;
  }
  if (error instanceof PdfjsOpenError) {
    if (error.kind === 'password') return UI_STRINGS.statusPdfPassword;
    if (error.kind === 'unreadable') return UI_STRINGS.statusPdfUnreadable;
    return UI_STRINGS.statusPdfReaderFailed;
  }
  if (step === 'download') return UI_STRINGS.statusPdfDownloadFailed;
  // A page tree pdf.js cannot read is a broken file, not a broken reader.
  if (step === 'pages') return UI_STRINGS.statusPdfUnreadable;
  return UI_STRINGS.statusPdfReaderFailed;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof PdfFetchError || error instanceof PdfjsOpenError) {
    return error.kind === 'aborted';
  }
  return (error as { name?: unknown } | undefined)?.name === 'AbortError';
}

function errorKind(error: unknown): string {
  if (error instanceof PdfFetchError || error instanceof PdfjsOpenError) return error.kind;
  return 'other';
}
