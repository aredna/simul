import type { ReplicaImageAnchor } from '../replica/contracts';
import type { ReplicaProjectionSurface } from '../replica/replica-surface-router';
import {
  sameSourceDocument,
  type ReplicaSourceDocumentIdentity,
  type ReplicaSourceDomTextRecord,
} from '../replica/source-text-record';
import type {
  ReplicaProjectionContext,
  ReplicaTextProjection,
  ReplicaTranslationSnapshot,
} from '../translation/replica-translation-coordinator';
import { canonicalizeLanguageTag } from '../translation-provider';
import type { PdfTextBlock } from './text-blocks';

/** A text block with the id its translation record carries. */
export interface PdfSurfaceBlock extends PdfTextBlock {
  readonly id: number;
}

/** Where the surface shows a PDF's text and translations: the PDF view. */
export interface PdfTextSink {
  setPageText(pageIndex: number, blocks: readonly PdfSurfaceBlock[]): void;
  showTranslation(blockId: number, text: string, language: string | undefined): void;
  hideTranslations(): void;
}

export interface PdfPageText {
  /** 0-based. */
  readonly index: number;
  readonly blocks: readonly PdfTextBlock[];
  /** The document's /Lang, as pdf.js reports it with each page. */
  readonly language?: string | null;
  /**
   * pdf.js read the page and it has no text at all: a scanned page, which
   * OCR may read. Not set for a page whose read failed or timed out, or
   * whose only text is rotated or vertical.
   */
  readonly scanned?: boolean;
}

// A /Lang longer than this is not a language tag.
const MAX_LANGUAGE_LENGTH = 35;

/**
 * The shown PDF as a translation surface. Its text blocks are the records the
 * translation coordinator translates, and a projection becomes a block's
 * overlay in the PDF view. One document identity and replay lease cover one
 * shown PDF; a projection for anything else is refused. Pages are added as
 * their text is read and go to the view at once; the coordinator sees them
 * through `snapshot()` only once every page is read (`markTextComplete`),
 * never through commits, so a half-read PDF is never published.
 */
export class PdfTextSurface implements ReplicaProjectionSurface {
  readonly #sink: PdfTextSink;
  #document: ReplicaSourceDocumentIdentity | undefined;
  #replayLease = 0;
  #language: string | undefined;
  #pageCount = 0;
  #pages: (readonly PdfSurfaceBlock[] | undefined)[] = [];
  readonly #records = new Map<number, ReplicaSourceDomTextRecord>();
  #nextId = 1;
  #snapshot: ReplicaTranslationSnapshot | undefined;
  #textComplete = false;
  #context: ReplicaProjectionContext = { translationEpoch: 0, pairKey: undefined };
  #readingPage = 0;
  /**
   * Pages whose text read found nothing (scanned pages), with the OCR model
   * group they were read in; `undefined` while unread.
   */
  readonly #scanned = new Map<number, string | undefined>();
  #languageHint: string | undefined;
  /** The running scanned-page reader, if any. */
  #reading: object | undefined;
  readonly #waiters = new Set<() => void>();

  constructor(sink: PdfTextSink) {
    this.#sink = sink;
  }

  get document(): ReplicaSourceDocumentIdentity | undefined {
    return this.#document;
  }

  get replayLease(): number {
    return this.#replayLease;
  }

  /** Whether any page read so far has text to translate. */
  get hasText(): boolean {
    return this.#records.size > 0;
  }

  /** Every page of the mounted document has been read: it can be published. */
  markTextComplete(): void {
    if (this.#document) this.#textComplete = true;
  }

  /** Starts a new document; everything from the previous one is forgotten. */
  mount(document: ReplicaSourceDocumentIdentity, pageCount: number): void {
    this.#reset();
    this.#document = document;
    this.#replayLease += 1;
    this.#pageCount = Math.max(0, Math.floor(pageCount));
    this.#pages = Array.from({ length: this.#pageCount }, () => undefined);
  }

  /** The shown PDF is gone; nothing more is accepted for it. */
  clear(): void {
    this.#reset();
  }

  /**
   * The source language found some other way (the scanned-page probe), used
   * only when the PDF names no language of its own.
   */
  set languageHint(language: string | undefined) {
    const hint = language?.trim();
    const next = hint && hint.length <= MAX_LANGUAGE_LENGTH ? hint : undefined;
    if (next === this.#languageHint) return;
    this.#languageHint = next;
    this.#snapshot = undefined;
  }

  get languageHint(): string | undefined {
    return this.#languageHint;
  }

  /** Scanned pages (0-based): pages whose text read found no text. */
  scannedPages(): number[] {
    return [...this.#scanned.keys()].sort((left, right) => left - right);
  }

  /**
   * Scanned pages still to read: never read, or, with `group`, read in
   * another OCR model group.
   */
  unreadScannedPages(group?: string): number[] {
    const unread: number[] = [];
    for (const [index, readIn] of this.#scanned) {
      if (readIn === undefined || (group !== undefined && readIn !== group)) unread.push(index);
    }
    return unread.sort((left, right) => left - right);
  }

  /**
   * A scanned page's recognised text, read in the OCR model group `group`.
   * It replaces whatever the page held, with new block ids, and goes to the
   * view at once; a page with no text is read all the same. Wakes a run
   * waiting for text.
   */
  setScannedPage(index: number, blocks: readonly PdfTextBlock[], group: string): void {
    if (!this.#document || !this.#scanned.has(index)) return;
    try {
      this.#replacePage(index, blocks);
    } finally {
      // The view's failure does not undo the text.
      this.#scanned.set(index, group);
      this.#wake();
    }
  }

  /**
   * Scanned pages read in another OCR model group than `group` are unread
   * again, and their text and translations leave the view.
   */
  forgetScannedPages(group: string): void {
    for (const [index, readIn] of this.#scanned) {
      if (readIn === undefined || readIn === group) continue;
      this.#scanned.set(index, undefined);
      try {
        this.#replacePage(index, []);
      } catch {
        // The view's failure does not undo it.
      }
    }
  }

  /** Marks a scanned-page reader running; a translation run waits for it. */
  beginReading(): object {
    const token = {};
    this.#reading = token;
    this.#wake();
    return token;
  }

  /** The reader `token` has stopped; a waiting run goes on. */
  endReading(token: object): void {
    if (this.#reading !== token) return;
    this.#reading = undefined;
    this.#wake();
  }

  /** Whether scanned pages are being read, so more text may come. */
  isReading(): boolean {
    return this.#reading !== undefined;
  }

  /**
   * Resolves at the next change a translation run cares about: a scanned
   * page read, reading ended, or the document mounted or cleared. Rejects
   * when `signal` aborts.
   */
  waitForText(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortReason(signal));
        return;
      }
      const abort = () => {
        this.#waiters.delete(wake);
        reject(abortReason(signal));
      };
      const wake = () => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
      this.#waiters.add(wake);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  /** The page (0-based) at the top of the view; translation starts there. */
  set readingPage(index: number) {
    if (Number.isInteger(index) && index >= 0) this.#readingPage = index;
  }

  get readingPage(): number {
    return this.#readingPage;
  }

  hasPage(index: number): boolean {
    return this.#pages[index] !== undefined;
  }

  /**
   * Adds a page's text and hands it to the view. A page already added, or
   * outside the document, is ignored. The view's failure does not undo the
   * text. A page pdf.js found no text on at all is a scanned page, which
   * OCR may read later.
   */
  addPage(page: PdfPageText): void {
    if (!this.#document) return;
    if (!Number.isInteger(page.index) || page.index < 0 || page.index >= this.#pageCount) return;
    if (this.#pages[page.index]) return;
    if (this.#language === undefined && typeof page.language === 'string') {
      const language = page.language.trim();
      if (language.length > 0 && language.length <= MAX_LANGUAGE_LENGTH) {
        this.#language = language;
      }
    }
    if (page.scanned === true && page.blocks.length === 0) {
      this.#scanned.set(page.index, undefined);
    }
    this.#replacePage(page.index, page.blocks);
  }

  snapshot(): ReplicaTranslationSnapshot | undefined {
    const document = this.#document;
    if (!document || !this.#textComplete) return undefined;
    if (!this.#snapshot) {
      const records: ReplicaSourceDomTextRecord[] = [];
      for (const blocks of this.#pages) {
        for (const block of blocks ?? []) {
          const record = this.#records.get(block.id);
          if (record) records.push(record);
        }
      }
      // The PDF's own /Lang wins, unless it is not a language Simul knows.
      const declared = this.#language && canonicalizeLanguageTag(this.#language)
        ? this.#language
        : undefined;
      const hinted = declared === undefined ? this.#languageHint : undefined;
      const language = declared ?? hinted ?? this.#language;
      this.#snapshot = Object.freeze({
        document,
        ...(language ? { documentLanguage: language } : {}),
        ...(hinted ? { documentLanguageSource: 'scanned-pages' as const } : {}),
        replayLease: this.#replayLease,
        records: Object.freeze(records),
      });
    }
    return this.#snapshot;
  }

  beginProjection(context: ReplicaProjectionContext): void {
    this.#context = Object.freeze({ ...context });
    this.#sink.hideTranslations();
  }

  project(projection: ReplicaTextProjection): boolean {
    const document = this.#document;
    const record = this.#records.get(projection.nodeId);
    if (
      !document ||
      !record ||
      projection.nodeType !== 3 ||
      !sameSourceDocument(document, projection.document) ||
      projection.replayLease !== this.#replayLease ||
      projection.translationEpoch !== this.#context.translationEpoch ||
      projection.pairKey === undefined ||
      projection.pairKey !== this.#context.pairKey ||
      projection.sourceRevision !== record.revision ||
      projection.source !== record.source ||
      // An empty translation would only cover the text with nothing.
      projection.translated.trim().length === 0
    ) return false;
    this.#sink.showTranslation(
      projection.nodeId,
      projection.translated,
      targetLanguage(projection.pairKey),
    );
    return true;
  }

  /**
   * Block ids in the order to translate them: the reading page and the pages
   * after it, then the pages before it, nearest first.
   */
  *translationOrder(): Generator<number> {
    const start = Math.min(this.#readingPage, Math.max(0, this.#pageCount - 1));
    for (let index = start; index < this.#pageCount; index += 1) {
      yield* this.#pageIds(index);
    }
    for (let index = start - 1; index >= 0; index -= 1) {
      yield* this.#pageIds(index);
    }
  }

  resolveImageAnchor(): ReplicaImageAnchor | undefined {
    return undefined;
  }

  /** Gives the page `blocks` with new ids, in place of what it held. */
  #replacePage(index: number, blocks: readonly PdfTextBlock[]): void {
    const document = this.#document;
    if (!document) return;
    for (const block of this.#pages[index] ?? []) this.#records.delete(block.id);
    const placed = blocks.map((block): PdfSurfaceBlock => ({ ...block, id: this.#nextId++ }));
    this.#pages[index] = placed;
    for (const block of placed) {
      if (block.text.trim().length === 0) continue;
      this.#records.set(block.id, {
        document,
        nodeId: block.id,
        nodeType: 3,
        revision: 1,
        source: block.text,
      });
    }
    this.#snapshot = undefined;
    this.#sink.setPageText(index, placed);
  }

  #wake(): void {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const wake of waiters) wake();
  }

  *#pageIds(index: number): Generator<number> {
    for (const block of this.#pages[index] ?? []) {
      if (this.#records.has(block.id)) yield block.id;
    }
  }

  #reset(): void {
    this.#document = undefined;
    this.#language = undefined;
    this.#pageCount = 0;
    this.#pages = [];
    this.#records.clear();
    this.#snapshot = undefined;
    this.#textComplete = false;
    this.#readingPage = 0;
    this.#scanned.clear();
    this.#languageHint = undefined;
    this.#reading = undefined;
    this.#wake();
  }
}

function abortReason(signal: AbortSignal): unknown {
  const reason = signal.reason as { name?: unknown } | undefined;
  return reason?.name === 'AbortError'
    ? reason
    : new DOMException('Waiting for the PDF text was cancelled.', 'AbortError');
}

/** The target of a pair key such as `fr>en`. */
function targetLanguage(pairKey: string): string | undefined {
  const target = pairKey.split('>')[1];
  return target && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/u.test(target) ? target : undefined;
}
