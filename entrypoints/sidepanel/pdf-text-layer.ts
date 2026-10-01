import {
  sampleBlockColours,
  type PixelRect,
  type RgbaPixels,
} from '../../lib/pdf/colour-sample';
import type { PdfPagePoints } from '../../lib/pdf/pdf-layout';
import {
  MIN_PDF_FIT_SCALE,
  fitStep,
  type FitSize,
  type PdfFontFace,
} from '../../lib/pdf/pdf-overlay-style';
import type { PdfSurfaceBlock } from '../../lib/pdf/pdf-text-surface';
import type { PdfTextRect } from '../../lib/pdf/text-blocks';

/** What a translation needs and has room for, in CSS pixels. */
export interface PdfBlockFit {
  readonly needed: FitSize;
  readonly available: FitSize;
}

/** Measures one translated block; `undefined` when the page has no layout. */
export type PdfBlockMeasure = (
  block: HTMLElement,
  text: HTMLElement,
) => PdfBlockFit | undefined;

// A cover reaches this share of the font size past its line, so antialiased
// glyph edges are covered too.
const COVER_PADDING = 0.12;
// Fitting stops after this many measuring rounds, or once the largest size
// that fits is known to within this share.
export const PDF_FIT_PASSES = 6;
const FIT_PRECISION = 0.03;

interface LayerBlock {
  readonly block: PdfSurfaceBlock;
  /** The height the block's text is laid out in, in points. */
  readonly height: number;
  readonly element: HTMLElement;
  readonly text: HTMLElement;
  covers: HTMLElement[] | undefined;
  translated: boolean;
  fit: number;
  fitted: boolean;
  /** While fitting: the largest scale known to fit, the smallest known not to. */
  fits?: number;
  overflows?: number;
  /** While fitting: this round's measurement. */
  measured?: PdfBlockFit | undefined;
}

/**
 * One page's text, laid over its canvas. Every block holds its source text,
 * transparent, so screen readers read the page; a translated block covers
 * its lines with the page's own background colour and shows the translation
 * in the text's colour, shrinking it to fit. Positions are shares of the
 * page and font sizes follow `--pdf-scale`, so a zoom moves nothing.
 */
export class PdfPageTextLayer {
  readonly element: HTMLElement;
  readonly #page: PdfPagePoints;
  readonly #blocks = new Map<number, LayerBlock>();
  #coloursSampled = false;
  /** The blocks being fitted in the current fitting run. */
  #fitting: LayerBlock[] = [];
  /** The layout scale the translations were last fitted at. */
  fittedAtScale: number | undefined;
  /** Whether the fonts' weight and slant were asked for. */
  fontFacesRequested = false;
  /** Reading the canvas failed; it is tried again after the next draw. */
  colourReadFailed = false;

  constructor(owner: Document, page: PdfPagePoints, blocks: readonly PdfSurfaceBlock[]) {
    this.#page = page;
    this.element = owner.createElement('div');
    this.element.className = 'pdf-text-layer';
    for (const block of blocks) {
      const element = owner.createElement('div');
      element.className = 'pdf-block';
      element.setAttribute('dir', 'auto');
      const box = block.box;
      // Room for every line at the block's own line pitch: the last line's
      // leading lies below the PDF's line box.
      const height = Math.max(box.height, block.lines.length * block.lineHeight * block.fontSize);
      element.style.left = percent(box.left, page.width);
      element.style.top = percent(box.top, page.height);
      element.style.width = percent(box.width, page.width);
      element.style.height = percent(height, page.height);
      element.style.fontFamily = block.fontFamily;
      element.style.lineHeight = String(round(block.lineHeight));
      element.style.textAlign = block.align;
      const text = owner.createElement('div');
      text.className = 'pdf-block-text';
      text.textContent = block.text;
      element.append(text);
      this.element.append(element);
      const entry: LayerBlock = {
        block,
        height,
        element,
        text,
        covers: undefined,
        translated: false,
        fit: 1,
        fitted: true,
      };
      setFontSize(entry);
      this.#blocks.set(block.id, entry);
    }
  }

  get ids(): number[] {
    return [...this.#blocks.keys()];
  }

  get fontIds(): string[] {
    return [...new Set([...this.#blocks.values()].map(({ block }) => block.fontId))];
  }

  get coloursSampled(): boolean {
    return this.#coloursSampled;
  }

  get hasTranslations(): boolean {
    for (const entry of this.#blocks.values()) {
      if (entry.translated) return true;
    }
    return false;
  }

  /** Whether a translation still waits to be fitted. */
  get needsFit(): boolean {
    for (const entry of this.#blocks.values()) {
      if (entry.translated && !entry.fitted) return true;
    }
    return false;
  }

  /** Shows `text` in place of the block's source; `undefined` shows the source again. */
  setTranslation(id: number, text: string | undefined, language?: string): void {
    const entry = this.#blocks.get(id);
    if (!entry) return;
    if (text === undefined) {
      this.#showSource(entry);
      return;
    }
    if (!entry.covers) entry.covers = this.#createCovers(entry);
    entry.text.textContent = text;
    entry.element.classList.add('pdf-block--translated');
    // Unknown is said so: the layer's `lang` is the source language, which
    // a translation must not inherit.
    entry.element.setAttribute('lang', language ?? '');
    entry.translated = true;
    entry.fit = 1;
    entry.fitted = false;
    setFontSize(entry);
  }

  hideTranslations(): void {
    for (const entry of this.#blocks.values()) {
      if (entry.translated) this.#showSource(entry);
    }
  }

  /**
   * Samples every block's background and text colour from the page as drawn,
   * `pixelsPerPoint` pixels to a PDF point.
   */
  applyColours(pixels: RgbaPixels, pixelsPerPoint: number): void {
    if (!(pixelsPerPoint > 0)) return;
    this.#coloursSampled = true;
    for (const entry of this.#blocks.values()) {
      const rects: PixelRect[] = entry.block.lines.map((line) => ({
        left: line.left * pixelsPerPoint,
        top: line.top * pixelsPerPoint,
        width: line.width * pixelsPerPoint,
        height: line.height * pixelsPerPoint,
      }));
      const colours = sampleBlockColours(pixels, rects, {
        ringPadding: COVER_PADDING * entry.block.fontSize * pixelsPerPoint,
      });
      entry.element.style.setProperty('--pdf-cover', colours.background);
      entry.element.style.setProperty('--pdf-ink', colours.ink);
    }
  }

  applyFontFaces(faces: Readonly<Record<string, PdfFontFace>>): void {
    for (const entry of this.#blocks.values()) {
      const face = faces[entry.block.fontId];
      if (!face) continue;
      const weight = face.bold ? '700' : '';
      const style = face.italic ? 'italic' : '';
      if (entry.element.style.fontWeight === weight && entry.element.style.fontStyle === style) continue;
      entry.element.style.fontWeight = weight;
      entry.element.style.fontStyle = style;
      if (entry.translated) {
        entry.fit = 1;
        entry.fitted = false;
        setFontSize(entry);
      }
    }
  }

  /** Starts every translation over at full size, to fit again. */
  resetFit(): void {
    for (const entry of this.#blocks.values()) {
      if (!entry.translated) continue;
      entry.fit = 1;
      entry.fitted = false;
      setFontSize(entry);
    }
  }

  /**
   * Fitting shrinks translations that overflow their block to about the
   * largest size that fits. It runs in rounds so the view can measure every
   * page's blocks before resizing any (`measureFit`, then `applyFit`). The
   * first shrink is estimated from the overflow; later rounds halve the gap
   * between sizes known to fit and not to. A translation that does not fit
   * at the smallest size stops there and overflows. A block that cannot be
   * measured yet (no layout) keeps waiting for a later run.
   * Returns whether any translation is being fitted.
   */
  startFit(layoutScale: number): boolean {
    this.fittedAtScale = layoutScale;
    this.#fitting = [...this.#blocks.values()].filter((entry) => entry.translated && !entry.fitted);
    for (const entry of this.#fitting) {
      entry.fits = undefined;
      entry.overflows = undefined;
      entry.measured = undefined;
    }
    return this.#fitting.length > 0;
  }

  /** Measures every block being fitted; reads layout only. */
  measureFit(measure: PdfBlockMeasure): void {
    for (const entry of this.#fitting) entry.measured = measure(entry.element, entry.text);
  }

  /** Resizes from the measurements; returns whether any block goes on. */
  applyFit(): boolean {
    const next: LayerBlock[] = [];
    for (const entry of this.#fitting) {
      const size = entry.measured;
      entry.measured = undefined;
      // Not laid out: keep what is known, and try again in a later run.
      if (!size) continue;
      const step = fitStep(entry.fit, size.needed, size.available);
      if (step.fits) entry.fits = entry.fit;
      else entry.overflows = entry.fit;
      const scale = step.overflowsAtMinimum ? undefined : this.#nextScale(entry, step.next);
      if (scale === undefined) {
        entry.fit = entry.fits ?? MIN_PDF_FIT_SCALE;
        entry.fitted = true;
      } else {
        entry.fit = scale;
        next.push(entry);
      }
      setFontSize(entry);
    }
    this.#fitting = next;
    return next.length > 0;
  }

  /** Ends a run: a search cut short keeps the largest size known to fit. */
  finishFit(): void {
    for (const entry of this.#fitting) {
      entry.fit = entry.fits ?? entry.fit;
      entry.fitted = true;
      setFontSize(entry);
    }
    this.#fitting = [];
  }

  /** The scale to try next, or `undefined` when the search is done. */
  #nextScale(entry: LayerBlock, estimate: number): number | undefined {
    const { fits, overflows } = entry;
    if (overflows === undefined) return undefined;
    if (fits === undefined) {
      // Nothing fits yet: shrink by the estimate, down to the smallest size.
      if (overflows <= MIN_PDF_FIT_SCALE) return undefined;
      return Math.max(MIN_PDF_FIT_SCALE, Math.min(estimate, overflows - FIT_PRECISION));
    }
    if (overflows - fits <= FIT_PRECISION) return undefined;
    return (fits + overflows) / 2;
  }

  #showSource(entry: LayerBlock): void {
    entry.text.textContent = entry.block.text;
    entry.element.classList.remove('pdf-block--translated');
    entry.element.removeAttribute('lang');
    entry.translated = false;
    entry.fit = 1;
    entry.fitted = true;
    setFontSize(entry);
  }

  /** One cover per line, in shares of the block's element. */
  #createCovers(entry: LayerBlock): HTMLElement[] {
    const { box, lines, fontSize } = entry.block;
    const { height } = entry;
    const owner = entry.element.ownerDocument;
    const padding = COVER_PADDING * fontSize;
    const covers = lines.map((line) => {
      const padded = pad(line, padding);
      const cover = owner.createElement('span');
      cover.className = 'pdf-block-cover';
      cover.setAttribute('aria-hidden', 'true');
      cover.style.left = percent(padded.left - box.left, box.width);
      cover.style.top = percent(padded.top - box.top, height);
      cover.style.width = percent(padded.width, box.width);
      cover.style.height = percent(padded.height, height);
      return cover;
    });
    entry.element.prepend(...covers);
    return covers;
  }
}

function setFontSize(entry: LayerBlock): void {
  entry.element.style.fontSize =
    `calc(var(--pdf-scale, 1) * ${round(entry.block.fontSize * entry.fit)}px)`;
}

function pad(rect: PdfTextRect, padding: number): PdfTextRect {
  return {
    left: rect.left - padding,
    top: rect.top - padding,
    width: rect.width + 2 * padding,
    height: rect.height + 2 * padding,
  };
}

function percent(value: number, whole: number): string {
  return whole > 0 && Number.isFinite(value) ? `${round((value / whole) * 100)}%` : '0%';
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
