import { UI_STRINGS } from '../../lib/companion-ui-strings';
import type { ImageTextProviderId } from '../../lib/ocr/known-provider-ids';
import type { OcrMinimumConfidence } from '../../lib/ocr/result-quality';
import { PageAccessError } from '../../lib/page-identity';
import { PdfFetchError } from '../../lib/pdf/pdf-fetch';
import { readPdfFile, type LocalPdfFile } from '../../lib/pdf/pdf-file';
import type {
  PdfLayoutSettings,
  PdfPagePoints,
  PdfReadingPosition,
} from '../../lib/pdf/pdf-layout';
import {
  canReadScannedPages,
  pdfOcrRoute,
  probeScannedLanguage,
  readScannedPage,
  type PdfOcrEnvironment,
} from '../../lib/pdf/pdf-ocr';
import { tesseractLanguageGroupFor } from '../../lib/ocr/providers/tesseract/language-catalog';
import type { PdfPageText } from '../../lib/pdf/pdf-text-surface';
import { PdfjsOpenError, type PdfDocumentHandle } from '../../lib/pdf/pdfjs-runtime';
import { pdfTextBlocks, type PdfTextBlock } from '../../lib/pdf/text-blocks';
import type { ReplicaSourceDocumentIdentity } from '../../lib/replica/source-identity';
import type { SupportedLanguage } from '../../lib/translation-provider';
import { uiLanguageName, uiText, type UiText } from '../../lib/ui-text';
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
    }
  | {
      readonly stage: 'ocr';
      readonly pages: number;
      readonly pagesWithText: number;
      readonly failed: number;
      /** The reading stopped before every page was read (cancel, close, error). */
      readonly stopped: boolean;
      readonly milliseconds: number;
    };

/** How the last reading of scanned pages ended. */
export type PdfScannedReadingOutcome =
  | { readonly kind: 'complete' }
  | { readonly kind: 'no-method' }
  | { readonly kind: 'unsupported'; readonly language: SupportedLanguage }
  | { readonly kind: 'failed'; readonly pages: number };

/** Whether the shown PDF's unread scanned pages can be read now, and if not, why. */
export type PdfScannedPagesState = 'readable' | 'none' | 'no-method' | 'unsupported';

/** `read`: reading a file chosen on this computer, in place of `download`. */
type PdfLoadStep = 'download' | 'read' | 'open' | 'pages' | 'show';

/** The part of the PDF's translation surface the controller fills. */
export interface PdfControllerSurface {
  mount(document: ReplicaSourceDocumentIdentity, pageCount: number): void;
  clear(): void;
  addPage(page: PdfPageText): void;
  markTextComplete(): void;
  readonly document: ReplicaSourceDocumentIdentity | undefined;
  readonly hasText: boolean;
  readingPage: number;
  languageHint: string | undefined;
  unreadScannedPages(group?: string): number[];
  setScannedPage(index: number, blocks: readonly PdfTextBlock[], group: string): void;
  forgetScannedPages(group: string): void;
  beginReading(): object;
  endReading(token: object): void;
}

/** Local OCR for scanned pages; without it, scanned pages are never read. */
export interface PdfControllerOcr {
  readonly environment: PdfOcrEnvironment;
  /** The enabled, runtime-ready pixel reading methods, in the saved order. */
  readonly providerOrder: () => readonly ImageTextProviderId[];
  readonly minimumConfidence: () => OcrMinimumConfidence;
}

export interface PdfControllerDependencies {
  readonly fetchPdf: (url: string, signal: AbortSignal) => Promise<Uint8Array>;
  /** Reads a PDF chosen on this computer; `readPdfFile` by default. */
  readonly readFile?: (file: Blob, signal: AbortSignal) => Promise<Uint8Array>;
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
  readonly ocr?: PdfControllerOcr;
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
 * Loads the followed tab's PDF, or one chosen on this computer, and shows
 * it in the PDF view. Like the mirror's last good replica, the shown
 * document stays until its replacement has opened and every page size is
 * known; only then is it swapped in and the old pdf.js task destroyed, so
 * nothing is half drawn. A failed load leaves what was shown as it was.
 */
export class PdfController {
  readonly #dependencies: PdfControllerDependencies;
  #document: PdfDocumentHandle | undefined;
  /** The shown PDF's address without its fragment, or its chosen file's key. */
  #shownKey: string | undefined;
  #pages: PageSizes | undefined;
  /** The running text reading; replaced or cleared to stop it. */
  #reading: object | undefined;
  /** Stops the running scanned-page reading. */
  #scannedStop: AbortController | undefined;
  /** Stops the running language probe; a run settling never stops it. */
  #probeStop: AbortController | undefined;
  /** What the probe found for the shown PDF with the reading methods it used. */
  #probed:
    | {
        readonly document: PdfDocumentHandle;
        readonly key: string;
        readonly language: SupportedLanguage | undefined;
      }
    | undefined;
  #scannedOutcome: PdfScannedReadingOutcome | undefined;
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
   * Resolves once the PDF at `source` (the tab's URL, or a file chosen on
   * this computer) is shown. Failures reject with a `PageAccessError` whose
   * message is the status to show; a cancelled load rejects with an
   * `AbortError` and shows nothing. With `sourceDocument`, the translation
   * surface is started for it, empty; `readText` fills it.
   */
  async show(
    source: string | LocalPdfFile,
    signal: AbortSignal,
    sourceDocument?: ReplicaSourceDocumentIdentity,
  ): Promise<{ readonly pageCount: number }> {
    const { fetchPdf, openDocument, view, surface } = this.#dependencies;
    const readFile = this.#dependencies.readFile ??
      ((file: Blob, readSignal: AbortSignal) => readPdfFile(file, { signal: readSignal }));
    const now = this.#dependencies.now ?? (() => performance.now());
    const started = now();
    const key = typeof source === 'string' ? documentKey(source) : source.key;
    let step: PdfLoadStep = typeof source === 'string' ? 'download' : 'read';
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
      const bytes = typeof source === 'string'
        ? await fetchPdf(source, signal)
        : await readFile(source.file, signal);
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
      this.stopScannedReading();
      this.#stopProbe();
      this.#scannedOutcome = undefined;
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

  /**
   * Reads the shown PDF's unread scanned pages with local OCR in `language`,
   * one at a time: the reading page first, then the nearest unread page
   * after the page being read, else before it, so it follows the reader.
   * Pages read in another OCR model group are read again (and forgotten even
   * when this language cannot be read). While it runs the surface is
   * reading, so a translation run waits for each page. A page that cannot be
   * drawn is marked read with no text, so later runs do not draw it again;
   * a page whose recognition failed stays unread for the next run. Resolves
   * with the outcome; rejects with an `AbortError` when `signal` aborts, the
   * PDF closes, another is shown or `stopScannedReading` is called.
   */
  async readScannedPages(
    language: SupportedLanguage,
    signal: AbortSignal,
    onProgress?: (read: number, total: number) => void,
  ): Promise<PdfScannedReadingOutcome> {
    const { surface, ocr } = this.#dependencies;
    const document = this.#document;
    const pages = this.#pages;
    const sourceDocument = surface?.document;
    this.stopScannedReading();
    this.#scannedOutcome = undefined;
    if (!surface || !ocr || !document || !pages || !sourceDocument || signal.aborted) {
      throw abortError();
    }
    const resolved = pdfOcrRoute(language, ocr.providerOrder(), ocr.minimumConfidence());
    if (resolved.status !== 'ready') {
      // Text read with another model must not be translated as this language.
      surface.forgetScannedPages(tesseractLanguageGroupFor(language) ?? '');
      const outcome: PdfScannedReadingOutcome = surface.unreadScannedPages().length === 0
        ? { kind: 'complete' }
        : resolved.status === 'no-method'
          ? { kind: 'no-method' }
          : { kind: 'unsupported', language };
      this.#scannedOutcome = outcome;
      return outcome;
    }
    surface.forgetScannedPages(resolved.group);
    const unread = new Set(surface.unreadScannedPages(resolved.group));
    if (unread.size === 0) {
      const outcome: PdfScannedReadingOutcome = { kind: 'complete' };
      this.#scannedOutcome = outcome;
      return outcome;
    }
    const stop = new AbortController();
    this.#scannedStop = stop;
    const reading = AbortSignal.any([signal, stop.signal]);
    const token = surface.beginReading();
    const now = this.#dependencies.now ?? (() => performance.now());
    const started = now();
    const total = unread.size;
    const counts = { pages: 0, pagesWithText: 0, failed: 0 };
    let stopped = true;
    const current = () =>
      !reading.aborted && this.#document === document && surface.document === sourceDocument;
    try {
      reportProgress(onProgress, 0, total);
      while (unread.size > 0) {
        const index = nextPageToRead(unread, surface.readingPage);
        unread.delete(index);
        const size = pages.sizes[index];
        const result = size
          ? await readScannedPage(
              document,
              { index, size, document: sourceDocument, route: resolved.route },
              ocr.environment,
              reading,
            )
          : { status: 'unreadable' as const };
        if (!current()) throw abortError();
        counts.pages += 1;
        if (result.status === 'failed' || result.status === 'unreadable') counts.failed += 1;
        if (result.status !== 'failed') {
          // Read, without images, or not drawable: it is not read again.
          const blocks = result.status === 'read' ? result.blocks : [];
          if (blocks.length > 0) counts.pagesWithText += 1;
          try {
            surface.setScannedPage(index, blocks, resolved.group);
          } catch {
            // A page the view could not take does not stop the rest.
          }
        }
        reportProgress(onProgress, counts.pages, total);
      }
      stopped = false;
      // Known before the surface stops reading, so the run's end can say it.
      const outcome: PdfScannedReadingOutcome = counts.failed > 0
        ? { kind: 'failed', pages: counts.failed }
        : { kind: 'complete' };
      this.#scannedOutcome = outcome;
      return outcome;
    } catch (error) {
      if (isAbortError(error) || reading.aborted) throw abortError();
      throw error;
    } finally {
      if (this.#scannedStop === stop) this.#scannedStop = undefined;
      this.#report({
        stage: 'ocr',
        ...counts,
        stopped,
        milliseconds: Math.max(0, Math.round(now() - started)),
      });
      surface.endReading(token);
    }
  }

  /**
   * Finds the language of the shown PDF's scanned pages with the image
   * language probe, from the reading page on. `undefined` when it cannot
   * tell, the pages cannot be read, or it was stopped. It runs at most once
   * per shown PDF and set of reading methods; asking again gives the same
   * answer without reading anything.
   */
  async probeLanguage(signal: AbortSignal): Promise<SupportedLanguage | undefined> {
    const { surface, ocr } = this.#dependencies;
    const document = this.#document;
    const pages = this.#pages;
    const sourceDocument = surface?.document;
    if (!surface || !ocr || !document || !pages || !sourceDocument || signal.aborted) {
      return undefined;
    }
    const providerOrder = ocr.providerOrder();
    const minimumConfidence = ocr.minimumConfidence();
    const key = JSON.stringify([providerOrder, minimumConfidence]);
    const probed = this.#probed;
    if (probed?.document === document && probed.key === key) return probed.language;
    const unread = surface.unreadScannedPages();
    if (!canReadScannedPages(providerOrder) || unread.length === 0) return undefined;
    const start = surface.readingPage;
    const ordered = [
      ...unread.filter((index) => index >= start),
      ...unread.filter((index) => index < start).reverse(),
    ];
    this.#stopProbe();
    const stop = new AbortController();
    this.#probeStop = stop;
    try {
      const language = await probeScannedLanguage(
        document,
        {
          pages: ordered.flatMap((index) => {
            const size = pages.sizes[index];
            return size ? [{ index, size }] : [];
          }),
          document: sourceDocument,
          providerOrder,
          minimumConfidence,
        },
        ocr.environment,
        AbortSignal.any([signal, stop.signal]),
      );
      if (this.#document !== document || stop.signal.aborted || signal.aborted) return undefined;
      this.#probed = { document, key, language };
      return language;
    } catch {
      // Stopped: nothing is remembered, so the next ask probes again.
      return undefined;
    } finally {
      if (this.#probeStop === stop) this.#probeStop = undefined;
    }
  }

  /** Stops a running scanned-page reading; a running probe goes on. */
  stopScannedReading(): void {
    const stop = this.#scannedStop;
    this.#scannedStop = undefined;
    stop?.abort();
  }

  #stopProbe(): void {
    const stop = this.#probeStop;
    this.#probeStop = undefined;
    stop?.abort();
  }

  /** The language the probe found; used only when the PDF names none. */
  setLanguageHint(language: SupportedLanguage | undefined): void {
    const surface = this.#dependencies.surface;
    if (surface && this.#document) surface.languageHint = language;
  }

  /**
   * Whether the shown PDF has scanned pages still to read in `language`,
   * and whether they can be read: a pixel reading method must be on and the
   * language must have an OCR model. With no language yet, unread pages
   * count as readable; the run that reads them needs a language anyway.
   */
  scannedPagesState(language: SupportedLanguage | undefined): PdfScannedPagesState {
    const { surface, ocr } = this.#dependencies;
    if (!surface || !this.#document || !surface.document) return 'none';
    const providerOrder = ocr?.providerOrder() ?? [];
    if (!ocr || language === undefined) {
      if (surface.unreadScannedPages().length === 0) return 'none';
      return canReadScannedPages(providerOrder) ? 'readable' : 'no-method';
    }
    const resolved = pdfOcrRoute(language, providerOrder, ocr.minimumConfidence());
    // Pages read with another model count as unread: a run would forget them.
    const unread = surface.unreadScannedPages(
      resolved.status === 'ready' ? resolved.group : tesseractLanguageGroupFor(language) ?? '',
    );
    if (unread.length === 0) return 'none';
    return resolved.status === 'ready' ? 'readable' : resolved.status;
  }

  /**
   * Why the last reading left scanned pages as they were, for the status at
   * the end of a translation run; `undefined` when it read them all.
   */
  scannedPagesNote(): UiText | undefined {
    const outcome = this.#scannedOutcome;
    if (!outcome || outcome.kind === 'complete') return undefined;
    if (outcome.kind === 'no-method') return UI_STRINGS.statusPdfScannedNoMethod;
    if (outcome.kind === 'unsupported') {
      return uiText(UI_STRINGS.statusPdfScannedUnsupported, uiLanguageName(outcome.language));
    }
    return uiText(UI_STRINGS.statusPdfScannedFailed, outcome.pages);
  }

  /**
   * The status for a shown PDF with nothing to translate: its scanned pages
   * cannot be read (and why), or it has no text at all.
   */
  noTextStatus(language: SupportedLanguage | undefined): UiText {
    const state = this.scannedPagesState(language);
    if (state === 'no-method') return UI_STRINGS.statusPdfScannedNoMethod;
    if (state === 'unsupported' && language) {
      return uiText(UI_STRINGS.statusPdfScannedUnsupported, uiLanguageName(language));
    }
    return UI_STRINGS.statusPdfNoText;
  }

  /** The translation surface's document, while its PDF is shown. */
  get textDocument(): ReplicaSourceDocumentIdentity | undefined {
    return this.#document ? this.#dependencies.surface?.document : undefined;
  }

  /** Destroys the shown document and empties and hides the view. Idempotent. */
  close(): void {
    this.#rememberPosition();
    this.#reading = undefined;
    this.stopScannedReading();
    this.#stopProbe();
    this.#probed = undefined;
    this.#scannedOutcome = undefined;
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
      // No text at all, not even rotated or vertical text: a scanned page.
      ...(content.items.every((item) => item.str.trim() === '') ? { scanned: true } : {}),
    };
  } catch {
    return { index, blocks: [] };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function reportProgress(
  onProgress: ((read: number, total: number) => void) | undefined,
  read: number,
  total: number,
): void {
  try {
    onProgress?.(read, total);
  } catch {
    // Progress is shown on the side; reading goes on.
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
    return step === 'read'
      ? UI_STRINGS.statusPdfFileReadFailed
      : UI_STRINGS.statusPdfDownloadFailed;
  }
  if (error instanceof PdfjsOpenError) {
    if (error.kind === 'password') return UI_STRINGS.statusPdfPassword;
    if (error.kind === 'unreadable') return UI_STRINGS.statusPdfUnreadable;
    return UI_STRINGS.statusPdfReaderFailed;
  }
  if (step === 'download') return UI_STRINGS.statusPdfDownloadFailed;
  if (step === 'read') return UI_STRINGS.statusPdfFileReadFailed;
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
