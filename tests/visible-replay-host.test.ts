import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

import {
  LIVE_REPLAY_LABEL,
  STATIC_REPLAY_LABEL,
  VisibleReplayHost,
  type VisibleReplayCandidateLease,
} from '../lib/replica/visible-replay-host';

describe('visible isolated replay host', () => {
  it('uses canonical replica labels without claiming fallback bugs are fixed', () => {
    expect(STATIC_REPLAY_LABEL).toBe('Replica reconnecting');
    expect(LIVE_REPLAY_LABEL).toBe('Live page replica');
    expect(`${STATIC_REPLAY_LABEL} ${LIVE_REPLAY_LABEL}`).not.toMatch(/exact|perfect/iu);
  });

  it('keeps candidates hidden, commits atomically, and labels the static preview', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const iframe = createProtectedIframe(fixture.document);
    candidate.mount.append(iframe);

    expect(fixture.preview.hidden).toBe(true);
    expect(candidate.mount.closest('[data-simul-replica-candidate]')).not.toBeNull();

    candidate.commit(iframe, { width: 1_400, height: 2_500 });

    expect(fixture.preview.hidden).toBe(false);
    expect(fixture.preview.children).toHaveLength(1);
    expect(fixture.badge.hidden).toBe(false);
    expect(fixture.badge.textContent).toBe(STATIC_REPLAY_LABEL);
    expect(iframe.getAttribute('width')).toBe('1200');
    expect(iframe.getAttribute('height')).toBe('700');
    expect(iframe.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(iframe.hasAttribute('inert')).toBe(true);
  });

  it('exposes the committed replica to assistive technology (D118)', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const iframe = createProtectedIframe(fixture.document);
    candidate.mount.append(iframe);
    const root = requireElement<HTMLElement>(
      fixture.preview,
      '[data-simul-replica-candidate]',
    );
    // A candidate is not what the panel shows yet.
    expect(root.getAttribute('aria-hidden')).toBe('true');
    expect(iframe.getAttribute('aria-hidden')).toBe('true');
    expect(fixture.host.setInteractiveAccessibility(iframe, true)).toBe(false);

    candidate.commit(iframe, { width: 1_400, height: 2_500 });
    // An ordinary page, with no proof-backed control in it, is read too.
    expect(fixture.preview.hasAttribute('aria-hidden')).toBe(false);
    expect(root.hasAttribute('aria-hidden')).toBe(false);
    expect(iframe.hasAttribute('aria-hidden')).toBe(false);
    expect(iframe.getAttribute('tabindex')).toBe('-1');

    expect(fixture.host.setInteractiveAccessibility(iframe, true)).toBe(true);
    fixture.host.markLive(iframe);
    expect(fixture.host.setInteractiveAccessibility(iframe, false)).toBe(true);
    expect(fixture.preview.hasAttribute('aria-hidden')).toBe(false);
    expect(root.hasAttribute('aria-hidden')).toBe(false);
    expect(iframe.hasAttribute('aria-hidden')).toBe(false);

    fixture.host.clearPresentation();
    expect(fixture.preview.getAttribute('aria-hidden')).toBe('true');
    expect(fixture.host.setInteractiveAccessibility(iframe, true)).toBe(false);
  });

  it('keeps a replacement candidate hidden until it is committed (D118)', () => {
    const fixture = createFixture();
    const first = fixture.host.createCandidate(dimensions());
    const firstFrame = createProtectedIframe(fixture.document);
    first.mount.append(firstFrame);
    first.commit(firstFrame, { width: 1_400, height: 2_500 });

    const next = fixture.host.createCandidate(dimensions());
    const nextFrame = createProtectedIframe(fixture.document);
    next.mount.append(nextFrame);
    const nextRoot = nextFrame.closest<HTMLElement>('[data-simul-replica-candidate]');
    expect(nextRoot?.getAttribute('aria-hidden')).toBe('true');
    expect(nextFrame.getAttribute('aria-hidden')).toBe('true');
    expect(fixture.preview.hasAttribute('aria-hidden')).toBe(false);

    next.commit(nextFrame, { width: 1_400, height: 2_500 });
    expect(nextRoot?.hasAttribute('aria-hidden')).toBe(false);
    expect(nextFrame.hasAttribute('aria-hidden')).toBe(false);
  });

  it('paints the complete presentation shell with the resolved source canvas', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate({
      ...dimensions(),
      canvasBackgroundColor: 'rgb(0, 0, 0)',
    });
    const iframe = createProtectedIframe(fixture.document);
    candidate.mount.append(iframe);
    candidate.commit(iframe, { width: 1_400, height: 2_500 });

    for (const selector of [
      '.replica-replay-root',
      '.replica-replay-scroll',
      '.replica-replay-stage',
      '.replica-replay-sticky-viewport',
      '.replica-replay-scale-layer',
      '.replica-replay-mount',
    ]) {
      expect(requireElement<HTMLElement>(fixture.preview, selector)
        .style.backgroundColor).toBe('rgb(0, 0, 0)');
    }
    expect(iframe.style.backgroundColor).toBe('rgb(0, 0, 0)');

    fixture.host.refreshDimensions(iframe, {
      ...dimensions(),
      canvasBackgroundColor: 'rgb(16, 16, 16)',
    });
    expect(iframe.style.backgroundColor).toBe('rgb(16, 16, 16)');
    expect(requireElement<HTMLElement>(fixture.preview, '.replica-replay-root')
      .style.backgroundColor).toBe('rgb(16, 16, 16)');

    fixture.host.refreshDimensions(iframe, dimensions());
    expect(iframe.style.backgroundColor).toBe('');
    expect(requireElement<HTMLElement>(fixture.preview, '.replica-replay-root')
      .style.backgroundColor).toBe('');
  });

  it('scales outside the source-sized iframe and projects parent scrolling inside it', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const scrollTo = vi.fn();
    const iframe = createProtectedIframe(fixture.document, scrollTo);
    candidate.mount.append(iframe);
    candidate.commit(iframe, { width: 1_400, height: 2_500 });
    const scroller = requireElement<HTMLElement>(fixture.preview, '.replica-replay-scroll');
    const scaleLayer = requireElement<HTMLElement>(fixture.preview, '.replica-replay-scale-layer');
    const stage = requireElement<HTMLElement>(fixture.preview, '.replica-replay-stage');
    Object.defineProperty(scroller, 'clientWidth', {
      configurable: true,
      value: 600,
    });

    fixture.host.updateLayout({ displayMode: 'fit', zoomPercent: 100 });

    expect(scaleLayer.style.transform).toBe('scale(0.5)');
    expect(stage.style.width).toBe('800px');
    expect(stage.style.height).toBe('1300px');
    expect(iframe.style.width).toBe('1200px');
    expect(iframe.style.height).toBe('700px');

    fixture.host.followSourceScroll({ scrollX: 300, scrollY: 800 });
    expect(scroller.scrollLeft).toBe(150);
    expect(scroller.scrollTop).toBe(400);
    expect(scrollTo).toHaveBeenLastCalledWith({
      left: 300,
      top: 800,
      behavior: 'auto',
    });

    scroller.scrollLeft = 150;
    scroller.scrollTop = 450;
    scroller.dispatchEvent(new fixture.window.Event('scroll'));
    expect(scrollTo).toHaveBeenLastCalledWith({
      left: 300,
      top: 900,
      behavior: 'auto',
    });

    fixture.host.updateLayout({ displayMode: 'custom', zoomPercent: 175 });
    expect(scaleLayer.style.transform).toBe('scale(1.75)');
    expect(iframe.style.width).toBe('1200px');
  });

  it('grows Fit to the panel and sizes 1:1 and custom zoom by the tab zoom (D104)', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const iframe = createProtectedIframe(fixture.document);
    candidate.mount.append(iframe);
    candidate.commit(iframe, { width: 1_200, height: 2_500 });
    const scroller = requireElement<HTMLElement>(fixture.preview, '.replica-replay-scroll');
    const scaleLayer = requireElement<HTMLElement>(fixture.preview, '.replica-replay-scale-layer');
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 1_800 });
    const scaleFor = (layout: Parameters<typeof fixture.host.updateLayout>[0]) => {
      fixture.host.updateLayout(layout);
      return scaleLayer.style.transform;
    };

    // Fit grows past 1 when the panel is wider than the page.
    expect(scaleFor({ displayMode: 'fit', zoomPercent: 100 })).toBe('scale(1.5)');
    // A zoomed tab already lays the page out narrower, so Fit ignores the factor.
    expect(scaleFor({ displayMode: 'fit', zoomPercent: 100, sourceZoomFactor: 2 }))
      .toBe('scale(1.5)');
    expect(scaleFor({ displayMode: 'actual', zoomPercent: 100 })).toBe('scale(1)');
    expect(scaleFor({ displayMode: 'actual', zoomPercent: 100, sourceZoomFactor: 1.25 }))
      .toBe('scale(1.25)');
    for (const sourceZoomFactor of [Number.NaN, 0, -2, Number.POSITIVE_INFINITY]) {
      expect(scaleFor({ displayMode: 'actual', zoomPercent: 100, sourceZoomFactor }))
        .toBe('scale(1)');
    }
    expect(scaleFor({ displayMode: 'custom', zoomPercent: 150, sourceZoomFactor: 1.25 }))
      .toBe('scale(1.875)');
    expect(scaleFor({ displayMode: 'custom', zoomPercent: 300, sourceZoomFactor: 2 }))
      .toBe('scale(5)');
    expect(scaleFor({ displayMode: 'custom', zoomPercent: 25, sourceZoomFactor: 0.5 }))
      .toBe('scale(0.25)');
    expect(iframe.style.width).toBe('1200px');
  });

  it('crops the replica frame\'s own scrollbar so only the panel scrolls (D84)', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const iframe = createProtectedIframe(fixture.document);
    // A classic 15px scrollbar: the frame lays the page out 15px narrower,
    // as the source tab does, and draws its own bar beside the panel's.
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: { scrollX: 0, scrollY: 0, scrollTo: vi.fn(), innerWidth: 1_200, innerHeight: 700 },
    });
    Object.defineProperty(iframe, 'contentDocument', {
      configurable: true,
      value: { scrollingElement: { clientWidth: 1_185, clientHeight: 700 } },
    });
    candidate.mount.append(iframe);
    candidate.commit(iframe, { width: 1_185, height: 2_500 });
    const scroller = requireElement<HTMLElement>(fixture.preview, '.replica-replay-scroll');
    const scaleLayer = requireElement<HTMLElement>(fixture.preview, '.replica-replay-scale-layer');
    const viewport = requireElement<HTMLElement>(
      fixture.preview,
      '.replica-replay-sticky-viewport',
    );
    Object.defineProperty(scroller, 'clientWidth', {
      configurable: true,
      value: 600,
    });

    fixture.host.updateLayout({ displayMode: 'fit', zoomPercent: 100 });
    // The page's width, not the frame's, fills the panel; the frame keeps
    // the source viewport size and its scrollbar falls outside the crop.
    expect(scaleLayer.style.transform).toBe(`scale(${600 / 1_185})`);
    expect(viewport.style.width).toBe(`${Math.ceil((600 / 1_185) * 1_185)}px`);
    expect(iframe.style.width).toBe('1200px');

    fixture.host.updateLayout({ displayMode: 'actual', zoomPercent: 100 });
    expect(viewport.style.width).toBe('1185px');
    expect(viewport.style.height).toBe('700px');
  });

  it('keeps the reader scroll when the source re-reports an unchanged position', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const scrollTo = vi.fn();
    const iframe = createProtectedIframe(fixture.document, scrollTo);
    candidate.mount.append(iframe);
    candidate.commit(iframe, { width: 1_400, height: 2_500 });
    const scroller = requireElement<HTMLElement>(fixture.preview, '.replica-replay-scroll');
    const sourceAtTop = { scrollTarget: 'document' as const, scrollX: 0, scrollY: 0, maxScrollY: 1_800 };
    fixture.host.followSourceScroll(sourceAtTop);

    scroller.scrollTop = 900;
    scroller.dispatchEvent(new fixture.window.Event('scroll'));
    // An image load or resize in the source posts the same position again,
    // possibly with a new maximum; the replica must stay where the reader is.
    fixture.host.followSourceScroll({ ...sourceAtTop, maxScrollY: 2_400 });
    fixture.host.refreshExtent(iframe, { width: 1_400, height: 3_100 });
    expect(scroller.scrollTop).toBe(900);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 900, behavior: 'auto' });

    // A real source move still wins.
    fixture.host.followSourceScroll({ ...sourceAtTop, scrollY: 300, maxScrollY: 2_400 });
    expect(scroller.scrollTop).toBe(300);

    // Turning following back on re-aligns even without a new source position.
    scroller.scrollTop = 1_200;
    scroller.dispatchEvent(new fixture.window.Event('scroll'));
    fixture.host.followSourceScroll({ ...sourceAtTop, scrollY: 300, maxScrollY: 2_400 }, true);
    expect(scroller.scrollTop).toBe(300);

    // A new page starts following afresh, even at the same offsets.
    scroller.scrollTop = 700;
    scroller.dispatchEvent(new fixture.window.Event('scroll'));
    fixture.host.resetSourceScroll();
    fixture.host.followSourceScroll({ ...sourceAtTop, scrollY: 300, maxScrollY: 2_400 });
    expect(scroller.scrollTop).toBe(300);
  });

  it('retains source scroll received before a slow replica commits and resets it between pages', () => {
    const fixture = createFixture();
    fixture.host.followSourceScroll({
      scrollTarget: 'document',
      scrollX: 120,
      scrollY: 800,
      maxScrollX: 400,
      maxScrollY: 1_900,
    });
    const first = fixture.host.createCandidate(dimensions());
    const firstScrollTo = vi.fn();
    const firstIframe = createProtectedIframe(fixture.document, firstScrollTo);
    first.mount.append(firstIframe);
    first.commit(firstIframe, { width: 1_400, height: 2_500 });

    expect(firstScrollTo).toHaveBeenLastCalledWith({
      left: 120,
      top: 800,
      behavior: 'auto',
    });

    fixture.host.resetSourceScroll();
    const second = fixture.host.createCandidate(dimensions());
    const secondScrollTo = vi.fn();
    const secondIframe = createProtectedIframe(fixture.document, secondScrollTo);
    second.mount.append(secondIframe);
    second.commit(secondIframe, { width: 1_400, height: 2_500 });

    expect(secondScrollTo).toHaveBeenLastCalledWith({
      left: 0,
      top: 0,
      behavior: 'auto',
    });
  });

  it('retains reader scroll across recovery before source scroll arrives', () => {
    const fixture = createFixture();
    const first = fixture.host.createCandidate(dimensions());
    const firstScrollTo = vi.fn();
    const firstIframe = createProtectedIframe(fixture.document, firstScrollTo);
    first.mount.append(firstIframe);
    first.commit(firstIframe, { width: 1_400, height: 2_500 });
    const firstScroller = requireElement<HTMLElement>(
      fixture.preview,
      '.replica-replay-scroll',
    );

    firstScroller.scrollTop = 375;
    firstScroller.dispatchEvent(new fixture.window.Event('scroll'));

    const recovery = fixture.host.createCandidate(dimensions());
    const recoveryScrollTo = vi.fn();
    const recoveryIframe = createProtectedIframe(
      fixture.document,
      recoveryScrollTo,
    );
    recovery.mount.append(recoveryIframe);
    recovery.commit(recoveryIframe, { width: 1_400, height: 2_500 });

    expect(recoveryScrollTo).toHaveBeenLastCalledWith({
      left: 0,
      top: 375,
      behavior: 'auto',
    });
    expect(requireElement<HTMLElement>(
      fixture.preview,
      '.replica-replay-scroll',
    ).scrollTop).toBe(375);
  });

  it('keeps the source share of its range while a delayed replica extent catches up', () => {
    const fixture = createFixture();
    fixture.host.followSourceScroll({
      scrollTarget: 'document',
      scrollX: 0,
      scrollY: 3_800,
      maxScrollX: 0,
      maxScrollY: 5_000,
    });
    const candidate = fixture.host.createCandidate({
      viewportWidth: 1_200,
      viewportHeight: 700,
      documentWidth: 1_200,
      documentHeight: 1_000,
    });
    const scrollTo = vi.fn();
    const iframe = createProtectedIframe(fixture.document, scrollTo);
    candidate.mount.append(iframe);
    candidate.commit(iframe, { width: 1_200, height: 1_000 });

    // 76% of the source range is 76% of the short replica's 300px range.
    expect(scrollTo).toHaveBeenLastCalledWith({
      left: 0,
      top: 228,
      behavior: 'auto',
    });
    expect(requireElement<HTMLElement>(
      fixture.preview,
      '.replica-replay-stage',
    ).style.height).toBe('1000px');

    fixture.host.markLive(iframe);
    fixture.host.refreshExtent(iframe, { width: 1_200, height: 5_700 });
    expect(scrollTo).toHaveBeenLastCalledWith({
      left: 0,
      top: 3_800,
      behavior: 'auto',
    });
  });

  it('follows a longer translated page by its share of the scroll range', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const scrollTo = vi.fn();
    const iframe = createProtectedIframe(fixture.document, scrollTo);
    candidate.mount.append(iframe);
    candidate.commit(iframe, { width: 1_200, height: 2_500 });
    fixture.host.markLive(iframe);
    // Translation doubled the page's scroll range: 1,800px in the source,
    // 3,600px in the replica.
    fixture.host.refreshExtent(iframe, { width: 1_200, height: 4_300 });
    const scroller = requireElement<HTMLElement>(fixture.preview, '.replica-replay-scroll');
    const source = { scrollTarget: 'document' as const, scrollX: 0, maxScrollX: 0, maxScrollY: 1_800 };

    fixture.host.followSourceScroll({ ...source, scrollY: 900 });
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 1_800, behavior: 'auto' });
    expect(scroller.scrollTop).toBe(1_800);

    fixture.host.followSourceScroll({ ...source, scrollY: 1_800 });
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 3_600, behavior: 'auto' });

    // More translations land below: the replica stays at its end.
    fixture.host.refreshExtent(iframe, { width: 1_200, height: 5_000 });
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 4_300, behavior: 'auto' });
  });

  it('tells its own scroll echo from a reader move while translations grow the page', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const scrollTo = vi.fn();
    const iframe = createProtectedIframe(fixture.document, scrollTo);
    candidate.mount.append(iframe);
    candidate.commit(iframe, { width: 1_200, height: 2_500 });
    fixture.host.markLive(iframe);
    fixture.host.refreshExtent(iframe, { width: 1_200, height: 4_300 });
    const scroller = requireElement<HTMLElement>(fixture.preview, '.replica-replay-scroll');

    fixture.host.followSourceScroll({
      scrollTarget: 'document', scrollX: 0, scrollY: 900, maxScrollX: 0, maxScrollY: 1_800,
    });
    // Setting the panel scroller fires a scroll event of its own; the
    // replica keeps following the source's half-way point as it grows.
    scroller.dispatchEvent(new fixture.window.Event('scroll'));
    fixture.host.refreshExtent(iframe, { width: 1_200, height: 5_700 });
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 2_500, behavior: 'auto' });

    // A reader's own move is kept in replica pixels as the page grows.
    scroller.scrollTop = 3_000;
    scroller.dispatchEvent(new fixture.window.Event('scroll'));
    fixture.host.refreshExtent(iframe, { width: 1_200, height: 6_700 });
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 3_000, behavior: 'auto' });
    expect(scroller.scrollTop).toBe(3_000);
  });

  it('magnifies the part of the page a pinch zoom shows in the tab (D115)', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const scrollTo = vi.fn();
    const iframe = createProtectedIframe(fixture.document, scrollTo);
    candidate.mount.append(iframe);
    candidate.commit(iframe, { width: 1_200, height: 2_500 });
    const scroller = requireElement<HTMLElement>(fixture.preview, '.replica-replay-scroll');
    const scaleLayer = requireElement<HTMLElement>(fixture.preview, '.replica-replay-scale-layer');
    const sticky = requireElement<HTMLElement>(fixture.preview, '.replica-replay-sticky-viewport');
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 600 });
    fixture.host.updateLayout({ displayMode: 'fit', zoomPercent: 100 });
    const source = {
      scrollX: 0, scrollY: 800, maxScrollX: 0, maxScrollY: 1_900,
    };
    fixture.host.followSourceScroll(source);
    expect(scaleLayer.style.transform).toBe('scale(0.5)');
    expect(scroller.scrollTop).toBe(400);

    // The tab is magnified 2 times, its view's corner at 300, 150 of the
    // layout viewport: the same part fills the space the whole view took.
    const pinched = { ...source, visualScale: 2, visualOffsetX: 300, visualOffsetY: 150 };
    fixture.host.followSourceScroll(pinched);
    expect(scaleLayer.style.transform).toBe('translate(-300px, -150px) scale(1)');
    expect(sticky.style.width).toBe('600px');
    expect(sticky.style.height).toBe('350px');
    expect(iframe.style.width).toBe('1200px');
    // The page's own scroll position is unchanged by the pinch.
    expect(scroller.scrollTop).toBe(400);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 800, behavior: 'auto' });

    // Panning inside the magnified view moves only the corner.
    fixture.host.followSourceScroll({ ...pinched, visualOffsetX: 420, visualOffsetY: 200 });
    expect(scaleLayer.style.transform).toBe('translate(-420px, -200px) scale(1)');
    // 1:1 and the tab's browser zoom multiply as before.
    fixture.host.updateLayout({ displayMode: 'actual', zoomPercent: 100, sourceZoomFactor: 1.5 });
    expect(scaleLayer.style.transform).toBe('translate(-1260px, -600px) scale(3)');
    fixture.host.updateLayout({ displayMode: 'fit', zoomPercent: 100 });

    // Following turned off: the whole view again. The same report is then
    // followed when following is turned on, not taken for a repeat.
    fixture.host.clearSourceVisualViewport();
    expect(scaleLayer.style.transform).toBe('scale(0.5)');
    fixture.host.followSourceScroll({ ...pinched, visualOffsetX: 420, visualOffsetY: 200 });
    expect(scaleLayer.style.transform).toBe('translate(-420px, -200px) scale(1)');

    // Pinched back out: the report carries no zoom.
    fixture.host.followSourceScroll(source);
    expect(scaleLayer.style.transform).toBe('scale(0.5)');
    // A zoom that is not one is none; a huge one is cut at 10.
    fixture.host.followSourceScroll({ ...source, scrollY: 801, visualScale: 0.5 });
    expect(scaleLayer.style.transform).toBe('scale(0.5)');
    fixture.host.followSourceScroll({
      ...source, visualScale: 40, visualOffsetX: 0, visualOffsetY: 0,
    });
    expect(scaleLayer.style.transform).toBe('translate(0px, 0px) scale(5)');
    fixture.host.resetSourceScroll();
    fixture.host.updateLayout({ displayMode: 'fit', zoomPercent: 100 });
    expect(scaleLayer.style.transform).toBe('scale(0.5)');
  });

  it('projects nested source progress into the replica primary viewport', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const scrollTo = vi.fn();
    const iframe = createProtectedIframe(fixture.document, scrollTo);
    const replica = parseHTML(
      '<html><body><main id="results"></main></body></html>',
    ).document;
    const results = replica.querySelector('#results') as HTMLElement;
    Object.defineProperties(results, {
      clientWidth: { configurable: true, value: 900 },
      clientHeight: { configurable: true, value: 650 },
      scrollWidth: { configurable: true, value: 900 },
      scrollHeight: { configurable: true, value: 3_650 },
      scrollLeft: { configurable: true, writable: true, value: 0 },
      scrollTop: { configurable: true, writable: true, value: 0 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({
          x: 200, y: 25, left: 200, top: 25, right: 1_100, bottom: 675,
          width: 900, height: 650, toJSON: () => ({}),
        }),
      },
    });
    Object.defineProperty(iframe, 'contentDocument', {
      configurable: true,
      value: replica,
    });
    candidate.mount.append(iframe);
    candidate.commit(iframe, { width: 1_200, height: 700 });

    fixture.host.followSourceScroll({
      scrollTarget: 'nested',
      scrollX: 0,
      scrollY: 2_000,
      maxScrollX: 0,
      maxScrollY: 4_000,
    });

    expect(results.scrollTop).toBe(1_500);
    expect(scrollTo).toHaveBeenLastCalledWith({
      left: 0, top: 0, behavior: 'auto',
    });
    expect(requireElement<HTMLElement>(
      fixture.preview,
      '.replica-replay-scroll',
    ).scrollTop).toBe(0);

    fixture.host.markLive(iframe);
    fixture.host.refreshExtent(iframe, { width: 1_200, height: 700 });
    fixture.host.refreshDimensions(iframe, {
      viewportWidth: 1_200,
      viewportHeight: 700,
      documentWidth: 1_200,
      documentHeight: 700,
    });

    expect(results.scrollTop).toBe(1_500);
    expect(requireElement<HTMLElement>(
      fixture.preview,
      '.replica-replay-scroll',
    ).scrollTop).toBe(0);
  });

  it('preserves document position while projecting a nested reading viewport', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const scrollTo = vi.fn();
    const iframe = createProtectedIframe(fixture.document, scrollTo);
    const replica = parseHTML(
      '<html><body><main id="results" style="overflow-y:auto"></main></body></html>',
    ).document;
    const results = replica.querySelector('#results') as HTMLElement;
    defineReplicaScrollBox(results, {
      clientWidth: 900,
      clientHeight: 650,
      scrollHeight: 3_650,
    });
    Object.defineProperty(iframe, 'contentDocument', {
      configurable: true,
      value: replica,
    });
    candidate.mount.append(iframe);
    candidate.commit(iframe, { width: 1_600, height: 2_600 });

    fixture.host.followSourceScroll({
      scrollTarget: 'nested',
      scrollX: 0,
      scrollY: 2_000,
      maxScrollX: 0,
      maxScrollY: 4_000,
      documentScrollX: 0,
      documentScrollY: 420,
      documentMaxScrollX: 400,
      documentMaxScrollY: 1_900,
    });

    expect(results.scrollTop).toBe(1_500);
    expect(scrollTo).toHaveBeenLastCalledWith({
      left: 0,
      top: 420,
      behavior: 'auto',
    });
    expect(requireElement<HTMLElement>(
      fixture.preview,
      '.replica-replay-scroll',
    ).scrollTop).toBe(420);
  });

  it('switches away from removed or shrunken nested targets and restores document scrolling', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const scrollTo = vi.fn();
    const iframe = createProtectedIframe(fixture.document, scrollTo);
    const replica = parseHTML(
      '<html><body><main id="first" style="overflow-y:auto"></main>' +
      '<main id="replacement" style="overflow-y:auto"></main></body></html>',
    ).document;
    const first = replica.querySelector('#first') as HTMLElement;
    const replacement = replica.querySelector('#replacement') as HTMLElement;
    defineReplicaScrollBox(first, {
      clientWidth: 960, clientHeight: 680, scrollHeight: 4_680,
    });
    defineReplicaScrollBox(replacement, {
      clientWidth: 900, clientHeight: 650, scrollHeight: 3_650,
    });
    Object.defineProperty(iframe, 'contentDocument', {
      configurable: true,
      value: replica,
    });
    candidate.mount.append(iframe);
    candidate.commit(iframe, { width: 1_600, height: 2_600 });

    fixture.host.followSourceScroll({
      scrollTarget: 'nested',
      scrollX: 0,
      scrollY: 2_000,
      maxScrollX: 0,
      maxScrollY: 4_000,
    });
    expect(first.scrollTop).toBe(2_000);

    first.remove();
    fixture.host.followSourceScroll({
      scrollTarget: 'nested',
      scrollX: 0,
      scrollY: 1_000,
      maxScrollX: 0,
      maxScrollY: 2_000,
    });
    expect(replacement.scrollTop).toBe(1_500);

    // A responsive shrink can make the former reading pane incidental. The
    // host must invalidate it and use bounded outer progress instead.
    Object.defineProperty(replacement, 'scrollHeight', {
      configurable: true,
      value: 700,
    });
    fixture.host.followSourceScroll({
      scrollTarget: 'nested',
      scrollX: 0,
      scrollY: 900,
      maxScrollX: 0,
      maxScrollY: 600,
    });
    expect(scrollTo).toHaveBeenLastCalledWith({
      left: 0,
      top: 1_900,
      behavior: 'auto',
    });

    fixture.host.followSourceScroll({
      scrollTarget: 'document',
      scrollX: 0,
      scrollY: 640,
      maxScrollX: 400,
      maxScrollY: 1_900,
    });
    expect(scrollTo).toHaveBeenLastCalledWith({
      left: 0,
      top: 640,
      behavior: 'auto',
    });
    expect(requireElement<HTMLElement>(
      fixture.preview,
      '.replica-replay-scroll',
    ).scrollTop).toBe(640);
  });

  it('reselects a qualified replica pane when the source nested owner changes', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const iframe = createProtectedIframe(fixture.document);
    const replica = parseHTML(
      '<html><body><main id="first" style="overflow-y:auto"></main>' +
      '<main id="second" style="overflow-y:auto"></main></body></html>',
    ).document;
    const first = replica.querySelector('#first') as HTMLElement;
    const second = replica.querySelector('#second') as HTMLElement;
    defineReplicaScrollBox(first, {
      clientWidth: 960, clientHeight: 680, scrollHeight: 4_680,
    });
    defineReplicaScrollBox(second, {
      clientWidth: 900, clientHeight: 650, scrollHeight: 3_650,
    });
    Object.defineProperty(iframe, 'contentDocument', {
      configurable: true,
      value: replica,
    });
    candidate.mount.append(iframe);
    candidate.commit(iframe, { width: 1_600, height: 2_600 });

    fixture.host.followSourceScroll({
      scrollTarget: 'nested', nestedOwnerKey: 1, nestedOwnerOrdinal: 0,
      scrollX: 0, scrollY: 2_000, maxScrollX: 0, maxScrollY: 4_000,
    });
    expect(first.scrollTop).toBe(2_000);
    expect(second.scrollTop).toBe(0);

    defineReplicaScrollBox(second, {
      clientWidth: 1_100, clientHeight: 690, scrollHeight: 8_690,
    });
    fixture.host.followSourceScroll({
      scrollTarget: 'nested', nestedOwnerKey: 2, nestedOwnerOrdinal: 1,
      scrollX: 0, scrollY: 1_000, maxScrollX: 0, maxScrollY: 2_000,
    });

    expect(first.scrollTop).toBe(2_000);
    expect(second.scrollTop).toBe(4_000);
  });

  it('projects nested source progress into an open-shadow reading viewport', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const scrollTo = vi.fn();
    const iframe = createProtectedIframe(fixture.document, scrollTo);
    const replica = parseHTML(
      '<html><body><x-reading-pane></x-reading-pane></body></html>',
    ).document;
    const host = replica.querySelector('x-reading-pane')!;
    const shadow = host.attachShadow({ mode: 'open' });
    const results = replica.createElement('main');
    results.setAttribute('style', 'overflow-y:auto');
    shadow.append(results);
    Object.defineProperties(results, {
      clientWidth: { configurable: true, value: 900 },
      clientHeight: { configurable: true, value: 650 },
      scrollWidth: { configurable: true, value: 900 },
      scrollHeight: { configurable: true, value: 3_650 },
      scrollLeft: { configurable: true, writable: true, value: 0 },
      scrollTop: { configurable: true, writable: true, value: 0 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({
          x: 200, y: 25, left: 200, top: 25, right: 1_100, bottom: 675,
          width: 900, height: 650, toJSON: () => ({}),
        }),
      },
    });
    Object.defineProperty(iframe, 'contentDocument', {
      configurable: true,
      value: replica,
    });
    candidate.mount.append(iframe);
    candidate.commit(iframe, { width: 1_200, height: 700 });

    fixture.host.followSourceScroll({
      scrollTarget: 'nested',
      scrollX: 0,
      scrollY: 2_000,
      maxScrollX: 0,
      maxScrollY: 4_000,
    });

    expect(results.scrollTop).toBe(1_500);
    expect(scrollTo).toHaveBeenLastCalledWith({
      left: 0, top: 0, behavior: 'auto',
    });
  });

  it('labels a retained live replay and refreshes its bounded extent in place', () => {
    const fixture = createFixture();
    const candidate = commitCandidate(fixture);
    const iframe = requireElement<HTMLIFrameElement>(candidate.mount, 'iframe');
    const root = fixture.preview.firstElementChild;

    fixture.host.markLive(iframe);
    fixture.host.refreshExtent(iframe, { width: 1_900, height: 4_100 });

    const stage = requireElement<HTMLElement>(fixture.preview, '.replica-replay-stage');
    expect(fixture.badge.textContent).toBe(LIVE_REPLAY_LABEL);
    expect(fixture.preview.firstElementChild).toBe(root);
    expect(stage.style.width).toBe('1900px');
    expect(stage.style.height).toBe('4100px');
  });

  it('ignores repeated live and unchanged extent notifications', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const scrollTo = vi.fn();
    const iframe = createProtectedIframe(fixture.document, scrollTo);
    candidate.mount.append(iframe);
    candidate.commit(iframe, { width: 1_400, height: 2_500 });
    fixture.host.markLive(iframe);
    scrollTo.mockClear();

    fixture.host.markLive(iframe);
    fixture.host.refreshExtent(iframe, { width: 1_400, height: 2_500 });

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('lets a live document extent shrink below its initial capture size', () => {
    const fixture = createFixture();
    const candidate = commitCandidate(fixture);
    const iframe = requireElement<HTMLIFrameElement>(candidate.mount, 'iframe');
    const stage = requireElement<HTMLElement>(fixture.preview, '.replica-replay-stage');

    fixture.host.markLive(iframe);
    fixture.host.refreshExtent(iframe, { width: 900, height: 1_000 });

    expect(stage.style.width).toBe('1200px');
    expect(stage.style.height).toBe('1000px');
  });

  it('extends the parent scroll track when the panel is taller than the scaled source viewport', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const iframe = createProtectedIframe(fixture.document);
    candidate.mount.append(iframe);
    candidate.commit(iframe, { width: 1_400, height: 2_500 });
    const scroller = requireElement<HTMLElement>(fixture.preview, '.replica-replay-scroll');
    const stage = requireElement<HTMLElement>(fixture.preview, '.replica-replay-stage');
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 600 },
      clientHeight: { configurable: true, value: 800 },
    });

    fixture.host.updateLayout({ displayMode: 'fit', zoomPercent: 100 });

    expect(stage.style.height).toBe('1750px');
    fixture.host.followSourceScroll({ scrollX: 0, scrollY: 1_900 });
    expect(scroller.scrollTop).toBe(950);
  });

  it('preserves fractional scaled offsets without feeding scroll drift back into the iframe', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const scrollTo = vi.fn();
    const iframe = createProtectedIframe(fixture.document, scrollTo);
    candidate.mount.append(iframe);
    candidate.commit(iframe, { width: 1_400, height: 2_500 });
    const scroller = requireElement<HTMLElement>(fixture.preview, '.replica-replay-scroll');
    Object.defineProperty(scroller, 'clientWidth', {
      configurable: true,
      value: 500,
    });
    fixture.host.updateLayout({ displayMode: 'fit', zoomPercent: 100 });

    fixture.host.followSourceScroll({ scrollX: 1, scrollY: 1 });

    expect(scroller.scrollLeft).toBeCloseTo(5 / 12);
    expect(scroller.scrollTop).toBeCloseTo(5 / 12);
    scroller.dispatchEvent(new fixture.window.Event('scroll'));
    expect(scrollTo).toHaveBeenLastCalledWith({
      left: 1,
      top: 1,
      behavior: 'auto',
    });
  });

  it('retains the committed viewport until replacement and releases current ownership once', () => {
    const fixture = createFixture();
    const first = commitCandidate(fixture);
    const firstRoot = fixture.preview.firstElementChild;
    expect(fixture.host.hasCommittedReplica).toBe(true);

    const second = fixture.host.createCandidate(dimensions());
    const secondIframe = createProtectedIframe(fixture.document);
    second.mount.append(secondIframe);

    expect(fixture.preview.firstElementChild).toBe(firstRoot);
    expect(fixture.preview.children).toHaveLength(2);

    second.commit(secondIframe, { width: 1_450, height: 2_550 });

    expect(fixture.preview.children).toHaveLength(1);
    expect(fixture.preview.firstElementChild).not.toBe(firstRoot);
    expect(firstRoot?.isConnected).toBe(false);

    first.release();
    first.release();
    expect(fixture.preview.hidden).toBe(false);

    fixture.host.clearPresentation();
    expect(fixture.host.hasCommittedReplica).toBe(true);
    expect(fixture.preview.hidden).toBe(true);
    expect(fixture.badge.hidden).toBe(true);
    second.release();
    second.release();

    expect(fixture.preview.hidden).toBe(true);
    expect(fixture.badge.textContent).toBe('');
    expect(fixture.host.hasCommittedReplica).toBe(false);
  });

  it('bounds hostile source dimensions and scaled extension-owned overflow', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate({
      viewportWidth: Number.POSITIVE_INFINITY,
      viewportHeight: 2_000_000,
      documentWidth: 4_000_000,
      documentHeight: 8_000_000,
    });
    const iframe = createProtectedIframe(fixture.document);
    candidate.mount.append(iframe);
    candidate.commit(iframe, { width: 9_000_000, height: 9_000_000 });

    fixture.host.updateLayout({ displayMode: 'custom', zoomPercent: 300 });

    const stage = requireElement<HTMLElement>(fixture.preview, '.replica-replay-stage');
    expect(iframe.getAttribute('width')).toBe('1');
    expect(iframe.getAttribute('height')).toBe('1000000');
    expect(stage.style.width).toBe('3000000px');
    expect(stage.style.height).toBe('3000000px');
  });

  it('rejects an unprotected candidate and cleans staging on disposal', () => {
    const fixture = createFixture();
    commitCandidate(fixture);
    const committedRoot = fixture.preview.firstElementChild;
    const candidate = fixture.host.createCandidate(dimensions());
    const iframe = fixture.document.createElement('iframe');
    candidate.mount.append(iframe);

    expect(() => candidate.commit(iframe, { width: 100, height: 100 })).toThrow(
      'not eligible',
    );
    candidate.release();

    expect(fixture.preview.hidden).toBe(false);
    expect(fixture.preview.firstElementChild).toBe(committedRoot);

    fixture.host.dispose();
    fixture.host.dispose();

    expect(fixture.document.querySelector('[data-simul-replica-candidate]')).toBeNull();
    expect(fixture.badge.hidden).toBe(true);
  });

  it('reveals a connected candidate without moving its iframe subtree', () => {
    const fixture = createFixture();
    commitCandidate(fixture);
    const committedRoot = fixture.preview.firstElementChild;
    const candidate = fixture.host.createCandidate(dimensions());
    const iframe = createProtectedIframe(fixture.document);
    candidate.mount.append(iframe);
    const stagedRoot = candidate.mount.closest<HTMLElement>('.replica-replay-root');
    expect(stagedRoot?.parentElement).toBe(fixture.preview);
    fixture.preview.replaceChildren = () => {
      throw new Error('a connected candidate must never be moved');
    };

    expect(() => candidate.commit(iframe, { width: 1_400, height: 2_500 }))
      .not.toThrow();

    expect(fixture.preview.hidden).toBe(false);
    expect(fixture.preview.firstElementChild).toBe(stagedRoot);
    expect(stagedRoot?.isConnected).toBe(true);
    expect(iframe.isConnected).toBe(true);
    expect(committedRoot?.isConnected).toBe(false);
    expect(fixture.badge.textContent).toBe(STATIC_REPLAY_LABEL);
  });
});

function createFixture() {
  const { document, window } = parseHTML(
    '<html><body><section id="preview" hidden aria-hidden="true"></section>' +
      '<p id="badge" hidden></p></body></html>',
  );
  const preview = requireElement<HTMLElement>(document, '#preview');
  const badge = requireElement<HTMLElement>(document, '#badge');
  return {
    document,
    window,
    preview,
    badge,
    host: new VisibleReplayHost({
      hostDocument: document,
      previewSurface: preview,
      badge,
    }),
  };
}

function dimensions() {
  return {
    viewportWidth: 1_200,
    viewportHeight: 700,
    documentWidth: 1_600,
    documentHeight: 2_600,
  };
}

function createProtectedIframe(
  document: Document,
  scrollTo = vi.fn(),
): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-same-origin');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('inert', '');
  iframe.setAttribute('tabindex', '-1');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.style.pointerEvents = 'none';
  Object.defineProperty(iframe, 'contentWindow', {
    configurable: true,
    value: { scrollX: 0, scrollY: 0, scrollTo },
  });
  return iframe;
}

function commitCandidate(fixture: ReturnType<typeof createFixture>): VisibleReplayCandidateLease {
  const candidate = fixture.host.createCandidate(dimensions());
  const iframe = createProtectedIframe(fixture.document);
  candidate.mount.append(iframe);
  candidate.commit(iframe, { width: 1_400, height: 2_500 });
  return candidate;
}

function requireElement<T extends Element>(
  root: ParentNode,
  selector: string,
): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing test element: ${selector}`);
  return element;
}

function defineReplicaScrollBox(
  element: HTMLElement,
  dimensions: Readonly<{
    clientWidth: number;
    clientHeight: number;
    scrollHeight: number;
  }>,
): void {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: dimensions.clientWidth },
    clientHeight: { configurable: true, value: dimensions.clientHeight },
    scrollWidth: { configurable: true, value: dimensions.clientWidth },
    scrollHeight: { configurable: true, value: dimensions.scrollHeight },
    scrollLeft: { configurable: true, writable: true, value: 0 },
    scrollTop: { configurable: true, writable: true, value: 0 },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({
        x: 120,
        y: 10,
        left: 120,
        top: 10,
        right: 120 + dimensions.clientWidth,
        bottom: 10 + dimensions.clientHeight,
        width: dimensions.clientWidth,
        height: dimensions.clientHeight,
        toJSON: () => ({}),
      }),
    },
  });
}
