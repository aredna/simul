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
  /**
   * The page's own text covers little of it: it may be a scan under a
   * header, a page number or a stamp, which only its pictures tell. It
   * counts as a scanned page still to read until they are checked.
   */
  readonly littleText?: boolean;
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
   * Scanned pages, with the OCR model group they were read in; `undefined`
   * while unread.
   */
  readonly #scanned = new Map<number, string | undefined>();
  /** The typed text of scanned pages that have some: it stays whatever OCR adds. */
  readonly #typed = new Map<number, readonly PdfSurfaceBlock[]>();
  /** Pages with a little text whose pictures were not checked yet. */
  readonly #unconfirmed = new Set<number>();
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

  /** Scanned pages (0-based), read or not, with those not yet confirmed. */
  scannedPages(): number[] {
    return [...this.#scanned.keys()].sort((left, right) => left - right);
  }

  /**
   * Scanned pages still to read: never read, or, with `group`, read in
   * another OCR model group. Pages not yet confirmed are among them.
   */
  unreadScannedPages(group?: string): number[] {
    const unread: number[] = [];
    for (const [index, readIn] of this.#scanned) {
      if (readIn === undefined || (group !== undefined && readIn !== group)) unread.push(index);
    }
    return unread.sort((left, right) => left - right);
  }

  /**
   * Whether the page is taken for a scan only because it has little text:
   * its pictures were not checked yet.
   */
  isUnconfirmedScan(index: number): boolean {
    return this.#unconfirmed.has(index);
  }

  /** The page's pictures cover most of it: it is a scanned page. */
  confirmScannedPage(index: number): void {
    this.#unconfirmed.delete(index);
  }

  /**
   * The page with a little text is not a scan after all: a text page, as it
   * stands. Wakes a run waiting for text.
   */
  dismissScannedPage(index: number): void {
    if (!this.#unconfirmed.delete(index)) return;
    this.#scanned.delete(index);
    this.#typed.delete(index);
    this.#wake();
  }

  /** A scanned page's own typed text, which a reading leaves out; else none. */
  typedText(index: number): readonly PdfTextBlock[] {
    return this.#typed.get(index) ?? [];
  }

  /**
   * Whether the PDF's only text is on scanned pages (confirmed or not), such
   * as stamps over scans: text that does not name the language of the scans.
   */
  get textOnScannedPagesOnly(): boolean {
    if (this.#records.size === 0) return false;
    return this.#pages.every((blocks, index) =>
      !blocks || blocks.length === 0 || this.#scanned.has(index));
  }

  /**
   * A scanned page's recognised text, read in the OCR model group `group`.
   * It replaces what an earlier reading gave the page, with new block ids;
   * the page's typed text stays, with its ids. It goes to the view at once;
   * a page with no text is read all the same. Wakes a run waiting for text.
   */
  setScannedPage(index: number, blocks: readonly PdfTextBlock[], group: string): void {
    if (!this.#document || !this.#scanned.has(index)) return;
    // Read: a scan, whatever was known of its pictures.
    this.#unconfirmed.delete(index);
    try {
      this.#replacePage(index, blocks, this.#typed.get(index));
    } finally {
      // The view's failure does not undo the text.
      this.#scanned.set(index, group);
      this.#wake();
    }
  }

  /**
   * Scanned pages read in another OCR model group than `group` are unread
   * again, and their recognised text and its translations leave the view.
   * Their typed text stays.
   */
  forgetScannedPages(group: string): void {
    for (const [index, readIn] of this.#scanned) {
      if (readIn === undefined || readIn === group) continue;
      this.#scanned.set(index, undefined);
      try {
        this.#replacePage(index, [], this.#typed.get(index));
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
   * text. A scanned page (no text at all, or perhaps a little typed text
   * over a scan) may be read by OCR later; its typed text is kept through
   * that.
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
    const perhaps = page.scanned !== true && page.littleText === true;
    if (page.scanned === true || perhaps) this.#scanned.set(page.index, undefined);
    if (perhaps) this.#unconfirmed.add(page.index);
    try {
      this.#replacePage(page.index, page.blocks);
    } finally {
      const placed = this.#pages[page.index];
      if (this.#scanned.has(page.index) && placed && placed.length > 0) {
        this.#typed.set(page.index, placed);
      }
    }
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

  /**
   * Gives the page `blocks` with new ids, in place of what it held. Blocks
   * in `kept` (the page's typed text) stay as they are, ids and records
   * included, each before the first new block that starts below it.
   */
  #replacePage(
    index: number,
    blocks: readonly PdfTextBlock[],
    kept: readonly PdfSurfaceBlock[] = [],
  ): void {
    const document = this.#document;
    if (!document) return;
    const keptIds = new Set(kept.map((block) => block.id));
    for (const block of this.#pages[index] ?? []) {
      if (!keptIds.has(block.id)) this.#records.delete(block.id);
    }
    const placed = blocks.map((block): PdfSurfaceBlock => ({ ...block, id: this.#nextId++ }));
    this.#pages[index] = mergeByHeight(kept, placed);
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
    this.#sink.setPageText(index, this.#pages[index]!);
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
    this.#typed.clear();
    this.#unconfirmed.clear();
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

/**
 * `read` in its own order, with each block of `kept` before the first block
 * of `read` that starts at or below it, else at the end. Blocks of `kept`
 * that land together keep their own order.
 */
function mergeByHeight(
  kept: readonly PdfSurfaceBlock[],
  read: readonly PdfSurfaceBlock[],
): PdfSurfaceBlock[] {
  const before = new Map<number, PdfSurfaceBlock[]>();
  for (const block of kept) {
    const below = read.findIndex((other) => other.box.top >= block.box.top);
    const at = below < 0 ? read.length : below;
    const together = before.get(at);
    if (together) together.push(block);
    else before.set(at, [block]);
  }
  const merged: PdfSurfaceBlock[] = [];
  for (let index = 0; index <= read.length; index += 1) {
    merged.push(...(before.get(index) ?? []));
    if (index < read.length) merged.push(read[index]!);
  }
  return merged;
}
