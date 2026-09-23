import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

import type { SourceImageDescriptor } from '../lib/ocr/contracts';
import {
  computeImageFilePlacement,
  parseObjectPosition,
  renderImageFilePixels,
  validImageFileLayout,
  validImageFilePlacement,
  type ImageFileLayout,
  type ImageFilePlacementInput,
} from '../lib/ocr/image-file-pixels';
import {
  imageOffersUrl,
  readImageFilePixels,
  type ImageFilePixelReaderEnvironment,
} from '../lib/ocr/image-file-pixel-reader';
import type { ImageSourceLease } from '../lib/ocr/image-source-client';
import type { SourceImageFileEvidence } from '../lib/ocr/image-source-protocol';
import { OCR_NATIVE_PREPROCESSING_VERSION } from '../lib/ocr/preprocessing-profile';

const box: ImageFilePlacementInput = {
  boxWidth: 400,
  boxHeight: 200,
  insetLeft: 0,
  insetTop: 0,
  insetRight: 0,
  insetBottom: 0,
  naturalWidth: 800,
  naturalHeight: 800,
  objectFit: 'fill',
  objectPosition: '50% 50%',
};

describe('image file placement', () => {
  it('maps fill, contain, cover, none and scale-down onto the content box', () => {
    expect(computeImageFilePlacement(box)).toEqual({
      sourceX: 0, sourceY: 0, sourceWidth: 1, sourceHeight: 1,
      destX: 0, destY: 0, destWidth: 400, destHeight: 200,
      boxWidth: 400, boxHeight: 200,
    });
    // A square letterboxed into 400x200: 200x200 centred horizontally.
    expect(computeImageFilePlacement({ ...box, objectFit: 'contain' })).toMatchObject({
      sourceX: 0, sourceWidth: 1, destX: 100, destY: 0, destWidth: 200, destHeight: 200,
    });
    // Cover paints 400x400 and shows its middle half vertically.
    expect(computeImageFilePlacement({ ...box, objectFit: 'cover' })).toMatchObject({
      sourceX: 0, sourceY: 0.25, sourceWidth: 1, sourceHeight: 0.5,
      destX: 0, destY: 0, destWidth: 400, destHeight: 200,
    });
    // None at the top-left corner shows the top-left 400x200 of 800x800.
    expect(computeImageFilePlacement({
      ...box, objectFit: 'none', objectPosition: '0% 0%',
    })).toMatchObject({
      sourceX: 0, sourceY: 0, sourceWidth: 0.5, sourceHeight: 0.25,
      destWidth: 400, destHeight: 200,
    });
    // Scale-down never enlarges a small image.
    expect(computeImageFilePlacement({
      ...box, naturalWidth: 100, naturalHeight: 50, objectFit: 'scale-down',
    })).toMatchObject({
      sourceWidth: 1, sourceHeight: 1, destX: 150, destY: 75, destWidth: 100, destHeight: 50,
    });
  });

  it('insets borders and padding and honours pixel and calc positions', () => {
    expect(computeImageFilePlacement({
      ...box, insetLeft: 10, insetTop: 5, insetRight: 10, insetBottom: 5,
    })).toMatchObject({ destX: 10, destY: 5, destWidth: 380, destHeight: 190 });
    expect(computeImageFilePlacement({
      ...box, objectFit: 'contain', objectPosition: '20px 0px',
    })).toMatchObject({ destX: 20, destWidth: 200 });
    expect(computeImageFilePlacement({
      ...box, objectFit: 'contain', objectPosition: 'calc(100% - 10px) 50%',
    })).toMatchObject({ destX: 190, destWidth: 200 });
    expect(parseObjectPosition('')).toEqual({
      x: { percent: 50, pixels: 0 },
      y: { percent: 50, pixels: 0 },
    });
  });

  it('fails closed on unknown fits, unreadable positions and empty paint', () => {
    expect(computeImageFilePlacement({ ...box, objectFit: 'stretch' })).toBeUndefined();
    expect(computeImageFilePlacement({ ...box, objectPosition: 'left 10px top 5px' }))
      .toBeUndefined();
    expect(computeImageFilePlacement({
      ...box, objectFit: 'none', objectPosition: '5000px 0px',
    })).toBeUndefined();
    expect(computeImageFilePlacement({ ...box, naturalWidth: 0 })).toBeUndefined();
    expect(computeImageFilePlacement({ ...box, insetLeft: 250, insetRight: 250 }))
      .toBeUndefined();
    expect(validImageFilePlacement({
      ...computeImageFilePlacement(box)!, sourceWidth: 1.5,
    })).toBe(false);
    const { naturalWidth: _width, naturalHeight: _height, ...boxLayout } = box;
    expect(validImageFileLayout(boxLayout)).toBe(true);
    expect(validImageFileLayout({ ...boxLayout, objectFit: 'stretch' })).toBe(false);
    expect(validImageFileLayout({ ...boxLayout, objectPosition: 'url(x) 0' })).toBe(false);
    expect(validImageFileLayout({ ...boxLayout, boxWidth: 0 })).toBe(false);
  });

  it('draws the painted region at the copy resolution with box-relative geometry', async () => {
    const drawImage = vi.fn();
    const placement = computeImageFilePlacement({ ...box, objectFit: 'cover' })!;
    const rendered = await renderImageFilePixels(
      {} as CanvasImageSource,
      1_600,
      1_600,
      placement,
      {
        createSurface: () => ({
          getContext: () => ({ drawImage }),
          convertToBlob: async () => new Blob([new Uint8Array([1, 2])], { type: 'image/png' }),
        }),
        digest: async () => new Uint8Array(32).fill(0xcd).buffer,
      },
      4_000_000,
    );
    // Cover shows rows 400..1200 of a 1600x1600 copy.
    expect(drawImage).toHaveBeenCalledWith(
      expect.anything(), 0, 400, 1_600, 800, 0, 0, 1_600, 800,
    );
    expect(rendered).toMatchObject({
      bitmapWidth: 1_600,
      bitmapHeight: 800,
      preprocessingVersion: OCR_NATIVE_PREPROCESSING_VERSION,
      cropOffsetXCss: 0,
      cropOffsetYCss: 0,
      cropWidthCss: 400,
      cropHeightCss: 200,
      renderedWidthCss: 400,
      renderedHeightCss: 200,
      pixelHash: 'cd'.repeat(32),
    });
  });
});

const descriptor: SourceImageDescriptor = {
  document: {
    sessionId: 'file-session',
    pageEpoch: 1,
    generation: 1,
    documentId: 'file-document',
    frameId: 0,
  },
  nodeId: 7,
  sourceKind: 'img',
  contentRevision: 1,
  observationRevision: 1,
  visibility: 'background',
  connected: true,
  renderedWidth: 400,
  renderedHeight: 200,
};

const layout: ImageFileLayout = {
  boxWidth: 400,
  boxHeight: 200,
  insetLeft: 0,
  insetTop: 0,
  insetRight: 0,
  insetBottom: 0,
  objectFit: 'cover',
  objectPosition: '50% 50%',
};

function fileEvidence(
  overrides: Partial<SourceImageFileEvidence> = {},
): SourceImageFileEvidence {
  return {
    document: descriptor.document,
    nodeId: 7,
    contentRevision: 1,
    observationRevision: 1,
    layout,
    naturalWidth: 800,
    naturalHeight: 800,
    url: 'https://cdn.example.test/kv-800.png',
    ...overrides,
  };
}

function mirrorImage(srcset = '', loaded = true): HTMLImageElement {
  const { document } = parseHTML(
    `<html><body><img src="https://cdn.example.test/kv-400.png" srcset="${srcset}"></body></html>`,
  );
  const image = document.querySelector('img') as unknown as HTMLImageElement;
  Object.defineProperties(image, {
    complete: { value: loaded },
    naturalWidth: { value: loaded ? 400 : 0 },
    naturalHeight: { value: loaded ? 400 : 0 },
    currentSrc: { value: 'https://cdn.example.test/kv-400.png' },
    baseURI: { value: 'https://site.example.test/' },
  });
  return image;
}

function readerEnvironment(
  options: {
    readonly readFile: ImageSourceLease['readFile'];
    readonly mirror?: HTMLImageElement;
    readonly mirrorReadable?: boolean;
    readonly downloadAllowed?: boolean;
  },
): ImageFilePixelReaderEnvironment & { drawn: unknown[]; fetched: string[] } {
  const drawn: unknown[] = [];
  const fetched: string[] = [];
  return {
    drawn,
    fetched,
    source: new MethodSource(options.readFile!),
    resolveMirrorImage: () => options.mirror,
    canReadImage: () => options.mirrorReadable ?? true,
    downloadAllowed: async () => options.downloadAllowed ?? false,
    fetchImage: async (url) => {
      fetched.push(url);
      return new Blob([new Uint8Array([9])], { type: 'image/png' });
    },
    decode: async () => ({
      image: { decoded: true } as unknown as CanvasImageSource,
      width: 800,
      height: 800,
      close: () => undefined,
    }),
    render: {
      createSurface: () => ({
        getContext: () => ({
          drawImage: (image: CanvasImageSource) => drawn.push(image),
        }),
        convertToBlob: async () => new Blob([new Uint8Array([1])], { type: 'image/png' }),
      }),
      digest: async () => new Uint8Array(32).buffer,
    },
    maxPixels: 4_000_000,
  };
}

/** A lease whose methods need `this`, like the Chrome lease. */
class MethodSource implements ImageSourceLease {
  readonly #readFile: NonNullable<ImageSourceLease['readFile']>;

  constructor(readFile: NonNullable<ImageSourceLease['readFile']>) {
    this.#readFile = readFile;
  }

  async measure(): Promise<undefined> {
    return undefined;
  }

  readFile(
    descriptor: SourceImageDescriptor,
    includePixels: boolean,
    signal?: AbortSignal,
  ): Promise<SourceImageFileEvidence | undefined> {
    return this.#readFile(descriptor, includePixels, signal);
  }

  dispose(): void {}
}

describe('image file pixel reader', () => {
  it('reads the mirror copy first when it offers the same resource', async () => {
    const mirror = mirrorImage(
      'https://cdn.example.test/kv-400.png 1x, https://cdn.example.test/kv-800.png 2x',
    );
    const readFile = vi.fn(async () => fileEvidence());
    const environment = readerEnvironment({ readFile, mirror });

    const pixels = await readImageFilePixels(descriptor, environment);

    expect(pixels?.source).toBe('mirror');
    // The tab only confirms eligibility and placement; it encodes nothing.
    expect(readFile).toHaveBeenCalledExactlyOnceWith(descriptor, false, undefined);
    expect(environment.drawn).toEqual([mirror]);
    expect(environment.fetched).toEqual([]);
  });

  it('asks the tab for its pixels when the mirror shows another picture', async () => {
    const mirror = mirrorImage();
    const readFile = vi.fn(async (_descriptor: SourceImageDescriptor, includePixels: boolean) =>
      fileEvidence({
        url: 'https://cdn.example.test/replaced.png',
        ...(includePixels
          ? { pixels: { dataUrl: 'data:image/png;base64,AAAA', width: 800, height: 800 } }
          : {}),
      }));
    const environment = readerEnvironment({ readFile, mirror, downloadAllowed: true });

    const pixels = await readImageFilePixels(descriptor, environment);

    expect(pixels?.source).toBe('tab');
    expect(readFile.mock.calls.map(([, includePixels]) => includePixels))
      .toEqual([false, true]);
    expect(environment.drawn).not.toContain(mirror);
    expect(environment.fetched).toEqual([]);
  });

  it('downloads only when the tab cannot share pixels and downloads are allowed', async () => {
    const tainted = readerEnvironment({
      readFile: async () => fileEvidence(),
      mirror: mirrorImage('', false),
      downloadAllowed: true,
    });
    expect((await readImageFilePixels(descriptor, tainted))?.source).toBe('download');
    expect(tainted.fetched).toEqual(['https://cdn.example.test/kv-800.png']);

    const conservative = readerEnvironment({
      readFile: async () => fileEvidence(),
      downloadAllowed: false,
    });
    expect(await readImageFilePixels(descriptor, conservative)).toBeUndefined();
    expect(conservative.fetched).toEqual([]);
  });

  it('reads a lazy image the tab has not fetched from a download', async () => {
    const lazy = readerEnvironment({
      readFile: async () => {
        const { naturalWidth: _width, naturalHeight: _height, ...unloaded } = fileEvidence();
        return unloaded;
      },
      downloadAllowed: true,
    });
    const pixels = await readImageFilePixels(descriptor, lazy);
    expect(pixels).toMatchObject({
      source: 'download',
      // Cover of the decoded 800x800 file fills the 400x200 box.
      cropWidthCss: 400,
      cropHeightCss: 200,
      bitmapWidth: 800,
      bitmapHeight: 400,
    });

    // `object-fit: none` needs the page's CSS size, which a lazy image lacks.
    const none = readerEnvironment({
      readFile: async () => {
        const { naturalWidth: _width, naturalHeight: _height, ...unloaded } =
          fileEvidence({ layout: { ...layout, objectFit: 'none' } });
        return unloaded;
      },
      downloadAllowed: true,
    });
    expect(await readImageFilePixels(descriptor, none)).toBeUndefined();
    expect(none.fetched).toEqual([]);
  });

  it('reads nothing when the tab refuses the image', async () => {
    const environment = readerEnvironment({
      readFile: async () => undefined,
      mirror: mirrorImage('https://cdn.example.test/kv-800.png 2x'),
      downloadAllowed: true,
    });
    expect(await readImageFilePixels(descriptor, environment)).toBeUndefined();
    expect(environment.drawn).toEqual([]);
    expect(environment.fetched).toEqual([]);
  });

  it('matches a mirror image by src, srcset or picture source only', () => {
    const { document } = parseHTML(
      '<html><body><picture>' +
      '<source srcset="https://cdn.example.test/a.webp 1x, https://cdn.example.test/b.webp 2x">' +
      '<img src="https://cdn.example.test/a.jpg">' +
      '</picture></body></html>',
    );
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    Object.defineProperty(image, 'baseURI', { value: 'https://site.example.test/' });
    expect(imageOffersUrl(image, 'https://cdn.example.test/a.jpg')).toBe(true);
    expect(imageOffersUrl(image, 'https://cdn.example.test/b.webp')).toBe(true);
    expect(imageOffersUrl(image, 'https://cdn.example.test/c.webp')).toBe(false);
  });
});
