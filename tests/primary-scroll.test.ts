import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  forEachScrolledElement,
  isDocumentScrollTarget,
  readDocumentScrollSnapshot,
  readNestedScrollSnapshot,
  readPaneScrollPlace,
  readVisualViewportSnapshot,
} from '../lib/primary-scroll';
import { installSourceShadowRootReader } from '../lib/replica/source-shadow-root';
import { closedRootReader } from './support/closed-shadow-roots';

describe('primary scroll classification', () => {
  it('uses the authoritative standards/body document owner and bounded coordinates', () => {
    const { document, window } = parseHTML('<html><body></body></html>');
    defineScrollBox(document.documentElement, {
      clientWidth: 1_200, clientHeight: 700,
      scrollWidth: 1_500, scrollHeight: 3_000,
      scrollLeft: 60, scrollTop: 900,
    });
    defineScrollBox(document.body, {
      clientWidth: 1_200, clientHeight: 700,
      scrollWidth: 1_400, scrollHeight: 2_800,
      scrollLeft: 0, scrollTop: 0,
    });
    Object.defineProperties(window, {
      innerWidth: { configurable: true, value: 1_200 },
      innerHeight: { configurable: true, value: 700 },
      scrollX: { configurable: true, value: 60 },
      scrollY: { configurable: true, value: 900 },
    });
    Object.defineProperty(document, 'scrollingElement', {
      configurable: true,
      value: document.documentElement,
    });

    expect(readDocumentScrollSnapshot(document, window)).toEqual({
      scrollTarget: 'document', scrollX: 60, scrollY: 900,
      maxScrollX: 300, maxScrollY: 2_300,
    });

    document.documentElement.scrollTop = 300;
    document.body.scrollTop = 1_700;
    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      value: 300,
    });
    expect(readDocumentScrollSnapshot(document, window)).toMatchObject({
      scrollTarget: 'document', scrollY: 300,
    });
  });

  it('accepts viewport-scale nested surfaces and rejects incidental or editable scrollers', () => {
    const { document, window } = parseHTML(`
      <html><body><main id="results" style="overflow-y:auto"></main>
      <div id="carousel"></div><textarea id="editor"></textarea></body></html>
    `);
    Object.defineProperties(window, {
      innerWidth: { configurable: true, value: 1_200 },
      innerHeight: { configurable: true, value: 800 },
    });
    const results = document.querySelector('#results')!;
    defineScrollBox(results, {
      clientWidth: 900, clientHeight: 720,
      scrollWidth: 900, scrollHeight: 5_000,
      scrollLeft: 0, scrollTop: 1_300,
    }, { left: 240, top: 60, right: 1_140, bottom: 780 });
    expect(readNestedScrollSnapshot(results, document, window)).toEqual({
      scrollTarget: 'nested', scrollX: 0, scrollY: 1_300,
      maxScrollX: 0, maxScrollY: 4_280,
    });

    const carousel = document.querySelector('#carousel')!;
    defineScrollBox(carousel, {
      clientWidth: 900, clientHeight: 160,
      scrollWidth: 4_000, scrollHeight: 160,
      scrollLeft: 300, scrollTop: 0,
    });
    expect(readNestedScrollSnapshot(carousel, document, window)).toBeUndefined();

    const editor = document.querySelector('#editor')!;
    defineScrollBox(editor, {
      clientWidth: 900, clientHeight: 720,
      scrollWidth: 900, scrollHeight: 5_000,
      scrollLeft: 0, scrollTop: 900,
    });
    expect(readNestedScrollSnapshot(editor, document, window)).toBeUndefined();
  });

  it('treats a body with independent overflow as nested when html owns document scroll', () => {
    const { document, window } = parseHTML(
      '<html><body style="overflow-y:auto"></body></html>',
    );
    Object.defineProperties(window, {
      innerWidth: { configurable: true, value: 1_200 },
      innerHeight: { configurable: true, value: 800 },
    });
    Object.defineProperty(document, 'scrollingElement', {
      configurable: true,
      value: document.documentElement,
    });
    defineScrollBox(document.body, {
      clientWidth: 1_150, clientHeight: 760,
      scrollWidth: 1_150, scrollHeight: 4_760,
      scrollLeft: 0, scrollTop: 900,
    }, { left: 25, top: 20, right: 1_175, bottom: 780 });

    expect(readNestedScrollSnapshot(document.body, document, window)).toEqual({
      scrollTarget: 'nested', scrollX: 0, scrollY: 900,
      maxScrollX: 0, maxScrollY: 4_000,
    });
    expect(isDocumentScrollTarget(document.body, document, window)).toBe(false);
    expect(isDocumentScrollTarget(
      document.documentElement,
      document,
      window,
    )).toBe(true);
  });

  it('preserves scroll progress on a document taller than the protocol bound', () => {
    const { document, window } = parseHTML('<html><body></body></html>');
    defineScrollBox(document.documentElement, {
      clientWidth: 1_200, clientHeight: 800,
      scrollWidth: 1_500, scrollHeight: 250_800,
      scrollLeft: 60, scrollTop: 125_000,
    });
    Object.defineProperties(window, {
      innerWidth: { configurable: true, value: 1_200 },
      innerHeight: { configurable: true, value: 800 },
      scrollX: { configurable: true, value: 60 },
      scrollY: { configurable: true, value: 125_000 },
    });
    Object.defineProperty(document, 'scrollingElement', {
      configurable: true,
      value: document.documentElement,
    });

    // The vertical axis is 250,000 px deep: halfway reads as halfway of the
    // bound, while the horizontal axis inside the bound stays exact.
    expect(readDocumentScrollSnapshot(document, window)).toEqual({
      scrollTarget: 'document', scrollX: 60, scrollY: 50_000,
      maxScrollX: 300, maxScrollY: 100_000,
    });

    document.documentElement.scrollTop = 200_000;
    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      value: 200_000,
    });
    expect(readDocumentScrollSnapshot(document, window)).toMatchObject({
      scrollY: 80_000, maxScrollY: 100_000,
    });

    document.documentElement.scrollTop = 250_000;
    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      value: 250_000,
    });
    expect(readDocumentScrollSnapshot(document, window)).toMatchObject({
      scrollY: 100_000, maxScrollY: 100_000,
    });
  });

  it('reads the place of any pane that scrolls on its own (D122)', () => {
    const { document } = parseHTML(`
      <html><body><div id="board"></div><div id="chat"></div>
      <div id="strip" dir="rtl"></div><textarea id="editor"></textarea>
      <div id="rich" contenteditable="true"><div id="inside"></div></div>
      <div role="textbox"><div id="in-textbox"></div></div></body></html>
    `);
    Object.defineProperty(document, 'scrollingElement', {
      configurable: true,
      value: document.documentElement,
    });
    // Sideways only, far from viewport scale, with no style read at all.
    const board = document.querySelector('#board')!;
    defineScrollBox(board, {
      clientWidth: 1_200, clientHeight: 650,
      scrollWidth: 7_230, scrollHeight: 650,
      scrollLeft: 900.126, scrollTop: 0,
    });
    expect(readPaneScrollPlace(board, document)).toEqual({
      scrollX: 900.13, scrollY: 0, maxScrollX: 6_030, maxScrollY: 0,
    });
    expect(Object.isFrozen(readPaneScrollPlace(board, document))).toBe(true);

    const chat = document.querySelector('#chat')!;
    defineScrollBox(chat, {
      clientWidth: 400, clientHeight: 300,
      scrollWidth: 400, scrollHeight: 2_265,
      scrollLeft: 0, scrollTop: 600,
    });
    expect(readPaneScrollPlace(chat, document)).toEqual({
      scrollX: 0, scrollY: 600, maxScrollX: 0, maxScrollY: 1_965,
    });

    // A right-to-left strip counts down from 0: the sign is kept, and an
    // offset past the range is held at the range.
    const strip = document.querySelector('#strip')!;
    defineScrollBox(strip, {
      clientWidth: 1_000, clientHeight: 80,
      scrollWidth: 5_520, scrollHeight: 80,
      scrollLeft: -900, scrollTop: 0,
    });
    expect(readPaneScrollPlace(strip, document)).toEqual({
      scrollX: -900, scrollY: 0, maxScrollX: 4_520, maxScrollY: 0,
    });
    strip.scrollLeft = -9_000;
    expect(readPaneScrollPlace(strip, document)).toMatchObject({
      scrollX: -4_520, maxScrollX: 4_520,
    });

    // Text fields, and anything inside one, keep their own scroll.
    for (const selector of ['#editor', '#rich', '#inside', '#in-textbox']) {
      const editable = document.querySelector(selector)!;
      defineScrollBox(editable, {
        clientWidth: 400, clientHeight: 120,
        scrollWidth: 400, scrollHeight: 900,
        scrollLeft: 0, scrollTop: 300,
      });
      expect(readPaneScrollPlace(editable, document), selector).toBeUndefined();
    }
    const fields = parseHTML(`
      <html><body><input id="line" value="a long value">
      <select id="pick" multiple><option>one</option></select>
      <div id="combo" role="combobox"><div id="in-combo"></div></div>
      <div id="search" role="searchbox"></div>
      <div id="both" role="note searchbox"></div>
      <div id="rich" contenteditable><div id="in-rich"></div></div>
      <div id="fixed" contenteditable="false"><div id="in-fixed"></div></div>
      <div id="listbox" role="listbox"></div></body></html>
    `).document;
    const scrolled = (selector: string) => {
      const element = fields.querySelector(selector)!;
      defineScrollBox(element, {
        clientWidth: 400, clientHeight: 120,
        scrollWidth: 400, scrollHeight: 900,
        scrollLeft: 0, scrollTop: 300,
      });
      return readPaneScrollPlace(element, fields);
    };
    for (const selector of [
      '#line', '#pick', '#combo', '#in-combo', '#search', '#both', '#rich', '#in-rich',
    ]) expect(scrolled(selector), selector).toBeUndefined();
    // Not a text field: content that is not editable, and a plain list.
    for (const selector of ['#fixed', '#in-fixed', '#listbox']) {
      expect(scrolled(selector), selector).toEqual({
        scrollX: 0, scrollY: 300, maxScrollX: 0, maxScrollY: 780,
      });
    }

    // The document's own scroller and html follow as the document. body is a
    // pane only when it scrolls apart from the document, whatever its style.
    defineScrollBox(document.documentElement, {
      clientWidth: 1_200, clientHeight: 700,
      scrollWidth: 1_200, scrollHeight: 3_000,
      scrollLeft: 0, scrollTop: 900,
    });
    expect(readPaneScrollPlace(document.documentElement, document)).toBeUndefined();
    document.body.setAttribute('style', 'overflow-y:scroll');
    defineScrollBox(document.body, {
      clientWidth: 1_200, clientHeight: 2_960,
      scrollWidth: 1_200, scrollHeight: 2_960,
      scrollLeft: 0, scrollTop: 0,
    });
    expect(readPaneScrollPlace(document.body, document)).toEqual({
      scrollX: 0, scrollY: 0, maxScrollX: 0, maxScrollY: 0,
    });
    Object.defineProperty(document, 'scrollingElement', {
      configurable: true,
      value: document.body,
    });
    expect(readPaneScrollPlace(document.body, document)).toBeUndefined();
    expect(readPaneScrollPlace(document.documentElement, document)).toBeUndefined();

    // A removed element, and one of another document, are not panes.
    chat.remove();
    Object.defineProperty(chat, 'isConnected', { configurable: true, value: false });
    expect(readPaneScrollPlace(chat, document)).toBeUndefined();
    const other = parseHTML('<html><body><div></div></body></html>').document;
    expect(readPaneScrollPlace(other.querySelector('div')!, document)).toBeUndefined();
  });

  it('scales a pane longer than the protocol bound, keeping its share', () => {
    const { document } = parseHTML('<html><body><div id="list"></div></body></html>');
    const list = document.querySelector('#list')!;
    defineScrollBox(list, {
      clientWidth: 400, clientHeight: 300,
      scrollWidth: 400, scrollHeight: 400_300,
      scrollLeft: 0, scrollTop: 100_000,
    });
    expect(readPaneScrollPlace(list, document)).toEqual({
      scrollX: 0, scrollY: 25_000, maxScrollX: 0, maxScrollY: 100_000,
    });
  });

  it('walks to the scrolled elements inside closed shadow roots (D125)', () => {
    const { document } = parseHTML(
      '<html><body><x-list id="host"></x-list><input id="field"></body></html>',
    );
    const host = document.querySelector('#host')!;
    const reader = closedRootReader();
    const root = reader.attach(host, '<div id="pane"></div><x-inner id="inner"></x-inner>');
    const nested = reader.attach(root.querySelector('#inner')!, '<div id="deep"></div>');
    const pane = root.querySelector('#pane')!;
    const deep = nested.querySelector('#deep')!;
    Object.defineProperty(pane, 'scrollTop', { configurable: true, value: 500 });
    Object.defineProperty(deep, 'scrollLeft', { configurable: true, value: 120 });
    const walk = () => {
      const found: Element[] = [];
      forEachScrolledElement(document, (candidate) => {
        found.push(candidate);
        return true;
      });
      return found;
    };

    expect(walk()).toEqual([]);
    installSourceShadowRootReader(document, reader.read);
    expect(walk()).toEqual([pane, deep]);
    // A text field's own root is never asked for.
    expect(reader.calls).not.toContain(document.querySelector('#field'));
    installSourceShadowRootReader(document, undefined);
  });

  it('walks to the scrolled elements, through open shadow roots, within its bound', () => {
    const { document } = parseHTML('<html><body></body></html>');
    // Ordinary content is at its start and costs two number reads each.
    const filler = document.createDocumentFragment();
    for (let index = 0; index < 6_000; index += 1) {
      filler.append(document.createElement('span'));
    }
    document.body.append(filler);
    const strip = document.createElement('div');
    const host = document.createElement('x-list');
    const column = document.createElement('div');
    document.body.append(strip, host, column);
    const inner = document.createElement('div');
    host.attachShadow({ mode: 'open' }).append(inner);
    Object.defineProperty(strip, 'scrollLeft', { configurable: true, value: 300 });
    Object.defineProperty(inner, 'scrollTop', { configurable: true, value: 500 });
    // A reversed column counts down from 0.
    Object.defineProperty(column, 'scrollTop', { configurable: true, value: -40 });

    const found: Element[] = [];
    forEachScrolledElement(document, (candidate) => {
      found.push(candidate);
      return true;
    });
    expect(found).toEqual([strip, column, inner]);

    // The visitor can stop the walk.
    const first: Element[] = [];
    forEachScrolledElement(document, (candidate) => {
      first.push(candidate);
      return false;
    });
    expect(first).toEqual([strip]);

    // Past 50,000 elements the walk stops: a later pane waits for its next
    // scroll event.
    const many = document.createDocumentFragment();
    for (let index = 0; index < 50_000; index += 1) {
      many.append(document.createElement('i'));
    }
    document.body.prepend(many);
    const late: Element[] = [];
    forEachScrolledElement(document, (candidate) => {
      late.push(candidate);
      return true;
    });
    expect(late).toEqual([]);
  });

  it('reads a pinch zoom, and nothing while the page is not magnified (D115)', () => {
    expect(readVisualViewportSnapshot({})).toBeUndefined();
    expect(readVisualViewportSnapshot({ visualViewport: null })).toBeUndefined();
    expect(readVisualViewportSnapshot({
      visualViewport: { scale: 1, offsetLeft: 0, offsetTop: 0 },
    })).toBeUndefined();
    // A pinch that ends a hair from no magnification is none.
    expect(readVisualViewportSnapshot({
      visualViewport: { scale: 1.0004, offsetLeft: 0.2, offsetTop: 0 },
    })).toBeUndefined();
    expect(readVisualViewportSnapshot({
      visualViewport: { scale: 2.00049, offsetLeft: 200.004, offsetTop: 150.5 },
    })).toEqual({ visualScale: 2, visualOffsetX: 200, visualOffsetY: 150.5 });
    // Out-of-range and broken values stay inside what the panel accepts.
    expect(readVisualViewportSnapshot({
      visualViewport: { scale: 40, offsetLeft: -3, offsetTop: Number.NaN },
    })).toEqual({ visualScale: 10, visualOffsetX: 0, visualOffsetY: 0 });
    expect(readVisualViewportSnapshot({
      visualViewport: { scale: Number.POSITIVE_INFINITY, offsetLeft: 0, offsetTop: 0 },
    })).toBeUndefined();
    expect(readVisualViewportSnapshot({
      get visualViewport(): never {
        throw new Error('detached');
      },
    })).toBeUndefined();
  });

  it('scales an oversized nested scroller the same way', () => {
    const { document, window } = parseHTML(
      '<html><body><main id="feed" style="overflow-y:auto"></main></body></html>',
    );
    Object.defineProperties(window, {
      innerWidth: { configurable: true, value: 1_200 },
      innerHeight: { configurable: true, value: 800 },
    });
    const feed = document.querySelector('#feed')!;
    defineScrollBox(feed, {
      clientWidth: 900, clientHeight: 720,
      scrollWidth: 900, scrollHeight: 400_720,
      scrollLeft: 0, scrollTop: 100_000,
    }, { left: 240, top: 60, right: 1_140, bottom: 780 });

    expect(readNestedScrollSnapshot(feed, document, window)).toEqual({
      scrollTarget: 'nested', scrollX: 0, scrollY: 25_000,
      maxScrollX: 0, maxScrollY: 100_000,
    });
  });
});

function defineScrollBox(
  element: Element,
  dimensions: Readonly<{
    clientWidth: number;
    clientHeight: number;
    scrollWidth: number;
    scrollHeight: number;
    scrollLeft: number;
    scrollTop: number;
  }>,
  rect = {
    left: 0,
    top: 0,
    right: dimensions.clientWidth,
    bottom: dimensions.clientHeight,
  },
): void {
  for (const [name, value] of Object.entries(dimensions)) {
    Object.defineProperty(element, name, {
      configurable: true,
      writable: name === 'scrollLeft' || name === 'scrollTop',
      value,
    });
  }
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      ...rect,
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
      toJSON: () => ({}),
    }),
  });
}
