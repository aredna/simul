import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

import {
  IMAGE_OVERLAY_LAYER_ATTRIBUTE,
  ImageOverlayProjector,
  type ImageOverlayProjection,
} from '../lib/ocr/image-overlay-projector';
import type { ReplicaImageAnchor } from '../lib/replica/rrweb-shadow-engine';

const sourceDocument = {
  sessionId: 'image-overlay-session',
  pageEpoch: 2,
  generation: 2,
  documentId: 'image-overlay-document',
  frameId: 0,
};

function projection(
  overrides: Partial<ImageOverlayProjection> = {},
): ImageOverlayProjection {
  return {
    jobOrdinal: 1,
    document: sourceDocument,
    nodeId: 7,
    contentRevision: 3,
    observationRevision: 4,
    replayLease: 9,
    pairEpoch: 1,
    pairKey: 'en>ja',
    pixelHash: 'ab'.repeat(32),
    bitmapWidth: 80,
    bitmapHeight: 40,
    cropOffsetXCss: 20,
    cropOffsetYCss: 10,
    cropWidthCss: 80,
    cropHeightCss: 40,
    renderedWidthCss: 100,
    renderedHeightCss: 60,
    regions: [{
      text: '翻訳',
      boundingBox: { x: 0, y: 0, width: 40, height: 20 },
    }],
    ...overrides,
  };
}

describe('ImageOverlayProjector', () => {
  it('schedules and cancels overlay refreshes without adopting the projector receiver', () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    image.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 100, height: 60,
      right: 100, bottom: 60, x: 0, y: 0, toJSON: () => ({}),
    });
    const anchor = {
      document: sourceDocument,
      replayLease: 9,
      image,
      iframe: { contentDocument: document } as HTMLIFrameElement,
    };
    const receivers: unknown[] = [];
    const scheduleFrame = function (
      this: unknown,
      _callback: () => void,
    ): number {
      receivers.push(this);
      return 43;
    };
    const cancelFrame = function (this: unknown, _handle: number): void {
      receivers.push(this);
    };
    const projector = new ImageOverlayProjector({
      resolveAnchor: () => anchor,
      isCurrent: () => true,
      scheduleFrame,
      cancelFrame,
      createResizeObserver: () => undefined,
    });
    projector.beginPair(1, 'en>ja');
    expect(projector.project(projection())).toBe(true);

    projector.refresh();
    expect(receivers).toEqual([undefined]);
    projector.dispose();
    expect(receivers).toEqual([undefined, undefined]);
  });

  it('maps a visible crop onto an inert sibling layer without changing image layout', () => {
    const { document, window } = parseHTML('<html><body><main><img></main></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    image.getBoundingClientRect = () => ({
      left: 10,
      top: 30,
      width: 200,
      height: 120,
      right: 210,
      bottom: 150,
      x: 10,
      y: 30,
      toJSON: () => ({}),
    });
    const iframe = { contentDocument: document } as HTMLIFrameElement;
    const anchor: ReplicaImageAnchor = {
      document: sourceDocument,
      replayLease: 9,
      image,
      iframe,
    };
    const current = vi.fn(() => true);
    const projector = new ImageOverlayProjector({
      resolveAnchor: () => anchor,
      isCurrent: current,
      scheduleFrame: (callback) => {
        callback();
        return 1;
      },
      cancelFrame: () => undefined,
      createResizeObserver: () => undefined,
    });
    expect(projector.beginPair(1, 'en>ja')).toBe(true);

    expect(projector.project(projection({
      bitmapWidth: 160,
      bitmapHeight: 80,
      regions: [{
        text: '翻訳',
        boundingBox: { x: 0, y: 0, width: 80, height: 40 },
      }],
    }))).toBe(true);

    const layer = document.querySelector(`[${IMAGE_OVERLAY_LAYER_ATTRIBUTE}]`);
    const root = layer?.querySelector('[data-simul-image-overlay="7"]') as HTMLElement;
    const region = root?.firstElementChild as HTMLElement;
    expect(layer?.parentElement).toBe(document.body);
    expect(image.parentElement?.tagName.toLowerCase()).toBe('main');
    expect(root.style.left).toBe('10px');
    expect(root.style.top).toBe('30px');
    expect(root.style.width).toBe('200px');
    expect(region.textContent).toBe('翻訳');
    expect(region.style.left).toBe('40px');
    expect(region.style.top).toBe('20px');
    expect(region.style.width).toBe('80px');
    expect(region.style.height).toBe('40px');
    expect(region.style.whiteSpace).toBe('normal');
    expect(region.style.overflowWrap).toBe('anywhere');
    expect(region.style.wordBreak).toBe('break-word');
    expect(region.style.lineHeight).toBe('1.12');
    expect(region.style.pointerEvents).toBe('none');
    expect(current).toHaveBeenCalled();
    projector.dispose();
    expect(document.querySelector(`[${IMAGE_OVERLAY_LAYER_ATTRIBUTE}]`)).toBeNull();
    expect(window).toBeDefined();
  });

  it('wraps and downscales long Latin and CJK translations inside fixed OCR boxes', () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    image.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 100, height: 60,
      right: 100, bottom: 60, x: 0, y: 0, toJSON: () => ({}),
    });
    const projector = new ImageOverlayProjector({
      resolveAnchor: () => ({
        document: sourceDocument,
        replayLease: 9,
        image,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      isCurrent: () => true,
      scheduleFrame: (callback) => { callback(); return 1; },
      cancelFrame: () => undefined,
      createResizeObserver: () => undefined,
    });
    projector.beginPair(1, 'en>ja');
    expect(projector.project(projection({
      bitmapWidth: 100,
      bitmapHeight: 60,
      cropOffsetXCss: 0,
      cropOffsetYCss: 0,
      cropWidthCss: 100,
      cropHeightCss: 60,
      renderedWidthCss: 100,
      renderedHeightCss: 60,
      regions: [
        {
          text: 'OK',
          boundingBox: { x: 0, y: 0, width: 50, height: 30 },
        },
        {
          text: '非常に長い翻訳テキストが小さな領域でも折り返されます',
          boundingBox: { x: 50, y: 0, width: 50, height: 30 },
        },
      ],
    }))).toBe(true);

    const regions = [...document.querySelectorAll(
      '[data-simul-image-overlay="7"] > span',
    )] as HTMLElement[];
    expect(regions).toHaveLength(2);
    expect(Number.parseFloat(regions[1]!.style.fontSize)).toBeLessThan(
      Number.parseFloat(regions[0]!.style.fontSize),
    );
    expect(regions[1]!.style.overflow).toBe('hidden');
    expect(regions[1]!.style.whiteSpace).toBe('normal');
  });

  it('rejects stale leases/geometry and removes projections after pair currentness changes', () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    image.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 100, height: 60,
      right: 100, bottom: 60, x: 0, y: 0, toJSON: () => ({}),
    });
    const anchor = {
      document: sourceDocument,
      replayLease: 9,
      image,
      iframe: { contentDocument: document } as HTMLIFrameElement,
    };
    let current = true;
    const frames: Array<() => void> = [];
    const projector = new ImageOverlayProjector({
      resolveAnchor: () => anchor,
      isCurrent: () => current,
      scheduleFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: () => undefined,
      createResizeObserver: () => undefined,
    });
    projector.beginPair(1, 'en>ja');
    expect(projector.project(projection({ replayLease: 8 }))).toBe(false);
    expect(projector.project(projection({ cropWidthCss: 90 }))).toBe(false);
    expect(projector.project(projection())).toBe(true);

    current = false;
    projector.refresh();
    frames.splice(0).forEach((frame) => frame());

    expect(document.querySelector(`[${IMAGE_OVERLAY_LAYER_ATTRIBUTE}]`)).toBeNull();
    expect(projector.project(projection())).toBe(false);
    expect(projector.beginPair(2, 'en>es')).toBe(true);
  });

  it('rebinds a same-lease replacement image without discarding its overlay', () => {
    const { document } = parseHTML('<html><body><main><img></main></body></html>');
    const first = document.querySelector('img') as unknown as HTMLImageElement;
    const replacement = document.createElement('img') as unknown as HTMLImageElement;
    first.getBoundingClientRect = () => ({
      left: 10, top: 20, width: 100, height: 60,
      right: 110, bottom: 80, x: 10, y: 20, toJSON: () => ({}),
    });
    replacement.getBoundingClientRect = () => ({
      left: 30, top: 40, width: 120, height: 70,
      right: 150, bottom: 110, x: 30, y: 40, toJSON: () => ({}),
    });
    const iframe = { contentDocument: document } as HTMLIFrameElement;
    let image = first;
    const rebound = vi.fn();
    const projector = new ImageOverlayProjector({
      resolveAnchor: () => ({
        document: sourceDocument,
        replayLease: 9,
        image,
        iframe,
      }),
      isCurrent: () => true,
      scheduleFrame: (callback) => { callback(); return 1; },
      cancelFrame: () => undefined,
      createResizeObserver: () => undefined,
      onAnchorRebound: rebound,
    });
    projector.beginPair(1, 'en>ja');
    expect(projector.project(projection({ jobOrdinal: 17 }))).toBe(true);

    first.replaceWith(replacement);
    image = replacement;
    projector.refresh();

    const root = document.querySelector(
      '[data-simul-image-overlay="7"]',
    ) as HTMLElement | null;
    expect(root?.style.left).toBe('30px');
    expect(root?.style.top).toBe('40px');
    expect(root?.textContent).toBe('翻訳');
    expect(rebound).toHaveBeenCalledOnce();
    expect(rebound).toHaveBeenCalledWith(17);
  });
});
