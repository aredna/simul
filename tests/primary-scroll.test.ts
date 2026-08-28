import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  isDocumentScrollTarget,
  nestedScrollerOrdinal,
  readDocumentScrollSnapshot,
  readNestedScrollSnapshot,
} from '../lib/primary-scroll';

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

    const second = document.createElement('section');
    second.setAttribute('style', 'overflow-y:auto');
    document.body.append(second);
    defineScrollBox(second, {
      clientWidth: 880, clientHeight: 700,
      scrollWidth: 880, scrollHeight: 4_700,
      scrollLeft: 0, scrollTop: 600,
    }, { left: 260, top: 70, right: 1_140, bottom: 770 });
    expect(nestedScrollerOrdinal(results, document, window)).toBe(0);
    expect(nestedScrollerOrdinal(second, document, window)).toBe(1);

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
