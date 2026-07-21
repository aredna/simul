import { describe, expect, it, vi } from 'vitest';

import type { SourceImageDescriptor } from '../lib/ocr/contracts';
import {
  MAX_OCR_INPUT_PIXELS,
  PixelAcquisitionCoordinator,
  SourceTabCaptureError,
  captureVisibleSourceTab,
  type PixelAcquisitionEnvironment,
  type SourceTabCaptureEnvironment,
} from '../lib/ocr/pixel-acquisition';
import {
  OCR_DOWNSCALED_PREPROCESSING_VERSION,
  OCR_NATIVE_PREPROCESSING_VERSION,
  OCR_SHALLOW_BANNER_DOWNSCALED_PREPROCESSING_VERSION,
  OCR_SHALLOW_BANNER_NATIVE_PREPROCESSING_VERSION,
  OCR_SHALLOW_BANNER_PREPROCESSING_VERSION,
  selectOcrPreprocessingPlan,
} from '../lib/ocr/preprocessing-profile';
import type { ImageSourceLease } from '../lib/ocr/image-source-client';
import type { SourceImageCaptureMetrics } from '../lib/ocr/image-source-protocol';

const documentIdentity = {
  sessionId: 'session-image',
  pageEpoch: 1,
  generation: 1,
  documentId: 'document-image',
  frameId: 0,
};
const descriptor: SourceImageDescriptor = {
  document: documentIdentity,
  nodeId: 7,
  sourceKind: 'img',
  contentRevision: 1,
  observationRevision: 1,
  visibility: 'visible',
  connected: true,
  renderedWidth: 200,
  renderedHeight: 100,
  intrinsicWidth: 800,
  intrinsicHeight: 400,
};
const metrics: SourceImageCaptureMetrics = {
  document: documentIdentity,
  nodeId: 7,
  contentRevision: 1,
  observationRevision: 1,
  left: -10,
  top: 20,
  width: 200,
  height: 100,
  viewportWidth: 1_000,
  viewportHeight: 500,
  scrollX: 0,
  scrollY: 100,
  devicePixelRatio: 2,
};

describe('PixelAcquisitionCoordinator', () => {
  it('captures at capacity one, crops visible pixels, hashes them, and closes decode memory', async () => {
    const source = fakeSource([metrics, metrics]);
    let now = 1_000;
    const close = vi.fn();
    const drawImage = vi.fn();
    const environment: PixelAcquisitionEnvironment = {
      source,
      captureVisibleTab: vi.fn(async () => 'data:image/png;base64,AQID'),
      decode: vi.fn(async () => ({ width: 2_000, height: 1_000, close })),
      createSurface: (width, height) => ({
        width,
        height,
        getContext: () => ({ drawImage }),
        convertToBlob: async () => new Blob([new Uint8Array([5, 6, 7])], {
          type: 'image/png',
        }),
      }),
      digest: async () => new Uint8Array(32).fill(0xab).buffer,
      now: () => now,
      delay: async (milliseconds) => {
        now += milliseconds;
      },
    };
    const coordinator = new PixelAcquisitionCoordinator(environment);
    const result = await coordinator.acquire(descriptor);

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.pixels).toMatchObject({
      bitmapWidth: 380,
      bitmapHeight: 200,
      preprocessingVersion: OCR_NATIVE_PREPROCESSING_VERSION,
      cropOffsetXCss: 10,
      cropOffsetYCss: 0,
      cropWidthCss: 190,
      cropHeightCss: 100,
      renderedWidthCss: 200,
      renderedHeightCss: 100,
      pixelHash: 'ab'.repeat(32),
    });
    expect(drawImage).toHaveBeenCalledWith(
      expect.anything(),
      0,
      40,
      380,
      200,
      0,
      0,
      380,
      200,
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it('defers hidden or changing images without capturing or accepting stale pixels', async () => {
    const hiddenCapture = vi.fn(async () => 'data:image/png;base64,AQID');
    const hidden = new PixelAcquisitionCoordinator(fakeEnvironment(
      fakeSource([undefined]),
      hiddenCapture,
    ));
    expect(await hidden.acquire(descriptor)).toEqual({
      status: 'deferred',
      reason: 'hidden',
    });
    expect(hiddenCapture).not.toHaveBeenCalled();

    const changed = new PixelAcquisitionCoordinator(fakeEnvironment(
      fakeSource([metrics, { ...metrics, scrollY: 101 }]),
    ));
    expect(await changed.acquire(descriptor)).toEqual({
      status: 'deferred',
      reason: 'unstable',
    });
  });

  it('upscales a D-U-N-S-shaped shallow banner while retaining original CSS geometry', async () => {
    const bannerMetrics = {
      ...metrics,
      left: 0,
      top: 0,
      width: 275,
      height: 30,
      viewportWidth: 1_000,
      viewportHeight: 500,
    };
    const drawImage = vi.fn();
    const createSurface = vi.fn((width: number, height: number) => ({
      width,
      height,
      getContext: () => ({ drawImage }),
      convertToBlob: async () => new Blob([new Uint8Array([9])], {
        type: 'image/png',
      }),
    }));
    const coordinator = new PixelAcquisitionCoordinator({
      ...fakeEnvironment(fakeSource([bannerMetrics, bannerMetrics])),
      decode: async () => ({ width: 1_000, height: 500, close: vi.fn() }),
      createSurface,
    });

    const result = await coordinator.acquire(descriptor);

    expect(selectOcrPreprocessingPlan(
      275,
      30,
      MAX_OCR_INPUT_PIXELS,
    )).toEqual({
      width: 550,
      height: 60,
      scale: 2,
      version: OCR_SHALLOW_BANNER_PREPROCESSING_VERSION,
    });
    expect(result).toMatchObject({
      status: 'ready',
      pixels: {
        bitmapWidth: 550,
        bitmapHeight: 60,
        preprocessingVersion: OCR_SHALLOW_BANNER_PREPROCESSING_VERSION,
        cropWidthCss: 275,
        cropHeightCss: 30,
        renderedWidthCss: 275,
        renderedHeightCss: 30,
      },
    });
    expect(createSurface).toHaveBeenCalledWith(550, 60);
    expect(drawImage).toHaveBeenCalledWith(
      expect.anything(),
      0,
      0,
      275,
      30,
      0,
      0,
      550,
      60,
    );
  });

  it('keeps banner mode without scaling when 2x would exceed the OCR cap', () => {
    expect(selectOcrPreprocessingPlan(
      30_000,
      40,
      MAX_OCR_INPUT_PIXELS,
    )).toEqual({
      width: 30_000,
      height: 40,
      scale: 1,
      version: OCR_SHALLOW_BANNER_NATIVE_PREPROCESSING_VERSION,
    });
  });

  it('classifies banners from CSS geometry independently of device pixel ratio', () => {
    expect(selectOcrPreprocessingPlan(
      1_375,
      150,
      MAX_OCR_INPUT_PIXELS,
      275,
      30,
    )).toEqual({
      width: 1_375,
      height: 150,
      scale: 1,
      version: OCR_SHALLOW_BANNER_NATIVE_PREPROCESSING_VERSION,
    });
    expect(selectOcrPreprocessingPlan(
      500,
      100,
      MAX_OCR_INPUT_PIXELS,
      500,
      100,
    )).toEqual({
      width: 500,
      height: 100,
      scale: 1,
      version: OCR_NATIVE_PREPROCESSING_VERSION,
    });
  });

  it('preserves shallow-banner segmentation when an over-axis crop is downscaled', () => {
    expect(selectOcrPreprocessingPlan(
      40_000,
      40,
      MAX_OCR_INPUT_PIXELS,
      1_000,
      1,
    )).toEqual({
      width: 32_768,
      height: 32,
      scale: 0.8192,
      version: OCR_SHALLOW_BANNER_DOWNSCALED_PREPROCESSING_VERSION,
    });
  });

  it('downscales a high-DPI crop without raising the four-megapixel guard', async () => {
    const huge = {
      ...metrics,
      left: 0,
      top: 0,
      width: 1_000,
      height: 500,
    };
    const environment = fakeEnvironment(fakeSource([huge, huge]));
    environment.decode = async () => ({
      width: 4_000,
      height: 2_000,
      close: vi.fn(),
    });
    const coordinator = new PixelAcquisitionCoordinator(environment);
    expect(MAX_OCR_INPUT_PIXELS).toBe(4_000_000);
    const result = await coordinator.acquire(descriptor);
    expect(result).toMatchObject({
      status: 'ready',
      pixels: {
        bitmapWidth: 2_828,
        bitmapHeight: 1_414,
        preprocessingVersion: OCR_DOWNSCALED_PREPROCESSING_VERSION,
      },
    });
    if (result.status === 'ready') {
      expect(result.pixels.bitmapWidth * result.pixels.bitmapHeight)
        .toBeLessThanOrEqual(MAX_OCR_INPUT_PIXELS);
    }
  });

  it('admits the 1206x761 media geometry at 2.25x through a bounded crop', async () => {
    const mediaMetrics = {
      ...metrics,
      left: 0,
      top: 0,
      width: 1_206,
      height: 761,
      viewportWidth: 1_206,
      viewportHeight: 761,
      devicePixelRatio: 2.25,
    };
    const environment = fakeEnvironment(fakeSource([mediaMetrics, mediaMetrics]));
    environment.decode = async () => ({
      width: 2_714,
      height: 1_712,
      close: vi.fn(),
    });
    const result = await new PixelAcquisitionCoordinator(environment)
      .acquire(descriptor);

    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.pixels.preprocessingVersion)
        .toBe(OCR_DOWNSCALED_PREPROCESSING_VERSION);
      expect(result.pixels.bitmapWidth * result.pixels.bitmapHeight)
        .toBeLessThanOrEqual(MAX_OCR_INPUT_PIXELS);
      expect(result.pixels.cropWidthCss).toBe(1_206);
      expect(result.pixels.cropHeightCss).toBe(761);
    }
  });

  it.each([
    ['permission', () => {
      throw new SourceTabCaptureError('permission');
    }],
    ['quota', () => {
      throw new SourceTabCaptureError('quota');
    }],
    ['api', () => {
      throw new Error('unclassified browser failure');
    }],
  ] as const)('reports the bounded %s capture stage', async (reason, capture) => {
    const coordinator = new PixelAcquisitionCoordinator(fakeEnvironment(
      fakeSource([metrics]),
      vi.fn(capture),
    ));

    await expect(coordinator.acquire(descriptor)).resolves.toEqual({
      status: 'deferred',
      reason,
    });
  });

  it.each([
    ['data', () => ({
      captureVisibleTab: async () => 'not-image-data',
    })],
    ['decode', () => ({
      decode: async () => {
        throw new Error('decode failed');
      },
    })],
    ['surface', () => ({
      createSurface: () => {
        throw new Error('surface failed');
      },
    })],
    ['encode', () => ({
      createSurface: (width: number, height: number) => ({
        width,
        height,
        getContext: () => ({ drawImage: vi.fn() }),
        convertToBlob: async () => {
          throw new Error('encode failed');
        },
      }),
    })],
    ['digest', () => ({
      digest: async () => {
        throw new Error('digest failed');
      },
    })],
  ] as const)('reports the bounded %s processing stage', async (reason, overrides) => {
    const environment: PixelAcquisitionEnvironment = {
      ...fakeEnvironment(fakeSource([metrics, metrics])),
      ...overrides(),
    };
    const coordinator = new PixelAcquisitionCoordinator(environment);

    await expect(coordinator.acquire(descriptor)).resolves.toEqual({
      status: 'deferred',
      reason,
    });
  });

  it('propagates capture aborts instead of relabeling them as failures', async () => {
    const coordinator = new PixelAcquisitionCoordinator(fakeEnvironment(
      fakeSource([metrics]),
      vi.fn(async () => {
        throw new DOMException('superseded', 'AbortError');
      }),
    ));

    await expect(coordinator.acquire(descriptor)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('binds viewport capture to the exact active source tab under a global lane', async () => {
    const activeIds = [4, 4];
    const events: string[] = [];
    let now = 1_000;
    const environment: SourceTabCaptureEnvironment = {
      queryActiveTab: async () => activeIds.shift(),
      captureVisibleTab: async () => {
        events.push('capture');
        return 'data:image/png;base64,AQID';
      },
      withGlobalLock: async (callback) => {
        events.push('lock');
        return callback();
      },
      now: () => now,
      delay: async (milliseconds) => {
        events.push(`delay:${milliseconds}`);
        now += milliseconds;
      },
    };

    await expect(captureVisibleSourceTab(4, 3, undefined, environment))
      .resolves.toBe('data:image/png;base64,AQID');
    expect(events).toEqual(['lock', 'capture', 'delay:550']);

    const switched = {
      ...environment,
      queryActiveTab: vi.fn()
        .mockResolvedValueOnce(4)
        .mockResolvedValueOnce(9),
    };
    await expect(captureVisibleSourceTab(4, 3, undefined, switched))
      .rejects.toMatchObject({ code: 'inactive' });

    const inactiveCapture = vi.fn(async () => 'data:image/png;base64,AQID');
    await expect(captureVisibleSourceTab(4, 3, undefined, {
      ...environment,
      queryActiveTab: async () => 9,
      captureVisibleTab: inactiveCapture,
    })).rejects.toMatchObject({ code: 'inactive' });
    expect(inactiveCapture).not.toHaveBeenCalled();
  });

  it.each([
    [
      "Either the '<all_urls>' or 'activeTab' permission is required.",
      'permission',
    ],
    ['MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND exceeded', 'quota'],
    ['The tab could not be captured.', 'api'],
  ] as const)('classifies Chrome capture rejection without exposing it', async (
    message,
    code,
  ) => {
    const environment: SourceTabCaptureEnvironment = {
      queryActiveTab: async () => 4,
      captureVisibleTab: async () => {
        throw new Error(message);
      },
      withGlobalLock: (callback) => callback(),
      now: () => 1_000,
      delay: async () => undefined,
    };

    const failure = await captureVisibleSourceTab(4, 3, undefined, environment)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SourceTabCaptureError);
    expect(failure).toMatchObject({ code });
    expect((failure as Error).message).not.toContain(message);
  });
});

function fakeSource(
  values: Array<SourceImageCaptureMetrics | undefined>,
): ImageSourceLease {
  return {
    measure: vi.fn(async () => values.shift()),
    dispose: vi.fn(),
  };
}

function fakeEnvironment(
  source: ImageSourceLease,
  captureVisibleTab = vi.fn(async () => 'data:image/png;base64,AQID'),
): PixelAcquisitionEnvironment & { decode: PixelAcquisitionEnvironment['decode'] } {
  return {
    source,
    captureVisibleTab,
    decode: async () => ({ width: 2_000, height: 1_000, close: vi.fn() }),
    createSurface: (width, height) => ({
      width,
      height,
      getContext: () => ({ drawImage: vi.fn() }),
      convertToBlob: async () => new Blob([new Uint8Array([1])], { type: 'image/png' }),
    }),
    digest: async () => new Uint8Array(32).buffer,
    delay: async () => undefined,
  };
}
