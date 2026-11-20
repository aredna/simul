import { UI_STRINGS } from '../../lib/companion-ui-strings';
import type { LocalPdfFile } from '../../lib/pdf/pdf-file';
import type { PdfLayoutSettings } from '../../lib/pdf/pdf-layout';
import type { PdfViewerDoubt } from '../../lib/pdf/pdf-viewer-tracker';
import type { ReplicaSourceDocumentIdentity } from '../../lib/replica/source-identity';
import type { SupportedLanguage } from '../../lib/translation-provider';
import type { UiText } from '../../lib/ui-text';
import type {
  PdfScannedPagesState,
  PdfScannedReadingOutcome,
} from './pdf-controller';
import type { PdfLocateResult } from './pdf-page-box-reader';
import type { PdfViewerTarget } from './pdf-viewer-follower';
import { settle } from '../../lib/settle';

/** The part of the real controller this facade forwards. */
export interface PdfControllerLike {
  readonly shown: boolean;
  show(
    source: string | LocalPdfFile,
    signal: AbortSignal,
    sourceDocument?: ReplicaSourceDocumentIdentity,
    viewer?: PdfViewerTarget,
  ): Promise<{ readonly pageCount: number }>;
  readText(signal: AbortSignal): Promise<{ readonly hasText: boolean }>;
  readScannedPages(
    language: SupportedLanguage,
    signal: AbortSignal,
    onProgress?: (read: number, total: number) => void,
  ): Promise<PdfScannedReadingOutcome>;
  probeLanguage(signal: AbortSignal): Promise<SupportedLanguage | undefined>;
  stopScannedReading(): void;
  setLanguageHint(language: SupportedLanguage | undefined): void;
  scannedPagesState(language: SupportedLanguage | undefined): PdfScannedPagesState;
  readonly textOnScannedPagesOnly: boolean;
  scannedPagesNote(): UiText | undefined;
  noTextStatus(language: SupportedLanguage | undefined): UiText;
  readonly textDocument: ReplicaSourceDocumentIdentity | undefined;
  locatePage(
    target: PdfViewerTarget,
    doubt: PdfViewerDoubt,
    signal: AbortSignal,
  ): Promise<PdfLocateResult> | undefined;
  close(): void;
  updateLayout(settings: PdfLayoutSettings): void;
  handleReadingPage(index: number): void;
}

export interface LazyPdfControllerOptions {
  readonly load: () => Promise<PdfControllerLike>;
}

/**
 * Defers the PDF controller and its pdf.js/OCR reading stack until the first
 * PDF is shown (O8). Getters before then describe "no PDF shown", synchronous
 * view callbacks are no-ops (there is no document to act on), and layout and
 * language settings are kept for the controller created on first use. Only
 * `show` starts the load, so a panel that never opens a PDF never pays for
 * the stack.
 */
export class LazyPdfController implements PdfControllerLike {
  readonly #load: () => Promise<PdfControllerLike>;
  #controller: PdfControllerLike | undefined;
  #loadPromise: Promise<PdfControllerLike> | undefined;
  #latestLayout: PdfLayoutSettings | undefined;
  #languageHintSet = false;
  #languageHint: SupportedLanguage | undefined;
  #closePending = false;
  #closeGeneration = 0;

  constructor(options: LazyPdfControllerOptions) {
    this.#load = options.load;
  }

  get shown(): boolean {
    return this.#controller?.shown ?? false;
  }

  async show(
    source: string | LocalPdfFile,
    signal: AbortSignal,
    sourceDocument?: ReplicaSourceDocumentIdentity,
    viewer?: PdfViewerTarget,
  ): Promise<{ readonly pageCount: number }> {
    const closeGeneration = this.#closeGeneration;
    const controller = await this.#loadController();
    // A close after this show started must stop it at the door, even with a
    // live signal: the controller it would mount into has been closed. New
    // shows after the close capture the new generation and proceed.
    if (closeGeneration !== this.#closeGeneration) throw readingCancelled();
    return controller.show(source, signal, sourceDocument, viewer);
  }

  readText(signal: AbortSignal): Promise<{ readonly hasText: boolean }> {
    // Only a shown PDF has text to read; loading the stack here could not
    // make a document exist and would turn a programming error into work.
    if (!this.#controller) return Promise.reject(readingCancelled());
    return this.#controller.readText(signal);
  }

  readScannedPages(
    language: SupportedLanguage,
    signal: AbortSignal,
    onProgress?: (read: number, total: number) => void,
  ): Promise<PdfScannedReadingOutcome> {
    if (!this.#controller) return Promise.reject(readingCancelled());
    return this.#controller.readScannedPages(language, signal, onProgress);
  }

  probeLanguage(signal: AbortSignal): Promise<SupportedLanguage | undefined> {
    return this.#controller?.probeLanguage(signal) ?? Promise.resolve(undefined);
  }

  stopScannedReading(): void {
    this.#controller?.stopScannedReading();
  }

  setLanguageHint(language: SupportedLanguage | undefined): void {
    this.#languageHintSet = true;
    this.#languageHint = language;
    this.#controller?.setLanguageHint(language);
  }

  scannedPagesState(language: SupportedLanguage | undefined): PdfScannedPagesState {
    return this.#controller?.scannedPagesState(language) ?? 'none';
  }

  get textOnScannedPagesOnly(): boolean {
    return this.#controller?.textOnScannedPagesOnly ?? false;
  }

  scannedPagesNote(): UiText | undefined {
    return this.#controller?.scannedPagesNote();
  }

  noTextStatus(language: SupportedLanguage | undefined): UiText {
    return this.#controller?.noTextStatus(language) ?? UI_STRINGS.statusPdfNoText;
  }

  get textDocument(): ReplicaSourceDocumentIdentity | undefined {
    return this.#controller?.textDocument;
  }

  locatePage(
    target: PdfViewerTarget,
    doubt: PdfViewerDoubt,
    signal: AbortSignal,
  ): Promise<PdfLocateResult> | undefined {
    // The viewer follower asks only while a PDF is shown; before the first
    // show there is no document and no page to locate.
    return this.#controller?.locatePage(target, doubt, signal);
  }

  close(): void {
    // Advance the generation before anything else so a show that is awaiting
    // the stack load rejects instead of mounting a document into a controller
    // this close is about to close.
    this.#closeGeneration += 1;
    if (this.#controller) {
      this.#controller.close();
      return;
    }
    // A pagehide while the stack is loading still closes the controller that
    // arrives; the generation check in show keeps the queued show from
    // mounting into it.
    this.#closePending = true;
  }

  updateLayout(settings: PdfLayoutSettings): void {
    this.#latestLayout = settings;
    this.#controller?.updateLayout(settings);
  }

  handleReadingPage(index: number): void {
    // Called by the eager view; before the first show there is no document
    // whose reading page could change.
    this.#controller?.handleReadingPage(index);
  }

  #loadController(): Promise<PdfControllerLike> {
    if (this.#controller) return Promise.resolve(this.#controller);
    if (!this.#loadPromise) {
      const loading = this.#load();
      const pending = (async () => {
        const loaded = await settle(loading);
        this.#loadPromise = undefined;
        if (!loaded.ok) throw loaded.error;
        this.#controller = loaded.value;
        this.#applyPending(loaded.value);
        return loaded.value;
      })();
      this.#loadPromise = pending;
    }
    return this.#loadPromise;
  }

  #applyPending(controller: PdfControllerLike): void {
    if (this.#closePending) {
      this.#closePending = false;
      controller.close();
    }
    if (this.#latestLayout) controller.updateLayout(this.#latestLayout);
    if (this.#languageHintSet) controller.setLanguageHint(this.#languageHint);
  }
}

function readingCancelled(): DOMException {
  return new DOMException('Reading the PDF text was cancelled.', 'AbortError');
}