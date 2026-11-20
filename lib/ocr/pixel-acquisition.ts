import type { SourceImageDescriptor } from './contracts';
import type { SupportedLanguage } from '../translation-provider';
import type { ImageSourceLease } from './image-source-client';
import {
  sameImageCaptureMetrics,
  type SourceImageCaptureMetrics,
} from './image-source-protocol';
import {
  selectOcrPreprocessingPlan,
  type OcrPreprocessingVersion,
} from './preprocessing-profile';
import {
  createBrowserImageFilePixelReaderEnvironment,
  readImageFilePixels,
  type BrowserImageFilePixelOptions,
  type ImageFilePixelSource,
  type ImageFilePixels,
} from './image-file-pixel-reader';
import { settle } from '../settle';

export const MAX_CAPTURE_RATE_PER_SECOND = 2;
/** Stay below Chrome's documented two-captures-per-second ceiling. */
export const MIN_CAPTURE_INTERVAL_MS = 550;
export const MAX_OCR_INPUT_PIXELS = 4_000_000;
export const MAX_SCREENSHOT_BYTES = 32 * 1024 * 1024;
export const IMAGE_CAPTURE_LOCK_NAME = 'simul:ocr-visible-tab-capture-v1';
/**
 * How long an image the view cuts off, and that would fit in the view whole,
 * has to stay where it is before its visible strip is captured (D165). The
 * reader who scrolls on brings it into view whole, and only a whole read is
 * kept for the next time it comes into view; the reader who stops with it
 * half in view still gets that half read, a moment later. Measured on a page
 * scrolled 300 px at a time with two seconds between steps: a one-second
 * wait still read every strip first, and this one reads none of them.
 */
export const CLIPPED_IMAGE_QUIET_MS = 2_500;
/** Images whose clipped position is remembered at once (oldest go first). */
const MAX_CLIPPED_IMAGE_WAITS = 256;
const MIN_OCR_BITMAP_AXIS_PX = 3;

export interface AcquiredImagePixels {
  readonly descriptor: SourceImageDescriptor;
  readonly pixelHash: string;
  readonly encoded: Blob;
  readonly bitmapWidth: number;
  readonly bitmapHeight: number;
  readonly preprocessingVersion: OcrPreprocessingVersion;
  readonly cropOffsetXCss: number;
  readonly cropOffsetYCss: number;
  readonly cropWidthCss: number;
  readonly cropHeightCss: number;
  readonly renderedWidthCss: number;
  readonly renderedHeightCss: number;
  readonly nearestElementLanguage?: SupportedLanguage;
  /** Absent means the viewport screenshot. */
  readonly pixelSource?: ImageFilePixelSource;
  /**
   * For a screenshot: how long before these pixels were handed over it was
   * asked for (the time Chrome took to make it, and the second rectangle
   * and the crop after it).
   */
  readonly screenshotAgeMs?: number;
}

export type PixelAcquisitionResult =
  | { readonly status: 'ready'; readonly pixels: AcquiredImagePixels }
  | {
      readonly status: 'deferred';
      readonly reason: Exclude<PixelAcquisitionDeferralReason, 'clipped'>;
    }
  | {
      readonly status: 'deferred';
      readonly reason: 'clipped';
      /** When the image, still where it is, will have waited long enough. */
      readonly retryAfterMs: number;
    };

export type PixelAcquisitionDeferralReason =
  | 'hidden'
  /** Cut off by the view, would fit whole, and not still for long (D165). */
  | 'clipped'
  | 'unstable'
  | 'oversized'
  | 'too-small-visible'
  | 'inactive'
  | 'permission'
  | 'quota'
  | 'api'
  | 'data'
  | 'decode'
  | 'surface'
  | 'encode'
  | 'digest';

export type SourceTabCaptureFailureCode = Extract<
  PixelAcquisitionDeferralReason,
  'inactive' | 'permission' | 'quota' | 'api'
>;

/** Content-free error boundary between Chrome capture and OCR orchestration. */
export class SourceTabCaptureError extends Error {
  override readonly name = 'SourceTabCaptureError';

  constructor(readonly code: SourceTabCaptureFailureCode) {
    super('Visible tab capture was unavailable.');
  }
}

interface DecodedBitmap {
  readonly width: number;
  readonly height: number;
  close(): void;
}

interface CropSurface {
  readonly width: number;
  readonly height: number;
  getContext(contextId: '2d'): {
    drawImage(
      image: CanvasImageSource,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
    ): void;
  } | null;
  convertToBlob(options: { readonly type: 'image/png' }): Promise<Blob>;
}

export interface PixelAcquisitionEnvironment {
  readonly source: ImageSourceLease;
  readonly captureVisibleTab: (signal?: AbortSignal) => Promise<string>;
  readonly decode: (blob: Blob) => Promise<DecodedBitmap>;
  readonly createSurface: (width: number, height: number) => CropSurface;
  readonly digest: (bytes: ArrayBuffer) => Promise<ArrayBuffer>;
  readonly now?: () => number;
  readonly delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Reads an image from its file when the screenshot cannot: the image is
   * off screen, moving, clipped, or the source tab is not the active tab.
   */
  readonly readFilePixels?: (
    descriptor: SourceImageDescriptor,
    signal?: AbortSignal,
  ) => Promise<ImageFilePixels | undefined>;
  /**
   * How long an image the view cuts off, and that would fit in it whole,
   * must stay put before its strip is captured (D165). Absent or 0 captures
   * the strip at once; the side panel's environment sets
   * `CLIPPED_IMAGE_QUIET_MS`.
   */
  readonly clippedImageQuietMs?: number;
}

/**
 * Screenshot deferrals that reading the image's own file can resolve. A
 * clipped image read from its file is read whole, at once (D165).
 */
const FILE_PIXEL_FALLBACK_REASONS: ReadonlySet<PixelAcquisitionDeferralReason> =
  new Set(['hidden', 'unstable', 'too-small-visible', 'inactive', 'clipped']);

export interface SourceTabCaptureEnvironment {
  readonly queryActiveTab: (windowId: number) => Promise<number | undefined>;
  readonly captureVisibleTab: (windowId: number) => Promise<string>;
  readonly withGlobalLock: <T>(callback: () => Promise<T>) => Promise<T>;
  readonly now: () => number;
  readonly delay: (milliseconds: number) => Promise<void>;
}

/** Serialized viewport capture with strict pre/post geometry validation. */
export class PixelAcquisitionCoordinator {
  readonly #now: () => number;
  readonly #delay: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly #clippedImageQuietMs: number;
  /** Where each clipped image was first measured, and when (D165). */
  readonly #clippedWaits = new Map<string, {
    readonly geometry: string;
    readonly since: number;
  }>();
  #lastCaptureAt = Number.NEGATIVE_INFINITY;
  #lane: Promise<void> = Promise.resolve();

  constructor(private readonly environment: PixelAcquisitionEnvironment) {
    this.#now = environment.now ?? (() => performance.now());
    this.#delay = environment.delay ?? abortableDelay;
    const quiet = environment.clippedImageQuietMs ?? 0;
    this.#clippedImageQuietMs = Number.isFinite(quiet) && quiet > 0 ? quiet : 0;
  }

  acquire(
    descriptor: SourceImageDescriptor,
    signal?: AbortSignal,
  ): Promise<PixelAcquisitionResult> {
    const previous = this.#lane;
    const { promise: lane, resolve: release } = Promise.withResolvers<void>();
    this.#lane = lane;
    return (async () => {
      try {
        // After the previous acquisition, whether it worked or not.
        await settle(previous);
        return await this.#acquire(descriptor, signal);
      } finally {
        release();
      }
    })();
  }

  async #acquire(
    descriptor: SourceImageDescriptor,
    signal?: AbortSignal,
  ): Promise<PixelAcquisitionResult> {
    const screenshot = await this.#acquireScreenshot(descriptor, signal);
    if (
      screenshot.status === 'ready' ||
      !this.environment.readFilePixels ||
      !FILE_PIXEL_FALLBACK_REASONS.has(screenshot.reason)
    ) return screenshot;
    signal?.throwIfAborted();
    let file: ImageFilePixels | undefined;
    try {
      file = await this.environment.readFilePixels(descriptor, signal);
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      file = undefined;
    }
    if (!file) return screenshot;
    return {
      status: 'ready',
      pixels: Object.freeze({
        descriptor,
        pixelHash: file.pixelHash,
        encoded: file.encoded,
        bitmapWidth: file.bitmapWidth,
        bitmapHeight: file.bitmapHeight,
        preprocessingVersion: file.preprocessingVersion,
        cropOffsetXCss: file.cropOffsetXCss,
        cropOffsetYCss: file.cropOffsetYCss,
        cropWidthCss: file.cropWidthCss,
        cropHeightCss: file.cropHeightCss,
        renderedWidthCss: file.renderedWidthCss,
        renderedHeightCss: file.renderedHeightCss,
        pixelSource: file.source,
        ...(file.nearestElementLanguage
          ? { nearestElementLanguage: file.nearestElementLanguage }
          : {}),
      }),
    };
  }

  async #acquireScreenshot(
    descriptor: SourceImageDescriptor,
    signal?: AbortSignal,
  ): Promise<PixelAcquisitionResult> {
    signal?.throwIfAborted();
    const before = await this.environment.source.measure(descriptor, signal);
    if (!before) return { status: 'deferred', reason: 'hidden' };
    const clipped = this.#clippedWait(descriptor, before);
    if (clipped) return clipped;
    const wait = MIN_CAPTURE_INTERVAL_MS - (this.#now() - this.#lastCaptureAt);
    if (wait > 0) await this.#delay(wait, signal);
    signal?.throwIfAborted();
    let screenshotUrl: string;
    const askedAt = this.#now();
    try {
      this.#lastCaptureAt = askedAt;
      screenshotUrl = await this.environment.captureVisibleTab(signal);
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      return {
        status: 'deferred',
        reason: error instanceof SourceTabCaptureError ? error.code : 'api',
      };
    }
    signal?.throwIfAborted();
    const after = await this.environment.source.measure(descriptor, signal);
    if (!after || !sameImageCaptureMetrics(before, after)) {
      return { status: 'deferred', reason: 'unstable' };
    }
    const cropped = await this.#crop(descriptor, before, screenshotUrl, signal);
    if (cropped.status !== 'ready') return cropped;
    // The capture window is [before, after]: nothing measured after the
    // screenshot can see what its pixels contained. This third measure only
    // closes the after-measure-to-crop window (geometry drift, a page that
    // stops admitting the image while the crop decodes, pixel-to-revision
    // attribution). A credential field that appears and leaves again strictly
    // inside the before/after window is not observable here and would need
    // per-frame DOM sampling.
    //
    // Cost: one extra full safety measure per accepted crop: a port round trip
    // plus the session's document-wide overlap scan and style reads, roughly
    // half again the measure work of a capture and a longer hold of the
    // capture lane. There is no cheap change signal to skip it when nothing
    // has changed since the after-measure, so the check stays.
    const confirmed = await this.environment.source.measure(descriptor, signal);
    if (!confirmed || !sameImageCaptureMetrics(after, confirmed)) {
      return { status: 'deferred', reason: 'unstable' };
    }
    return {
      status: 'ready',
      pixels: Object.freeze({
        ...cropped.pixels,
        screenshotAgeMs: Math.max(0, this.#now() - askedAt),
      }),
    };
  }

  /**
   * D165. An image the view cuts off but could show whole is not captured
   * until it has stayed where it is for `clippedImageQuietMs`. While the
   * reader scrolls, the images wholly in view are read first and this one is
   * read whole once the scroll brings it in; a strip read first would be
   * read again then, since only a whole read is kept for the image. Its place
   * is the measured rectangle, so any scroll, resize or zoom starts the wait
   * again. An image larger than the view is never seen whole: its strip is
   * all the reader sees, and it is captured at once as before.
   */
  #clippedWait(
    descriptor: SourceImageDescriptor,
    metrics: SourceImageCaptureMetrics,
  ): PixelAcquisitionResult | undefined {
    if (this.#clippedImageQuietMs <= 0) return undefined;
    const key = clippedWaitKey(descriptor);
    if (!clippedButFitsView(metrics)) {
      this.#clippedWaits.delete(key);
      return undefined;
    }
    const geometry = [
      metrics.left,
      metrics.top,
      metrics.width,
      metrics.height,
      metrics.viewportWidth,
      metrics.viewportHeight,
      metrics.scrollX,
      metrics.scrollY,
      metrics.devicePixelRatio,
    ].join(',');
    const now = this.#now();
    const known = this.#clippedWaits.get(key);
    if (known?.geometry === geometry) {
      const remaining = known.since + this.#clippedImageQuietMs - now;
      // Kept after the wait: a capture that fails for another reason and is
      // tried again at the same place does not wait a second time.
      if (remaining <= 0) return undefined;
      return { status: 'deferred', reason: 'clipped', retryAfterMs: remaining };
    }
    this.#clippedWaits.delete(key);
    if (this.#clippedWaits.size >= MAX_CLIPPED_IMAGE_WAITS) {
      const oldest = this.#clippedWaits.keys().next().value;
      if (oldest !== undefined) this.#clippedWaits.delete(oldest);
    }
    this.#clippedWaits.set(key, { geometry, since: now });
    return {
      status: 'deferred',
      reason: 'clipped',
      retryAfterMs: this.#clippedImageQuietMs,
    };
  }

  async #crop(
    descriptor: SourceImageDescriptor,
    metrics: SourceImageCaptureMetrics,
    screenshotUrl: string,
    signal?: AbortSignal,
  ): Promise<PixelAcquisitionResult> {
    let screenshotBlob: Blob;
    try {
      screenshotBlob = await dataUrlToBlob(screenshotUrl);
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      return { status: 'deferred', reason: 'data' };
    }
    if (screenshotBlob.size < 1 || screenshotBlob.size > MAX_SCREENSHOT_BYTES) {
      return { status: 'deferred', reason: 'oversized' };
    }
    signal?.throwIfAborted();
    let bitmap: DecodedBitmap | undefined;
    try {
      bitmap = await this.environment.decode(screenshotBlob);
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      return { status: 'deferred', reason: 'decode' };
    }
    try {
      const scaleX = bitmap.width / metrics.viewportWidth;
      const scaleY = bitmap.height / metrics.viewportHeight;
      if (!validScale(scaleX) || !validScale(scaleY)) {
        return { status: 'deferred', reason: 'unstable' };
      }
      const visible = visibleImageRect(metrics);
      if (!visible) return { status: 'deferred', reason: 'hidden' };
      const crop = toPixelCrop(visible, scaleX, scaleY, bitmap.width, bitmap.height);
      if (!crop) {
        // The visible rectangle is smaller than one whole device pixel, or it
        // lies past the bitmap edge, so rounding inward leaves nothing to
        // read. That is the same retryable "too small right now" state as an
        // output below MIN_OCR_BITMAP_AXIS_PX, not a permanently oversized
        // image: settling here would lose an image that a later observation
        // can expose (C7).
        return { status: 'deferred', reason: 'too-small-visible' };
      }
      const output = selectOcrPreprocessingPlan(
        crop.width,
        crop.height,
        MAX_OCR_INPUT_PIXELS,
        visible.right - visible.left,
        visible.bottom - visible.top,
      );
      if (!output) return { status: 'deferred', reason: 'oversized' };
      if (
        output.width < MIN_OCR_BITMAP_AXIS_PX ||
        output.height < MIN_OCR_BITMAP_AXIS_PX
      ) {
        // Keep the image eligible for semantic text while deferring only the
        // unusable pixel crop. A later geometry observation can expose enough
        // of a clipped image for OCR without capturing neighboring page pixels.
        return { status: 'deferred', reason: 'too-small-visible' };
      }
      let surface: CropSurface;
      try {
        surface = this.environment.createSurface(output.width, output.height);
        const context = surface.getContext('2d');
        if (!context) return { status: 'deferred', reason: 'surface' };
        context.drawImage(
          bitmap as unknown as CanvasImageSource,
          crop.left,
          crop.top,
          crop.width,
          crop.height,
          0,
          0,
          output.width,
          output.height,
        );
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw error;
        return { status: 'deferred', reason: 'surface' };
      }
      let encoded: Blob;
      try {
        encoded = await surface.convertToBlob({ type: 'image/png' });
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw error;
        return { status: 'deferred', reason: 'encode' };
      }
      if (encoded.size < 1 || encoded.size > MAX_SCREENSHOT_BYTES) {
        return { status: 'deferred', reason: 'oversized' };
      }
      signal?.throwIfAborted();
      let pixelHash: string;
      try {
        pixelHash = toHex(
          await this.environment.digest(await encoded.arrayBuffer()),
        );
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw error;
        return { status: 'deferred', reason: 'digest' };
      }
      return {
        status: 'ready',
        pixels: Object.freeze({
          descriptor,
          pixelHash,
          encoded,
          bitmapWidth: output.width,
          bitmapHeight: output.height,
          preprocessingVersion: output.version,
          cropOffsetXCss: visible.left - metrics.left,
          cropOffsetYCss: visible.top - metrics.top,
          cropWidthCss: visible.right - visible.left,
          cropHeightCss: visible.bottom - visible.top,
          renderedWidthCss: metrics.width,
          renderedHeightCss: metrics.height,
          ...(metrics.nearestElementLanguage
            ? { nearestElementLanguage: metrics.nearestElementLanguage }
            : {}),
        }),
      };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      return { status: 'deferred', reason: 'surface' };
    } finally {
      bitmap?.close();
    }
  }
}

export function createBrowserPixelAcquisitionEnvironment(
  source: ImageSourceLease,
  sourceTabId: number,
  sourceWindowId: number,
  filePixels?: Omit<BrowserImageFilePixelOptions, 'maxPixels'>,
  capture: SourceTabCaptureEnvironment = browserSourceTabCaptureEnvironment(),
): PixelAcquisitionEnvironment {
  const fileEnvironment = filePixels
    ? createBrowserImageFilePixelReaderEnvironment(source, {
        ...filePixels,
        maxPixels: MAX_OCR_INPUT_PIXELS,
      })
    : undefined;
  return {
    source,
    ...(fileEnvironment
      ? {
          readFilePixels: (descriptor: SourceImageDescriptor, signal?: AbortSignal) =>
            readImageFilePixels(descriptor, fileEnvironment, signal),
        }
      : {}),
    // Handed out as soon as it is made: the second rectangle is asked for
    // while the tab still shows what was captured, and the words show half a
    // second sooner. The lane is kept for the rest of the quota interval all
    // the same, so the next screenshot waits its turn there.
    captureVisibleTab: (signal) => captureVisibleSourceTabPromptly(
      sourceTabId,
      sourceWindowId,
      signal,
      capture,
    ),
    decode: (blob) => createImageBitmap(blob),
    createSurface: (width, height) => new OffscreenCanvas(width, height),
    digest: (bytes) => crypto.subtle.digest('SHA-256', bytes),
    clippedImageQuietMs: CLIPPED_IMAGE_QUIET_MS,
  };
}

/**
 * Bind captureVisibleTab's window-scoped API to the exact source tab. The
 * origin-wide Web Lock also keeps separate sidepanel/popout contexts within
 * Chrome's two-captures-per-second extension quota.
 *
 * The capture is handed out as soon as it is taken and checked, and the lane
 * is kept for the rest of the quota interval all the same, so the next
 * capture (the PDF viewer's or image text's) waits its turn. Both callers
 * act while the tab still shows what was captured: the PDF viewer's page
 * box (D133), and image text's second rectangle (D147; until then image
 * text got its capture when the lane let go of it, half a second later).
 */
export function captureVisibleSourceTabPromptly(
  sourceTabId: number,
  sourceWindowId: number,
  signal?: AbortSignal,
  environment: SourceTabCaptureEnvironment = browserSourceTabCaptureEnvironment(),
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    void (async () => {
      try {
        resolve(await captureInLane(sourceTabId, sourceWindowId, signal, environment, resolve));
      } catch (error) {
        reject(error);
      }
    })();
  });
}

async function captureInLane(
  sourceTabId: number,
  sourceWindowId: number,
  signal: AbortSignal | undefined,
  environment: SourceTabCaptureEnvironment,
  onCaptured: (screenshot: string) => void,
): Promise<string> {
  if (
    !Number.isSafeInteger(sourceTabId) || sourceTabId < 0 ||
    !Number.isSafeInteger(sourceWindowId) || sourceWindowId < 0
  ) throw new Error('Invalid source tab capture identity.');
  try {
    return await environment.withGlobalLock(async () => {
      signal?.throwIfAborted();
      let activeBefore: number | undefined;
      try {
        activeBefore = await environment.queryActiveTab(sourceWindowId);
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw error;
        throw new SourceTabCaptureError('api');
      }
      signal?.throwIfAborted();
      if (activeBefore !== sourceTabId) {
        throw new SourceTabCaptureError('inactive');
      }
      const captureStartedAt = environment.now();
      try {
        let screenshot: string;
        try {
          screenshot = await environment.captureVisibleTab(sourceWindowId);
        } catch (error) {
          if (signal?.aborted || isAbortError(error)) throw error;
          throw new SourceTabCaptureError(classifyCaptureApiFailure(error));
        }
        signal?.throwIfAborted();
        let activeAfter: number | undefined;
        try {
          activeAfter = await environment.queryActiveTab(sourceWindowId);
        } catch (error) {
          if (signal?.aborted || isAbortError(error)) throw error;
          throw new SourceTabCaptureError('api');
        }
        signal?.throwIfAborted();
        if (activeAfter !== sourceTabId) {
          throw new SourceTabCaptureError('inactive');
        }
        onCaptured(screenshot);
        return screenshot;
      } finally {
        // Hold the cross-context lane for the remainder of the quota interval,
        // including failed API attempts that still count against Chrome's cap.
        const remaining = MIN_CAPTURE_INTERVAL_MS -
          (environment.now() - captureStartedAt);
        if (remaining > 0) await environment.delay(remaining);
      }
    });
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    if (error instanceof SourceTabCaptureError) throw error;
    throw new SourceTabCaptureError('api');
  }
}

function browserSourceTabCaptureEnvironment(): SourceTabCaptureEnvironment {
  return {
    queryActiveTab: async (windowId) => {
      const [active] = await browser.tabs.query({ active: true, windowId });
      return active?.id;
    },
    captureVisibleTab: (windowId) => browser.tabs.captureVisibleTab(windowId, {
      format: 'png',
    }),
    withGlobalLock: (callback) =>
      navigator.locks.request(IMAGE_CAPTURE_LOCK_NAME, callback),
    now: () => performance.now(),
    delay: (milliseconds) => new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, milliseconds));
    }),
  };
}

function clippedWaitKey(descriptor: SourceImageDescriptor): string {
  const document = descriptor.document;
  return [
    document.sessionId,
    document.pageEpoch,
    document.generation,
    document.documentId,
    document.frameId,
    descriptor.nodeId,
    descriptor.contentRevision,
  ].join('|');
}

/**
 * The view cuts part of the image off, by more than the half pixel a whole
 * read allows, and the image is no larger than the view on either axis.
 */
function clippedButFitsView(metrics: SourceImageCaptureMetrics): boolean {
  if (
    metrics.width > metrics.viewportWidth ||
    metrics.height > metrics.viewportHeight
  ) return false;
  const visible = visibleImageRect(metrics);
  if (!visible) return false;
  return visible.left - metrics.left > 0.5 ||
    visible.top - metrics.top > 0.5 ||
    metrics.width - (visible.right - visible.left) > 1 ||
    metrics.height - (visible.bottom - visible.top) > 1;
}

function visibleImageRect(metrics: SourceImageCaptureMetrics): {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
} | undefined {
  const left = Math.max(0, metrics.left);
  const top = Math.max(0, metrics.top);
  const right = Math.min(metrics.viewportWidth, metrics.left + metrics.width);
  const bottom = Math.min(metrics.viewportHeight, metrics.top + metrics.height);
  return right > left && bottom > top ? { left, top, right, bottom } : undefined;
}

function toPixelCrop(
  visible: ReturnType<typeof visibleImageRect> & object,
  scaleX: number,
  scaleY: number,
  bitmapWidth: number,
  bitmapHeight: number,
): { readonly left: number; readonly top: number; readonly width: number; readonly height: number } | undefined {
  // Round inward: a box that exactly touches a credential field must not pull
  // in the fraction of a device pixel that belongs to its neighbour. Losing a
  // fraction of the image edge is harmless; including a mask dot is not (C7).
  const left = Math.max(0, Math.ceil(visible.left * scaleX));
  const top = Math.max(0, Math.ceil(visible.top * scaleY));
  const right = Math.min(bitmapWidth, Math.floor(visible.right * scaleX));
  const bottom = Math.min(bitmapHeight, Math.floor(visible.bottom * scaleY));
  const width = right - left;
  const height = bottom - top;
  return width > 0 && height > 0 ? { left, top, width, height } : undefined;
}

function validScale(value: number): boolean {
  return Number.isFinite(value) && value >= 0.1 && value <= 16;
}

async function dataUrlToBlob(value: string): Promise<Blob> {
  if (!value.startsWith('data:image/')) throw new Error('Invalid screenshot.');
  return (await fetch(value)).blob();
}

function toHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = (): void => finish(new DOMException('Capture cancelled.', 'AbortError'));
    const timer = setTimeout(() => finish(), Math.max(0, milliseconds));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'name' in error &&
    error.name === 'AbortError',
  );
}

function classifyCaptureApiFailure(
  error: unknown,
): Exclude<SourceTabCaptureFailureCode, 'inactive'> {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (
    message.includes('<all_urls>') ||
    message.includes('activetab') ||
    message.includes('permission') ||
    message.includes('not allowed')
  ) return 'permission';
  if (
    message.includes('max_capture_visible_tab_calls_per_second') ||
    message.includes('too many') ||
    message.includes('quota') ||
    message.includes('per second')
  ) return 'quota';
  return 'api';
}
