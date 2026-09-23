import type { SourceImageDescriptor } from './contracts';
import type { ImageSourceLease } from './image-source-client';
import {
  computeImageFilePlacement,
  layoutNeedsCssNaturalSize,
  renderImageFilePixels,
  type ImageFileLayout,
  type ImageFilePlacement,
  type ImageFileRenderEnvironment,
  type RenderedImageFilePixels,
} from './image-file-pixels';
import type { SupportedLanguage } from '../translation-provider';

export const MAX_IMAGE_DOWNLOAD_BYTES = 16 * 1024 * 1024;
export const IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000;

/**
 * Where pixels for an image the screenshot cannot see came from: the copy
 * the mirror already loaded, the source tab's own `<img>`, or a cache-first
 * download of the same URL.
 */
export type ImageFilePixelSource = 'mirror' | 'tab' | 'download';

export interface ImageFilePixels extends RenderedImageFilePixels {
  readonly source: ImageFilePixelSource;
  readonly nearestElementLanguage?: SupportedLanguage;
}

export interface DecodedImageFile {
  readonly image: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  close(): void;
}

export interface ImageFilePixelReaderEnvironment {
  readonly source: ImageSourceLease;
  /** The mirror's `<img>` for this source image, if the mirror has it. */
  readonly resolveMirrorImage: (
    descriptor: SourceImageDescriptor,
  ) => HTMLImageElement | undefined;
  /** Whether the extension may read this loaded copy's pixels. */
  readonly canReadImage: (image: HTMLImageElement) => boolean;
  /** Passive fidelity and a host grant for the URL's origin. */
  readonly downloadAllowed: (url: string) => Promise<boolean>;
  /** Cache-first, credential-free fetch of an image file. */
  readonly fetchImage: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<Blob | undefined>;
  readonly decode: (blob: Blob) => Promise<DecodedImageFile>;
  readonly render: ImageFileRenderEnvironment;
  readonly maxPixels: number;
}

const WHOLE_SOURCE = Object.freeze({
  sourceX: 0,
  sourceY: 0,
  sourceWidth: 1,
  sourceHeight: 1,
});

/**
 * Reads an image from its file in the cheapest way available. The tab always
 * decides eligibility and placement first, so the mirror copy and the
 * download are only used for images the read policy admits.
 */
export async function readImageFilePixels(
  descriptor: SourceImageDescriptor,
  environment: ImageFilePixelReaderEnvironment,
  signal?: AbortSignal,
): Promise<ImageFilePixels | undefined> {
  const source = environment.source;
  if (!source.readFile) return undefined;
  // Called as a method: the Chrome lease keeps its request state on `this`.
  const readFile = (includePixels: boolean) =>
    source.readFile!(descriptor, includePixels, signal);
  const mirror = loadedImage(environment.resolveMirrorImage(descriptor));
  const mirrorReadable = mirror !== undefined && safely(
    () => environment.canReadImage(mirror),
  );
  let file = await readFile(!mirrorReadable);
  if (!file) return undefined;
  const language = file.nearestElementLanguage;

  if (mirror && mirrorReadable && file.url && imageOffersUrl(mirror, file.url)) {
    // The mirror reports a CSS natural size like the tab does.
    const placement = placementFor(file.layout, {
      width: mirror.naturalWidth,
      height: mirror.naturalHeight,
    });
    const rendered = placement && await tryRender(
      mirror,
      mirror.naturalWidth,
      mirror.naturalHeight,
      placement,
      environment,
      signal,
    );
    if (rendered) return withSource(rendered, 'mirror', language);
  }

  if (!file.pixels && mirrorReadable) {
    // The mirror shows another resource (not yet patched, or a different
    // picture): ask the tab for its own pixels after all.
    file = await readFile(true) ?? file;
  }
  const tabNatural = file.naturalWidth !== undefined &&
      file.naturalHeight !== undefined
    ? { width: file.naturalWidth, height: file.naturalHeight }
    : undefined;
  if (file.pixels && tabNatural) {
    // The tab already cut the painted region; only its box position is needed.
    const placement = placementFor(file.layout, tabNatural);
    const tab = placement && await decodeAndRender(
      async () => dataUrlToBlob(file.pixels!.dataUrl),
      () => ({ ...placement, ...WHOLE_SOURCE }),
      environment,
      signal,
    );
    if (tab) return withSource(tab, 'tab', language);
  }

  const url = file.url;
  if (
    url &&
    (tabNatural || !layoutNeedsCssNaturalSize(file.layout)) &&
    await safelyAsync(() => environment.downloadAllowed(url))
  ) {
    // Fill, contain and cover need only the file's aspect ratio, which the
    // decoded download supplies when the tab has not loaded a lazy image.
    const downloaded = await decodeAndRender(
      () => environment.fetchImage(url, signal),
      (decoded) => placementFor(
        file.layout,
        tabNatural ?? { width: decoded.width, height: decoded.height },
      ),
      environment,
      signal,
    );
    if (downloaded) return withSource(downloaded, 'download', language);
  }
  return undefined;
}

function placementFor(
  layout: ImageFileLayout,
  natural: { readonly width: number; readonly height: number },
): ImageFilePlacement | undefined {
  return computeImageFilePlacement({
    ...layout,
    naturalWidth: natural.width,
    naturalHeight: natural.height,
  });
}

/**
 * True when `url` is one of the resources this `<img>` may display: its
 * current source, `src`, `srcset` candidates, or a `<picture>` source. A
 * different candidate of the same set is the same picture at another size;
 * a URL outside the set means the copy is stale or another picture.
 */
export function imageOffersUrl(image: HTMLImageElement, url: string): boolean {
  const base = image.baseURI;
  const candidates = new Set<string>();
  const add = (value: string | null | undefined): void => {
    if (!value) return;
    try {
      candidates.add(new URL(value, base).href);
    } catch {
      // An unparsable candidate cannot match.
    }
  };
  add(image.currentSrc);
  add(image.getAttribute('src'));
  for (const candidate of srcsetUrls(image.getAttribute('srcset'))) add(candidate);
  const parent = image.parentElement;
  if (parent?.localName.toLowerCase() === 'picture') {
    for (const source of parent.children) {
      if (source.localName.toLowerCase() !== 'source') continue;
      for (const candidate of srcsetUrls(source.getAttribute('srcset'))) {
        add(candidate);
      }
    }
  }
  try {
    return candidates.has(new URL(url).href);
  } catch {
    return false;
  }
}

export function srcsetUrls(value: string | null): string[] {
  if (!value) return [];
  return value.split(/,\s+/u)
    .map((candidate) => candidate.trim().split(/\s+/u)[0] ?? '')
    .filter((candidate) => candidate.length > 0);
}

async function decodeAndRender(
  load: () => Promise<Blob | undefined>,
  place: (decoded: DecodedImageFile) => ImageFilePlacement | undefined,
  environment: ImageFilePixelReaderEnvironment,
  signal?: AbortSignal,
): Promise<RenderedImageFilePixels | undefined> {
  let blob: Blob | undefined;
  try {
    blob = await load();
  } catch (error) {
    if (isAbort(error, signal)) throw error;
    return undefined;
  }
  if (!blob) return undefined;
  signal?.throwIfAborted();
  let decoded: DecodedImageFile;
  try {
    decoded = await environment.decode(blob);
  } catch (error) {
    if (isAbort(error, signal)) throw error;
    return undefined;
  }
  try {
    const placement = place(decoded);
    return placement && await tryRender(
      decoded.image,
      decoded.width,
      decoded.height,
      placement,
      environment,
      signal,
    );
  } finally {
    decoded.close();
  }
}

async function tryRender(
  image: CanvasImageSource,
  width: number,
  height: number,
  placement: ImageFilePlacement,
  environment: ImageFilePixelReaderEnvironment,
  signal?: AbortSignal,
): Promise<RenderedImageFilePixels | undefined> {
  try {
    return await renderImageFilePixels(
      image,
      width,
      height,
      placement,
      environment.render,
      environment.maxPixels,
      signal,
    );
  } catch (error) {
    if (isAbort(error, signal)) throw error;
    // A tainted copy, a surface failure or an encode failure: try the next.
    return undefined;
  }
}

function withSource(
  rendered: RenderedImageFilePixels,
  source: ImageFilePixelSource,
  nearestElementLanguage: SupportedLanguage | undefined,
): ImageFilePixels {
  return Object.freeze({
    ...rendered,
    source,
    ...(nearestElementLanguage ? { nearestElementLanguage } : {}),
  });
}

function loadedImage(
  image: HTMLImageElement | undefined,
): HTMLImageElement | undefined {
  return image && image.complete && image.naturalWidth > 0 &&
      image.naturalHeight > 0
    ? image
    : undefined;
}

async function dataUrlToBlob(value: string): Promise<Blob> {
  if (!value.startsWith('data:image/png;base64,')) {
    throw new Error('Invalid tab pixels.');
  }
  return (await fetch(value)).blob();
}

function safely(read: () => boolean): boolean {
  try {
    return read();
  } catch {
    return false;
  }
}

async function safelyAsync(read: () => Promise<boolean>): Promise<boolean> {
  try {
    return await read();
  } catch {
    return false;
  }
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || Boolean(
    error && typeof error === 'object' && 'name' in error &&
    error.name === 'AbortError',
  );
}

export interface BrowserImageFilePixelOptions {
  readonly resolveMirrorImage: (
    descriptor: SourceImageDescriptor,
  ) => HTMLImageElement | undefined;
  /** Downloads follow the mirror's Passive fidelity, which loads them too. */
  readonly downloadsEnabled: () => boolean;
  readonly maxPixels: number;
}

export function createBrowserImageFilePixelReaderEnvironment(
  source: ImageSourceLease,
  options: BrowserImageFilePixelOptions,
): ImageFilePixelReaderEnvironment {
  return {
    source,
    resolveMirrorImage: options.resolveMirrorImage,
    canReadImage: (image) => {
      const context = new OffscreenCanvas(1, 1).getContext('2d');
      if (!context) return false;
      context.drawImage(image, 0, 0, 1, 1);
      // A copy the extension may not read taints the canvas and throws here.
      context.getImageData(0, 0, 1, 1);
      return true;
    },
    downloadAllowed: async (url) => {
      if (!options.downloadsEnabled()) return false;
      return browser.permissions.contains({
        origins: [`${new URL(url).origin}/*`],
      });
    },
    fetchImage: fetchImageFile,
    decode: async (blob) => {
      const bitmap = await createImageBitmap(blob);
      return {
        image: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    },
    render: {
      createSurface: (width, height) => new OffscreenCanvas(width, height),
      digest: (bytes) => crypto.subtle.digest('SHA-256', bytes),
    },
    maxPixels: options.maxPixels,
  };
}

/**
 * Cache-first and without cookies: under Passive fidelity the mirror has
 * usually loaded the same URL already, so Chrome answers from its cache.
 * SVG and non-image responses are refused; size and time are bounded.
 */
export async function fetchImageFile(
  url: string,
  signal?: AbortSignal,
): Promise<Blob | undefined> {
  const timeout = AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS);
  const response = await fetch(url, {
    credentials: 'omit',
    cache: 'force-cache',
    redirect: 'follow',
    referrerPolicy: 'no-referrer',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) return undefined;
  const type = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!type.startsWith('image/') || type.includes('svg')) return undefined;
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_IMAGE_DOWNLOAD_BYTES) {
    return undefined;
  }
  const blob = await response.blob();
  return blob.size > 0 && blob.size <= MAX_IMAGE_DOWNLOAD_BYTES
    ? blob
    : undefined;
}
