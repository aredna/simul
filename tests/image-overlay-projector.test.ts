import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

import {
  IMAGE_OVERLAY_ELEMENT,
  IMAGE_OVERLAY_MOTION_FRAMES,
  MAX_IMAGE_OVERLAY_RETAINED_WEIGHT,
  ImageOverlayProjector,
  captionBandBox,
  findImageOverlays,
  imageOverlayContent,
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

/** An overlay by its node id, in the light tree or an owned shadow root. */
function overlayFor(document: unknown, nodeId: number): HTMLElement | null {
  return findImageOverlays(document as Document).find(
    (root) => root.dataset.simulImageOverlay === String(nodeId),
  ) ?? null;
}

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

  it('maps a visible crop onto an inert overlay in the image parent, out of sight of page selectors (D74, D92)', () => {
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

    const root = overlayFor(document, 7) as HTMLElement;
    const content = imageOverlayContent(root) as HTMLElement;
    const region = content?.firstElementChild as HTMLElement;
    // In the image's parent, so the page's stacking decides what paints over
    // it (no z-index of its own), but in the parent's closed Simul-owned
    // shadow root after a slot: the page's children, and selectors such as
    // `img + p` or `:last-child`, see no new sibling (D92).
    expect(root.localName).toBe(IMAGE_OVERLAY_ELEMENT);
    const main = document.querySelector('main')!;
    const shadow = root.parentNode as unknown as ShadowRoot;
    expect(shadow.host).toBe(main);
    expect(shadow.firstChild?.nodeName.toLowerCase()).toBe('slot');
    expect(main.shadowRoot).toBeNull();
    expect(image.nextSibling).toBeNull();
    expect(main.childNodes).toHaveLength(1);
    expect(document.querySelector(IMAGE_OVERLAY_ELEMENT)).toBeNull();
    expect(root.style.zIndex).toBe('');
    expect(root.style.position).toBe('absolute');
    expect(root.style.pointerEvents).toBe('none');
    // The boxes are in a closed shadow root, out of reach of page CSS.
    expect(root.childNodes).toHaveLength(0);
    expect(root.hidden).toBe(false);
    expect(root.style.left).toBe('10px');
    expect(root.style.top).toBe('30px');
    expect(root.style.width).toBe('200px');
    expect(content.style.left).toBe('0px');
    expect(content.style.width).toBe('200px');
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
    expect((findImageOverlays(document as unknown as Document)[0] ?? null)).toBeNull();
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

    const root = overlayFor(document, 7) as HTMLElement;
    const band = imageOverlayContent(root)?.firstElementChild as HTMLElement;
    // 34% of the 120px image, pinned to the bottom edge, full width.
    expect(band.style.left).toBe('0px');
    expect(band.style.width).toBe('200px');
    expect(band.style.height).toBe('40.8px');
    expect(band.style.top).toBe('79.2px');
    projector.dispose();
  });

  it('grows the caption band on a short image only when its text would be illegible (O3)', () => {
    const bandFor = (text: string) => {
      const { document } = parseHTML('<html><body><main><img></main></body></html>');
      const image = document.querySelector('img') as unknown as HTMLImageElement;
      image.getBoundingClientRect = () => ({
        left: 0, top: 0, width: 200, height: 60,
        right: 200, bottom: 60, x: 0, y: 0, toJSON: () => ({}),
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
      projector.beginPair(1, 'en>ja');
      projector.project(projection({
        methodId: 'accessibility-text',
        evidenceKind: 'semantic',
        bitmapWidth: 200,
        bitmapHeight: 60,
        regions: [{ text, boundingBox: { x: 0, y: 0, width: 200, height: 60 }, placement: 'whole-image' }],
      }));
      const band = imageOverlayContent(
        overlayFor(document, 7),
      )!.firstElementChild as HTMLElement;
      const result = { height: band.style.height, top: band.style.top };
      projector.dispose();
      return result;
    };
    // A short caption keeps the usual third of the image (20.4px here).
    expect(bandFor('Menu')).toEqual({ height: '20.4px', top: '39.6px' });
    // Long alt text would shrink below 9px, so the band grows to 60%.
    expect(bandFor('A long description of the photograph for screen readers '.repeat(4)))
      .toEqual({ height: '36px', top: '24px' });
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

    const regions = [...imageOverlayContent(
      overlayFor(document, 7),
    )!.children] as HTMLElement[];
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

    expect((findImageOverlays(document as unknown as Document)[0] ?? null)).toBeNull();
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

    const root = overlayFor(document, 7) as HTMLElement | null;
    expect(root?.style.left).toBe('30px');
    expect(root?.style.top).toBe('40px');
    expect((root?.parentNode as unknown as ShadowRoot).host)
      .toBe(document.querySelector('main'));
    expect(imageOverlayContent(root)?.textContent).toBe('翻訳');
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
    const originalRoot = overlayFor(document, 7);
    const originalRegion = imageOverlayContent(originalRoot)?.firstElementChild;

    bounds.left = 30;
    bounds.top = 40;
    currentObservation = 5;
    expect(projector.project(projection({
      jobOrdinal: 2,
      contentRevision: 2,
      observationRevision: 5,
    }))).toBe(true);

    const rebasedRoot = overlayFor(document, 7) as HTMLElement | null;
    expect(rebasedRoot).toBe(originalRoot);
    expect(imageOverlayContent(rebasedRoot)?.firstElementChild).toBe(originalRegion);
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
    const root = overlayFor(document, 7) as HTMLElement;
    const region = imageOverlayContent(root)?.firstElementChild as HTMLElement;
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

  it('puts the overlay back in its image parent when the mirror rewrites it (D74, D92)', () => {
    const { document } = parseHTML(
      '<html><body><main><img><p>caption</p></main><section></section></body></html>',
    );
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    image.getBoundingClientRect = () => ({
      left: 10, top: 20, width: 100, height: 60,
      right: 110, bottom: 80, x: 10, y: 20, toJSON: () => ({}),
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
      scheduleFrame: (callback) => { frames.push(callback); return frames.length; },
      cancelFrame: () => undefined,
      createResizeObserver: () => undefined,
    });
    const refresh = () => {
      projector.refresh();
      frames.splice(0).forEach((frame) => frame());
    };
    projector.beginPair(1, 'en>ja');
    expect(projector.project(projection())).toBe(true);
    const root = (findImageOverlays(document as unknown as Document)[0] ?? null) as HTMLElement;
    const hostOf = () => (root.parentNode as unknown as ShadowRoot | null)?.host;
    const caption = document.querySelector('p')!;
    expect(hostOf()).toBe(document.querySelector('main'));
    expect(image.nextSibling).toBe(caption);

    // A reconcile reordered the parent's children: nothing to move.
    caption.after(image);
    refresh();
    expect(hostOf()).toBe(document.querySelector('main'));

    // Something dropped the overlay.
    root.remove();
    refresh();
    expect(hostOf()).toBe(document.querySelector('main'));

    // The image itself moved to another parent.
    document.querySelector('section')!.append(image);
    refresh();
    expect(hostOf()).toBe(document.querySelector('section'));
    expect(image.nextSibling).toBeNull();
    expect(findImageOverlays(document as unknown as Document)).toHaveLength(1);
    projector.dispose();
    expect(findImageOverlays(document as unknown as Document)).toHaveLength(0);
  });

  it('keeps the overlay right after the image where the parent cannot host it (D92)', () => {
    const { document } = parseHTML(
      '<html><body><a href="/x"><img id="linked"></a>' +
      '<figure><img id="figure"><figcaption>c</figcaption></figure>' +
      '<div id="mirrored"><img id="shadowed"></div></body></html>',
    );
    // A parent with its own (mirrored, open) shadow root cannot take another.
    document.querySelector('#mirrored')!.attachShadow({ mode: 'open' });
    const images = new Map<number, HTMLImageElement>();
    for (const [nodeId, id] of [[1, 'linked'], [2, 'figure'], [3, 'shadowed']] as const) {
      const image = document.querySelector(`#${id}`) as unknown as HTMLImageElement;
      image.getBoundingClientRect = () => ({
        left: 0, top: 0, width: 100, height: 60,
        right: 100, bottom: 60, x: 0, y: 0, toJSON: () => ({}),
      });
      images.set(nodeId, image);
    }
    const projector = new ImageOverlayProjector({
      resolveAnchor: (_document, nodeId) => ({
        document: sourceDocument,
        replayLease: 9,
        image: images.get(nodeId)!,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      isCurrent: () => true,
      scheduleFrame: (callback) => { callback(); return 1; },
      cancelFrame: () => undefined,
      createResizeObserver: () => undefined,
    });
    projector.beginPair(1, 'en>ja');
    for (const nodeId of [1, 2, 3]) {
      expect(projector.project(projection({ jobOrdinal: nodeId, nodeId })))
        .toBe(true);
      expect(images.get(nodeId)!.nextSibling).toBe(overlayFor(document, nodeId));
    }
    projector.dispose();
  });

  it('positions the overlay by measuring its containing block, including a scale (D74)', () => {
    const { document } = parseHTML('<html><body><main><img></main></body></html>');
    const image = document.querySelector('img') as unknown as HTMLImageElement;
    // The image renders at 200×120 at (100, 80) inside an ancestor scaled
    // by 0.5 whose origin is at (40, 70) in the viewport.
    image.getBoundingClientRect = () => ({
      left: 100, top: 80, width: 200, height: 120,
      right: 300, bottom: 200, x: 100, y: 80, toJSON: () => ({}),
    });
    const origin = { x: 40, y: 70 };
    const scale = 0.5;
    let jitter = 0;
    let measurements = 0;
    const frames: Array<() => void> = [];
    const projector = new ImageOverlayProjector({
      resolveAnchor: () => ({
        document: sourceDocument,
        replayLease: 9,
        image,
        iframe: { contentDocument: document } as HTMLIFrameElement,
      }),
      isCurrent: () => true,
      scheduleFrame: (callback) => { frames.push(callback); return frames.length; },
      cancelFrame: () => undefined,
      createResizeObserver: () => undefined,
    });
    projector.beginPair(1, 'en>ja');
    const originalCreate = document.createElement.bind(document);
    let root: HTMLElement | undefined;
    document.createElement = ((name: string) => {
      const element = originalCreate(name) as HTMLElement;
      if (name === IMAGE_OVERLAY_ELEMENT) {
        root = element;
        element.getBoundingClientRect = () => {
          measurements += 1;
          const css = (property: string) => Number.parseFloat(element.style.getPropertyValue(property));
          const left = origin.x + scale * css('left') + jitter;
          const top = origin.y + scale * css('top');
          const width = scale * css('width') + jitter;
          const height = scale * css('height');
          return {
            left, top, width, height,
            right: left + width, bottom: top + height, x: left, y: top,
            toJSON: () => ({}),
          };
        };
      }
      return element;
    }) as typeof document.createElement;
    expect(projector.project(projection({
      renderedWidthCss: 200,
      renderedHeightCss: 120,
      cropOffsetXCss: 0,
      cropOffsetYCss: 0,
      cropWidthCss: 200,
      cropHeightCss: 120,
    }))).toBe(true);
    document.createElement = originalCreate;
    const content = imageOverlayContent(root) as HTMLElement;
    // (100 - 40) / 0.5 = 120 and (80 - 70) / 0.5 = 20, in the ancestor's
    // CSS pixels; the image's 200×120 is 400×240 there.
    expect(root?.style.left).toBe('120px');
    expect(root?.style.top).toBe('20px');
    expect(root?.style.width).toBe('400px');
    expect(root?.style.height).toBe('240px');
    expect(content.style.width).toBe('400px');
    const region = content.firstElementChild as HTMLElement;
    // The 40px-wide OCR box is 100 CSS px of the image, 200px in the ancestor.
    expect(region.style.width).toBe('200px');

    // Sub-pixel layout rounding neither moves nor refits a settled overlay.
    let fittingReads = 0;
    Object.defineProperty(region, 'scrollWidth', {
      configurable: true,
      get: () => { fittingReads += 1; return 0; },
    });
    jitter = 0.01;
    const before = measurements;
    projector.refresh();
    frames.splice(0).forEach((frame) => frame());
    expect(measurements).toBeGreaterThan(before);
    expect(root?.style.left).toBe('120px');
    expect(root?.style.width).toBe('400px');
    expect(fittingReads).toBe(0);
    projector.dispose();
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
      const root = overlayFor(document, 7) as HTMLElement;
      const content = imageOverlayContent(root) as HTMLElement;
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
        content,
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
      expect(view.root.style.left).toBe('0px');
      expect(view.root.style.width).toBe('300px');

      // Halfway through a move: 200px of the slide are still inside the window.
      // The overlay covers only those 200px, so it never reaches past the
      // window into the page's scrollable area; its content is shifted.
      view.imageBox.left = -100;
      view.window.dispatchEvent(new view.window.Event('scroll'));
      view.runFrames();
      expect(view.root.hidden).toBe(false);
      expect(view.root.style.left).toBe('0px');
      expect(view.root.style.width).toBe('200px');
      expect(view.content.style.left).toBe('-100px');
      expect(view.content.style.width).toBe('300px');

      // The slide has left the window: its caption must not show beside it.
      view.imageBox.left = 300;
      view.window.dispatchEvent(new view.window.Event('scroll'));
      view.runFrames();
      expect(view.root.hidden).toBe(true);

      view.imageBox.left = 0;
      view.window.dispatchEvent(new view.window.Event('scroll'));
      view.runFrames();
      expect(view.root.hidden).toBe(false);
      expect(view.root.style.width).toBe('300px');
      expect(view.content.style.left).toBe('0px');
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
      expect(view.root.style.width).toBe('150px');
      expect(view.frames).toHaveLength(1);

      view.imageBox.left = 0;
      view.runFrames(1);
      expect(view.root.style.left).toBe('0px');
      expect(view.root.style.width).toBe('300px');

      // Following stops on its own, well within the frame budget.
      expect(view.runFrames()).toBeLessThanOrEqual(IMAGE_OVERLAY_MOTION_FRAMES);
      expect(view.frames).toHaveLength(0);

      // A motion longer than the budget still settles on its end event.
      view.imageBox.left = -40;
      view.motion(view.track, 'transitionend');
      view.runFrames();
      expect(view.root.style.width).toBe('260px');
      expect(view.content.style.left).toBe('-40px');
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
    expect(overlayFor(document, 1)).toBeNull();
    expect(overlayFor(document, 5)).not.toBeNull();
    expect(findImageOverlays(document as unknown as Document).length)
      .toBeLessThan(5);
  });
});
