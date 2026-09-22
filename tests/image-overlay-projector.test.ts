import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

import {
  IMAGE_OVERLAY_LAYER_ATTRIBUTE,
  IMAGE_OVERLAY_MOTION_FRAMES,
  MAX_IMAGE_OVERLAY_RETAINED_WEIGHT,
  ImageOverlayProjector,
  captionBandBox,
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

  it('shows a label-based translation as a caption band along the bottom edge, not over the whole image (D48)', () => {
    const { document } = parseHTML('<html><body><main><img></main></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    image.getBoundingClientRect = () => ({
      left: 10, top: 30, width: 200, height: 120,
      right: 210, bottom: 150, x: 10, y: 30, toJSON: () => ({}),
    });
    const projector = new ImageOverlayProjector({
      resolveAnchor: () => ({
        document: sourceDocument,
        replayLease: 9,
        image,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      isCurrent: () => true,
      scheduleFrame: (callback) => {
        callback();
        return 1;
      },
      cancelFrame: () => undefined,
      createResizeObserver: () => undefined,
    });
    expect(projector.beginPair(1, 'en>ja')).toBe(true);
    expect(projector.project(projection({
      methodId: 'accessibility-text',
      evidenceKind: 'semantic',
      bitmapWidth: 160,
      bitmapHeight: 80,
      // An accessibility label has no geometry: the controller hands the
      // projector the whole rendered image as its box.
      regions: [{
        text: 'For individuals: file your tax return with freee',
        boundingBox: { x: 0, y: 0, width: 160, height: 80 },
        placement: 'whole-image',
      }],
    }))).toBe(true);

    const root = document.querySelector('[data-simul-image-overlay="7"]') as HTMLElement;
    const band = root.firstElementChild as HTMLElement;
    // 34% of the 120px image, pinned to the bottom edge, full width.
    expect(band.style.left).toBe('0px');
    expect(band.style.width).toBe('200px');
    expect(band.style.height).toBe('40.8px');
    expect(band.style.top).toBe('79.2px');
    projector.dispose();
  });

  it('keeps a caption band at least 20px tall on a short image', () => {
    expect(captionBandBox(300, 40)).toEqual({ x: 0, y: 20, width: 300, height: 20 });
    expect(captionBandBox(300, 12)).toEqual({ x: 0, y: 0, width: 300, height: 12 });
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

  describe('carousel geometry (D52)', () => {
    type Box = { left: number; top: number; width: number; height: number };
    const rectOf = (box: Box) => ({
      ...box,
      right: box.left + box.width,
      bottom: box.top + box.height,
      x: box.left,
      y: box.top,
      toJSON: () => ({}),
    });

    /**
     * A 300×200 carousel window (`overflow: hidden`) around a moving track
     * that holds one 300×200 slide image, like Swiper's container, wrapper
     * and slide.
     */
    function carousel() {
      const { document, window } = parseHTML(`<html><body>
        <div class="window"><div class="track"><img></div></div>
        <aside class="elsewhere"></aside>
      </body></html>`);
      const windowElement = document.querySelector('.window') as unknown as HTMLElement;
      const track = document.querySelector('.track') as unknown as HTMLElement;
      const elsewhere = document.querySelector('.elsewhere') as unknown as HTMLElement;
      const image = document.querySelector('img') as unknown as HTMLImageElement;
      const imageBox: Box = { left: 0, top: 0, width: 300, height: 200 };
      image.getBoundingClientRect = () => rectOf(imageBox);
      windowElement.getBoundingClientRect = () =>
        rectOf({ left: 0, top: 0, width: 300, height: 200 });
      let painted = true;
      Object.assign(image, { checkVisibility: () => painted });
      Object.assign(window, {
        getComputedStyle: (element: Element) => ({
          position: 'static',
          overflowX: element === windowElement ? 'hidden' : 'visible',
          overflowY: element === windowElement ? 'hidden' : 'visible',
          contain: 'none',
          transform: 'none',
          filter: 'none',
        }),
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
      expect(projector.project(projection({
        renderedWidthCss: 300,
        renderedHeightCss: 200,
        cropOffsetXCss: 0,
        cropOffsetYCss: 0,
        cropWidthCss: 300,
        cropHeightCss: 200,
      }))).toBe(true);
      const root = document.querySelector(
        '[data-simul-image-overlay="7"]',
      ) as HTMLElement;
      const runFrames = (limit = 1_000) => {
        let ran = 0;
        while (frames.length > 0 && ran < limit) {
          frames.shift()?.();
          ran += 1;
        }
        return ran;
      };
      const motion = (target: HTMLElement, type: string) =>
        target.dispatchEvent(new window.Event(type, { bubbles: true }));
      return {
        window,
        track,
        elsewhere,
        imageBox,
        root,
        frames,
        projector,
        runFrames,
        motion,
        setPainted: (value: boolean) => {
          painted = value;
        },
      };
    }

    it('clips an overlay to the part of its image the carousel window shows', () => {
      const view = carousel();
      expect(view.root.hidden).toBe(false);
      expect(view.root.style.clipPath).toBe('');

      // Halfway through a move: 200px of the slide are still inside the window.
      view.imageBox.left = -100;
      view.window.dispatchEvent(new view.window.Event('scroll'));
      view.runFrames();
      expect(view.root.hidden).toBe(false);
      expect(view.root.style.left).toBe('-100px');
      expect(view.root.style.clipPath).toBe('inset(0px 0px 0px 100px)');

      // The slide has left the window: its caption must not show beside it.
      view.imageBox.left = 300;
      view.window.dispatchEvent(new view.window.Event('scroll'));
      view.runFrames();
      expect(view.root.hidden).toBe(true);

      view.imageBox.left = 0;
      view.window.dispatchEvent(new view.window.Event('scroll'));
      view.runFrames();
      expect(view.root.hidden).toBe(false);
      expect(view.root.style.clipPath).toBe('');
    });

    it('hides an overlay while its image is not painted, as on a faded-out slide', () => {
      const view = carousel();
      view.setPainted(false);
      view.projector.refresh();
      view.runFrames();
      expect(view.root.hidden).toBe(true);

      view.setPainted(true);
      view.projector.refresh();
      view.runFrames();
      expect(view.root.hidden).toBe(false);
    });

    it('follows a slide transition frame by frame and settles when it ends', () => {
      const view = carousel();
      view.imageBox.left = 300;
      view.projector.refresh();
      view.runFrames();
      expect(view.root.hidden).toBe(true);

      // The track starts sliding the image in; nothing else re-measures.
      view.motion(view.track, 'transitionrun');
      expect(view.frames).toHaveLength(1);
      view.imageBox.left = 150;
      view.runFrames(1);
      expect(view.root.hidden).toBe(false);
      expect(view.root.style.left).toBe('150px');
      expect(view.root.style.clipPath).toBe('inset(0px 150px 0px 0px)');
      expect(view.frames).toHaveLength(1);

      view.imageBox.left = 0;
      view.runFrames(1);
      expect(view.root.style.left).toBe('0px');
      expect(view.root.style.clipPath).toBe('');

      // Following stops on its own, well within the frame budget.
      expect(view.runFrames()).toBeLessThanOrEqual(IMAGE_OVERLAY_MOTION_FRAMES);
      expect(view.frames).toHaveLength(0);

      // A motion longer than the budget still settles on its end event.
      view.imageBox.left = -40;
      view.motion(view.track, 'transitionend');
      view.runFrames();
      expect(view.root.style.left).toBe('-40px');
      expect(view.frames).toHaveLength(0);
    });

    it('ignores transitions on elements that do not contain an overlaid image', () => {
      const view = carousel();
      view.runFrames();
      view.motion(view.elsewhere, 'transitionrun');
      view.motion(view.elsewhere, 'animationstart');
      expect(view.frames).toHaveLength(0);
    });

    it('stops listening for motion once the layer is disposed', () => {
      const view = carousel();
      view.runFrames();
      view.projector.dispose();
      view.motion(view.track, 'transitionrun');
      expect(view.frames).toHaveLength(0);
    });
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
