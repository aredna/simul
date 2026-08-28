import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  MAX_PAINTED_SEMANTIC_LABEL_TEXT,
  PAINTED_SEMANTIC_LABEL_ATTRIBUTE,
  PAINTED_SEMANTIC_LABEL_OVERLAY_ATTRIBUTE,
  aggregatePaintedSemanticLabelText,
  detectPaintedSemanticLabel,
  normalizePaintedSemanticLabelText,
  presentPaintedSemanticLabel,
  removePaintedSemanticLabelPresentation,
  synchronizePaintedSemanticLabelPresentation,
  type PaintedSemanticLabelEnvironment,
} from '../lib/replica/painted-semantic-label';

interface StyleValues {
  readonly [property: string]: string;
}

const visibleLogoStyle: StyleValues = {
  'background-image': 'url("https://cdn.example.test/logo.svg")',
  'content-visibility': 'visible',
  display: 'block',
  'font-size': '16px',
  opacity: '1',
  overflow: 'hidden',
  'overflow-x': 'hidden',
  position: 'static',
  'text-indent': '-99em',
  visibility: 'visible',
  '-webkit-text-security': 'none',
};

describe('painted semantic labels', () => {
  it('admits a Mainichi-style image-painted direct label without retaining its URL', () => {
    const fixture = createFixture(
      '<a id="logo" href="/"> 毎日新聞デジタル\n 総合案内 </a>',
    );

    const candidate = detectPaintedSemanticLabel(
      fixture.element,
      fixture.environment,
    );

    expect(candidate).toEqual({
      element: fixture.element,
      sourceText: '毎日新聞デジタル 総合案内',
      width: 130,
      height: 24,
    });
    expect(JSON.stringify(candidate)).not.toContain('cdn.example.test');
  });

  it('normalizes direct text while rejecting blank, punctuation-only, and oversized values', () => {
    expect(normalizePaintedSemanticLabelText('  毎日\n 新聞  ')).toBe('毎日 新聞');
    expect(normalizePaintedSemanticLabelText(' -- / -- ')).toBeUndefined();
    expect(normalizePaintedSemanticLabelText('logo.svg')).toBeUndefined();
    expect(normalizePaintedSemanticLabelText('https://example.test/logo'))
      .toBeUndefined();
    expect(normalizePaintedSemanticLabelText('a'.repeat(
      MAX_PAINTED_SEMANTIC_LABEL_TEXT + 1,
    ))).toBeUndefined();
  });

  it('aggregates multiple current direct text fragments in DOM order', () => {
    const fixture = createFixture(
      '<a id="logo">Mainichi <span>ignored descendant</span>Daily News</a>',
    );

    expect(aggregatePaintedSemanticLabelText(fixture.element))
      .toBe('Mainichi Daily News');
  });

  it.each([
    ['no background', { 'background-image': 'none' }],
    ['gradient decoration', {
      'background-image': 'linear-gradient(red, blue)',
    }],
    ['data URL', { 'background-image': 'url("data:image/gif;base64,AAAA")' }],
    ['blob URL', { 'background-image': 'url("blob:https://example.test/id")' }],
    ['file URL', { 'background-image': 'url("file:///tmp/logo.svg")' }],
    ['javascript URL', { 'background-image': 'url("javascript:alert(1)")' }],
    ['multiple layers', {
      'background-image':
        'url("https://example.test/a.svg"), url("https://example.test/b.svg")',
    }],
    ['fragment paint', { 'background-image': 'url("#logo")' }],
    ['unclipped overflow', { overflow: 'visible', 'overflow-x': 'visible' }],
    ['ordinary indentation', { 'text-indent': '-12px' }],
    ['positive indentation', { 'text-indent': '999px' }],
    ['hidden display', { display: 'none' }],
    ['hidden visibility', { visibility: 'hidden' }],
    ['zero opacity', { opacity: '0' }],
    ['hidden content visibility', { 'content-visibility': 'hidden' }],
    ['masked text', { '-webkit-text-security': 'disc' }],
  ])('rejects %s', (_name, style) => {
    const fixture = createFixture('<a id="logo">Semantic label</a>', style);
    expect(detectPaintedSemanticLabel(
      fixture.element,
      fixture.environment,
    )).toBeUndefined();
  });

  it('rejects tiny, oversized, and off-viewport boxes', () => {
    const zero = createFixture(
      '<a id="logo">Label</a>',
      {},
      { width: 1, height: 1, right: 11, bottom: 11 },
    );
    expect(detectPaintedSemanticLabel(zero.element, zero.environment))
      .toBeUndefined();

    const oversized = createFixture(
      '<a id="logo">Label</a>',
      {},
      { width: 4_001, height: 2_000, right: 4_001, bottom: 2_000 },
    );
    expect(detectPaintedSemanticLabel(
      oversized.element,
      oversized.environment,
    )).toBeUndefined();

    const offscreen = createFixture(
      '<a id="logo">Label</a>',
      {},
      { left: 801, right: 931 },
    );
    expect(detectPaintedSemanticLabel(
      offscreen.element,
      offscreen.environment,
    )).toBeUndefined();
  });

  it('requires direct text rather than harvesting a hidden descendant label', () => {
    const fixture = createFixture(
      '<a id="logo"><span>Nested hidden text</span></a>',
    );
    expect(detectPaintedSemanticLabel(
      fixture.element,
      fixture.environment,
    )).toBeUndefined();
  });

  it('rejects credential structure before reading direct text', () => {
    const fixture = createFixture(
      '<a id="logo">Never read<input type="password" value="secret"></a>',
    );
    const directText = fixture.element.firstChild!;
    let textReads = 0;
    Object.defineProperty(directText, 'nodeValue', {
      configurable: true,
      get: () => {
        textReads += 1;
        return 'Never read';
      },
    });

    expect(detectPaintedSemanticLabel(
      fixture.element,
      fixture.environment,
    )).toBeUndefined();
    expect(textReads).toBe(0);
  });

  it.each([
    '<section autocomplete="current-password"><a id="logo">Label</a></section>',
    '<section contenteditable="true"><a id="logo">Label</a></section>',
    '<section role="textbox"><a id="logo">Label</a></section>',
    '<section aria-hidden="true"><a id="logo">Label</a></section>',
    '<section hidden><a id="logo">Label</a></section>',
  ])('rejects a private ancestor without reading it as a painted label', (markup) => {
    const fixture = createFixture(markup);
    expect(detectPaintedSemanticLabel(
      fixture.element,
      fixture.environment,
    )).toBeUndefined();
  });

  it('allows only extension-local chrome-extension backgrounds', () => {
    const local = createFixture(
      '<a id="logo">Extension label</a>',
      { 'background-image': 'url("chrome-extension://abc123/logo.svg")' },
      {},
      'chrome-extension://abc123/replica.html',
    );
    expect(detectPaintedSemanticLabel(local.element, local.environment))
      .toBeDefined();

    const foreign = createFixture(
      '<a id="logo">Extension label</a>',
      { 'background-image': 'url("chrome-extension://other/logo.svg")' },
      {},
      'chrome-extension://abc123/replica.html',
    );
    expect(detectPaintedSemanticLabel(foreign.element, foreign.environment))
      .toBeUndefined();
  });

  it('rejects an inert replacement without a real painted resource', () => {
    const fixture = createFixture(
      '<a id="logo">Captured painted label</a>',
      { 'background-image': 'url("about:blank")' },
    );

    expect(detectPaintedSemanticLabel(fixture.element, fixture.environment))
      .toBeUndefined();
  });

  it('presents translated text in an inert owned overlay and restores its host', () => {
    const fixture = createFixture('<a id="logo" style="position:static">毎日新聞</a>');
    const candidate = detectPaintedSemanticLabel(
      fixture.element,
      fixture.environment,
    )!;

    const cleanup = presentPaintedSemanticLabel(
      candidate,
      '<img src=x onerror=alert(1)> Mainichi Shimbun',
    );
    const overlay = fixture.element.querySelector(
      `[${PAINTED_SEMANTIC_LABEL_OVERLAY_ATTRIBUTE}]`,
    ) as HTMLElement | null;

    expect(cleanup).toBeTypeOf('function');
    expect(fixture.element.getAttribute(PAINTED_SEMANTIC_LABEL_ATTRIBUTE))
      .toBe('v1');
    expect(fixture.element.style.getPropertyValue('position')).toBe('relative');
    expect(fixture.element.style.getPropertyValue('pointer-events')).toBe('none');
    expect(overlay?.textContent).toBe('<img src=x onerror=alert(1)> Mainichi Shimbun');
    expect(overlay?.querySelector('img')).toBeNull();
    expect(overlay?.getAttribute('aria-hidden')).toBe('true');
    expect(overlay?.style.getPropertyValue('position')).toBe('absolute');
    expect(overlay?.style.getPropertyValue('text-indent')).toBe('0');
    expect(overlay?.style.getPropertyValue('pointer-events')).toBe('none');

    cleanup?.();
    cleanup?.();
    expect(fixture.element.hasAttribute(PAINTED_SEMANTIC_LABEL_ATTRIBUTE))
      .toBe(false);
    expect(fixture.element.querySelector(
      `[${PAINTED_SEMANTIC_LABEL_OVERLAY_ATTRIBUTE}]`,
    )).toBeNull();
    expect(fixture.element.style.getPropertyValue('position')).toBe('static');
    expect(fixture.element.style.getPropertyValue('pointer-events')).toBe('');
  });

  it('refuses forged, stale, and duplicate presentation proofs', () => {
    const fixture = createFixture('<a id="logo">毎日新聞</a>');
    const candidate = detectPaintedSemanticLabel(
      fixture.element,
      fixture.environment,
    )!;
    expect(presentPaintedSemanticLabel({ ...candidate }, 'Mainichi'))
      .toBeUndefined();

    fixture.element.firstChild!.nodeValue = 'Changed source';
    expect(presentPaintedSemanticLabel(candidate, 'Mainichi')).toBeUndefined();

    const fresh = detectPaintedSemanticLabel(
      fixture.element,
      fixture.environment,
    )!;
    const cleanup = presentPaintedSemanticLabel(fresh, 'Mainichi');
    expect(cleanup).toBeTypeOf('function');
    expect(presentPaintedSemanticLabel(fresh, 'Duplicate')).toBeUndefined();
    cleanup?.();
  });

  it('synchronizes repeated translated text projections idempotently', () => {
    const fixture = createFixture('<a id="logo">Mainichi Newspaper</a>');
    expect(synchronizePaintedSemanticLabelPresentation(
      fixture.element,
      'Mainichi Newspaper',
      fixture.environment,
    )).toBe(true);
    expect(synchronizePaintedSemanticLabelPresentation(
      fixture.element,
      'Mainichi Daily News',
      fixture.environment,
    )).toBe(true);
    expect(fixture.element.querySelectorAll(
      `[${PAINTED_SEMANTIC_LABEL_OVERLAY_ATTRIBUTE}]`,
    )).toHaveLength(1);
    expect(fixture.element.querySelector(
      `[${PAINTED_SEMANTIC_LABEL_OVERLAY_ATTRIBUTE}]`,
    )?.textContent).toBe('Mainichi Daily News');

    expect(removePaintedSemanticLabelPresentation(fixture.element)).toBe(true);
    expect(removePaintedSemanticLabelPresentation(fixture.element)).toBe(false);
    expect(fixture.element.querySelector(
      `[${PAINTED_SEMANTIC_LABEL_OVERLAY_ATTRIBUTE}]`,
    )).toBeNull();
    expect(fixture.element.style.getPropertyValue('pointer-events')).toBe('');
  });

  it('removes an active presentation when its painted shape no longer qualifies', () => {
    const fixture = createFixture('<a id="logo">Mainichi Newspaper</a>');
    expect(synchronizePaintedSemanticLabelPresentation(
      fixture.element,
      'Mainichi Newspaper',
      fixture.environment,
    )).toBe(true);

    expect(synchronizePaintedSemanticLabelPresentation(
      fixture.element,
      'Mainichi Newspaper',
      {
        ...fixture.environment,
        getComputedStyle: () => styleFor({
          ...visibleLogoStyle,
          'background-image': 'none',
        }),
      },
    )).toBe(false);
    expect(fixture.element.hasAttribute(PAINTED_SEMANTIC_LABEL_ATTRIBUTE))
      .toBe(false);
    expect(fixture.element.querySelector(
      `[${PAINTED_SEMANTIC_LABEL_OVERLAY_ATTRIBUTE}]`,
    )).toBeNull();
  });
});

function createFixture(
  markup: string,
  styleOverrides: StyleValues = {},
  rectOverrides: Partial<DOMRectReadOnly> = {},
  baseHref = 'https://mainichi.example.test/page',
): {
  readonly element: HTMLElement;
  readonly environment: PaintedSemanticLabelEnvironment;
} {
  const { document } = parseHTML(
    `<html><head><base href="${baseHref}"></head><body>${markup}</body></html>`,
  );
  const element = document.querySelector('#logo') as unknown as HTMLElement;
  const values = { ...visibleLogoStyle, ...styleOverrides };
  const rect = {
    left: 10,
    top: 10,
    right: 140,
    bottom: 34,
    width: 130,
    height: 24,
    x: 10,
    y: 10,
    toJSON: () => ({}),
    ...rectOverrides,
  } as DOMRectReadOnly;
  return {
    element,
    environment: {
      getComputedStyle: () => styleFor(values),
      getBoundingClientRect: () => rect,
      viewportWidth: 800,
      viewportHeight: 600,
    },
  };
}

function styleFor(values: StyleValues): CSSStyleDeclaration {
  return {
    getPropertyValue: (property: string) => values[property] ?? '',
  } as unknown as CSSStyleDeclaration;
}
