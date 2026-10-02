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
      behavior: 'instant',
    });

    scroller.scrollLeft = 150;
    scroller.scrollTop = 450;
    scroller.dispatchEvent(new fixture.window.Event('scroll'));
    expect(scrollTo).toHaveBeenLastCalledWith({
      left: 300,
      top: 900,
      behavior: 'instant',
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
    const sourceAtTop = { scrollX: 0, scrollY: 0, maxScrollY: 1_800 };
    fixture.host.followSourceScroll(sourceAtTop);

    scroller.scrollTop = 900;
    scroller.dispatchEvent(new fixture.window.Event('scroll'));
    // An image load or resize in the source posts the same position again,
    // possibly with a new maximum; the replica must stay where the reader is.
    fixture.host.followSourceScroll({ ...sourceAtTop, maxScrollY: 2_400 });
    fixture.host.refreshExtent(iframe, { width: 1_400, height: 3_100 });
    expect(scroller.scrollTop).toBe(900);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 900, behavior: 'instant' });

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
      behavior: 'instant',
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
      behavior: 'instant',
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
      behavior: 'instant',
    });
    expect(requireElement<HTMLElement>(
      fixture.preview,
      '.replica-replay-scroll',
    ).scrollTop).toBe(375);
  });

  it('keeps the source share of its range while a delayed replica extent catches up', () => {
    const fixture = createFixture();
    fixture.host.followSourceScroll({
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
      behavior: 'instant',
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
      behavior: 'instant',
    });
  });

  it('follows the page at once, whatever scroll behaviour the page asks for (D122)', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const scrollTo = vi.fn();
    const iframe = createProtectedIframe(fixture.document, scrollTo);
    candidate.mount.append(iframe);
    candidate.commit(iframe, { width: 1_600, height: 2_600 });
    scrollTo.mockClear();

    // The replica keeps the page's `scroll-behavior: smooth`; `auto` would
    // animate every followed move and leave the mirror behind the tab.
    fixture.host.followSourceScroll({
      scrollX: 0, scrollY: 1_500, maxScrollX: 400, maxScrollY: 1_900,
    });
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({
      left: 0, top: 1_500, behavior: 'instant',
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
    const source = { scrollX: 0, maxScrollX: 0, maxScrollY: 1_800 };

    fixture.host.followSourceScroll({ ...source, scrollY: 900 });
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 1_800, behavior: 'instant' });
    expect(scroller.scrollTop).toBe(1_800);

    fixture.host.followSourceScroll({ ...source, scrollY: 1_800 });
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 3_600, behavior: 'instant' });

    // More translations land below: the replica stays at its end.
    fixture.host.refreshExtent(iframe, { width: 1_200, height: 5_000 });
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 4_300, behavior: 'instant' });
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
      scrollX: 0, scrollY: 900, maxScrollX: 0, maxScrollY: 1_800,
    });
    // Setting the panel scroller fires a scroll event of its own; the
    // replica keeps following the source's half-way point as it grows.
    scroller.dispatchEvent(new fixture.window.Event('scroll'));
    fixture.host.refreshExtent(iframe, { width: 1_200, height: 5_700 });
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 2_500, behavior: 'instant' });

    // A reader's own move is kept in replica pixels as the page grows.
    scroller.scrollTop = 3_000;
    scroller.dispatchEvent(new fixture.window.Event('scroll'));
    fixture.host.refreshExtent(iframe, { width: 1_200, height: 6_700 });
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 3_000, behavior: 'instant' });
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
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 800, behavior: 'instant' });

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

  it('scrolls the tab\'s viewport-scale pane in the replica, found by node id (D122)', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const scrollTo = vi.fn();
    const iframe = createProtectedIframe(fixture.document, scrollTo);
    const replica = attachReplica(
      iframe,
      '<html><body><main id="results"></main></body></html>',
    );
    const results = replica.querySelector('#results') as HTMLElement;
    defineReplicaScrollBox(results, {
      clientWidth: 900, clientHeight: 650, scrollHeight: 3_650,
    });
    candidate.mount.append(iframe);
    candidate.commit(iframe, { width: 1_200, height: 700 }, resolver([[7, results]]));

    fixture.host.followSourceScroll({
      scrollX: 0, scrollY: 0, maxScrollX: 0, maxScrollY: 0,
      panes: [{ nodeId: 7, scrollX: 0, scrollY: 2_000, maxScrollX: 0, maxScrollY: 4_000 }],
      primaryPaneId: 7,
    });

    expect(results.scrollTop).toBe(1_500);
    expect(scrollTo).toHaveBeenLastCalledWith({
      left: 0, top: 0, behavior: 'instant',
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

  it('keeps the document at its own share while a pane is scrolled', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const scrollTo = vi.fn();
    const iframe = createProtectedIframe(fixture.document, scrollTo);
    const replica = attachReplica(
      iframe,
      '<html><body><main id="results"></main></body></html>',
    );
    const results = replica.querySelector('#results') as HTMLElement;
    defineReplicaScrollBox(results, {
      clientWidth: 900, clientHeight: 650, scrollHeight: 3_650,
    });
    candidate.mount.append(iframe);
    candidate.commit(iframe, { width: 1_600, height: 2_600 }, resolver([[7, results]]));

    fixture.host.followSourceScroll({
      scrollX: 0, scrollY: 420, maxScrollX: 400, maxScrollY: 1_900,
      panes: [{ nodeId: 7, scrollX: 0, scrollY: 2_000, maxScrollX: 0, maxScrollY: 4_000 }],
      primaryPaneId: 7,
    });

    expect(results.scrollTop).toBe(1_500);
    expect(scrollTo).toHaveBeenLastCalledWith({
      left: 0,
      top: 420,
      behavior: 'instant',
    });
    expect(requireElement<HTMLElement>(
      fixture.preview,
      '.replica-replay-scroll',
    ).scrollTop).toBe(420);
  });

  it('moves the replica document by the pane\'s progress when the replica cannot scroll that pane', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const scrollTo = vi.fn();
    const iframe = createProtectedIframe(fixture.document, scrollTo);
    const replica = attachReplica(
      iframe,
      '<html><body><main id="first"></main><main id="other"></main></body></html>',
    );
    const first = replica.querySelector('#first') as HTMLElement;
    const other = replica.querySelector('#other') as HTMLElement;
    defineReplicaScrollBox(first, {
      clientWidth: 960, clientHeight: 680, scrollHeight: 4_680,
    });
    // Another viewport-scale pane in the replica is never taken instead.
    defineReplicaScrollBox(other, {
      clientWidth: 900, clientHeight: 650, scrollHeight: 3_650,
    });
    const nodes = new Map<number, Node>([[7, first], [8, other]]);
    candidate.mount.append(iframe);
    candidate.commit(iframe, { width: 1_600, height: 2_600 }, (id) => nodes.get(id));
    const pane = (scrollY: number, maxScrollY: number) => ({
      scrollX: 0, scrollY: 0, maxScrollX: 0, maxScrollY: 0,
      panes: [{ nodeId: 7, scrollX: 0, scrollY, maxScrollX: 0, maxScrollY }],
      primaryPaneId: 7,
    });

    fixture.host.followSourceScroll(pane(2_000, 4_000));
    expect(first.scrollTop).toBe(2_000);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 0, behavior: 'instant' });

    // The replica no longer has the element: its progress moves the page.
    first.remove();
    nodes.delete(7);
    fixture.host.followSourceScroll(pane(1_000, 2_000));
    expect(other.scrollTop).toBe(0);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 950, behavior: 'instant' });

    // The element is there but the replica lays it out with no scroll
    // range (a style the replica does not have): the same.
    const flat = replica.createElement('main');
    replica.body.append(flat);
    defineReplicaScrollBox(flat, {
      clientWidth: 900, clientHeight: 650, scrollHeight: 650,
    });
    nodes.set(7, flat);
    fixture.host.followSourceScroll(pane(600, 600));
    expect(flat.scrollTop).toBe(0);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 1_900, behavior: 'instant' });
    expect(requireElement<HTMLElement>(
      fixture.preview,
      '.replica-replay-scroll',
    ).scrollTop).toBe(1_900);

    // The replica's element gains a range (a late style): the engine's
    // layout refresh puts the page back where it belongs without the pane's
    // progress, and any range the element has is used from then on.
    defineReplicaScrollBox(flat, {
      clientWidth: 900, clientHeight: 650, scrollHeight: 700,
    });
    fixture.host.refreshExtent(iframe, { width: 1_600, height: 2_600 });
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 0, behavior: 'instant' });
    expect(flat.scrollTop).toBe(50);
    fixture.host.followSourceScroll(pane(300, 600));
    expect(flat.scrollTop).toBe(25);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 0, behavior: 'instant' });

    fixture.host.followSourceScroll({
      scrollX: 0, scrollY: 640, maxScrollX: 400, maxScrollY: 1_900,
    });
    expect(scrollTo).toHaveBeenLastCalledWith({
      left: 0,
      top: 640,
      behavior: 'instant',
    });
    expect(requireElement<HTMLElement>(
      fixture.preview,
      '.replica-replay-scroll',
    ).scrollTop).toBe(640);
  });

  it('lets the pane stand in for the page on each axis the replica cannot scroll (D122)', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const scrollTo = vi.fn();
    const iframe = createProtectedIframe(fixture.document, scrollTo);
    const replica = attachReplica(iframe, '<html><body><main id="p"></main></body></html>');
    const p = replica.querySelector('#p') as HTMLElement;
    // The replica lays the pane out at full height (no vertical range) and
    // keeps its small sideways range, as the tab's pane has one.
    defineReplicaScrollBox(p, {
      clientWidth: 900, clientHeight: 4_650, scrollHeight: 4_650, scrollWidth: 920,
    });
    candidate.mount.append(iframe);
    candidate.commit(iframe, { width: 1_600, height: 2_600 }, resolver([[7, p]]));
    const scroller = requireElement<HTMLElement>(fixture.preview, '.replica-replay-scroll');
    const pane = (scrollX: number, scrollY: number) => ({
      scrollX: 0, scrollY: 0, maxScrollX: 0, maxScrollY: 0,
      panes: [{ nodeId: 7, scrollX, scrollY, maxScrollX: 20, maxScrollY: 4_000 }],
      primaryPaneId: 7,
    });

    // Down: the replica cannot scroll the pane, so the page moves.
    fixture.host.followSourceScroll(pane(0, 3_000));
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 1_425, behavior: 'instant' });
    expect(scroller.scrollTop).toBe(1_425);
    expect(p.scrollTop).toBe(0);
    // Sideways: the replica can, so the pane moves and the page does not.
    scrollTo.mockClear();
    fixture.host.followSourceScroll(pane(10, 3_000));
    expect(p.scrollLeft).toBe(10);
    expect(scrollTo).not.toHaveBeenCalled();
    fixture.host.followSourceScroll(pane(20, 4_000));
    expect(p.scrollLeft).toBe(20);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 1_900, behavior: 'instant' });

    // The other way round: a vertical range only. The pane is scrolled down
    // by id and its sideways progress moves the page across.
    defineReplicaScrollBox(p, {
      clientWidth: 900, clientHeight: 650, scrollHeight: 3_650,
    });
    fixture.host.refreshExtent(iframe, { width: 1_600, height: 2_600 });
    expect(p.scrollTop).toBe(3_000);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 400, top: 0, behavior: 'instant' });
    fixture.host.followSourceScroll(pane(10, 2_000));
    expect(p.scrollTop).toBe(1_500);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 200, top: 0, behavior: 'instant' });
    // A pane that reports no sideways range has nothing to stand in with.
    fixture.host.followSourceScroll({
      scrollX: 0, scrollY: 0, maxScrollX: 0, maxScrollY: 0,
      panes: [{ nodeId: 7, scrollX: 0, scrollY: 2_000, maxScrollX: 0, maxScrollY: 4_000 }],
      primaryPaneId: 7,
    });
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 0, behavior: 'instant' });
  });

  it('keeps the reader\'s scroll when a stand-in gains its own range with no move in the tab (D122)', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const scrollTo = vi.fn();
    const iframe = createProtectedIframe(fixture.document, scrollTo);
    const replica = attachReplica(
      iframe,
      '<html><body><main id="p"></main><div id="car"></div></body></html>',
    );
    const p = replica.querySelector('#p') as HTMLElement;
    const car = replica.querySelector('#car') as HTMLElement;
    defineReplicaScrollBox(p, { clientWidth: 900, clientHeight: 650, scrollHeight: 650 });
    defineReplicaScrollBox(car, {
      clientWidth: 900, clientHeight: 100, scrollHeight: 100, scrollWidth: 5_000,
    });
    candidate.mount.append(iframe);
    candidate.commit(iframe, { width: 1_600, height: 2_600 }, resolver([[7, p], [8, car]]));
    const scroller = requireElement<HTMLElement>(fixture.preview, '.replica-replay-scroll');
    const report = (slide: number) => ({
      scrollX: 0, scrollY: 0, maxScrollX: 0, maxScrollY: 0,
      panes: [
        { nodeId: 7, scrollX: 0, scrollY: 1_000, maxScrollX: 0, maxScrollY: 4_000 },
        ...(slide
          ? [{ nodeId: 8, scrollX: slide, scrollY: 0, maxScrollX: 4_100, maxScrollY: 0 }]
          : []),
      ],
      primaryPaneId: 7,
    });

    fixture.host.followSourceScroll(report(0));
    expect(scroller.scrollTop).toBe(475);
    scroller.scrollTop = 100;
    scroller.dispatchEvent(new fixture.window.Event('scroll'));
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 100, behavior: 'instant' });

    // A late style or a translation gives the replica's pane a range. The
    // pane is placed by its id; the reader's place is not taken away.
    defineReplicaScrollBox(p, { clientWidth: 900, clientHeight: 650, scrollHeight: 3_650 });
    fixture.host.refreshExtent(iframe, { width: 1_600, height: 2_600 });
    expect(p.scrollTop).toBe(750);
    expect(scroller.scrollTop).toBe(100);
    // The carousel advances; the pane that stood in has not moved in the tab.
    scrollTo.mockClear();
    fixture.host.followSourceScroll(report(800));
    expect(car.scrollLeft).toBe(800);
    expect(scroller.scrollTop).toBe(100);
    expect(scrollTo).not.toHaveBeenCalled();

    // The same before the engine has refreshed: the next report alone does
    // not take the reader's place either.
    defineReplicaScrollBox(p, { clientWidth: 900, clientHeight: 650, scrollHeight: 650 });
    fixture.host.followSourceScroll(report(1_600));
    expect(scroller.scrollTop).toBe(100);
    expect(scrollTo).not.toHaveBeenCalled();
    // The pane does move in the tab while it stands in: the page follows.
    fixture.host.followSourceScroll({
      ...report(1_600),
      panes: [{ nodeId: 7, scrollX: 0, scrollY: 2_000, maxScrollX: 0, maxScrollY: 4_000 }],
    });
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 950, behavior: 'instant' });
    expect(scroller.scrollTop).toBe(950);
  });

  it('takes its own scroller echo for an echo when a pane moved in the same report (D122)', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const scrollTo = vi.fn();
    const iframe = createProtectedIframe(fixture.document, scrollTo);
    const replica = attachReplica(iframe, '<html><body><div id="car"></div></body></html>');
    const car = replica.querySelector('#car') as HTMLElement;
    defineReplicaScrollBox(car, {
      clientWidth: 900, clientHeight: 100, scrollHeight: 100, scrollWidth: 5_000,
    });
    candidate.mount.append(iframe);
    candidate.commit(iframe, { width: 1_200, height: 2_500 }, resolver([[8, car]]));
    fixture.host.markLive(iframe);
    fixture.host.refreshExtent(iframe, { width: 1_200, height: 4_300 });
    const scroller = requireElement<HTMLElement>(fixture.preview, '.replica-replay-scroll');
    const report = (scrollY: number, slide: number) => ({
      scrollX: 0, scrollY, maxScrollX: 0, maxScrollY: 1_800,
      panes: [{ nodeId: 8, scrollX: slide, scrollY: 0, maxScrollX: 4_100, maxScrollY: 0 }],
    });

    // The page and a pane move in one report. The panel scroller then fires
    // the scroll event of the position the host set: not a reader's move.
    fixture.host.followSourceScroll(report(900, 820));
    expect(scroller.scrollTop).toBe(1_800);
    expect(car.scrollLeft).toBe(820);
    scroller.dispatchEvent(new fixture.window.Event('scroll'));
    fixture.host.refreshExtent(iframe, { width: 1_200, height: 5_700 });
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 2_500, behavior: 'instant' });
    // A pane alone moves, and an event of the same position follows: still
    // not the reader, and the pane is where the tab has it.
    fixture.host.followSourceScroll(report(900, 1_640));
    scroller.dispatchEvent(new fixture.window.Event('scroll'));
    fixture.host.refreshExtent(iframe, { width: 1_200, height: 7_900 });
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 3_600, behavior: 'instant' });
    expect(car.scrollLeft).toBe(1_640);
  });

  it('puts each pane at its own place, whichever pane the replica would rank first', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const iframe = createProtectedIframe(fixture.document);
    const replica = attachReplica(
      iframe,
      '<html><body><main id="first"></main><main id="second"></main></body></html>',
    );
    const first = replica.querySelector('#first') as HTMLElement;
    const second = replica.querySelector('#second') as HTMLElement;
    // A translation made the first pane overflow in the replica only; the
    // tab scrolls the second one.
    defineReplicaScrollBox(first, {
      clientWidth: 960, clientHeight: 680, scrollHeight: 4_680,
    });
    defineReplicaScrollBox(second, {
      clientWidth: 900, clientHeight: 650, scrollHeight: 3_650,
    });
    candidate.mount.append(iframe);
    candidate.commit(
      iframe,
      { width: 1_600, height: 2_600 },
      resolver([[1, first], [2, second]]),
    );

    fixture.host.followSourceScroll({
      scrollX: 0, scrollY: 0, maxScrollX: 0, maxScrollY: 0,
      panes: [{ nodeId: 2, scrollX: 0, scrollY: 1_000, maxScrollX: 0, maxScrollY: 2_000 }],
      primaryPaneId: 2,
    });
    expect(first.scrollTop).toBe(0);
    expect(second.scrollTop).toBe(1_500);

    // Both scrolled: each by its own share.
    fixture.host.followSourceScroll({
      scrollX: 0, scrollY: 0, maxScrollX: 0, maxScrollY: 0,
      panes: [
        { nodeId: 2, scrollX: 0, scrollY: 1_000, maxScrollX: 0, maxScrollY: 2_000 },
        { nodeId: 1, scrollX: 0, scrollY: 400, maxScrollX: 0, maxScrollY: 4_000 },
      ],
      primaryPaneId: 1,
    });
    expect(first.scrollTop).toBe(400);
    expect(second.scrollTop).toBe(1_500);
  });

  it('scrolls a pane inside an open shadow root, found by node id', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const scrollTo = vi.fn();
    const iframe = createProtectedIframe(fixture.document, scrollTo);
    const replica = attachReplica(
      iframe,
      '<html><body><x-reading-pane></x-reading-pane></body></html>',
    );
    const host = replica.querySelector('x-reading-pane')!;
    const shadow = host.attachShadow({ mode: 'open' });
    const results = replica.createElement('main');
    shadow.append(results);
    defineReplicaScrollBox(results, {
      clientWidth: 900, clientHeight: 650, scrollHeight: 3_650,
    });
    candidate.mount.append(iframe);
    candidate.commit(iframe, { width: 1_200, height: 700 }, resolver([[7, results]]));

    fixture.host.followSourceScroll({
      scrollX: 0, scrollY: 0, maxScrollX: 0, maxScrollY: 0,
      panes: [{ nodeId: 7, scrollX: 0, scrollY: 2_000, maxScrollX: 0, maxScrollY: 4_000 }],
      primaryPaneId: 7,
    });

    expect(results.scrollTop).toBe(1_500);
    expect(scrollTo).toHaveBeenLastCalledWith({
      left: 0, top: 0, behavior: 'instant',
    });
  });

  it('follows small and sideways panes by share of their own range, at once (D122)', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const scrollTo = vi.fn();
    const iframe = createProtectedIframe(fixture.document, scrollTo);
    const replica = attachReplica(
      iframe,
      '<html><body><div id="board"></div><div id="chat"></div>' +
        '<div id="strip"></div><div id="smooth"></div></body></html>',
    );
    const board = replica.querySelector('#board') as HTMLElement;
    const chat = replica.querySelector('#chat') as HTMLElement;
    const strip = replica.querySelector('#strip') as HTMLElement;
    const smooth = replica.querySelector('#smooth') as HTMLElement;
    defineReplicaScrollBox(board, {
      clientWidth: 1_200, clientHeight: 650, scrollHeight: 650, scrollWidth: 7_230,
    });
    // A translation doubled the chat's range in the replica.
    defineReplicaScrollBox(chat, {
      clientWidth: 400, clientHeight: 300, scrollHeight: 4_230,
    });
    defineReplicaScrollBox(strip, {
      clientWidth: 1_000, clientHeight: 80, scrollHeight: 80, scrollWidth: 5_520,
    });
    defineReplicaScrollBox(smooth, {
      clientWidth: 1_000, clientHeight: 80, scrollHeight: 80, scrollWidth: 5_520,
    });
    const smoothScrollTo = vi.fn((options: ScrollToOptions) => {
      smooth.scrollLeft = options.left ?? 0;
      smooth.scrollTop = options.top ?? 0;
    });
    Object.defineProperty(smooth, 'scrollTo', { configurable: true, value: smoothScrollTo });
    candidate.mount.append(iframe);
    candidate.commit(
      iframe,
      { width: 1_600, height: 2_600 },
      resolver([[11, board], [12, chat], [13, strip], [14, smooth]]),
    );
    const scroller = requireElement<HTMLElement>(fixture.preview, '.replica-replay-scroll');
    scrollTo.mockClear();

    fixture.host.followSourceScroll({
      scrollX: 0, scrollY: 150, maxScrollX: 400, maxScrollY: 1_900,
      panes: [
        // Equal ranges keep exact pixels.
        { nodeId: 11, scrollX: 900, scrollY: 0, maxScrollX: 6_030, maxScrollY: 0 },
        { nodeId: 12, scrollX: 0, scrollY: 1_965, maxScrollX: 0, maxScrollY: 1_965 },
        // A right-to-left strip counts down from 0 on both sides.
        { nodeId: 13, scrollX: -2_260, scrollY: 0, maxScrollX: 4_520, maxScrollY: 0 },
        { nodeId: 14, scrollX: 2_000, scrollY: 0, maxScrollX: 4_520, maxScrollY: 0 },
      ],
    });

    expect(board.scrollLeft).toBe(900);
    expect(board.scrollTop).toBe(0);
    // At its end in the tab, at its end in the longer replica pane.
    expect(chat.scrollTop).toBe(3_930);
    expect(strip.scrollLeft).toBe(-2_260);
    // Never the page's smooth-scroll animation: the pane is put there.
    expect(smoothScrollTo).toHaveBeenCalledExactlyOnceWith({
      left: 2_000, top: 0, behavior: 'instant',
    });
    // The page itself went to the document's place, and only there.
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 150, behavior: 'instant' });
    expect(scroller.scrollTop).toBe(150);

    // A pane that is where it should be is not scrolled again.
    fixture.host.followSourceScroll({
      scrollX: 0, scrollY: 150, maxScrollX: 400, maxScrollY: 1_900,
      panes: [
        { nodeId: 14, scrollX: 2_000, scrollY: 0, maxScrollX: 4_520, maxScrollY: 0 },
      ],
    });
    expect(smoothScrollTo).toHaveBeenCalledOnce();
    // The three the report no longer lists are back at their start.
    expect(board.scrollLeft).toBe(0);
    expect(chat.scrollTop).toBe(0);
    expect(strip.scrollLeft).toBe(0);
  });

  it('leaves the reader\'s own scroll and the page where they are when a pane moves (D122)', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const scrollTo = vi.fn();
    const iframe = createProtectedIframe(fixture.document, scrollTo);
    const replica = attachReplica(
      iframe,
      '<html><body><div id="carousel"></div><main id="feed"></main></body></html>',
    );
    const carousel = replica.querySelector('#carousel') as HTMLElement;
    const feed = replica.querySelector('#feed') as HTMLElement;
    defineReplicaScrollBox(carousel, {
      clientWidth: 1_200, clientHeight: 420, scrollHeight: 420, scrollWidth: 7_108,
    });
    defineReplicaScrollBox(feed, {
      clientWidth: 900, clientHeight: 650, scrollHeight: 3_650,
    });
    candidate.mount.append(iframe);
    candidate.commit(
      iframe,
      { width: 1_600, height: 2_600 },
      resolver([[21, carousel], [22, feed]]),
    );
    const scroller = requireElement<HTMLElement>(fixture.preview, '.replica-replay-scroll');
    const page = { scrollX: 0, scrollY: 100, maxScrollX: 400, maxScrollY: 1_900 };
    const slide = (index: number) => ({
      nodeId: 21, scrollX: index * 844, scrollY: 0, maxScrollX: 5_908, maxScrollY: 0,
    });
    fixture.host.followSourceScroll({ ...page, panes: [slide(1)] });
    expect(carousel.scrollLeft).toBe(844);
    expect(scroller.scrollTop).toBe(100);

    // The reader scrolls the mirror down; the carousel then advances by
    // itself, again and again: the mirror stays where the reader put it.
    scroller.scrollTop = 500;
    scroller.dispatchEvent(new fixture.window.Event('scroll'));
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 500, behavior: 'instant' });
    scrollTo.mockClear();
    for (const index of [2, 3, 4]) {
      fixture.host.followSourceScroll({ ...page, panes: [slide(index)] });
      expect(carousel.scrollLeft).toBe(index * 844);
      expect(scroller.scrollTop).toBe(500);
    }
    expect(scrollTo).not.toHaveBeenCalled();

    // The same holds while the tab scrolls a viewport-scale pane the
    // replica has too: its moves are not the page's.
    const reading = (scrollY: number) => ({
      nodeId: 22, scrollX: 0, scrollY, maxScrollX: 0, maxScrollY: 3_000,
    });
    fixture.host.followSourceScroll({
      ...page, panes: [slide(4), reading(1_200)], primaryPaneId: 22,
    });
    expect(feed.scrollTop).toBe(1_200);
    expect(scroller.scrollTop).toBe(500);
    expect(scrollTo).not.toHaveBeenCalled();
    // And the reader can still scroll the mirror while it is followed.
    scroller.scrollTop = 800;
    scroller.dispatchEvent(new fixture.window.Event('scroll'));
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 800, behavior: 'instant' });
    fixture.host.followSourceScroll({
      ...page, panes: [slide(4), reading(1_500)], primaryPaneId: 22,
    });
    expect(feed.scrollTop).toBe(1_500);
    expect(scroller.scrollTop).toBe(800);

    // The page moves: the mirror follows it again, panes where they were.
    fixture.host.followSourceScroll({
      ...page, scrollY: 640, panes: [slide(4), reading(1_500)], primaryPaneId: 22,
    });
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 640, behavior: 'instant' });
    expect(scroller.scrollTop).toBe(640);
    expect(carousel.scrollLeft).toBe(4 * 844);
    expect(feed.scrollTop).toBe(1_500);
  });

  it('lets a pane that stands in for the page move the mirror, as the page does', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const scrollTo = vi.fn();
    const iframe = createProtectedIframe(fixture.document, scrollTo);
    attachReplica(iframe, '<html><body></body></html>');
    candidate.mount.append(iframe);
    // The replica has no element for the pane: its place is the page's.
    candidate.commit(iframe, { width: 1_600, height: 2_600 }, () => undefined);
    const scroller = requireElement<HTMLElement>(fixture.preview, '.replica-replay-scroll');
    const pane = (scrollY: number) => ({
      scrollX: 0, scrollY: 0, maxScrollX: 0, maxScrollY: 0,
      panes: [{ nodeId: 7, scrollX: 0, scrollY, maxScrollX: 0, maxScrollY: 4_000 }],
      primaryPaneId: 7,
    });

    fixture.host.followSourceScroll(pane(1_000));
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 475, behavior: 'instant' });
    scroller.scrollTop = 100;
    scroller.dispatchEvent(new fixture.window.Event('scroll'));
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 100, behavior: 'instant' });
    // A repeat of the same place keeps the reader's scroll; a move ends it.
    fixture.host.followSourceScroll(pane(1_000));
    expect(scroller.scrollTop).toBe(100);
    fixture.host.followSourceScroll(pane(4_000));
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 1_900, behavior: 'instant' });
    expect(scroller.scrollTop).toBe(1_900);
  });

  it('puts panes at their place again on a new replica, after a patch, and when following is turned on', () => {
    const fixture = createFixture();
    const first = fixture.host.createCandidate(dimensions());
    const firstFrame = createProtectedIframe(fixture.document);
    const firstReplica = attachReplica(
      firstFrame,
      '<html><body><div id="chat"></div></body></html>',
    );
    const chat = firstReplica.querySelector('#chat') as HTMLElement;
    defineReplicaScrollBox(chat, {
      clientWidth: 400, clientHeight: 300, scrollHeight: 2_265,
    });
    const nodes = new Map<number, Node>([[31, chat]]);
    first.mount.append(firstFrame);
    first.commit(firstFrame, { width: 1_600, height: 2_600 }, (id) => nodes.get(id));
    const report = {
      scrollX: 0, scrollY: 0, maxScrollX: 0, maxScrollY: 1_900,
      panes: [{ nodeId: 31, scrollX: 0, scrollY: 600, maxScrollX: 0, maxScrollY: 1_965 }],
    };
    fixture.host.followSourceScroll(report);
    expect(chat.scrollTop).toBe(600);

    // A patch makes the element again, at its start; the page's size is
    // unchanged. The engine's layout refresh puts it back.
    const remade = firstReplica.createElement('div');
    chat.replaceWith(remade);
    defineReplicaScrollBox(remade, {
      clientWidth: 400, clientHeight: 300, scrollHeight: 2_265,
    });
    nodes.set(31, remade);
    fixture.host.refreshExtent(firstFrame, { width: 1_600, height: 2_600 });
    expect(remade.scrollTop).toBe(600);

    // A translation lengthens the pane: it keeps its share.
    defineReplicaScrollBox(remade, {
      clientWidth: 400, clientHeight: 300, scrollHeight: 4_230,
    });
    remade.scrollTop = 600;
    fixture.host.refreshExtent(firstFrame, { width: 1_600, height: 2_600 });
    expect(remade.scrollTop).toBeCloseTo(1_200);

    // A new replica (Rebuild mirror, a recovery checkpoint) starts with
    // every pane at its start, and is given the kept places when shown.
    const next = fixture.host.createCandidate(dimensions());
    const nextFrame = createProtectedIframe(fixture.document);
    const nextReplica = attachReplica(
      nextFrame,
      '<html><body><div id="chat"></div></body></html>',
    );
    const nextChat = nextReplica.querySelector('#chat') as HTMLElement;
    defineReplicaScrollBox(nextChat, {
      clientWidth: 400, clientHeight: 300, scrollHeight: 2_265,
    });
    next.mount.append(nextFrame);
    next.commit(nextFrame, { width: 1_600, height: 2_600 }, resolver([[31, nextChat]]));
    expect(nextChat.scrollTop).toBe(600);

    // Following off: the panel does not pass reports on, and nothing moves.
    // On again, the last report is followed in full.
    nextChat.scrollTop = 0;
    fixture.host.followSourceScroll({
      ...report,
      panes: [{ nodeId: 31, scrollX: 0, scrollY: 1_965, maxScrollX: 0, maxScrollY: 1_965 }],
    }, true);
    expect(nextChat.scrollTop).toBe(1_965);

    // A new page: nothing of the old one is kept.
    fixture.host.resetSourceScroll();
    nextChat.scrollTop = 0;
    fixture.host.refreshExtent(nextFrame, { width: 1_600, height: 2_600 });
    expect(nextChat.scrollTop).toBe(0);
  });

  it('never takes the replica\'s own scroller, a stray node or a malformed entry for a pane', () => {
    const fixture = createFixture();
    const candidate = fixture.host.createCandidate(dimensions());
    const scrollTo = vi.fn();
    const iframe = createProtectedIframe(fixture.document, scrollTo);
    const replica = attachReplica(
      iframe,
      '<html><body><div id="pane">text</div></body></html>',
    );
    const pane = replica.querySelector('#pane') as HTMLElement;
    const html = replica.documentElement as HTMLElement;
    const body = replica.body as HTMLElement;
    const detached = replica.createElement('div');
    const foreign = fixture.document.createElement('div');
    for (const element of [pane, html, body, detached, foreign]) {
      defineReplicaScrollBox(element, {
        clientWidth: 400, clientHeight: 300, scrollHeight: 2_300,
      });
    }
    Object.defineProperty(replica, 'scrollingElement', {
      configurable: true,
      value: body,
    });
    Object.defineProperty(detached, 'isConnected', { configurable: true, value: false });
    const nodes = new Map<number, Node>([
      [1, html], [2, body], [3, detached], [4, foreign], [5, pane.firstChild as Node], [6, pane],
    ]);
    candidate.mount.append(iframe);
    candidate.commit(iframe, { width: 1_600, height: 2_600 }, (id) => {
      if (id === 9) throw new Error('resolver failed');
      return nodes.get(id);
    });
    const scroller = requireElement<HTMLElement>(fixture.preview, '.replica-replay-scroll');
    const at = (nodeId: unknown, scrollY: unknown = 500) => ({
      nodeId, scrollX: 0, scrollY, maxScrollX: 0, maxScrollY: 2_000,
    });

    fixture.host.followSourceScroll({
      scrollX: 0, scrollY: 0, maxScrollX: 0, maxScrollY: 1_900,
      panes: [
        at(1), at(2), at(3), at(4), at(5), at(9), at(77),
        at(0), at(1.5), at('6'), at(6, Number.NaN), null,
        // Past its range: held at the range. Named twice: the last one.
        at(6, 1_200), at(6, 9_000),
      ] as never,
    });

    for (const element of [html, body, detached, foreign]) {
      expect(element.scrollTop).toBe(0);
    }
    expect(pane.scrollTop).toBe(2_000);
    expect(scroller.scrollTop).toBe(0);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 0, behavior: 'instant' });

    // More panes than a report may name: the rest are not looked at.
    const many = Array.from({ length: 80 }, (_, index) => at(100 + index));
    nodes.set(179, pane);
    pane.scrollTop = 0;
    fixture.host.followSourceScroll({
      scrollX: 0, scrollY: 0, maxScrollX: 0, maxScrollY: 1_900, panes: many as never,
    });
    expect(pane.scrollTop).toBe(0);
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
      behavior: 'instant',
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

/** Gives a protected iframe a parsed replica document. */
function attachReplica(iframe: HTMLIFrameElement, markup: string): Document {
  const replica = parseHTML(markup).document;
  Object.defineProperty(iframe, 'contentDocument', {
    configurable: true,
    value: replica,
  });
  return replica;
}

/** The engine's node map, as the host sees it: mirror node id to node. */
function resolver(
  entries: ReadonlyArray<readonly [number, Node]>,
): (nodeId: number) => Node | undefined {
  const nodes = new Map(entries);
  return (nodeId) => nodes.get(nodeId);
}

function defineReplicaScrollBox(
  element: HTMLElement,
  dimensions: Readonly<{
    clientWidth: number;
    clientHeight: number;
    scrollHeight: number;
    scrollWidth?: number;
  }>,
): void {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: dimensions.clientWidth },
    clientHeight: { configurable: true, value: dimensions.clientHeight },
    scrollWidth: {
      configurable: true,
      value: dimensions.scrollWidth ?? dimensions.clientWidth,
    },
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
