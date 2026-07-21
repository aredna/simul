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

export const MAX_CAPTURE_RATE_PER_SECOND = 2;
export const MIN_CAPTURE_INTERVAL_MS = 500;
export const MAX_OCR_INPUT_PIXELS = 4_000_000;
export const MAX_SCREENSHOT_BYTES = 32 * 1024 * 1024;
export const IMAGE_CAPTURE_LOCK_NAME = 'simul:ocr-visible-tab-capture-v1';

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
}

export type PixelAcquisitionResult =
  | { readonly status: 'ready'; readonly pixels: AcquiredImagePixels }
  | {
      readonly status: 'deferred';
      readonly reason: 'hidden' | 'unstable' | 'oversized' | 'capture-failed';
    };

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
}

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
  #lastCaptureAt = Number.NEGATIVE_INFINITY;
  #lane: Promise<void> = Promise.resolve();

  constructor(private readonly environment: PixelAcquisitionEnvironment) {
    this.#now = environment.now ?? (() => performance.now());
    this.#delay = environment.delay ?? abortableDelay;
  }

  acquire(
    descriptor: SourceImageDescriptor,
    signal?: AbortSignal,
  ): Promise<PixelAcquisitionResult> {
    const previous = this.#lane;
    let release!: () => void;
    this.#lane = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(
      () => this.#acquire(descriptor, signal),
      () => this.#acquire(descriptor, signal),
    ).finally(release);
  }

  async #acquire(
    descriptor: SourceImageDescriptor,
    signal?: AbortSignal,
  ): Promise<PixelAcquisitionResult> {
    signal?.throwIfAborted();
    const before = await this.environment.source.measure(descriptor, signal);
    if (!before) return { status: 'deferred', reason: 'hidden' };
    const wait = MIN_CAPTURE_INTERVAL_MS - (this.#now() - this.#lastCaptureAt);
    if (wait > 0) await this.#delay(wait, signal);
    signal?.throwIfAborted();
    let screenshotUrl: string;
    try {
      this.#lastCaptureAt = this.#now();
      screenshotUrl = await this.environment.captureVisibleTab(signal);
    } catch {
      return { status: 'deferred', reason: 'capture-failed' };
    }
    signal?.throwIfAborted();
    const after = await this.environment.source.measure(descriptor, signal);
    if (!after || !sameImageCaptureMetrics(before, after)) {
      return { status: 'deferred', reason: 'unstable' };
    }
    return this.#crop(descriptor, before, screenshotUrl, signal);
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
    } catch {
      return { status: 'deferred', reason: 'capture-failed' };
    }
    if (screenshotBlob.size < 1 || screenshotBlob.size > MAX_SCREENSHOT_BYTES) {
      return { status: 'deferred', reason: 'oversized' };
    }
    signal?.throwIfAborted();
    let bitmap: DecodedBitmap | undefined;
    try {
      bitmap = await this.environment.decode(screenshotBlob);
      const scaleX = bitmap.width / metrics.viewportWidth;
      const scaleY = bitmap.height / metrics.viewportHeight;
      if (!validScale(scaleX) || !validScale(scaleY)) {
        return { status: 'deferred', reason: 'unstable' };
      }
      const visible = visibleImageRect(metrics);
      if (!visible) return { status: 'deferred', reason: 'hidden' };
      const crop = toPixelCrop(visible, scaleX, scaleY, bitmap.width, bitmap.height);
      if (!crop || crop.width * crop.height > MAX_OCR_INPUT_PIXELS) {
        return { status: 'deferred', reason: 'oversized' };
      }
      const output = selectOcrPreprocessingPlan(
        crop.width,
        crop.height,
        MAX_OCR_INPUT_PIXELS,
        visible.right - visible.left,
        visible.bottom - visible.top,
      );
      if (!output) return { status: 'deferred', reason: 'oversized' };
      const surface = this.environment.createSurface(output.width, output.height);
      const context = surface.getContext('2d');
      if (!context) return { status: 'deferred', reason: 'capture-failed' };
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
      const encoded = await surface.convertToBlob({ type: 'image/png' });
      if (encoded.size < 1 || encoded.size > MAX_SCREENSHOT_BYTES) {
        return { status: 'deferred', reason: 'oversized' };
      }
      signal?.throwIfAborted();
      const pixelHash = toHex(await this.environment.digest(await encoded.arrayBuffer()));
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
      return { status: 'deferred', reason: 'capture-failed' };
    } finally {
      bitmap?.close();
    }
  }
}

export function createBrowserPixelAcquisitionEnvironment(
  source: ImageSourceLease,
  sourceTabId: number,
  sourceWindowId: number,
): PixelAcquisitionEnvironment {
  return {
    source,
    captureVisibleTab: (signal) => captureVisibleSourceTab(
      sourceTabId,
      sourceWindowId,
      signal,
    ),
    decode: (blob) => createImageBitmap(blob),
    createSurface: (width, height) => new OffscreenCanvas(width, height),
    digest: (bytes) => crypto.subtle.digest('SHA-256', bytes),
  };
}

/**
 * Bind captureVisibleTab's window-scoped API to the exact source tab. The
 * origin-wide Web Lock also keeps separate sidepanel/popout contexts within
 * Chrome's two-captures-per-second extension quota.
 */
export async function captureVisibleSourceTab(
  sourceTabId: number,
  sourceWindowId: number,
  signal?: AbortSignal,
  environment: SourceTabCaptureEnvironment = browserSourceTabCaptureEnvironment(),
): Promise<string> {
  if (
    !Number.isSafeInteger(sourceTabId) || sourceTabId < 0 ||
    !Number.isSafeInteger(sourceWindowId) || sourceWindowId < 0
  ) throw new Error('Invalid source tab capture identity.');
  return environment.withGlobalLock(async () => {
    signal?.throwIfAborted();
    const activeBefore = await environment.queryActiveTab(sourceWindowId);
    signal?.throwIfAborted();
    if (activeBefore !== sourceTabId) {
      throw new Error('The source tab is not active for visible capture.');
    }
    const captureStartedAt = environment.now();
    try {
      const screenshot = await environment.captureVisibleTab(sourceWindowId);
      const activeAfter = await environment.queryActiveTab(sourceWindowId);
      if (activeAfter !== sourceTabId) {
        throw new Error('The active tab changed during visible capture.');
      }
      return screenshot;
    } finally {
      // Hold the cross-context lane for the remainder of the quota interval,
      // including failed API attempts that still count against Chrome's cap.
      const remaining = MIN_CAPTURE_INTERVAL_MS -
        (environment.now() - captureStartedAt);
      if (remaining > 0) await environment.delay(remaining);
    }
  });
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
  const left = Math.max(0, Math.floor(visible.left * scaleX));
  const top = Math.max(0, Math.floor(visible.top * scaleY));
  const right = Math.min(bitmapWidth, Math.ceil(visible.right * scaleX));
  const bottom = Math.min(bitmapHeight, Math.ceil(visible.bottom * scaleY));
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
  return error instanceof DOMException && error.name === 'AbortError';
}
