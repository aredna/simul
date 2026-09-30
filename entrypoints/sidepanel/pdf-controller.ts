import { UI_STRINGS } from '../../lib/companion-ui-strings';
import { PageAccessError } from '../../lib/page-identity';
import { PdfFetchError } from '../../lib/pdf/pdf-fetch';
import type {
  PdfLayoutSettings,
  PdfPagePoints,
  PdfReadingPosition,
} from '../../lib/pdf/pdf-layout';
import type { PdfPageText } from '../../lib/pdf/pdf-text-surface';
import { PdfjsOpenError, type PdfDocumentHandle } from '../../lib/pdf/pdfjs-runtime';
import { pdfTextBlocks } from '../../lib/pdf/text-blocks';
import type { ReplicaSourceDocumentIdentity } from '../../lib/replica/source-identity';
import type { PdfViewSurface } from './pdf-view';

/** Content-free: stages, counts, sizes and times only. */
export type PdfDiagnostic =
  | {
      readonly stage: 'shown';
      readonly pages: number;
      readonly bytes: number;
      readonly milliseconds: number;
    }
  | { readonly stage: 'failed'; readonly step: PdfLoadStep; readonly kind: string }
  | {
      readonly stage: 'text';
      readonly pages: number;
      readonly pagesWithText: number;
      readonly blocks: number;
      readonly milliseconds: number;
    };

type PdfLoadStep = 'download' | 'open' | 'pages' | 'show';

/** The part of the PDF's translation surface the controller fills. */
export interface PdfControllerSurface {
  mount(document: ReplicaSourceDocumentIdentity, pageCount: number): void;
  clear(): void;
  addPage(page: PdfPageText): void;
  markTextComplete(): void;
  readonly document: ReplicaSourceDocumentIdentity | undefined;
  readonly hasText: boolean;
  readingPage: number;
}

export interface PdfControllerDependencies {
  readonly fetchPdf: (url: string, signal: AbortSignal) => Promise<Uint8Array>;
  readonly openDocument: (bytes: Uint8Array, signal: AbortSignal) => Promise<PdfDocumentHandle>;
  readonly view: PdfViewSurface;
  readonly now?: () => number;
  readonly onDiagnostic?: (diagnostic: PdfDiagnostic) => void;
  /** How long opening the file and reading its page sizes may take. */
  readonly openTimeoutMs?: number;
  /** Where the PDF's text goes; without it, there is no text to read. */
  readonly surface?: PdfControllerSurface;
  /**
   * The reader settled on another page; translation should start there.
   * Called once the reading page has stopped changing for `priorityDelayMs`.
   */
  readonly onPriorityChange?: () => void;
  readonly priorityDelayMs?: number;
  /** How long one page's text may take; a slower page counts as no text. */
  readonly pageTextTimeoutMs?: number;
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
/** The reading page must hold this long before translation is reordered. */
export const PDF_PRIORITY_DELAY_MS = 250;
/** One page's text read that takes longer than this counts as no text. */
export const PDF_PAGE_TEXT_TIMEOUT_MS = 10_000;

interface PageSizes {
  readonly sizes: readonly PdfPagePoints[];
  /** Each page's transform to page points; missing when unmeasured. */
  readonly transforms: readonly (readonly number[] | undefined)[];
}

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
  #pages: PageSizes | undefined;
  /** The running text reading; replaced or cleared to stop it. */
  #reading: object | undefined;
  #priorityTimer: ReturnType<typeof setTimeout> | undefined;
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
   * rejects with an `AbortError` and shows nothing. With `sourceDocument`,
   * the translation surface is started for it, empty; `readText` fills it.
   */
  async show(
    url: string,
    signal: AbortSignal,
    sourceDocument?: ReplicaSourceDocumentIdentity,
  ): Promise<{ readonly pageCount: number }> {
    const { fetchPdf, openDocument, view, surface } = this.#dependencies;
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
      const measured = await readPageSizes(opened, bounded.signal);
      const pageSizes = measured.sizes;
      bounded.signal.throwIfAborted();
      step = 'show';
      this.#rememberPosition();
      const remembered = this.#positions.get(key);
      const position = remembered?.pageCount === pageSizes.length ? remembered.position : undefined;
      const previous = this.#document;
      this.#reading = undefined;
      try {
        view.mount(opened, pageSizes, position);
        this.#document = opened;
        this.#shownKey = key;
        this.#pages = measured;
        opened = undefined;
        if (surface && sourceDocument) {
          surface.mount(sourceDocument, pageSizes.length);
          surface.readingPage = position?.index ?? 0;
        } else {
          // No document to translate for: nothing of the previous PDF stays.
          surface?.clear();
        }
      } finally {
        // Once replaced, the previous document goes, even if a later step failed.
        if (previous && this.#document !== previous) void previous.destroy().catch(() => {});
      }
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

  /**
   * Reads every page's text of the shown PDF into the translation surface,
   * one page at a time so pdf.js's worker can draw in between: the reading
   * page first, then the next unread page after the page being read, else
   * the nearest before it. Each page reaches the view as soon as it is read.
   * Resolves with whether any page has text, once the surface is marked
   * complete. A page that takes longer than `pageTextTimeoutMs` counts as
   * no text, so reading always ends. Rejects with an `AbortError` when
   * `signal` aborts, the PDF closes or another is shown.
   */
  async readText(signal: AbortSignal): Promise<{ readonly hasText: boolean }> {
    const { surface } = this.#dependencies;
    const document = this.#document;
    const pages = this.#pages;
    if (!surface || !document || !pages || signal.aborted) throw abortError();
    const token = {};
    this.#reading = token;
    const now = this.#dependencies.now ?? (() => performance.now());
    const started = now();
    const counts = { pages: 0, pagesWithText: 0, blocks: 0 };
    const unread = new Set<number>();
    pages.transforms.forEach((transform, index) => {
      if (transform) unread.add(index);
    });
    while (unread.size > 0) {
      const index = nextPageToRead(unread, surface.readingPage);
      unread.delete(index);
      const page = await readPageText(
        document,
        index,
        pages.transforms[index]!,
        pages.sizes[index]?.width,
        this.#dependencies.pageTextTimeoutMs ?? PDF_PAGE_TEXT_TIMEOUT_MS,
      );
      if (this.#reading !== token || this.#document !== document || signal.aborted) {
        throw abortError();
      }
      counts.pages += 1;
      if (page.blocks.length > 0) counts.pagesWithText += 1;
      counts.blocks += page.blocks.length;
      try {
        surface.addPage(page);
      } catch {
        // A page the surface or view could not take does not stop the rest.
      }
    }
    this.#reading = undefined;
    surface.markTextComplete();
    this.#report({
      stage: 'text',
      ...counts,
      milliseconds: Math.max(0, Math.round(now() - started)),
    });
    return { hasText: surface.hasText };
  }

  /** Destroys the shown document and empties and hides the view. Idempotent. */
  /** The translation surface's document, while its PDF is shown. */
  get textDocument(): ReplicaSourceDocumentIdentity | undefined {
    return this.#document ? this.#dependencies.surface?.document : undefined;
  }

  close(): void {
    this.#rememberPosition();
    this.#reading = undefined;
    if (this.#priorityTimer !== undefined) clearTimeout(this.#priorityTimer);
    this.#priorityTimer = undefined;
    this.#pages = undefined;
    this.#dependencies.surface?.clear();
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

  /**
   * The view's top page changed (0-based). Reading and any run that starts
   * now follow it at once; queued translation is reordered once the reader
   * has stayed on a page for `priorityDelayMs`, not on every page scrolled
   * past.
   */
  handleReadingPage(index: number): void {
    const surface = this.#dependencies.surface;
    if (!this.#document || !surface || !Number.isInteger(index) || index < 0) return;
    if (surface.readingPage === index) return;
    surface.readingPage = index;
    if (this.#priorityTimer !== undefined) clearTimeout(this.#priorityTimer);
    this.#priorityTimer = setTimeout(() => {
      this.#priorityTimer = undefined;
      try {
        this.#dependencies.onPriorityChange?.();
      } catch {
        // The order is a preference; reading goes on.
      }
    }, this.#dependencies.priorityDelayMs ?? PDF_PRIORITY_DELAY_MS);
  }
}

/** The unread page at or after the reading page, else the nearest before it. */
function nextPageToRead(unread: ReadonlySet<number>, readingPage: number): number {
  let after: number | undefined;
  let before: number | undefined;
  for (const index of unread) {
    if (index >= readingPage) {
      if (after === undefined || index < after) after = index;
    } else if (before === undefined || index > before) {
      before = index;
    }
  }
  return after ?? before!;
}

/** One page's text blocks; a page pdf.js cannot read in time has none. */
async function readPageText(
  document: PdfDocumentHandle,
  index: number,
  transform: readonly number[],
  pageWidth: number | undefined,
  timeoutMs: number,
): Promise<PdfPageText> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const content = await Promise.race([
      document.getTextContent(index + 1),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
    if (!content) return { index, blocks: [] };
    return {
      index,
      blocks: pdfTextBlocks(content, transform, pageWidth),
      language: content.lang,
    };
  } catch {
    return { index, blocks: [] };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function abortError(): DOMException {
  return new DOMException('Reading the PDF text was cancelled.', 'AbortError');
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
): Promise<PageSizes> {
  if (!Number.isInteger(document.pageCount) || document.pageCount < 1) {
    throw new PdfjsOpenError('unreadable', 'The PDF has no pages.');
  }
  const measured: ({ size: PdfPagePoints; transform: readonly number[] } | undefined)[] = [];
  for (let first = 1; first <= document.pageCount; first += PAGE_SIZE_BATCH) {
    const last = Math.min(document.pageCount, first + PAGE_SIZE_BATCH - 1);
    const batch = await untilAborted(Promise.all(
      Array.from({ length: last - first + 1 }, (_, offset) =>
        document.getPageSize(first + offset).then(
          ({ width, height, transform }) => ({ size: { width, height }, transform }),
          () => undefined,
        )),
    ), signal);
    measured.push(...batch);
  }
  let previous = measured.find((page) => page !== undefined)?.size;
  if (!previous) throw new PdfjsOpenError('unreadable', 'No page of the PDF could be read.');
  return {
    sizes: measured.map((page) => {
      previous = page?.size ?? previous!;
      return previous;
    }),
    // A page borrowing its neighbour's size has no text to place.
    transforms: measured.map((page) => page?.transform),
  };
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
