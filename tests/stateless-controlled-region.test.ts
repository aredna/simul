import { parseHTML } from 'linkedom';
import { beforeEach, describe, expect, it } from 'vitest';

import { sanitizeSourceDocument } from '../lib/replica/html-mirror-sanitizer';
import { WeakNodeIdRegistry } from '../lib/replica/html-mirror-source';
import { hasSourceAriaControlledRegionAncestor } from '../lib/ocr/image-source-session';
import {
  createSourceControlledContentPolicy,
  sourceControlledContentChangedTargets,
  sourceControlledContentIsControlledRegion,
  sourceControlledContentIsWithheld,
} from '../lib/replica/source-privacy-policy';

// A Swiper-style carousel after its accessibility module ran: the slide
// wrapper carries a generated id and the previous/next buttons reference it
// with `aria-controls`, but neither button carries any disclosure state.
const CAROUSEL = `<!doctype html><html><body>
  <div class="carousel">
    <div id="swiper-wrapper-1" class="swiper-wrapper" aria-live="off">
      <div class="swiper-slide" role="group">Slide one headline</div>
      <div class="swiper-slide" role="group">
        <button class="signup"><img id="banner" src="/kv.png" alt="Banner label"></button>
      </div>
      <div class="swiper-slide" role="group">Slide three headline</div>
    </div>
    <div class="nav">
      <div id="prev" role="button" tabindex="0" aria-controls="swiper-wrapper-1" aria-label="Previous slide"></div>
      <div id="next" role="button" tabindex="0" aria-controls="swiper-wrapper-1" aria-label="Next slide"></div>
    </div>
  </div>
  <button id="disclosure" aria-expanded="true" aria-controls="popup-panel">Popup</button>
  <section id="popup-panel">Popup payload</section>
</body></html>`;

function rectList(rect: { left: number; top: number; width: number; height: number }): DOMRectList {
  const item = {
    ...rect,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => rect,
  };
  const list = [item] as unknown as DOMRectList;
  Object.defineProperty(list, 'item', { value: (index: number) => (index === 0 ? item : null) });
  return list;
}

function installPaintedSourceFixture(document: Document, window: Window): void {
  for (const element of document.querySelectorAll('*')) {
    Object.defineProperty(element, 'getClientRects', {
      configurable: true,
      value: () => rectList({ left: 0, top: 0, width: 320, height: 40 }),
    });
  }
  Object.defineProperty(window, 'getComputedStyle', {
    configurable: true,
    value: ((element: Element) => {
      const hidden = element.hasAttribute('hidden') ||
        element.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true';
      return {
        display: hidden ? 'none' : 'block',
        visibility: 'visible',
        opacity: '1',
        overflowX: 'visible',
        overflowY: 'visible',
        backgroundColor: 'rgba(0, 0, 0, 0)',
        getPropertyValue: (name: string) => {
          if (name === '-webkit-text-security') return 'none';
          if (name === 'content-visibility') return 'visible';
          if (name === 'clip') return 'auto';
          if (name === 'clip-path') return 'none';
          if (name.startsWith('overflow')) return 'visible';
          return '';
        },
      } as unknown as CSSStyleDeclaration;
    }) as Window['getComputedStyle'],
  });
}

function load(html = CAROUSEL) {
  const { document, window } = parseHTML(html);
  Object.defineProperty(document, 'baseURI', { configurable: true, value: 'https://example.test/' });
  installPaintedSourceFixture(document as unknown as Document, window as unknown as Window);
  return { document: document as unknown as Document, window: window as unknown as Window };
}

describe('stateless controlled regions', () => {
  beforeEach(() => {
    const { window } = parseHTML('<html><body></body></html>');
    Object.assign(globalThis, { Node: window.Node, Element: window.Element, Text: window.Text });
  });

  it('keeps a carousel wrapper controlled only by stateless buttons readable', () => {
    const { document, window } = load();
    const policy = createSourceControlledContentPolicy(document, window);
    const wrapper = document.querySelector('#swiper-wrapper-1')!;
    expect(policy.targets.get(wrapper)).toBe('controlled-region');
    expect(sourceControlledContentIsWithheld(wrapper, policy)).toBe(false);
    expect(sourceControlledContentIsControlledRegion(wrapper, policy)).toBe(true);
    // A stateful disclosure next to it still fails closed in the base graph.
    const popup = document.querySelector('#popup-panel')!;
    expect(policy.targets.get(popup)).toBe('withheld');

    const graph = sanitizeSourceDocument(document, window, new WeakNodeIdRegistry(), undefined, 'passive');
    const serialized = JSON.stringify(graph);
    expect(serialized).toContain('Slide one headline');
    expect(serialized).toContain('Slide three headline');
    expect(serialized).toContain('https://example.test/kv.png');
    expect(serialized).not.toContain('Popup payload');
  });

  it('withholds the same wrapper once any of its controllers carries disclosure state', () => {
    for (const mutate of [
      (button: Element) => button.setAttribute('aria-expanded', 'false'),
      (button: Element) => button.setAttribute('aria-expanded', 'true'),
      (button: Element) => button.setAttribute('aria-selected', 'true'),
      (button: Element) => button.setAttribute('aria-pressed', 'false'),
      (button: Element) => button.setAttribute('aria-haspopup', 'true'),
      (button: Element) => button.setAttribute('role', 'tab'),
    ]) {
      const { document, window } = load();
      mutate(document.querySelector('#next')!);
      const policy = createSourceControlledContentPolicy(document, window);
      const wrapper = document.querySelector('#swiper-wrapper-1')!;
      expect(policy.targets.get(wrapper)).toBe('withheld');
      const serialized = JSON.stringify(
        sanitizeSourceDocument(document, window, new WeakNodeIdRegistry(), undefined, 'passive'),
      );
      expect(serialized).not.toContain('Slide one headline');
      expect(serialized).toContain('https://example.test/kv.png');
    }
  });

  it('treats a native control or a tablist member as stateful', () => {
    const { document, window } = load(CAROUSEL
      .replace('<div id="prev" role="button" tabindex="0"', '<input id="prev" type="range"')
      .replace('<div id="next" role="button" tabindex="0"', '<div role="tablist"><div id="next"'));
    const policy = createSourceControlledContentPolicy(document, window);
    const wrapper = document.querySelector('#swiper-wrapper-1')!;
    expect(policy.targets.get(wrapper)).toBe('withheld');
  });

  it('reports the wrapper as changed when a controller gains disclosure state', () => {
    const { document, window } = load();
    const before = createSourceControlledContentPolicy(document, window);
    document.querySelector('#next')!.setAttribute('aria-expanded', 'false');
    const after = createSourceControlledContentPolicy(document, window);
    const wrapper = document.querySelector('#swiper-wrapper-1')!;
    expect(sourceControlledContentChangedTargets(before, after)).toContain(wrapper);
    expect(sourceControlledContentChangedTargets(after, before)).toContain(wrapper);
  });

  it('keeps a stateless-controlled panel withheld while it is collapsed, faded or clipped away (P2)', () => {
    const { document, window } = load(CAROUSEL.replace('</body>', `
      <button id="show-collapsed" aria-controls="collapsed-panel">Show details</button>
      <div id="collapsed-panel">Collapsed details</div>
      <button id="show-faded" aria-controls="faded-panel">Show more</button>
      <div id="faded-panel">Faded details</div>
      <button id="show-clipped" aria-controls="clipped-panel">Show extra</button>
      <div id="clip-window"><div id="clipped-panel">Clipped details</div></div>
    </body>`));
    const setRect = (
      selector: string,
      rect: { left: number; top: number; width: number; height: number },
    ) => Object.defineProperty(document.querySelector(selector)!, 'getClientRects', {
      configurable: true,
      value: () => rectList(rect),
    });
    // `max-height: 0; overflow: hidden` on the panel, and on the clipping
    // window around the third panel.
    setRect('#collapsed-panel', { left: 0, top: 0, width: 320, height: 0 });
    setRect('#clip-window', { left: 0, top: 0, width: 320, height: 0 });
    const painted = window.getComputedStyle.bind(window);
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: ((element: Element) => {
        const style = painted(element) as unknown as Record<string, unknown> & {
          getPropertyValue: (name: string) => string;
        };
        if (element.id === 'faded-panel') return { ...style, opacity: '0' };
        if (element.id === 'clip-window') {
          return {
            ...style,
            overflowX: 'hidden',
            overflowY: 'hidden',
            getPropertyValue: (name: string) =>
              name.startsWith('overflow') ? 'hidden' : style.getPropertyValue(name),
          };
        }
        return style;
      }) as unknown as Window['getComputedStyle'],
    });

    const policy = createSourceControlledContentPolicy(document, window);
    for (const id of ['#collapsed-panel', '#faded-panel', '#clipped-panel']) {
      expect(policy.targets.get(document.querySelector(id)!)).toBe('withheld');
    }
    // The painted carousel wrapper is unaffected.
    expect(policy.targets.get(document.querySelector('#swiper-wrapper-1')!))
      .toBe('controlled-region');
    const serialized = JSON.stringify(
      sanitizeSourceDocument(document, window, new WeakNodeIdRegistry(), undefined, 'passive'),
    );
    expect(serialized).toContain('Slide one headline');
    expect(serialized).not.toContain('Collapsed details');
    expect(serialized).not.toContain('Faded details');
    expect(serialized).not.toContain('Clipped details');

    // Expanding the panel makes it ordinary page content, and the flip is
    // reported so the source session re-emits it.
    setRect('#collapsed-panel', { left: 0, top: 0, width: 320, height: 40 });
    const expanded = createSourceControlledContentPolicy(document, window);
    const panel = document.querySelector('#collapsed-panel')!;
    expect(expanded.targets.get(panel)).toBe('controlled-region');
    expect(sourceControlledContentChangedTargets(policy, expanded)).toContain(panel);
  });

  it('reads a carousel whose track box is translated beside the window while a slide is in view', () => {
    // freee.co.jp: Swiper moves the wrapper with translate3d(-1068px, ...), so
    // the wrapper's own 320px box sits left of the carousel window and only
    // the slides it overflows into are painted. D54 withheld every slide's
    // text and button labels because the wrapper's own box was clipped away.
    const geometry = (options: {
      readonly wrapperClips?: boolean;
      readonly slideInView?: boolean;
    } = {}) => {
      const { document, window } = load();
      const setRect = (
        selector: string,
        rect: { left: number; top: number; width: number; height: number },
      ) => Object.defineProperty(document.querySelector(selector)!, 'getClientRects', {
        configurable: true,
        value: () => rectList(rect),
      });
      setRect('.carousel', { left: 100, top: 0, width: 320, height: 40 });
      setRect('#swiper-wrapper-1', { left: -220, top: 0, width: 320, height: 40 });
      const slides = [...document.querySelectorAll('.swiper-slide')];
      const firstLeft = options.slideInView === false ? 420 : -220;
      slides.forEach((slide, index) => Object.defineProperty(slide, 'getClientRects', {
        configurable: true,
        value: () => rectList({ left: firstLeft + index * 320, top: 0, width: 320, height: 40 }),
      }));
      const painted = window.getComputedStyle.bind(window);
      const clipping = (style: Record<string, unknown> & {
        getPropertyValue: (name: string) => string;
      }) => ({
        ...style,
        overflowX: 'hidden',
        overflowY: 'hidden',
        getPropertyValue: (name: string) =>
          name.startsWith('overflow') ? 'hidden' : style.getPropertyValue(name),
      });
      Object.defineProperty(window, 'getComputedStyle', {
        configurable: true,
        value: ((element: Element) => {
          const style = painted(element) as unknown as Record<string, unknown> & {
            getPropertyValue: (name: string) => string;
          };
          if (element.classList.contains('carousel')) return clipping(style);
          if (element.id === 'swiper-wrapper-1' && options.wrapperClips) {
            return clipping(style);
          }
          return style;
        }) as unknown as Window['getComputedStyle'],
      });
      return { document, window };
    };

    const { document, window } = geometry();
    const policy = createSourceControlledContentPolicy(document, window);
    expect(policy.targets.get(document.querySelector('#swiper-wrapper-1')!))
      .toBe('controlled-region');
    const serialized = JSON.stringify(
      sanitizeSourceDocument(document, window, new WeakNodeIdRegistry(), undefined, 'passive'),
    );
    expect(serialized).toContain('Slide one headline');
    expect(serialized).toContain('Slide three headline');

    // A track that clips its own overflow, or whose slides are all outside the
    // window too, is not proven painted.
    for (const options of [{ wrapperClips: true }, { slideInView: false }]) {
      const clipped = geometry(options);
      const withheld = createSourceControlledContentPolicy(clipped.document, clipped.window);
      expect(withheld.targets.get(clipped.document.querySelector('#swiper-wrapper-1')!))
        .toBe('withheld');
      expect(JSON.stringify(sanitizeSourceDocument(
        clipped.document,
        clipped.window,
        new WeakNodeIdRegistry(),
        undefined,
        'passive',
      ))).not.toContain('Slide one headline');
    }
  });

  it('still counts images inside a stateless controlled region as control images', () => {
    const { document, window } = load();
    const policy = createSourceControlledContentPolicy(document, window);
    const banner = document.querySelector('#banner')!;
    expect(hasSourceAriaControlledRegionAncestor(banner, policy)).toBe(true);
    document.querySelector('#prev')!.removeAttribute('aria-controls');
    document.querySelector('#next')!.removeAttribute('aria-controls');
    const freed = createSourceControlledContentPolicy(document, window);
    expect(hasSourceAriaControlledRegionAncestor(banner, freed)).toBe(false);
  });
});
