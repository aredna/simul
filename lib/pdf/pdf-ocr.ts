import type { SourceImageDescriptor } from '../ocr/contracts';
import {
  AutoImageLanguageProbe,
  autoLanguageProbeDetectedLanguage,
  autoLanguageProbeMinimumConfidence,
  createAutoLanguageProbeSampleIdentity,
  MAX_AUTO_LANGUAGE_PROBE_IMAGES,
  strongAutoLanguageScriptEvidence,
} from '../ocr/auto-language-probe';
import type {
  ImageRecognitionResult,
  ImageRecognitionRoute,
} from '../ocr/image-analysis-coordinator';
import {
  renderImageFilePixels,
  type ImageFileRenderEnvironment,
} from '../ocr/image-file-pixels';
import type { ImageTextProviderId } from '../ocr/known-provider-ids';
import { MAX_OCR_INPUT_PIXELS, type AcquiredImagePixels } from '../ocr/pixel-acquisition';
import {
  TESSERACT_MODEL_VERSION,
  tesseractLanguageGroupFor,
} from '../ocr/providers/tesseract/language-catalog';
import type { OcrMinimumConfidence } from '../ocr/result-quality';
import type { ReplicaSourceDocumentIdentity } from '../replica/source-identity';
import type { SupportedLanguage } from '../translation-provider';
import type { PdfPagePoints } from './pdf-layout';
import { PDF_SCAN_IMAGE_SHARE } from './pdf-scanned-page';
import type { PdfDocumentHandle } from './pdfjs-runtime';
import { pdfOcrBlocks, type PdfTextBlock } from './text-blocks';

/**
 * Reads a scanned PDF page with Simul's local OCR: pdf.js draws the page into
 * a bitmap Simul owns (no screenshot, no image access), and the recognised
 * lines become text blocks like the ones pdf.js reports for text pages.
 */

/** OCR reads a page drawn at no more than this many dots per inch. */
export const PDF_OCR_MAX_DPI = 300;
/**
 * How long checking a page for images and drawing and encoding it may take;
 * a slower page is unreadable. Recognition itself is bounded by the OCR
 * host's own time limits (30 s a page for Tesseract, 60 s to start it).
 */
export const PDF_OCR_PAGE_TIMEOUT_MS = 60_000;
/**
 * The weight budget of the PDF's recognition cache. A page's result carries
 * its words (D121), which the cache counts as it counts regions: a dense
 * page of 500 words weighs about 26,000, where it weighed 7,500 without
 * them. Under the default budget of 1,000,000 that is 38 pages, and a PDF
 * one page longer than the cache holds is read again in full on Refresh,
 * because pages are read in order and the oldest is dropped. With this
 * budget the cache's 128-entry limit decides, as it did before.
 */
export const PDF_RECOGNITION_CACHE_WEIGHT = 4_000_000;
/** A busy OCR host is asked once more after this long. */
export const PDF_OCR_RETRY_DELAY_MS = 500;
const MAX_DETECTION_SAMPLE = 4_000;

/** The canvas pdf.js draws a page into for OCR; an OffscreenCanvas in Chrome. */
export interface PdfOcrCanvas {
  width: number;
  height: number;
}

export interface PdfOcrEnvironment {
  readonly createCanvas: () => PdfOcrCanvas;
  readonly render: ImageFileRenderEnvironment;
  readonly recognize: (
    pixels: AcquiredImagePixels,
    route: ImageRecognitionRoute,
    signal: AbortSignal,
  ) => Promise<ImageRecognitionResult>;
  readonly detectLanguage?: (
    text: string,
  ) => Promise<{
    readonly isReliable: boolean;
    readonly languages: readonly { readonly language: string; readonly percentage: number }[];
  }>;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /** Tests shorten `PDF_OCR_PAGE_TIMEOUT_MS`. */
  readonly pageTimeoutMs?: number;
}

/** The part of the PDF document OCR draws with. */
export type PdfOcrDocument = Pick<
  PdfDocumentHandle,
  'hasImages' | 'imageCoverage' | 'render' | 'releasePage'
>;

export type PdfOcrRouteResult =
  | {
      readonly status: 'ready';
      readonly route: ImageRecognitionRoute;
      /** The Tesseract model group the page is read in. */
      readonly group: string;
    }
  | { readonly status: 'no-method' | 'unsupported' };

/**
 * Whether scanned pages can be read with these methods. Tesseract is needed:
 * Chrome's TextDetector reports no confidence, so on its own nothing it
 * reads passes the quality filter.
 */
export function canReadScannedPages(providerOrder: readonly ImageTextProviderId[]): boolean {
  return providerOrder.includes('tesseract');
}

/** How scanned pages in `language` are read, if they can be. */
export function pdfOcrRoute(
  language: SupportedLanguage,
  providerOrder: readonly ImageTextProviderId[],
  minimumConfidence: OcrMinimumConfidence,
): PdfOcrRouteResult {
  if (!canReadScannedPages(providerOrder)) return { status: 'no-method' };
  const group = tesseractLanguageGroupFor(language);
  if (!group) return { status: 'unsupported' };
  return {
    status: 'ready',
    group,
    route: Object.freeze({
      providerOrder: Object.freeze([...providerOrder]),
      sourceLanguage: language,
      languageGroup: group,
      modelVersion: TESSERACT_MODEL_VERSION,
      minimumConfidence,
      // A page with typed text cuts a recognised line by its words (D121).
      words: true,
    }),
  };
}

export type PdfScannedPageResult =
  | { readonly status: 'read'; readonly blocks: readonly PdfTextBlock[] }
  /** The page paints no image: there is nothing to read. */
  | { readonly status: 'no-image' }
  /**
   * The page could not be checked, drawn or encoded (in time): reading it
   * again would fail again.
   */
  | { readonly status: 'unreadable' }
  /** Recognition failed; another run may read it. */
  | { readonly status: 'failed' };

export interface PdfScannedPageRequest {
  /** 0-based. */
  readonly index: number;
  readonly size: PdfPagePoints;
  readonly document: ReplicaSourceDocumentIdentity;
  readonly route: ImageRecognitionRoute;
  /**
   * The page's own typed text (a header or a stamp over the scan): OCR lines
   * that only repeat it are left out.
   */
  readonly typed?: readonly PdfTextBlock[];
  /** `isScannedPage` just said the page is a scan: its images are not checked again. */
  readonly confirmed?: boolean;
}

/**
 * Reads one page. Rejects only with an `AbortError`; anything else that goes
 * wrong is an unreadable page (before recognition) or a failed page
 * (recognition), which stays as drawn.
 */
export async function readScannedPage(
  document: PdfOcrDocument,
  request: PdfScannedPageRequest,
  environment: PdfOcrEnvironment,
  signal: AbortSignal,
): Promise<PdfScannedPageResult> {
  const pageNumber = request.index + 1;
  let pixels: AcquiredImagePixels | undefined;
  try {
    signal.throwIfAborted();
    const drawn = await withinPageDeadline(async (bounded) => {
      if (request.confirmed !== true && !(await document.hasImages(pageNumber))) {
        return 'no-image' as const;
      }
      bounded.throwIfAborted();
      return drawPage(document, request, environment, bounded);
    }, environment, signal);
    if (drawn === 'no-image') return { status: 'no-image' };
    if (!drawn) return { status: 'unreadable' };
    pixels = drawn;
  } catch {
    if (signal.aborted) throw abortError(signal);
    return { status: 'unreadable' };
  } finally {
    if (!pixels) void document.releasePage(pageNumber).catch(() => undefined);
  }
  try {
    let recognition = await environment.recognize(pixels, request.route, signal);
    if (recognition.status === 'failed' && recognition.code === 'host-overflow') {
      await (environment.wait ?? wait)(PDF_OCR_RETRY_DELAY_MS, signal);
      recognition = await environment.recognize(pixels, request.route, signal);
    }
    signal.throwIfAborted();
    if (recognition.status !== 'complete') return { status: 'failed' };
    const { result } = recognition;
    return {
      status: 'read',
      blocks: pdfOcrBlocks(
        result.regions,
        // The regions are in pixels of the bitmap OCR read.
        result.bitmapWidth / request.size.width,
        request.size.width,
        (request.typed ?? []).flatMap((block) => block.lines),
      ),
    };
  } catch {
    // Only this reading's own signal stops it; anything else (a cleared
    // recognition cache included) fails just this page.
    if (signal.aborted) throw abortError(signal);
    return { status: 'failed' };
  } finally {
    void document.releasePage(pageNumber).catch(() => undefined);
  }
}

/**
 * Whether a page with a little text is a scan: its pictures cover
 * `PDF_SCAN_IMAGE_SHARE` of it. Not when that cannot be told in time.
 * Rejects only with an `AbortError`.
 */
export async function isScannedPage(
  document: PdfOcrDocument,
  index: number,
  environment: PdfOcrEnvironment,
  signal: AbortSignal,
): Promise<boolean> {
  const pageNumber = index + 1;
  try {
    signal.throwIfAborted();
    return await withinPageDeadline(() => coversPage(document, pageNumber), environment, signal);
  } catch {
    if (signal.aborted) throw abortError(signal);
    return false;
  } finally {
    // pdf.js decoded the page's pictures for the check.
    void document.releasePage(pageNumber).catch(() => undefined);
  }
}

/** Whether the page's pictures cover most of it; not when it cannot be told. */
async function coversPage(document: PdfOcrDocument, pageNumber: number): Promise<boolean> {
  try {
    return (await document.imageCoverage(pageNumber)) >= PDF_SCAN_IMAGE_SHARE;
  } catch {
    return false;
  }
}

/**
 * Runs `task` with a signal that also ends after `PDF_OCR_PAGE_TIMEOUT_MS`.
 * pdf.js does not stop checking a page for images on a signal, so the
 * deadline rejects at once instead of waiting for it.
 */
async function withinPageDeadline<T>(
  task: (signal: AbortSignal) => Promise<T>,
  environment: PdfOcrEnvironment,
  signal: AbortSignal,
): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new DOMException('The page took too long.', 'TimeoutError')),
    environment.pageTimeoutMs ?? PDF_OCR_PAGE_TIMEOUT_MS,
  );
  const bounded = AbortSignal.any([signal, deadline.signal]);
  try {
    return await new Promise<T>((resolve, reject) => {
      const stop = () => reject(bounded.reason);
      if (bounded.aborted) {
        stop();
        return;
      }
      bounded.addEventListener('abort', stop, { once: true });
      task(bounded).then(resolve, reject).finally(() => bounded.removeEventListener('abort', stop));
    });
  } finally {
    clearTimeout(timer);
  }
}

export interface PdfLanguageProbeRequest {
  /** Candidate pages, the reading page first; at most three are drawn. */
  readonly pages: readonly { readonly index: number; readonly size: PdfPagePoints }[];
  readonly document: ReplicaSourceDocumentIdentity;
  readonly providerOrder: readonly ImageTextProviderId[];
  readonly minimumConfidence: OcrMinimumConfidence;
}

/**
 * Finds the language of a scanned PDF with the image language probe: each
 * page is read in the probe's representative routes until one page shows a
 * strong script or two pages agree, within the probe's attempt and time
 * budgets. `undefined` when it cannot tell.
 */
export async function probeScannedLanguage(
  document: PdfOcrDocument,
  request: PdfLanguageProbeRequest,
  environment: PdfOcrEnvironment,
  signal: AbortSignal,
): Promise<SupportedLanguage | undefined> {
  if (!canReadScannedPages(request.providerOrder)) return undefined;
  const now = environment.now ?? (() => Date.now());
  const minimumConfidence = autoLanguageProbeMinimumConfidence(request.minimumConfidence);
  const probe = new AutoImageLanguageProbe(now(), minimumConfidence);
  // The probe's time budget ends a drawing or recognition in progress too.
  const budget = new AbortController();
  const timer = setTimeout(
    () => budget.abort(new DOMException('The language probe ran out of time.', 'TimeoutError')),
    Math.max(0, probe.remainingMs(now())),
  );
  const bounded = AbortSignal.any([signal, budget.signal]);
  const outOfTime = () => budget.signal.aborted || probe.remainingMs(now()) <= 0;
  let drawn = 0;
  try {
    for (const page of request.pages) {
      if (drawn >= MAX_AUTO_LANGUAGE_PROBE_IMAGES || outOfTime()) break;
      signal.throwIfAborted();
      const pageNumber = page.index + 1;
      let pixels: AcquiredImagePixels | undefined;
      try {
        pixels = await withinPageDeadline(async (pageSignal) => {
          if (!(await document.hasImages(pageNumber))) return undefined;
          pageSignal.throwIfAborted();
          return drawPage(document, { ...page, document: request.document }, environment, pageSignal);
        }, environment, bounded);
      } catch {
        if (signal.aborted) throw abortError(signal);
        continue;
      } finally {
        void document.releasePage(pageNumber).catch(() => undefined);
      }
      if (!pixels) continue;
      drawn += 1;
      const sample = createAutoLanguageProbeSampleIdentity();
      for (const language of probe.candidateLanguages(sample, pixels.pixelHash)) {
        signal.throwIfAborted();
        if (outOfTime()) break;
        if (!probe.beginAttempt(sample, pixels.pixelHash, language, now())) continue;
        const group = tesseractLanguageGroupFor(language);
        const route: ImageRecognitionRoute = {
          providerOrder: request.providerOrder,
          sourceLanguage: language,
          minimumConfidence,
          ...(group ? { languageGroup: group, modelVersion: TESSERACT_MODEL_VERSION } : {}),
          // As the page read asks, so one recognition serves both.
          words: true,
        };
        let recognition: ImageRecognitionResult;
        try {
          recognition = await environment.recognize(pixels, route, bounded);
          if (recognition.status === 'failed' && recognition.code === 'host-overflow') {
            await (environment.wait ?? wait)(PDF_OCR_RETRY_DELAY_MS, bounded);
            recognition = await environment.recognize(pixels, route, bounded);
          }
        } catch {
          probe.rollbackAttempt(sample, pixels.pixelHash, language);
          if (signal.aborted) throw abortError(signal);
          if (outOfTime()) break;
          continue;
        }
        // A result that comes after the budget no longer counts.
        if (outOfTime()) {
          probe.rollbackAttempt(sample, pixels.pixelHash, language);
          break;
        }
        if (recognition.status !== 'complete' || recognition.result.regions.length === 0) {
          probe.completeAttempt(sample, pixels.pixelHash, language);
          continue;
        }
        const { transcript, transcriptConfidence } = recognition.result;
        const detectedLanguage = strongAutoLanguageScriptEvidence(transcript)
          ? undefined
          : await detectTranscriptLanguage(transcript, environment, signal);
        signal.throwIfAborted();
        const observed = probe.observe({
          sampleIdentity: sample,
          pixelHash: pixels.pixelHash,
          routeLanguage: language,
          transcript,
          ...(transcriptConfidence !== undefined ? { confidence: transcriptConfidence } : {}),
          ...(detectedLanguage ? { detectedLanguage } : {}),
        });
        if (observed.status === 'resolved') return observed.language;
      }
    }
    return probe.resolvedLanguage;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Draws the page at no more than 4 MP and 300 dpi and encodes it for the OCR
 * host. The page number is the image's node id in the PDF's document.
 */
async function drawPage(
  document: PdfOcrDocument,
  request: Omit<PdfScannedPageRequest, 'route'>,
  environment: PdfOcrEnvironment,
  signal: AbortSignal,
): Promise<AcquiredImagePixels | undefined> {
  const { width, height } = request.size;
  if (!(width > 0) || !(height > 0)) return undefined;
  const scale = Math.min(
    Math.sqrt(MAX_OCR_INPUT_PIXELS / (width * height)),
    PDF_OCR_MAX_DPI / 72,
  );
  const canvas = environment.createCanvas();
  try {
    await document.render(
      request.index + 1,
      canvas as unknown as OffscreenCanvas,
      scale,
      signal,
    );
    signal.throwIfAborted();
    const drawnWidth = canvas.width;
    const drawnHeight = canvas.height;
    const rendered = await renderImageFilePixels(
      canvas as unknown as CanvasImageSource,
      drawnWidth,
      drawnHeight,
      {
        sourceX: 0,
        sourceY: 0,
        sourceWidth: 1,
        sourceHeight: 1,
        destX: 0,
        destY: 0,
        destWidth: drawnWidth,
        destHeight: drawnHeight,
        boxWidth: drawnWidth,
        boxHeight: drawnHeight,
      },
      environment.render,
      MAX_OCR_INPUT_PIXELS,
      signal,
    );
    if (!rendered) return undefined;
    const descriptor: SourceImageDescriptor = Object.freeze({
      document: request.document,
      nodeId: request.index + 1,
      sourceKind: 'img',
      contentRevision: 1,
      observationRevision: 1,
      visibility: 'visible',
      connected: true,
      renderedWidth: drawnWidth,
      renderedHeight: drawnHeight,
    });
    return Object.freeze({ ...rendered, descriptor });
  } finally {
    // The drawing is encoded; its memory goes back at once.
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function detectTranscriptLanguage(
  transcript: string,
  environment: PdfOcrEnvironment,
  signal: AbortSignal,
): Promise<SupportedLanguage | undefined> {
  const sample = transcript.replace(/\s+/gu, ' ').trim().slice(0, MAX_DETECTION_SAMPLE);
  if (!environment.detectLanguage || sample.length < 3) return undefined;
  try {
    return autoLanguageProbeDetectedLanguage(await environment.detectLanguage(sample));
  } catch {
    signal.throwIfAborted();
    return undefined;
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function abortError(signal: AbortSignal): DOMException {
  const reason = signal.reason as { name?: unknown } | undefined;
  return reason instanceof DOMException && reason.name === 'AbortError'
    ? reason
    : new DOMException('Reading the scanned page was cancelled.', 'AbortError');
}
