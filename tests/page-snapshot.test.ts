import { describe, expect, it } from 'vitest';

import {
  capturePageSnapshot,
  InvalidPageSnapshotError,
  SNAPSHOT_LIMITS,
  isSafeImageSource,
  normalizeVisibleText,
  parsePageSnapshot,
} from '../lib/page-snapshot';
import { isSamePageIdentity } from '../lib/page-identity';
import { afterEach, vi } from 'vitest';
import { parseHTML } from 'linkedom';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parsePageSnapshot', () => {
  it('rebuilds typed content in order and drops hostile markup and private fields', () => {
    const snapshot = parsePageSnapshot({
      version: 1,
      title: '  Example\n page ',
      url: 'https://user:secret@example.com/article?token=private#account',
      capturedAt: '2026-07-19T00:00:00.000Z',
      documentLanguage: ' ja ',
      html: '<script>globalThis.attacked = true</script>',
      items: [
        {
          id: 'attacker-controlled',
          kind: 'text',
          role: 'heading-1',
          text: ' 見出し ',
          innerHTML: '<img src=x onerror=alert(1)>',
          onclick: 'alert(1)',
          value: 'typed private value',
        },
        {
          kind: 'image',
          src: 'https://cdn.example.com/photo.png',
          altText: ' 富士山 ',
          caption: ' 朝の景色 ',
          onerror: 'alert(1)',
        },
        {
          kind: 'text',
          role: 'not-a-role',
          text: 'must be omitted',
        },
      ],
      omissions: {
        hidden: 2.8,
        controls: 4,
        frames: -1,
        unsafeImages: 1,
        truncated: false,
      },
    });

    expect(snapshot).toEqual({
      version: 1,
      title: 'Example page',
      url: 'https://example.com/article',
      documentLanguage: 'ja',
      capturedAt: '2026-07-19T00:00:00.000Z',
      items: [
        {
          id: 'text-1',
          kind: 'text',
          role: 'heading-1',
          text: '見出し',
        },
        {
          id: 'image-2',
          kind: 'image',
          src: 'https://cdn.example.com/photo.png',
          altText: '富士山',
          caption: '朝の景色',
        },
      ],
      omissions: {
        hidden: 2,
        controls: 4,
        frames: 0,
        unsafeImages: 1,
        truncated: false,
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain('script');
    expect(JSON.stringify(snapshot)).not.toContain('typed private value');
    expect(JSON.stringify(snapshot)).not.toContain('onclick');
  });

  it('rejects non-web page results and unsupported image schemes', () => {
    expect(() =>
      parsePageSnapshot({
        version: 1,
        title: 'Settings',
        url: 'chrome://settings',
        capturedAt: new Date().toISOString(),
        items: [],
      }),
    ).toThrow(InvalidPageSnapshotError);

    const snapshot = parsePageSnapshot({
      version: 1,
      title: 'Unsafe image',
      url: 'https://example.com/',
      capturedAt: 'invalid',
      items: [
        { kind: 'image', src: 'javascript:alert(1)', altText: 'bad' },
        {
          kind: 'image',
          src: 'data:image/svg+xml,<svg onload="alert(1)"/>',
          altText: 'also bad',
        },
        {
          kind: 'image',
          src: 'data:image/png;base64,iVBORw0KGgo=',
          altText: 'safe raster',
        },
      ],
      omissions: {},
    });

    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toMatchObject({ altText: 'safe raster' });
    expect(snapshot.capturedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('bounds item and character input from the page', () => {
    const items = Array.from(
      { length: SNAPSHOT_LIMITS.maxItems + 10 },
      (_, index) => ({
        kind: 'text',
        role: 'paragraph',
        text: `item ${index}`,
      }),
    );
    const snapshot = parsePageSnapshot({
      version: 1,
      title: 'Large page',
      url: 'https://example.com/',
      capturedAt: new Date().toISOString(),
      items,
      omissions: {},
    });

    expect(snapshot.items).toHaveLength(SNAPSHOT_LIMITS.maxItems);
    expect(snapshot.omissions.truncated).toBe(true);
  });

  it('marks individual text and image fields truncated at the boundary', () => {
    const tooLong = 'x'.repeat(SNAPSHOT_LIMITS.maxTextLength + 1);
    const snapshot = parsePageSnapshot({
      version: 1,
      title: 'Long fields',
      url: 'https://example.com/',
      capturedAt: new Date().toISOString(),
      items: [
        { kind: 'text', role: 'paragraph', text: tooLong },
        {
          kind: 'image',
          src: 'https://example.com/image.png',
          altText: tooLong,
          caption: tooLong,
        },
      ],
      omissions: {},
    });

    expect(snapshot.omissions.truncated).toBe(true);
    expect(snapshot.items[0]).toMatchObject({
      text: 'x'.repeat(SNAPSHOT_LIMITS.maxTextLength),
    });
  });

  it('does not bind a partial translation over a longer visual text node', () => {
    const tooLong = 'x'.repeat(SNAPSHOT_LIMITS.maxTextLength + 1);
    const snapshot = parsePageSnapshot({
      version: 1,
      title: 'Long visual field',
      url: 'https://example.com/',
      capturedAt: new Date().toISOString(),
      items: [
        { id: 'raw-long', kind: 'text', role: 'paragraph', text: tooLong },
      ],
      omissions: {},
      visual: {
        viewportWidth: 1_000,
        viewportHeight: 800,
        documentWidth: 1_000,
        documentHeight: 800,
        styles: [{}],
        root: {
          kind: 'element',
          tag: 'p',
          styleId: 0,
          children: [
            { kind: 'text', text: tooLong, itemId: 'raw-long' },
          ],
        },
      },
    });

    expect(snapshot.items[0]).toMatchObject({
      text: 'x'.repeat(SNAPSHOT_LIMITS.maxTextLength),
    });
    const visualText = snapshot.visual?.root.children[0];
    expect(visualText?.kind).toBe('text');
    expect(visualText).not.toHaveProperty('itemId');
  });
});

describe('capturePageSnapshot', () => {
  it('captures a guarded figure caption once as visual page text', () => {
    installTestPage(`
      <figure>
        <figcaption>
          Visible caption
          <span hidden>hidden secret</span>
          <span role="button">interactive secret</span>
          <span contenteditable="true">typed secret</span>
        </figcaption>
        <img src="https://example.com/first.png" alt="first image">
        <img src="https://example.com/second.png" alt="second image">
      </figure>
      <div role="checkbox">private control label</div>
    `);

    const snapshot = capturePageSnapshot();
    const images = snapshot.items.filter((item) => item.kind === 'image');
    const captions = snapshot.items.filter(
      (item) => item.kind === 'text' && item.text === 'Visible caption',
    );

    expect(images).toHaveLength(2);
    expect(images[0]).toMatchObject({
      altText: 'first image',
    });
    expect(images[0]).not.toHaveProperty('caption');
    expect(images[1]).not.toHaveProperty('caption');
    expect(captions).toHaveLength(1);
    expect(JSON.stringify(snapshot.items)).not.toContain('secret');
    expect(JSON.stringify(snapshot.items)).not.toContain('private control');
    expect(snapshot.omissions.controls).toBeGreaterThan(0);
  });

  it('bounds DOM traversal even when nodes produce no snapshot items', () => {
    installTestPage(
      Array.from(
        { length: SNAPSHOT_LIMITS.maxVisitedNodes + 10 },
        () => '<span></span>',
      ).join(''),
    );

    const snapshot = capturePageSnapshot();

    expect(snapshot.items).toHaveLength(0);
    expect(snapshot.omissions.truncated).toBe(true);
  });

  it('keeps oversized visual text intact while omitting its partial translation key', () => {
    const tooLong = '長'.repeat(SNAPSHOT_LIMITS.maxTextLength + 1);
    installTestPage(`
      <p>${tooLong}</p>
      <figure>
        <img src="https://example.com/long.png" alt="${tooLong}">
        <figcaption>${tooLong}</figcaption>
      </figure>
    `);

    const snapshot = capturePageSnapshot();
    const text = snapshot.items.find((item) => item.kind === 'text');
    const image = snapshot.items.find((item) => item.kind === 'image');

    expect(snapshot.omissions.truncated).toBe(true);
    expect(text).toBeUndefined();
    expect(JSON.stringify(snapshot.visual)).toContain(tooLong);
    if (image?.kind === 'image') {
      expect(image.altText?.length).toBe(SNAPSHOT_LIMITS.maxTextLength);
      expect(image.caption).toBeUndefined();
    } else {
      throw new Error('Expected captured image.');
    }
  });
});

describe('isSamePageIdentity', () => {
  const captured = {
    tabId: 7,
    windowId: 3,
    url: 'https://example.com/page?version=1',
  };

  it('requires an exact tab and URL match', () => {
    expect(
      isSamePageIdentity(captured, {
        id: 7,
        windowId: 3,
        url: 'https://example.com/page?version=1',
      }),
    ).toBe(true);
    expect(
      isSamePageIdentity(captured, {
        id: 7,
        windowId: 3,
        url: 'https://example.com/page?version=2',
      }),
    ).toBe(false);
    expect(
      isSamePageIdentity(captured, {
        id: 8,
        windowId: 3,
        url: 'https://example.com/page?version=1',
      }),
    ).toBe(false);
  });

  it('rejects the same tab identity in a different browser window', () => {
    expect(
      isSamePageIdentity(captured, {
        id: 7,
        windowId: 4,
        url: 'https://example.com/page?version=1',
      }),
    ).toBe(false);
  });

  it('treats a missing current URL as stale', () => {
    expect(isSamePageIdentity(captured, { id: 7, windowId: 3 })).toBe(false);
  });
});

describe('snapshot text and image guards', () => {
  it('normalizes visible text and enforces a caller-provided limit', () => {
    expect(normalizeVisibleText('  hello\n\tworld  ', 8)).toBe('hello wo');
  });

  it('accepts web and bounded raster sources only', () => {
    expect(isSafeImageSource('https://example.com/image.webp')).toBe(true);
    expect(isSafeImageSource('http://example.com/image.jpg')).toBe(true);
    expect(isSafeImageSource('blob:https://example.com/id')).toBe(false);
    expect(isSafeImageSource('data:text/html,hello')).toBe(false);
  });
});

function installTestPage(body: string): void {
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
  Object.defineProperty(window.Element.prototype, 'getClientRects', {
    configurable: true,
    value(this: Element) {
      return this.hasAttribute('hidden') ? [] : [{}];
    },
  });
  Object.defineProperty(window, 'getComputedStyle', {
    configurable: true,
    value(element: Element) {
      const style = element.getAttribute('style') ?? '';
      return {
        display: /display\s*:\s*none/iu.test(style) ? 'none' : 'block',
        visibility: /visibility\s*:\s*hidden/iu.test(style)
          ? 'hidden'
          : 'visible',
        opacity: /opacity\s*:\s*0(?:\D|$)/iu.test(style) ? '0' : '1',
      };
    },
  });

  vi.stubGlobal('window', window);
  vi.stubGlobal('document', document);
  vi.stubGlobal('Node', window.Node);
  vi.stubGlobal('Element', window.Element);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('HTMLImageElement', window.HTMLImageElement);
}
