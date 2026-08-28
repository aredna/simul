import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

import {
  IMAGE_OVERLAY_LAYER_ATTRIBUTE,
  MAX_IMAGE_OVERLAY_RETAINED_WEIGHT,
  ImageOverlayProjector,
  type ImageOverlayProjection,
} from '../lib/ocr/image-overlay-projector';
import type { ReplicaImageAnchor } from '../lib/replica/contracts';

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
    methodId: 'tesseract',
    evidenceKind: 'ocr',
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
    expect(projector.project(projection({
      methodId: 'accessibility-text',
      evidenceKind: 'ocr',
    }))).toBe(false);
    expect(projector.project(projection({
      methodId: 'tesseract',
      evidenceKind: 'semantic',
    }))).toBe(false);
    expect(projector.project(projection({
      evidenceKind: 'forged' as 'ocr',
    }))).toBe(false);
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

  it('rebases identical projection currency on the existing overlay root', () => {
    const { document } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const bounds = { left: 10, top: 20, width: 100, height: 60 };
    image.getBoundingClientRect = () => ({
      ...bounds,
      right: bounds.left + bounds.width,
      bottom: bounds.top + bounds.height,
      x: bounds.left,
      y: bounds.top,
      toJSON: () => ({}),
    });
    let currentObservation = 4;
    const projector = new ImageOverlayProjector({
      resolveAnchor: () => ({
        document: sourceDocument,
        replayLease: 9,
        image,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      isCurrent: (candidate) =>
        candidate.observationRevision === currentObservation,
      scheduleFrame: (callback) => { callback(); return 1; },
      cancelFrame: () => undefined,
      createResizeObserver: () => undefined,
    });
    projector.beginPair(1, 'en>ja');
    expect(projector.project(projection())).toBe(true);
    const originalRoot = document.querySelector(
      '[data-simul-image-overlay="7"]',
    );
    const originalRegion = originalRoot?.firstElementChild;

    bounds.left = 30;
    bounds.top = 40;
    currentObservation = 5;
    expect(projector.project(projection({
      jobOrdinal: 2,
      contentRevision: 2,
      observationRevision: 5,
    }))).toBe(true);

    const rebasedRoot = document.querySelector(
      '[data-simul-image-overlay="7"]',
    ) as HTMLElement | null;
    expect(rebasedRoot).toBe(originalRoot);
    expect(rebasedRoot?.firstElementChild).toBe(originalRegion);
    expect(rebasedRoot?.style.left).toBe('30px');
    expect(rebasedRoot?.style.top).toBe('40px');
  });

  it('updates position on scroll without refitting text at stable dimensions', () => {
    const { document, window } = parseHTML('<html><body><img></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    const bounds = { left: 10, top: 20, width: 100, height: 60 };
    image.getBoundingClientRect = () => ({
      ...bounds,
      right: bounds.left + bounds.width,
      bottom: bounds.top + bounds.height,
      x: bounds.left,
      y: bounds.top,
      toJSON: () => ({}),
    });
    const frames: Array<() => void> = [];
    const projector = new ImageOverlayProjector({
      resolveAnchor: () => ({
        document: sourceDocument,
        replayLease: 9,
        image,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      isCurrent: () => true,
      scheduleFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: () => undefined,
      createResizeObserver: () => undefined,
    });
    projector.beginPair(1, 'en>ja');
    expect(projector.project(projection())).toBe(true);
    const root = document.querySelector(
      '[data-simul-image-overlay="7"]',
    ) as HTMLElement;
    const region = root.firstElementChild as HTMLElement;
    let fittingReads = 0;
    Object.defineProperties(region, {
      scrollWidth: {
        configurable: true,
        get: () => {
          fittingReads += 1;
          return 0;
        },
      },
      scrollHeight: {
        configurable: true,
        get: () => {
          fittingReads += 1;
          return 0;
        },
      },
    });

    bounds.left = 35;
    bounds.top = 45;
    window.dispatchEvent(new window.Event('scroll'));
    frames.splice(0).forEach((frame) => frame());

    expect(root.style.left).toBe('35px');
    expect(root.style.top).toBe('45px');
    expect(fittingReads).toBe(0);
  });

  it('evicts the oldest overlays before retained DOM weight exceeds its bound', () => {
    const { document } = parseHTML(
      `<html><body>${'<img>'.repeat(5)}</body></html>`,
    );
    const images = [...document.querySelectorAll('img')] as HTMLImageElement[];
    const anchors = new Map<number, ReplicaImageAnchor>();
    images.forEach((image, index) => {
      image.getBoundingClientRect = () => ({
        left: index * 110,
        top: 0,
        width: 100,
        height: 60,
        right: index * 110 + 100,
        bottom: 60,
        x: index * 110,
        y: 0,
        toJSON: () => ({}),
      });
      anchors.set(index + 1, {
        document: sourceDocument,
        replayLease: 9,
        image,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      });
    });
    const projector = new ImageOverlayProjector({
      resolveAnchor: (_document, nodeId) => anchors.get(nodeId),
      isCurrent: () => true,
      scheduleFrame: (callback) => { callback(); return 1; },
      cancelFrame: () => undefined,
      createResizeObserver: () => undefined,
    });
    projector.beginPair(1, 'en>ja');
    const retainedText = 'x'.repeat(100_000);
    for (let nodeId = 1; nodeId <= 5; nodeId += 1) {
      expect(projector.project(projection({
        jobOrdinal: nodeId,
        nodeId,
        regions: [{
          text: retainedText,
          boundingBox: { x: 0, y: 0, width: 40, height: 20 },
        }],
      }))).toBe(true);
    }

    expect(MAX_IMAGE_OVERLAY_RETAINED_WEIGHT).toBe(1_000_000);
    expect(document.querySelector('[data-simul-image-overlay="1"]')).toBeNull();
    expect(document.querySelector('[data-simul-image-overlay="5"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-simul-image-overlay]').length)
      .toBeLessThan(5);
  });
});
