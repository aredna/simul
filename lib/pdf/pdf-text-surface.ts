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
   * text.
   */
  addPage(page: PdfPageText): void {
    const document = this.#document;
    if (!document) return;
    if (!Number.isInteger(page.index) || page.index < 0 || page.index >= this.#pageCount) return;
    if (this.#pages[page.index]) return;
    if (this.#language === undefined && typeof page.language === 'string') {
      const language = page.language.trim();
      if (language.length > 0 && language.length <= MAX_LANGUAGE_LENGTH) {
        this.#language = language;
      }
    }
    const blocks = page.blocks.map((block): PdfSurfaceBlock => ({ ...block, id: this.#nextId++ }));
    this.#pages[page.index] = blocks;
    for (const block of blocks) {
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
    this.#sink.setPageText(page.index, blocks);
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
      this.#snapshot = Object.freeze({
        document,
        ...(this.#language ? { documentLanguage: this.#language } : {}),
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
  }
}

/** The target of a pair key such as `fr>en`. */
function targetLanguage(pairKey: string): string | undefined {
  const target = pairKey.split('>')[1];
  return target && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/u.test(target) ? target : undefined;
}
