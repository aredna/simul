import { parseHTML } from 'linkedom';
import { vi } from 'vitest';

import { MirrorView } from '../../entrypoints/sidepanel/mirror-view';
import { parsePageSnapshot, type PageSnapshot } from '../../lib/page-snapshot';

export const PAGE_URL = 'https://example.com/article';
export const PAGE_IDENTITY = { tabId: 4, windowId: 1, url: PAGE_URL };

/** Raw capture output for a page with two translatable fields. */
export function visualSnapshotInput(documentLanguage?: string): Record<string, unknown> {
  return {
    version: 1,
    title: 'Visual page',
    url: PAGE_URL,
    ...(documentLanguage ? { documentLanguage } : {}),
    capturedAt: '2026-09-04T00:00:00.000Z',
    items: [
      { id: 't1', kind: 'text', role: 'paragraph', text: 'こんにちは 世界' },
      { id: 'i1', kind: 'image', src: 'https://cdn.example.com/a.png', altText: '山' },
    ],
    omissions: {},
    visual: {
      viewportWidth: 1_000,
      viewportHeight: 600,
      documentWidth: 1_000,
      documentHeight: 3_000,
      styles: [{ display: 'block' }],
      root: {
        kind: 'element',
        tag: 'div',
        styleId: 0,
        attributes: {},
        children: [
          { kind: 'text', text: 'こんにちは 世界', itemId: 't1' },
          {
            kind: 'element',
            tag: 'img',
            styleId: 0,
            itemId: 'i1',
            attributes: { src: 'https://cdn.example.com/a.png', alt: '山' },
            children: [],
          },
        ],
      },
    },
  };
}

/** Raw capture output for a page with no translatable text. */
export function flatSnapshotInput(): Record<string, unknown> {
  return {
    version: 1,
    title: 'Flat page',
    url: PAGE_URL,
    capturedAt: '2026-09-04T00:00:00.000Z',
    items: [],
    omissions: {},
  };
}

export function visualSnapshot(documentLanguage?: string): PageSnapshot {
  return parsePageSnapshot(visualSnapshotInput(documentLanguage));
}

/** A mirror view over a linkedom container, ready to render snapshots. */
export function mountMirrorView(preferences: () => {
  displayMode: 'fit' | 'actual' | 'custom';
  zoomPercent: number;
  syncScroll: boolean;
  textLayoutMode: 'adaptive' | 'faithful';
}) {
  const { document } = parseHTML('<html><body><div id="snapshot"></div></body></html>');
  const container = document.querySelector<HTMLElement>('#snapshot');
  if (!container) throw new Error('missing container');
  const replayHost = {
    previewVisible: false,
    updateLayout: vi.fn(),
    followSourceScroll: vi.fn(),
  };
  const view = new MirrorView({
    document: document as unknown as Document,
    container,
    replayHost,
    readPreferences: preferences,
    readSourceScroll: () => undefined,
  });
  return { view, container, replayHost };
}
