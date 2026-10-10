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

describe('painted controlled regions', () => {
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
    // An open disclosure the page paints is page content too (D75).
    const popup = document.querySelector('#popup-panel')!;
    expect(policy.targets.get(popup)).toBe('controlled-region');

    const graph = sanitizeSourceDocument(document, window, new WeakNodeIdRegistry(), undefined, 'passive');
    const serialized = JSON.stringify(graph);
    expect(serialized).toContain('Slide one headline');
    expect(serialized).toContain('Slide three headline');
    expect(serialized).toContain('https://example.test/kv.png');
    expect(serialized).toContain('Popup payload');
  });

  it('keeps the painted wrapper readable whatever state its controllers carry (D75)', () => {
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
      expect(policy.targets.get(wrapper)).toBe('controlled-region');
      const serialized = JSON.stringify(
        sanitizeSourceDocument(document, window, new WeakNodeIdRegistry(), undefined, 'passive'),
      );
      expect(serialized).toContain('Slide one headline');
      expect(serialized).toContain('https://example.test/kv.png');
    }
  });

  it('reads a painted wrapper that a native control or a tablist member controls (D75)', () => {
    const { document, window } = load(CAROUSEL
      .replace('<div id="prev" role="button" tabindex="0"', '<input id="prev" type="range"')
      .replace('<div id="next" role="button" tabindex="0"', '<div role="tablist"><div id="next"'));
    const policy = createSourceControlledContentPolicy(document, window);
    const wrapper = document.querySelector('#swiper-wrapper-1')!;
    expect(policy.targets.get(wrapper)).toBe('controlled-region');
  });

  it('reports the wrapper as changed when it stops being painted', () => {
    const { document, window } = load();
    const before = createSourceControlledContentPolicy(document, window);
    // Nothing of it is painted any more: the wrapper has no height, and
    // neither has anything in it. (While something still hangs out of a
    // wrapper of no height, painted, the tab draws it and it is read.)
    for (const element of document.querySelectorAll('#swiper-wrapper-1, #swiper-wrapper-1 *')) {
      Object.defineProperty(element, 'getClientRects', {
        configurable: true,
        value: () => rectList({ left: 0, top: 0, width: 320, height: 0 }),
      });
    }
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
  describe('a target without a box of its own', () => {
    /**
     * A page whose classes say how Chrome lays each element out: `contents`
     * (`display: contents`), `h0` (a block of no height), `clip0` (the same,
     * clipping), `op0` (faded out, no height), `off` (placed off the page),
     * `faroff` (fixed, off the page), `above` (placed above the page), `vh`
     * (`visibility: hidden`), `dn` (`display: none`). `roots` gives a host
     * its root.
     */
    const shaped = (html: string, roots: Record<string, string> = {}) => {
      const { document, window } = load(`<!doctype html><html><body>${html}</body></html>`);
      const all: Element[] = [...document.querySelectorAll('*')];
      for (const [id, markup] of Object.entries(roots)) {
        const root = document.querySelector(`#${id}`)!.attachShadow({ mode: 'open' });
        root.innerHTML = markup;
        all.push(...root.querySelectorAll('*'));
      }
      const none = Object.assign([], { item: () => null }) as unknown as DOMRectList;
      const has = (element: Element, name: string) => element.classList.contains(name);
      const under = (element: Element, name: string): boolean => {
        for (let current: Element | null = element; current; current = current.parentElement) {
          if (has(current, name)) return true;
        }
        return false;
      };
      // A `<style>` is not displayed, like anything under `dn`.
      const gone = (element: Element) => under(element, 'dn') || element.localName === 'style';
      const base = window.getComputedStyle.bind(window);
      for (const element of all) {
        Object.defineProperty(element, 'getClientRects', {
          configurable: true,
          value: () => gone(element) ||
              ['contents', 'h0', 'clip0', 'op0'].some((name) => has(element, name)) ||
              element.localName === 'slot'
            ? none
            : has(element, 'off') || has(element, 'faroff')
              ? rectList({ left: -9000, top: 10, width: 120, height: 20 })
              : has(element, 'above')
                ? rectList({ left: 10, top: -9000, width: 120, height: 20 })
                : rectList({ left: 0, top: 0, width: 320, height: 40 }),
        });
      }
      Object.defineProperty(window, 'getComputedStyle', {
        configurable: true,
        value: (element: Element) => {
          const computed = base(element) as unknown as Record<string, unknown> & {
            getPropertyValue: (name: string) => string;
          };
          const clips = has(element, 'clip0');
          return {
            ...computed,
            display: has(element, 'dn') || element.localName === 'style'
              ? 'none'
              : has(element, 'contents') || element.localName === 'slot' ? 'contents' : 'block',
            visibility: under(element, 'vh') ? 'hidden' : 'visible',
            opacity: has(element, 'op0') ? '0' : '1',
            position: has(element, 'faroff')
              ? 'fixed'
              : has(element, 'off') || has(element, 'above') ? 'absolute' : 'static',
            overflowX: clips ? 'hidden' : 'visible',
            overflowY: clips ? 'hidden' : 'visible',
            getPropertyValue: (name: string) => name.startsWith('overflow') && clips
              ? 'hidden'
              : computed.getPropertyValue(name),
          };
        },
      });
      const find = (id: string): Element => {
        const found = all.find((element) => element.id === id);
        if (!found) throw new Error(`no #${id}`);
        return found;
      };
      const policy = () => createSourceControlledContentPolicy(document, window);
      return {
        document,
        window,
        find,
        policy,
        state: (id: string) => policy().targets.get(find(id)),
        sent: () => JSON.stringify(
          sanitizeSourceDocument(document, window, new WeakNodeIdRegistry(), undefined, 'passive'),
        ),
      };
    };
    const button = (n: string, label = `Open ${n}`) =>
      `<button id="b${n}" aria-expanded="false" aria-controls="t${n}">${label}</button>`;
    /** What a closed popup keeps: clipped, faded, off the page, hidden twice. */
    const closed = (n: string) =>
      `<div id="clip${n}" class="clip0"><p>CLIPPED${n}</p><input type="password" value="PASS${n}"></div>` +
      `<div id="op${n}" class="op0"><p>FADED${n}</p></div>` +
      `<div id="off${n}" class="off"><p>OFFPAGE${n}</p></div>` +
      `<div id="vh${n}" class="vh"><p>UNSEEN${n}</p></div>` +
      `<div id="dn${n}" class="dn"><p>UNSHOWN${n}</p></div>`;
    const closedIds = (n: string) => ['clip', 'op', 'off', 'vh', 'dn'].map((kind) => `${kind}${n}`);
    const closedText = (n: string) =>
      ['CLIPPED', 'PASS', 'FADED', 'OFFPAGE', 'UNSEEN', 'UNSHOWN'].map((kind) => `${kind}${n}`);

    it('reads what such a target holds that is painted, and nothing beside it', () => {
      // One painted thing used to open the whole popup. Each kind here did:
      // a caret, text in transparent ink, a child that something covers, a
      // search box. Now each opens itself and the closed content stays shut.
      const page = shaped(
        `${button('2')}<div id="t2" class="contents"><span id="seen2">CARET2</span>${closed('2')}</div>` +
        `${button('3')}<div id="t3" class="h0"><span id="seen3">ICON3</span>${closed('3')}</div>` +
        `${button('7')}<div id="t7" class="contents"><span id="seen7" style="color:transparent">INK7</span>${closed('7')}</div>` +
        `${button('8')}<div style="position:relative"><div id="t8" class="contents"><span id="seen8">COVERED8</span>${closed('8')}</div><div class="cover"></div></div>` +
        `${button('12')}<div id="t12" class="contents"><input id="seen12" type="search">${closed('12')}</div>`,
      );
      const targets = page.policy().targets;
      const sent = page.sent();
      for (const n of ['2', '3', '7', '8', '12']) {
        expect(targets.get(page.find(`t${n}`)), n).toBe('controlled-region');
        expect(targets.get(page.find(`seen${n}`)), n).toBe('controlled-region');
        for (const id of closedIds(n)) expect(targets.get(page.find(id)), id).toBe('withheld');
        for (const text of closedText(n)) expect(sent, text).not.toContain(text);
      }
      for (const text of ['CARET2', 'ICON3', 'INK7', 'COVERED8']) expect(sent).toContain(text);
    });

    it('stays withheld whole while nothing it holds is painted on the page', () => {
      const page = shaped(
        // Only closed content; a child fixed far off the page; a block
        // placed off it; a target that clips; one clipped from above.
        `${button('1')}<div id="t1" class="contents">${closed('1')}</div>` +
        `${button('5')}<div id="t5" class="contents"><span id="seen5" class="faroff">FARAWAY5</span>${closed('5')}</div>` +
        `${button('6')}<div id="t6" class="clip0"><span id="seen6">INSIDE6</span>${closed('6')}</div>` +
        `${button('9')}<div class="clip0"><div id="t9" class="contents"><span id="seen9">ABOVE9</span>${closed('9')}</div></div>`,
      );
      const targets = page.policy().targets;
      const sent = page.sent();
      for (const n of ['1', '5', '6', '9']) {
        expect(targets.get(page.find(`t${n}`)), n).toBe('withheld');
        // It is the boundary it was: nothing inside it is judged.
        for (const id of closedIds(n)) expect(targets.has(page.find(id)), id).toBe(false);
        for (const text of closedText(n)) expect(sent, text).not.toContain(text);
      }
      for (const text of ['FARAWAY5', 'INSIDE6', 'ABOVE9']) expect(sent).not.toContain(text);
      for (const id of ['seen5', 'seen6', 'seen9']) expect(targets.has(page.find(id)), id).toBe(false);
    });

    it('does not vouch for text of its own', () => {
      // Text straight in the target has no box to be judged by.
      const loose = shaped(
        `${button('1')}<div id="t1" class="contents">LOOSE1<span id="seen1">SEEN1</span></div>`,
      );
      expect(loose.state('t1')).toBe('withheld');
      expect(loose.sent()).not.toContain('LOOSE1');
      expect(loose.sent()).not.toContain('SEEN1');
      const inRoot = shaped(`${button('2')}<span id="t2" class="contents"></span>`, {
        t2: 'LOOSE2<span id="seen2">SEEN2</span>',
      });
      expect(inRoot.state('t2')).toBe('withheld');
      const fallback = shaped(`${button('3')}<span id="t3" class="contents"></span>`, {
        t3: '<slot>LOOSE3</slot><span id="seen3">SEEN3</span>',
      });
      expect(fallback.state('t3')).toBe('withheld');
      // White space between its elements is no text.
      const spaced = shaped(
        `${button('4')}<div id="t4" class="contents">\n  <span id="seen4">SEEN4</span>\n</div>`,
      );
      expect(spaced.state('t4')).toBe('controlled-region');
    });

    it('judges what its root holds, and what is slotted where it is drawn', () => {
      // A component host with its popup in its root (Material Web's
      // `md-menu`): closed, the popup is not displayed and what is slotted
      // into it has no box; open, both have.
      const menu = (open: boolean) => shaped(
        `${button('1')}<x-menu id="t1" class="contents"><span id="item" class="${open ? '' : 'h0'}">LIGHT1</span></x-menu>`,
        { t1: `<style>.x{}</style><div id="box" class="${open ? '' : 'dn'}"><slot></slot></div>` },
      );
      const shut = menu(false);
      expect(shut.state('t1')).toBe('withheld');
      expect(shut.policy().targets.has(shut.find('item'))).toBe(false);
      expect(shut.sent()).not.toContain('LIGHT1');
      const open = menu(true);
      expect(open.state('t1')).toBe('controlled-region');
      expect(open.state('box')).toBe('controlled-region');
      expect(open.state('item')).toBe('controlled-region');
      expect(open.sent()).toContain('LIGHT1');
      // A label in the root is read, the closed content beside it is not;
      // and a slot straight in the root is no boundary of its own: what it
      // draws are the host's own children, judged with the rest.
      const labelled = shaped(
        `${button('2')}<span id="t2" class="contents"><span id="light2">LIGHT2</span><span id="gone2" class="dn">GONE2</span></span>`,
        { t2: `<span id="label2">LABEL2</span><slot id="slot2"></slot>${closed('2')}` },
      );
      const targets = labelled.policy().targets;
      expect(targets.get(labelled.find('t2'))).toBe('controlled-region');
      expect(targets.get(labelled.find('label2'))).toBe('controlled-region');
      expect(targets.get(labelled.find('light2'))).toBe('controlled-region');
      expect(targets.get(labelled.find('gone2'))).toBe('withheld');
      expect(targets.has(labelled.find('slot2'))).toBe(false);
      for (const id of closedIds('2')) expect(targets.get(labelled.find(id)), id).toBe('withheld');
      const sent = labelled.sent();
      for (const text of closedText('2')) expect(sent, text).not.toContain(text);
      expect(sent).toContain('LABEL2');
      expect(sent).toContain('LIGHT2');
    });

    it('looks through what it holds that has no box either, a few levels deep', () => {
      const nest = (levels: number) => shaped(
        `${button('1')}<div id="t1" class="contents">${'<div class="contents">'.repeat(levels)}` +
        `<span id="seen1">DEEP1</span>${closed('1')}${'</div>'.repeat(levels)}</div>`,
      );
      const two = nest(2);
      expect(two.state('t1')).toBe('controlled-region');
      expect(two.state('seen1')).toBe('controlled-region');
      for (const id of closedIds('1')) expect(two.state(id), id).toBe('withheld');
      expect(two.sent()).toContain('DEEP1');
      const three = nest(3);
      expect(three.state('t1')).toBe('withheld');
      expect(three.sent()).not.toContain('DEEP1');
      // A wrapper of no height is looked through like one of no box at all,
      // and one that clips is not.
      const hanging = shaped(
        `${button('2')}<div id="t2" class="contents"><div id="mid2" class="h0"><p id="seen2">HANGS2</p></div>` +
        `<div id="cut2" class="clip0"><p>CUT2</p></div></div>`,
      );
      expect(hanging.state('mid2')).toBe('controlled-region');
      expect(hanging.state('seen2')).toBe('controlled-region');
      expect(hanging.state('cut2')).toBe('withheld');
      expect(hanging.sent()).not.toContain('CUT2');
    });

    it('leaves a target it holds to its own answer', () => {
      // The button of a closed popup inside the target is read; that popup
      // stays shut, and so does the rest. Targets without a box inside each
      // other are each looked through, and each keeps its closed content.
      const page = shaped(
        `${button('4')}<div id="t4" class="contents">${button('4b')}<div id="t4b" class="clip0">${closed('4b')}</div>${closed('4')}</div>` +
        `${button('9')}<div id="t9" class="contents">${button('9b')}<div id="t9b" class="contents"><span id="seen9">DEEP9</span>${closed('9b')}</div>${closed('9')}</div>` +
        // A target with a box, put away off the page, inside one without.
        `${button('6')}<div id="t6" class="contents"><span id="seen6">SEEN6</span>${button('6b')}<div id="t6b" class="off"><p>AWAY6</p></div></div>`,
      );
      const targets = page.policy().targets;
      const sent = page.sent();
      expect(targets.get(page.find('t4'))).toBe('controlled-region');
      expect(targets.get(page.find('b4b'))).toBe('controlled-region');
      expect(targets.get(page.find('t4b'))).toBe('withheld');
      expect(targets.get(page.find('t9'))).toBe('controlled-region');
      expect(targets.get(page.find('t9b'))).toBe('controlled-region');
      expect(targets.get(page.find('seen9'))).toBe('controlled-region');
      for (const n of ['4', '9', '9b']) {
        for (const id of closedIds(n)) expect(targets.get(page.find(id)), id).toBe('withheld');
      }
      for (const n of ['4', '4b', '9', '9b']) {
        for (const text of closedText(n)) expect(sent, text).not.toContain(text);
      }
      expect(sent).toContain('Open 4b');
      expect(sent).toContain('DEEP9');
      expect(targets.get(page.find('t6b'))).toBe('withheld');
      expect(sent).toContain('SEEN6');
      expect(sent).not.toContain('AWAY6');
      // A target that holds nothing but another target without a box is
      // looked through to what that one holds.
      // (Whichever of the two the page names first.)
      for (const buttons of [button('1') + button('1b'), button('1b') + button('1')]) {
        const only = shaped(
          `${buttons}<div id="t1" class="contents"><div id="t1b" class="contents">` +
          `<span id="seen1">INNER1</span>${closed('1b')}</div></div>`,
        );
        expect(only.state('t1')).toBe('controlled-region');
        expect(only.state('t1b')).toBe('controlled-region');
        expect(only.sent()).toContain('INNER1');
        expect(only.sent()).not.toContain('CLIPPED1b');
      }
    });

    it('takes a box left of the page or above it for put away, wherever the page is scrolled', () => {
      // The state of what a target holds on a page scrolled far right and
      // down. (The test window is one object for every page: put it back.)
      const scrolled = (held: string, id: string) => {
        const page = shaped(`${button('1')}<div id="t1" class="contents">${held}</div>`);
        const window = page.window as unknown as Record<string, unknown>;
        Object.assign(window, { scrollX: 20_000, scrollY: 20_000 });
        try {
          return page.state(id);
        } finally {
          delete window.scrollX;
          delete window.scrollY;
        }
      };
      // Fixed to the window, off it: no scrolling brings it in.
      expect(scrolled('<span class="faroff">FIXED1</span>', 't1')).toBe('withheld');
      // In the page, scrolled out of the window for now: it is on the page.
      expect(scrolled('<span id="seen1" class="off">REACHED1</span>', 'seen1'))
        .toBe('controlled-region');
      // Above the page, and left of it, where no scrolling reaches.
      const above = shaped(`${button('2')}<div id="t2" class="contents"><span class="above">ABOVE2</span></div>`);
      expect(above.state('t2')).toBe('withheld');
      const left = shaped(`${button('3')}<div id="t3" class="contents"><span class="off">LEFT3</span></div>`);
      expect(left.state('t3')).toBe('withheld');
    });

    it('follows the page when what it holds is shown and hidden again', () => {
      const page = shaped(
        `${button('1')}<div id="t1" class="contents"><span id="late1" class="dn">LATE1</span>${closed('1')}</div>`,
      );
      const before = page.policy();
      expect(before.targets.get(page.find('t1'))).toBe('withheld');
      page.find('late1').classList.remove('dn');
      const shown = page.policy();
      expect(shown.targets.get(page.find('late1'))).toBe('controlled-region');
      expect(page.sent()).toContain('LATE1');
      expect(page.sent()).not.toContain('CLIPPED1');
      // What changed is told, so that the mirror reads those elements again.
      expect(sourceControlledContentChangedTargets(before, shown))
        .toEqual(expect.arrayContaining([page.find('t1'), page.find('late1'), page.find('clip1')]));
      page.find('late1').classList.add('dn');
      expect(page.state('t1')).toBe('withheld');
      expect(page.sent()).not.toContain('LATE1');
    });

    it('gives up on a target that holds more than it will judge', () => {
      const many = (count: number) => shaped(
        `${button('1')}<div id="t1" class="contents">${'<span>MANY1</span>'.repeat(count)}</div>`,
      );
      expect(many(256).state('t1')).toBe('controlled-region');
      expect(many(257).state('t1')).toBe('withheld');
      // And on a page of many such targets, once 2,048 elements are judged:
      // of nine targets of 250, the one that comes last is left as it was.
      const targets = Array.from({ length: 9 }, (_, index) => String(index + 1));
      const crowd = shaped(targets.map((n) =>
        `${button(n)}<div id="t${n}" class="contents">${'<span>CROWD</span>'.repeat(250)}</div>`).join(''));
      const states = crowd.policy().targets;
      expect(targets.map((n) => states.get(crowd.find(`t${n}`))).sort()).toEqual([
        ...Array.from({ length: 8 }, () => 'controlled-region'),
        'withheld',
      ]);
    });
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
  it('reads a target with no box of its own when something it holds is painted', () => {
    // Material Web's `md-menu`: the host is `display: contents` and its popup
    // sits in its root, so the host never has a box of its own. It stayed
    // withheld for good, open or closed, and its items were blank.
    const { document, window } = load(`<!doctype html><html><body>
      <button aria-controls="menu" aria-expanded="true">Theme</button>
      <x-menu id="menu" role="listbox"><span id="item">Light</span></x-menu>
      <button aria-controls="zero" aria-expanded="true">More</button>
      <div id="zero"><p id="hanging">Hangs out of a block of no height</p></div>
      <button aria-controls="clip" aria-expanded="true">Clipped</button>
      <div id="clip"><p>Clipped away</p></div>
    </body></html>`);
    const byId = (id: string) => document.querySelector(`#${id}`)!;
    const menu = byId('menu');
    const root = menu.attachShadow({ mode: 'open' });
    root.innerHTML = '<div id="box"><slot></slot></div>';
    const box = root.querySelector('#box')!;
    const none = Object.assign([], { item: () => null }) as unknown as DOMRectList;
    const painted = rectList({ left: 0, top: 0, width: 320, height: 40 });
    let open = false;
    let hanging = true;
    let itemsIn = true;
    const rects = new Map<Element, () => DOMRectList>([
      // In Chrome the host has no box, and neither have its popup and what
      // is slotted into it while the popup is closed.
      [menu, () => none],
      [box, () => open ? painted : none],
      [root.querySelector('slot')!, () => none],
      [byId('item'), () => open && itemsIn ? painted : none],
      [byId('zero'), () => none],
      [byId('hanging'), () => hanging ? painted : none],
      [byId('clip'), () => none],
    ]);
    for (const [element, read] of rects) {
      Object.defineProperty(element, 'getClientRects', { configurable: true, value: read });
    }
    const style = window.getComputedStyle.bind(window);
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => {
        const computed = style(element) as unknown as Record<string, unknown> & {
          getPropertyValue: (name: string) => string;
        };
        if (element === box && !open) return { ...computed, display: 'none' };
        if (element !== byId('clip')) return computed;
        return {
          ...computed,
          overflowX: 'hidden',
          overflowY: 'hidden',
          getPropertyValue: (name: string) =>
            name.startsWith('overflow') ? 'hidden' : computed.getPropertyValue(name),
        };
      },
    });
    const state = (id: string) =>
      createSourceControlledContentPolicy(document, window).targets.get(byId(id));
    // Closed: nothing it holds is painted, and it is withheld as before.
    expect(state('menu')).toBe('withheld');
    open = true;
    expect(state('menu')).toBe('controlled-region');
    // The popup in its root alone is enough (its items may still fade in).
    itemsIn = false;
    expect(state('menu')).toBe('controlled-region');
    // A block of no height is read while what hangs out of it is painted,
    // and one that clips away what it holds is not.
    expect(state('zero')).toBe('controlled-region');
    hanging = false;
    expect(state('zero')).toBe('withheld');
    expect(state('clip')).toBe('withheld');
  });
});
