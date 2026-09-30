import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  GEOMETRY_LOCK_MARKER,
  MIN_TRANSLATED_FONT_SCALE,
  TranslatedGeometryLock,
  type TranslatedGeometryEntry,
  type TranslatedGeometryView,
} from '../lib/replica/translated-geometry';

// A small layout model: paragraphs are 300px wide; a character is half the
// font size wide and a line is 1.5 font sizes tall.
const BOX_WIDTH = 300;
const PAGE_FONT = 16;

describe('translated geometry lock', () => {
  it('holds a translated box at the page text size and shrinks text to fit', () => {
    const fixture = createFixture('<p id="p">SOURCE</p>');
    const { entry } = fixture.translate('#p', 'x'.repeat(40), 'y'.repeat(80));
    // Page text: 320px on two lines, 48px. Translated: three lines, 72px.
    expect(fixture.height('#p')).toBe(72);

    fixture.lock.lock([entry], fixture.view);

    const box = fixture.element('#p');
    expect(box.textContent).toBe('y'.repeat(80));
    expect(box.style.getPropertyValue('height')).toBe('48px');
    expect(box.style.getPropertyValue('width')).toBe('300px');
    expect(fixture.height('#p')).toBe(48);
    expect(fixture.overflows('#p')).toBe(false);
    const scale = parseFloat(box.style.getPropertyValue('font-size')) / PAGE_FONT;
    expect(scale).toBeLessThan(1);
    expect(scale).toBeGreaterThan(MIN_TRANSLATED_FONT_SCALE);
    // Line height follows the font, or the lines would not shrink.
    expect(parseFloat(box.style.getPropertyValue('line-height')))
      .toBeCloseTo(1.5 * PAGE_FONT * scale, 2);
    // Margins the page set in em stay at the page's pixels.
    expect(box.style.getPropertyValue('margin-top')).toBe('16px');
    expect(box.style.getPropertyValue('margin-bottom')).toBe('16px');
    expect(fixture.lock.lockedCount).toBe(1);
  });

  it('measures with the page text and paints only the translation', () => {
    const fixture = createFixture('<p id="p">SOURCE</p>');
    const { entry } = fixture.translate('#p', 'x'.repeat(40), 'y'.repeat(80));

    fixture.lock.lock([entry], fixture.view);

    expect(fixture.measuredTexts[0]).toBe('x'.repeat(40));
    expect(fixture.element('#p').textContent).toBe('y'.repeat(80));
  });

  it('leaves text that fits at its size and restores the page styles', () => {
    const fixture = createFixture('<p id="p" style="color: red">SOURCE</p>');
    const { entry } = fixture.translate('#p', 'x'.repeat(40), 'y'.repeat(20));

    fixture.lock.lock([entry], fixture.view);
    const box = fixture.element('#p');
    expect(box.style.getPropertyValue('height')).toBe('48px');
    expect(box.style.getPropertyValue('font-size')).toBe('');
    expect(box.style.getPropertyValue('margin-top')).toBe('');

    fixture.lock.release();
    expect(box.getAttribute('style')).toBe('color:red');
    expect(box.style.getPropertyValue(GEOMETRY_LOCK_MARKER)).toBe('');
    expect(fixture.lock.lockedCount).toBe(0);
  });

  it('locks the block around inline text, not the inline element', () => {
    const fixture = createFixture('<p id="p">Read <a id="a">SOURCE</a></p>');
    const { entry } = fixture.translate('#a', 'x'.repeat(40), 'y'.repeat(80));

    fixture.lock.lock([entry], fixture.view);

    expect(fixture.element('#a').getAttribute('style')).toBeNull();
    expect(fixture.element('#p').style.getPropertyValue('height')).toBe('48px');
  });

  it('never shrinks translated text below half the page size', () => {
    const fixture = createFixture('<p id="p">SOURCE</p>');
    const { entry } = fixture.translate('#p', 'x'.repeat(10), 'y'.repeat(2_000));

    fixture.lock.lock([entry], fixture.view);

    expect(fixture.element('#p').style.getPropertyValue('font-size'))
      .toBe(`${PAGE_FONT * MIN_TRANSLATED_FONT_SCALE}px`);
  });

  it('keeps a page style that a patch wrote over the lock', () => {
    const fixture = createFixture('<p id="p" style="color: red">SOURCE</p>');
    const { entry } = fixture.translate('#p', 'x'.repeat(40), 'y'.repeat(80));
    fixture.lock.lock([entry], fixture.view);

    fixture.element('#p').setAttribute('style', 'color: blue');
    fixture.lock.release();

    expect(fixture.element('#p').getAttribute('style')).toBe('color: blue');
  });

  it('relocks from the page values when a stale lock comes back', () => {
    const fixture = createFixture('<p id="p" style="color: red">SOURCE</p>');
    const { entry } = fixture.translate('#p', 'x'.repeat(40), 'y'.repeat(80));
    fixture.lock.lock([entry], fixture.view);
    const locked = fixture.element('#p').getAttribute('style');

    // A disclosure closing restores the style it saved while locked.
    fixture.lock.release();
    fixture.element('#p').setAttribute('style', locked ?? '');
    fixture.lock.lock([entry], fixture.view);
    fixture.lock.release();

    expect(fixture.element('#p').getAttribute('style')).toBe('color:red');
  });

  it('skips text that is not rendered', () => {
    const fixture = createFixture('<p id="p" data-display="none">SOURCE</p>');
    const { entry } = fixture.translate('#p', 'x'.repeat(40), 'y'.repeat(80));

    fixture.lock.lock([entry], fixture.view);

    expect(fixture.element('#p').getAttribute('style')).toBeNull();
    expect(fixture.lock.lockedCount).toBe(0);
  });
});

function createFixture(body: string) {
  const { document } = parseHTML(`<html><body>${body}</body></html>`);
  const measuredTexts: string[] = [];
  const element = (selector: string): HTMLElement => {
    const found = document.querySelector<HTMLElement>(selector);
    if (!found) throw new Error(`Missing test element: ${selector}`);
    return found;
  };
  const fontSize = (box: HTMLElement): number =>
    parseFloat(box.style.getPropertyValue('font-size')) || PAGE_FONT;
  const lineHeight = (box: HTMLElement): number =>
    parseFloat(box.style.getPropertyValue('line-height')) || fontSize(box) * 1.5;
  const naturalHeight = (box: HTMLElement): number => {
    const lines = Math.max(
      1,
      Math.ceil((box.textContent ?? '').length * fontSize(box) * 0.5 / BOX_WIDTH),
    );
    return lines * lineHeight(box);
  };
  const clientHeight = (box: HTMLElement): number =>
    parseFloat(box.style.getPropertyValue('height')) || naturalHeight(box);
  for (const box of document.querySelectorAll<HTMLElement>('p')) {
    Object.defineProperties(box, {
      clientWidth: { configurable: true, get: () => BOX_WIDTH },
      scrollWidth: { configurable: true, get: () => BOX_WIDTH },
      clientHeight: { configurable: true, get: () => clientHeight(box) },
      scrollHeight: {
        configurable: true,
        get: () => Math.max(clientHeight(box), naturalHeight(box)),
      },
    });
  }
  const view: TranslatedGeometryView = {
    getComputedStyle: (target: Element) => {
      const box = target as HTMLElement;
      const inline = box.localName === 'a' || box.localName === 'span';
      if (!inline && box.localName === 'p') measuredTexts.push(box.textContent ?? '');
      return {
        display: box.getAttribute('data-display') ?? (inline ? 'inline' : 'block'),
        width: inline ? 'auto' : `${BOX_WIDTH}px`,
        height: inline ? 'auto' : `${clientHeight(box)}px`,
        marginTop: '16px', marginBottom: '16px', marginLeft: '0px', marginRight: '0px',
        paddingLeft: '0px', paddingRight: '0px', paddingTop: '0px', paddingBottom: '0px',
        fontSize: `${fontSize(box)}px`,
        lineHeight: `${lineHeight(box)}px`,
      } as unknown as CSSStyleDeclaration;
    },
  };
  return {
    document,
    view,
    measuredTexts,
    lock: new TranslatedGeometryLock(),
    element,
    height: (selector: string) => clientHeight(element(selector)),
    overflows: (selector: string) => {
      const box = element(selector);
      return naturalHeight(box) > clientHeight(box) + 1;
    },
    /** Puts the translation in place, as a projection does. */
    translate(selector: string, source: string, translated: string) {
      const node = element(selector).firstChild as Text;
      node.nodeValue = translated;
      const entry: TranslatedGeometryEntry = {
        node,
        showSource: () => { node.nodeValue = source; },
        showTranslation: () => { node.nodeValue = translated; },
      };
      return { entry };
    },
  };
}
