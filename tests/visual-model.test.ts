import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';

import {
  capturePageSnapshot,
  parsePageSnapshot,
  SNAPSHOT_LIMITS,
  type PageSnapshot,
  type VisualElementNode,
} from '../lib/page-snapshot';
import type { TranslatedSnapshot } from '../lib/translation-pipeline';
import {
  computeMirrorExtent,
  computeMirrorScale,
  createVisualMirror,
} from '../lib/visual-renderer';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('visual snapshot boundary', () => {
  it('keeps safe presentation data while rejecting executable and private fields', () => {
    const snapshot = buildParsedVisualSnapshot();
    const visual = snapshot.visual;

    expect(visual).toBeDefined();
    expect(visual?.styles[0]).toEqual({
      color: 'rgb(12, 34, 56)',
      display: 'grid',
    });
    expect(visual?.styles[1]).toEqual({
      'background-image': 'url("https://cdn.example.com/background.png")',
      width: '100px',
    });

    const root = visual?.root;
    expect(root?.children.some(isTag('script'))).toBe(false);
    expect(root?.children.some(isTag('a'))).toBe(false);

    const image = root?.children.find(isTag('img'));
    expect(image).toMatchObject({
      itemId: 'image-2',
      attributes: {
        alt: '山',
        src: 'https://cdn.example.com/image.png',
      },
    });
    expect(image?.attributes).not.toHaveProperty('onclick');

    const input = root?.children.find(isTag('input'));
    expect(input).toMatchObject({
      controlShell: 'input',
      children: [],
    });
    expect(input).not.toHaveProperty('attributes');

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('javascript:');
    expect(serialized).not.toContain('cursor');
    expect(serialized).not.toContain('onclick');
    expect(serialized).not.toContain('typed parser secret');
    expect(serialized).not.toContain('script parser secret');
    expect(serialized).not.toContain('link parser secret');
  });

  it('captures controls as empty shells without reading form or contenteditable data', () => {
    const { document } = installCapturePage(`
      <main style="display: grid; color: rgb(1, 2, 3)">
        <p>Public copy</p>
        <input value="input capture secret">
        <textarea>textarea capture secret</textarea>
        <select><option>select capture secret</option></select>
        <div contenteditable="true">contenteditable capture secret</div>
        <span role="textbox">role capture secret</span>
        <span role="note textbox">fallback role capture secret</span>
        <output>output capture secret</output>
        <datalist><option>datalist capture secret</option></datalist>
      </main>
    `);
    const input = document.querySelector('input');
    const editable = document.querySelector('[contenteditable]');

    const snapshot = capturePageSnapshot();
    const serialized = JSON.stringify(snapshot);

    expect(serialized).toContain('Public copy');
    expect(serialized).not.toContain('input capture secret');
    expect(serialized).not.toContain('textarea capture secret');
    expect(serialized).not.toContain('select capture secret');
    expect(serialized).not.toContain('contenteditable capture secret');
    expect(serialized).not.toContain('role capture secret');
    expect(serialized).not.toContain('fallback role capture secret');
    expect(serialized).not.toContain('output capture secret');
    expect(serialized).not.toContain('datalist capture secret');
    expect(snapshot.omissions.controls).toBeGreaterThanOrEqual(8);

    expect(input?.getAttribute('value')).toBe('input capture secret');
    expect(editable?.textContent).toBe('contenteditable capture secret');

    const shells = collectElements(snapshot.visual?.root).filter(
      (node) => node.controlShell !== undefined,
    );
    expect(shells.map((node) => node.controlShell)).toEqual([
      'input',
      'textarea',
      'select',
      'input',
      'button',
      'button',
      'input',
      'input',
    ]);
    expect(shells.every((node) => node.children.length === 0)).toBe(true);
    expect(shells.every((node) => node.attributes === undefined)).toBe(true);
  });

  it('enforces aggregate visual style and attribute budgets', () => {
    const styles = Array.from(
      { length: SNAPSHOT_LIMITS.maxVisualStyles },
      () => ({
        color: 'x'.repeat(SNAPSHOT_LIMITS.maxVisualValueLength),
        'font-family': 'y'.repeat(SNAPSHOT_LIMITS.maxVisualValueLength),
        'box-shadow': 'z'.repeat(SNAPSHOT_LIMITS.maxVisualValueLength),
      }),
    );
    const children = Array.from(
      { length: SNAPSHOT_LIMITS.maxVisualNodes - 1 },
      () => ({
        kind: 'element',
        tag: 'path',
        styleId: 0,
        attributes: {
          d: 'M'.repeat(SNAPSHOT_LIMITS.maxVisualAttributeLength),
        },
        children: [],
      }),
    );

    const snapshot = parsePageSnapshot({
      version: 1,
      title: 'Bounded visual',
      url: 'https://example.com/',
      capturedAt: '2026-07-19T00:00:00.000Z',
      items: [],
      omissions: {},
      visual: {
        viewportWidth: 1_200,
        viewportHeight: 800,
        documentWidth: 1_200,
        documentHeight: 2_000,
        styles,
        root: {
          kind: 'element',
          tag: 'svg',
          styleId: 0,
          children,
        },
      },
    });

    const styleCharacters = (snapshot.visual?.styles ?? []).reduce(
      (total, style) =>
        total +
        Object.entries(style).reduce(
          (styleTotal, [property, value]) =>
            styleTotal + property.length + value.length,
          0,
        ),
      0,
    );
    const attributeCharacters = collectElements(snapshot.visual?.root).reduce(
      (total, node) =>
        total +
        Object.entries(node.attributes ?? {}).reduce(
          (nodeTotal, [name, value]) =>
            nodeTotal + name.length + value.length,
          0,
        ),
      0,
    );

    expect(styleCharacters).toBeLessThanOrEqual(
      SNAPSHOT_LIMITS.maxVisualStyleCharacters,
    );
    expect(attributeCharacters).toBeLessThanOrEqual(
      SNAPSHOT_LIMITS.maxVisualAttributeCharacters,
    );
  });
});

describe('visual mirror renderer', () => {
  it('renders translated text and image alt text into an inert mirror', () => {
    const snapshot = buildParsedVisualSnapshot();
    const translated = buildTranslatedSnapshot(snapshot);
    const { document } = parseHTML('<html><body></body></html>');

    const mirror = createVisualMirror(snapshot, translated, document);

    expect(mirror).toBeDefined();
    expect(mirror?.getAttribute('data-simul-inert-mirror')).toBe('');
    expect(mirror?.style.pointerEvents).toBe('none');
    expect(mirror?.textContent).toContain('Hello');
    expect(mirror?.textContent).not.toContain('こんにちは');

    const image = mirror?.querySelector('img');
    expect(image?.getAttribute('src')).toBe(
      'https://cdn.example.com/image.png',
    );
    expect(image?.getAttribute('alt')).toBe('Mountain');
    expect(image?.loading).toBe('lazy');
    expect(image?.referrerPolicy).toBe('no-referrer');

    const input = mirror?.querySelector('input');
    expect(input?.getAttribute('aria-disabled')).toBe('true');
    expect(input?.tabIndex).toBe(-1);
    expect(input?.value).toBe('');
    expect(input?.textContent).toBe('');
    expect(mirror?.querySelector('script')).toBeNull();
    expect(mirror?.querySelector('a')).toBeNull();
    expect(mirror?.outerHTML).not.toContain('typed parser secret');
    expect(mirror?.outerHTML).not.toContain('onclick');
  });

  it('preserves layout whitespace around translated inline text', () => {
    const snapshot = buildParsedVisualSnapshot();
    const textNode = snapshot.visual?.root.children[0];
    if (!textNode || textNode.kind !== 'text') {
      throw new Error('Expected the visual text fixture.');
    }
    textNode.text = '  こんにちは\n';
    const translated = buildTranslatedSnapshot(snapshot);
    const { document } = parseHTML('<html><body></body></html>');

    const mirror = createVisualMirror(snapshot, translated, document);

    expect(mirror?.textContent).toContain('  Hello\n');
  });

  it('translates an inline-formatted sentence as one grammatical unit', () => {
    installCapturePage('<p>I <em>love</em> cats</p>');
    const snapshot = capturePageSnapshot();
    const textItem = snapshot.items.find((item) => item.kind === 'text');
    if (!textItem || textItem.kind !== 'text') {
      throw new Error('Expected a grouped text item.');
    }
    expect(textItem.text).toBe('I love cats');

    const translated: TranslatedSnapshot = {
      snapshot,
      items: [
        {
          ...textItem,
          translation: {
            source: textItem.text,
            translated: '私は猫が大好きです',
            state: 'translated',
          },
        },
      ],
      state: 'complete',
      completed: 1,
      total: 1,
      failed: 0,
    };
    const { document } = parseHTML('<html><body></body></html>');

    const mirror = createVisualMirror(snapshot, translated, document);

    expect(mirror?.textContent).toContain('私は猫が大好きです');
    expect(mirror?.textContent).not.toContain('I love cats');
    expect(mirror?.querySelector('em')).not.toBeNull();
  });

  it('redistributes grouped inline translations without splitting target segments', () => {
    installCapturePage('<p>I <em>love</em> cats</p>');
    const snapshot = capturePageSnapshot();
    const textItem = snapshot.items.find((item) => item.kind === 'text');
    if (!textItem || textItem.kind !== 'text') {
      throw new Error('Expected a grouped text item.');
    }
    const target = 'extraordinary hi 👩‍💻 collaboration';
    const translated: TranslatedSnapshot = {
      snapshot,
      items: [
        {
          ...textItem,
          translation: {
            source: textItem.text,
            translated: target,
            state: 'translated',
          },
        },
      ],
      state: 'complete',
      completed: 1,
      total: 1,
      failed: 0,
    };
    const { document } = parseHTML('<html><body></body></html>');

    const mirror = createVisualMirror(snapshot, translated, document);
    const paragraph = mirror?.querySelector('p');
    const chunks = Array.from(
      paragraph?.childNodes ?? [],
      (node) => node.textContent ?? '',
    );
    const wordBoundaries = segmentBoundaries(target, 'word');
    const graphemeBoundaries = segmentBoundaries(target, 'grapheme');
    let consumed = 0;

    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.length > 0)).toBe(true);
    expect(chunks.join('')).toBe(target);
    for (const chunk of chunks.slice(0, -1)) {
      consumed += chunk.length;
      expect(wordBoundaries.has(consumed)).toBe(true);
      expect(graphemeBoundaries.has(consumed)).toBe(true);
    }
  });

  it('fits wide pages down without enlarging them and supports actual size', () => {
    expect(computeMirrorScale(600, 1_200, 'fit')).toBe(0.5);
    expect(computeMirrorScale(1_600, 1_200, 'fit')).toBe(1);
    expect(computeMirrorScale(600, 1_200, 'actual')).toBe(1);
    expect(computeMirrorScale(0, 1_200, 'fit')).toBe(1);
    expect(computeMirrorScale(600, Number.NaN, 'fit')).toBe(1);
    expect(computeMirrorExtent(0.5, 1_200, 2_000, 1_200, 2_600)).toEqual({
      width: 600,
      height: 1_300,
    });
  });
});

function buildParsedVisualSnapshot(): PageSnapshot {
  return parsePageSnapshot({
    version: 1,
    title: 'Visual page',
    url: 'https://example.com/private?token=removed',
    capturedAt: '2026-07-19T00:00:00.000Z',
    items: [
      {
        id: 'raw-text',
        kind: 'text',
        role: 'paragraph',
        text: 'こんにちは',
      },
      {
        id: 'raw-image',
        kind: 'image',
        src: 'https://cdn.example.com/image.png',
        altText: '山',
      },
    ],
    omissions: {},
    visual: {
      viewportWidth: 1_200,
      viewportHeight: 800,
      documentWidth: 1_200,
      documentHeight: 2_000,
      styles: [
        {
          display: 'grid',
          color: 'rgb(12, 34, 56)',
          cursor: 'pointer',
          'background-image': 'url("javascript:alert(1)")',
          behavior: 'url(evil.htc)',
        },
        {
          width: '100px',
          'background-image':
            'url("https://cdn.example.com/background.png")',
        },
      ],
      root: {
        kind: 'element',
        tag: 'div',
        styleId: 0,
        attributes: {
          onclick: 'alert(1)',
        },
        children: [
          {
            kind: 'text',
            text: 'こんにちは',
            itemId: 'raw-text',
          },
          {
            kind: 'element',
            tag: 'img',
            styleId: 1,
            itemId: 'raw-image',
            attributes: {
              src: 'https://cdn.example.com/image.png',
              alt: '山',
              onclick: 'alert(1)',
            },
            children: [],
          },
          {
            kind: 'element',
            tag: 'input',
            styleId: 0,
            controlShell: 'input',
            attributes: {
              value: 'typed parser secret',
              oninput: 'alert(1)',
            },
            children: [
              { kind: 'text', text: 'typed parser secret' },
            ],
          },
          {
            kind: 'element',
            tag: 'script',
            styleId: 0,
            children: [
              { kind: 'text', text: 'script parser secret' },
            ],
          },
          {
            kind: 'element',
            tag: 'a',
            styleId: 0,
            attributes: { href: 'https://evil.example/' },
            children: [
              { kind: 'text', text: 'link parser secret' },
            ],
          },
        ],
      },
    },
  });
}

function buildTranslatedSnapshot(snapshot: PageSnapshot): TranslatedSnapshot {
  const [text, image] = snapshot.items;
  if (text?.kind !== 'text' || image?.kind !== 'image') {
    throw new Error('Expected text and image fixture items.');
  }
  return {
    snapshot,
    items: [
      {
        ...text,
        translation: {
          source: text.text,
          translated: 'Hello',
          state: 'translated',
        },
      },
      {
        ...image,
        altTranslation: {
          source: image.altText ?? '',
          translated: 'Mountain',
          state: 'translated',
        },
      },
    ],
    state: 'complete',
    completed: 2,
    total: 2,
    failed: 0,
  };
}

function isTag(tag: string) {
  return (node: unknown): node is VisualElementNode =>
    typeof node === 'object' &&
    node !== null &&
    'kind' in node &&
    node.kind === 'element' &&
    'tag' in node &&
    node.tag === tag;
}

function collectElements(
  root: VisualElementNode | undefined,
): VisualElementNode[] {
  if (!root) return [];
  const elements = [root];
  for (const child of root.children) {
    if (child.kind === 'element') elements.push(...collectElements(child));
  }
  return elements;
}

function segmentBoundaries(
  value: string,
  granularity: Intl.SegmenterOptions['granularity'],
): Set<number> {
  const boundaries = new Set([0, value.length]);
  const segmenter = new Intl.Segmenter(undefined, { granularity });
  for (const segment of segmenter.segment(value)) {
    boundaries.add(segment.index);
    boundaries.add(segment.index + segment.segment.length);
  }
  return boundaries;
}

function installCapturePage(body: string): { document: Document } {
  const { document, window } = parseHTML(
    `<html lang="ja"><head><title>Test</title></head><body>${body}</body></html>`,
  );
  Object.defineProperty(document, 'baseURI', {
    value: 'https://example.com/page',
  });
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: new URL('https://example.com/page?private=yes'),
  });
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 1_200,
  });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: 800,
  });
  Object.defineProperty(window.Element.prototype, 'getClientRects', {
    configurable: true,
    value(this: Element) {
      return this.hasAttribute('hidden') ? [] : [{}];
    },
  });
  Object.defineProperty(window, 'getComputedStyle', {
    configurable: true,
    value(element: Element) {
      const declarations = new Map<string, string>();
      for (const declaration of (element.getAttribute('style') ?? '').split(';')) {
        const separator = declaration.indexOf(':');
        if (separator < 0) continue;
        declarations.set(
          declaration.slice(0, separator).trim().toLowerCase(),
          declaration.slice(separator + 1).trim(),
        );
      }
      return {
        display: declarations.get('display') ?? 'block',
        visibility: declarations.get('visibility') ?? 'visible',
        opacity: declarations.get('opacity') ?? '1',
        getPropertyValue(property: string) {
          return declarations.get(property) ?? '';
        },
      };
    },
  });

  vi.stubGlobal('window', window);
  vi.stubGlobal('document', document);
  vi.stubGlobal('Node', window.Node);
  vi.stubGlobal('Element', window.Element);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('HTMLImageElement', window.HTMLImageElement);
  return { document: document as unknown as Document };
}
