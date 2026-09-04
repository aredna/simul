import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

import { MirrorView } from '../entrypoints/sidepanel/mirror-view';
import type { LivePageScrollMessage } from '../lib/live-page-mirror';
import { parsePageSnapshot, type PageSnapshot } from '../lib/page-snapshot';
import { DEFAULT_COMPANION_PREFERENCES, parseCompanionPreferences } from '../lib/preferences';

function visualSnapshot(): PageSnapshot {
  return parsePageSnapshot({
    version: 1,
    title: 'Visual page',
    url: 'https://example.com/',
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
  });
}

function flatSnapshot(): PageSnapshot {
  return parsePageSnapshot({
    version: 1,
    title: 'Flat page',
    url: 'https://example.com/flat',
    capturedAt: '2026-09-04T00:00:00.000Z',
    items: [
      { id: 'h', kind: 'text', role: 'heading-1', text: 'Title' },
      { id: 'q', kind: 'text', role: 'quote', text: 'Quoted' },
      { id: 'c', kind: 'text', role: 'code', text: 'code()' },
      { id: 'p', kind: 'text', role: 'paragraph', text: 'Body' },
    ],
    omissions: {},
  });
}

function setup() {
  const { document } = parseHTML('<html><body><div id="snapshot"></div></body></html>');
  const container = document.querySelector<HTMLElement>('#snapshot');
  if (!container) throw new Error('missing container');
  let preferences = parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES);
  let sourceScroll: LivePageScrollMessage | undefined;
  const replayHost = {
    previewVisible: false,
    updateLayout: vi.fn(),
    followSourceScroll: vi.fn(),
  };
  const onLayoutUpdated = vi.fn();
  const view = new MirrorView({
    document: document as unknown as Document,
    container,
    replayHost,
    readPreferences: () => preferences,
    readSourceScroll: () => sourceScroll,
    onLayoutUpdated,
  });
  return {
    view,
    container,
    replayHost,
    onLayoutUpdated,
    setPreferences(next: typeof preferences) {
      preferences = next;
    },
    setSourceScroll(next: LivePageScrollMessage | undefined) {
      sourceScroll = next;
    },
  };
}

describe('MirrorView', () => {
  it('mounts a visual snapshot inside the scroll, stage and scale layers', () => {
    const harness = setup();
    harness.view.renderSnapshot(visualSnapshot());
    const root = harness.view.root;
    expect(root).toBeDefined();
    expect(harness.container.querySelector('.mirror-scroll .mirror-stage .mirror-scale-layer')).toBeTruthy();
    expect(root?.classList.contains('visual-page-root--adaptive')).toBe(true);
    expect(harness.view.translationFieldCount()).toBe(2);
    expect(harness.view.languageSample()).toBe('こんにちは 世界 山');
    expect(harness.replayHost.updateLayout).toHaveBeenCalledWith({
      displayMode: 'fit',
      zoomPercent: 100,
    });
    expect(harness.onLayoutUpdated).toHaveBeenCalled();
  });

  it('renders a flat snapshot with semantic elements and no mirror root', () => {
    const harness = setup();
    harness.view.renderSnapshot(flatSnapshot());
    expect(harness.view.root).toBeUndefined();
    expect(harness.view.translationFieldCount()).toBe(0);
    expect(harness.view.languageSample()).toBe('');
    const tags = [...harness.container.querySelectorAll('.translated-text')].map(
      (element) => element.tagName.toLowerCase(),
    );
    expect(tags).toEqual(['h2', 'blockquote', 'pre', 'p']);
  });

  it('shows loading and error states in the same container', () => {
    const harness = setup();
    harness.view.renderLoading();
    expect(harness.container.querySelector('.empty-state')?.textContent).toContain('Preparing');
    harness.view.renderError('The source tab was closed.');
    expect(harness.container.querySelector('.empty-state--error')?.textContent).toBe(
      'The source tab was closed.',
    );
  });

  it('scales the stage to the display mode and follows the source scroll', () => {
    const harness = setup();
    harness.view.renderSnapshot(visualSnapshot());
    harness.setPreferences({
      ...parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      displayMode: 'custom',
      zoomPercent: 50,
      syncScroll: true,
      textLayoutMode: 'faithful',
    });
    const scroll: LivePageScrollMessage = {
      type: 'simul:page-scroll',
      version: 1,
      generation: 1,
      sessionId: 'session-1234',
      url: 'https://example.com/',
      scrollTarget: 'document',
      scrollX: 10,
      scrollY: 200,
      maxScrollX: 100,
      maxScrollY: 2_400,
      documentScrollX: 10,
      documentScrollY: 200,
      documentMaxScrollX: 100,
      documentMaxScrollY: 2_400,
    };
    harness.setSourceScroll(scroll);
    harness.view.updateLayout();
    expect(harness.view.scale).toBe(0.5);
    const scaleLayer = harness.container.querySelector<HTMLElement>('.mirror-scale-layer');
    expect(scaleLayer?.style.transform).toBe('scale(0.5)');
    expect(harness.replayHost.followSourceScroll).toHaveBeenCalledWith(scroll);
  });

  it('adopts a replacement root from a live delta and forgets it on disconnect', () => {
    const harness = setup();
    harness.view.renderSnapshot(visualSnapshot());
    const replacement = harness.container.ownerDocument.createElement('div') as HTMLElement;
    harness.view.replaceRoot(replacement, 900, 1_800);
    expect(harness.view.root).toBe(replacement);
    harness.view.disconnect();
    expect(harness.view.root).toBeUndefined();
    expect(harness.view.translationFieldCount()).toBe(0);
  });
});
