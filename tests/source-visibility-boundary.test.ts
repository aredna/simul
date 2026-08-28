import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import { SourceVisibilityBoundaryIndex } from
  '../lib/replica/source-visibility-boundary';

describe('source visibility boundary index', () => {
  it('reports only a real hidden/painted transition and never reads text', () => {
    const { document, window } = parseHTML(`<html><body>
      <div id="ordinary" class="one">ordinary</div>
      <nav><div id="wrapper"><a id="trigger">About</a>
        <div id="panel" class="hidden">Private until painted</div>
      </div></nav></body></html>`);
    const ordinary = document.querySelector<HTMLElement>('#ordinary')!;
    const panel = document.querySelector<HTMLElement>('#panel')!;
    installPositivePaintRects(document);
    Object.defineProperty(panel.firstChild!, 'nodeValue', {
      configurable: true,
      get: () => {
        throw new Error('visibility indexing must not read text');
      },
    });
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => paintedStyle({
        display: element.classList.contains('hidden') ? 'none' : 'block',
      }),
    });
    const index = new SourceVisibilityBoundaryIndex(
      document as unknown as Document,
      window as unknown as Window,
      100,
    );

    ordinary.className = 'two';
    expect(index.refreshMutations([attributeRecord(ordinary, 'class')]))
      .toEqual({ changedTargets: [], overflow: false });

    panel.classList.remove('hidden');
    expect(index.refreshMutations([attributeRecord(panel, 'class')]))
      .toEqual({ changedTargets: [panel], overflow: false });
    index.dispose();
  });

  it('finds sibling and descendant transitions caused by ancestor or hover CSS', () => {
    const { document, window } = parseHTML(`<html><body><nav id="nav">
      <div id="wrapper"><a id="trigger">Company</a>
        <div id="panel">Team</div></div></nav></body></html>`);
    const nav = document.querySelector<HTMLElement>('#nav')!;
    const wrapper = document.querySelector<HTMLElement>('#wrapper')!;
    const trigger = document.querySelector<HTMLElement>('#trigger')!;
    const panel = document.querySelector<HTMLElement>('#panel')!;
    installPositivePaintRects(document);
    let hover = false;
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => paintedStyle({
        display: element === panel &&
          !hover && !wrapper.classList.contains('open') ? 'none' : 'block',
      }),
    });
    const index = new SourceVisibilityBoundaryIndex(
      document as unknown as Document,
      window as unknown as Window,
      100,
    );

    wrapper.classList.add('open');
    expect(index.refreshMutations([attributeRecord(wrapper, 'class')])
      .changedTargets).toEqual([panel]);

    wrapper.classList.remove('open');
    expect(index.refreshMutations([attributeRecord(wrapper, 'class')])
      .changedTargets).toEqual([panel]);

    hover = true;
    expect(index.refreshInteractionTargets([trigger]).changedTargets)
      .toEqual([panel]);
    expect(nav.contains(panel)).toBe(true);
  });

  it('does not rematerialize an image-only paint transition', () => {
    const { document, window } = parseHTML(`<html><body>
      <img id="slide" class="hidden" alt="Carousel image">
      <div id="panel" class="hidden">Authored panel text</div>
    </body></html>`);
    const slide = document.querySelector<HTMLImageElement>('#slide')!;
    const panel = document.querySelector<HTMLElement>('#panel')!;
    installPositivePaintRects(document);
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => paintedStyle({
        display: element.classList.contains('hidden') ? 'none' : 'block',
      }),
    });
    const index = new SourceVisibilityBoundaryIndex(
      document as unknown as Document,
      window as unknown as Window,
      100,
    );

    slide.classList.remove('hidden');
    expect(index.refreshMutations([attributeRecord(slide, 'class')]))
      .toEqual({ changedTargets: [], overflow: false });

    panel.classList.remove('hidden');
    expect(index.refreshMutations([attributeRecord(panel, 'class')]))
      .toEqual({ changedTargets: [panel], overflow: false });
    index.dispose();
  });

  it('detects text visibility changed remotely by any image attribute selector', () => {
    const { document, window } = parseHTML(`<html><body>
      <section id="carousel"><img id="slide" alt="hide"></section>
      <aside id="remote-panel">Remote authored text</aside>
    </body></html>`);
    const slide = document.querySelector<HTMLImageElement>('#slide')!;
    const panel = document.querySelector<HTMLElement>('#remote-panel')!;
    installPositivePaintRects(document);
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => paintedStyle({
        display: element === panel && slide.getAttribute('alt') !== 'show'
          ? 'none'
          : 'block',
      }),
    });
    const index = new SourceVisibilityBoundaryIndex(
      document as unknown as Document,
      window as unknown as Window,
      100,
    );

    slide.setAttribute('alt', 'show');
    expect(index.refreshMutations([attributeRecord(slide, 'alt')]))
      .toEqual({ changedTargets: [panel], overflow: false });
    index.dispose();
  });

  it('detects remote text revealed by a non-image data-state selector', () => {
    const { document, window } = parseHTML(`<html><body>
      <button id="trigger" data-state="closed">Menu</button>
      <aside id="remote-panel">Remote authored menu text</aside>
    </body></html>`);
    const trigger = document.querySelector<HTMLElement>('#trigger')!;
    const panel = document.querySelector<HTMLElement>('#remote-panel')!;
    installPositivePaintRects(document);
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => paintedStyle({
        display: element === panel && trigger.dataset.state !== 'open'
          ? 'none'
          : 'block',
      }),
    });
    const index = new SourceVisibilityBoundaryIndex(
      document as unknown as Document,
      window as unknown as Window,
      100,
    );

    trigger.dataset.state = 'open';
    expect(index.refreshMutations([attributeRecord(trigger, 'data-state')]))
      .toEqual({ changedTargets: [panel], overflow: false });
    index.dispose();
  });

  it('detects remote text revealed by local child presence through :has()', () => {
    const { document, window } = parseHTML(`<html><body>
      <section id="local"></section>
      <aside id="remote-panel">Remote authored panel</aside>
    </body></html>`);
    const local = document.querySelector<HTMLElement>('#local')!;
    const panel = document.querySelector<HTMLElement>('#remote-panel')!;
    installPositivePaintRects(document);
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => paintedStyle({
        display: element === panel && !local.querySelector('.marker')
          ? 'none'
          : 'block',
      }),
    });
    const index = new SourceVisibilityBoundaryIndex(
      document as unknown as Document,
      window as unknown as Window,
      100,
    );
    const marker = document.createElement('span');
    marker.className = 'marker';
    local.append(marker);

    expect(index.refreshMutations([{
      type: 'childList',
      target: local,
      addedNodes: [marker] as unknown as NodeList,
      removedNodes: [] as unknown as NodeList,
    } as unknown as MutationRecord])).toEqual({
      changedTargets: [panel],
      overflow: false,
    });
    index.dispose();
  });

  it('detects remote text revealed by local text presence through :empty', () => {
    const { document, window } = parseHTML(`<html><body>
      <span id="marker">closed</span>
      <aside id="remote-panel">Remote authored panel</aside>
    </body></html>`);
    const marker = document.querySelector<HTMLElement>('#marker')!;
    const markerText = marker.firstChild as Text;
    const panel = document.querySelector<HTMLElement>('#remote-panel')!;
    installPositivePaintRects(document);
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => paintedStyle({
        display: element === panel && marker.textContent !== ''
          ? 'none'
          : 'block',
      }),
    });
    const index = new SourceVisibilityBoundaryIndex(
      document as unknown as Document,
      window as unknown as Window,
      100,
    );

    markerText.nodeValue = '';
    expect(index.refreshMutations([characterDataRecord(markerText)]))
      .toEqual({ changedTargets: [panel], overflow: false });
    index.dispose();
  });

  it('detects interaction state that reveals text outside the local nav', () => {
    const { document, window } = parseHTML(`<html><body>
      <nav><button id="trigger">Products</button></nav>
      <aside id="remote-panel">Remote authored submenu</aside>
    </body></html>`);
    const trigger = document.querySelector<HTMLElement>('#trigger')!;
    const panel = document.querySelector<HTMLElement>('#remote-panel')!;
    installPositivePaintRects(document);
    let active = false;
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => paintedStyle({
        display: element === panel && !active ? 'none' : 'block',
      }),
    });
    const index = new SourceVisibilityBoundaryIndex(
      document as unknown as Document,
      window as unknown as Window,
      100,
    );

    active = true;
    expect(index.refreshInteractionTargets([trigger])).toEqual({
      changedTargets: [panel],
      overflow: false,
    });
    index.dispose();
  });

  it('fails closed when an image mutation cannot prove remote paint inputs', () => {
    const { document, window } = parseHTML(`<html><body>
      <img id="slide"><aside id="remote-panel">Remote authored text</aside>
    </body></html>`);
    const slide = document.querySelector<HTMLImageElement>('#slide')!;
    const panel = document.querySelector<HTMLElement>('#remote-panel')!;
    installPositivePaintRects(document);
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => {
        if (element === panel) throw new Error('unreadable remote style');
        return paintedStyle();
      },
    });
    const index = new SourceVisibilityBoundaryIndex(
      document as unknown as Document,
      window as unknown as Window,
      100,
    );

    slide.className = 'active';
    expect(index.refreshMutations([attributeRecord(slide, 'class')]))
      .toEqual({ changedTargets: [], overflow: true });
    index.dispose();
  });

  it('fails closed when open-shadow visibility scope is unreadable', () => {
    const { document, window } = parseHTML(`<html><body>
      <img id="slide"><x-panel id="host"></x-panel>
    </body></html>`);
    const slide = document.querySelector<HTMLImageElement>('#slide')!;
    const host = document.querySelector<HTMLElement>('#host')!;
    installPositivePaintRects(document);
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: () => paintedStyle(),
    });
    Object.defineProperty(host, 'shadowRoot', {
      configurable: true,
      get: () => {
        throw new Error('unreadable shadow root');
      },
    });
    const index = new SourceVisibilityBoundaryIndex(
      document as unknown as Document,
      window as unknown as Window,
      100,
    );

    slide.className = 'active';
    expect(index.refreshMutations([attributeRecord(slide, 'class')]))
      .toEqual({ changedTargets: [], overflow: true });
    index.dispose();
  });

  it('reads each element paint input once during a full mutation scan', () => {
    const { document, window } = parseHTML(`<html><body>
      <img id="slide"><section><span>Public panel text</span></section>
    </body></html>`);
    const slide = document.querySelector<HTMLImageElement>('#slide')!;
    void document.head;
    const elements = [...document.querySelectorAll('*')];
    const styleReads = new Map<Element, number>();
    const geometryReads = new Map<Element, number>();
    for (const element of elements) {
      Object.defineProperty(element, 'getClientRects', {
        configurable: true,
        value: () => {
          geometryReads.set(element, (geometryReads.get(element) ?? 0) + 1);
          return paintRectList([{ left: 0, right: 100 }]);
        },
      });
    }
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => {
        styleReads.set(element, (styleReads.get(element) ?? 0) + 1);
        return paintedStyle();
      },
    });
    const index = new SourceVisibilityBoundaryIndex(
      document as unknown as Document,
      window as unknown as Window,
      100,
    );
    styleReads.clear();
    geometryReads.clear();

    slide.className = 'active';
    expect(index.refreshMutations([attributeRecord(slide, 'class')]))
      .toEqual({ changedTargets: [], overflow: false });
    for (const element of elements) {
      expect(styleReads.get(element)).toBe(1);
      expect(geometryReads.get(element)).toBe(1);
    }
    index.dispose();
  });

  it('tracks every painted-style, geometry, and ancestor-clipping boundary', () => {
    const { document, window } = parseHTML(`<html><body>
      <div id="clipper"><div id="target">Painted payload</div></div>
    </body></html>`);
    const clipper = document.querySelector<HTMLElement>('#clipper')!;
    const target = document.querySelector<HTMLElement>('#target')!;
    const styleOverrides = new Map<Element, Partial<PaintedStyleOptions>>();
    const rectOverrides = new Map<Element, DOMRectList>();
    installPositivePaintRects(document, rectOverrides);
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => paintedStyle(
        styleOverrides.get(element),
      ),
    });
    const index = new SourceVisibilityBoundaryIndex(
      document as unknown as Document,
      window as unknown as Window,
      100,
    );
    const transition = (
      style: Partial<PaintedStyleOptions> | undefined,
      rects?: DOMRectList,
    ): readonly Element[] => {
      if (style) styleOverrides.set(target, style);
      else styleOverrides.delete(target);
      if (rects) rectOverrides.set(target, rects);
      else rectOverrides.delete(target);
      return index.refreshMutations([attributeRecord(target, 'class')])
        .changedTargets;
    };

    expect(transition({ opacity: '0' })).toEqual([target]);
    expect(transition(undefined)).toEqual([target]);
    expect(transition({ contentVisibility: 'hidden' })).toEqual([target]);
    expect(transition(undefined)).toEqual([target]);
    expect(transition({ clip: 'rect(0, 0, 0, 0)' })).toEqual([target]);
    expect(transition(undefined)).toEqual([target]);
    expect(transition({ clipPath: 'inset(50%)' })).toEqual([target]);
    expect(transition(undefined)).toEqual([target]);
    expect(transition(undefined, paintRectList([]))).toEqual([target]);
    expect(transition(undefined)).toEqual([target]);

    styleOverrides.set(clipper, { overflowX: 'hidden' });
    rectOverrides.set(clipper, paintRectList([{ left: 0, right: 40 }]));
    rectOverrides.set(target, paintRectList([{ left: 60, right: 100 }]));
    expect(index.refreshMutations([attributeRecord(clipper, 'class')])
      .changedTargets).toEqual([target]);
    rectOverrides.set(target, paintRectList([{ left: 20, right: 60 }]));
    expect(index.refreshMutations([attributeRecord(target, 'class')])
      .changedTargets).toEqual([target]);
    index.dispose();
  });

  it('recovers completeness after a later bounded full refresh succeeds', () => {
    const { document, window } = parseHTML(`<html><body><main>
      <span></span><span></span><span></span>
    </main></body></html>`);
    installPositivePaintRects(document);
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: () => paintedStyle(),
    });
    const index = new SourceVisibilityBoundaryIndex(
      document as unknown as Document,
      window as unknown as Window,
      4,
    );
    expect(index.refreshInteractionTargets([document.body]).overflow).toBe(true);

    document.querySelector('main')?.remove();
    expect(index.refreshAll()).toEqual({ changedTargets: [], overflow: false });
    document.body.className = 'ordinary-churn';
    expect(index.refreshMutations([attributeRecord(document.body, 'class')]))
      .toEqual({ changedTargets: [], overflow: false });
    index.dispose();
  });
});

interface PaintedStyleOptions {
  readonly display: string;
  readonly visibility: string;
  readonly opacity: string;
  readonly contentVisibility: string;
  readonly clip: string;
  readonly clipPath: string;
  readonly overflowX: string;
  readonly overflowY: string;
}

function paintedStyle(
  overrides: Partial<PaintedStyleOptions> = {},
): CSSStyleDeclaration {
  const options: PaintedStyleOptions = {
    display: 'block',
    visibility: 'visible',
    opacity: '1',
    contentVisibility: 'visible',
    clip: 'auto',
    clipPath: 'none',
    overflowX: 'visible',
    overflowY: 'visible',
    ...overrides,
  };
  return {
    display: options.display,
    visibility: options.visibility,
    opacity: options.opacity,
    overflowX: options.overflowX,
    overflowY: options.overflowY,
    getPropertyValue: (name: string) => ({
      'content-visibility': options.contentVisibility,
      clip: options.clip,
      'clip-path': options.clipPath,
      'overflow-x': options.overflowX,
      'overflow-y': options.overflowY,
    })[name] ?? '',
  } as unknown as CSSStyleDeclaration;
}

function installPositivePaintRects(
  document: Document,
  overrides: ReadonlyMap<Element, DOMRectList> = new Map(),
): void {
  // Linkedom materializes an omitted <head> lazily after later mutations.
  // Force the stable browser-shaped tree before installing geometry stubs.
  void document.head;
  for (const element of [...document.querySelectorAll('*')]) {
    Object.defineProperty(element, 'getClientRects', {
      configurable: true,
      value: () => overrides.get(element) ?? paintRectList([
        { left: 0, right: 100 },
      ]),
    });
  }
}

function paintRectList(
  horizontal: readonly { readonly left: number; readonly right: number }[],
): DOMRectList {
  const rects = horizontal.map(({ left, right }) => ({
    x: left,
    y: 0,
    left,
    top: 0,
    right,
    bottom: 40,
    width: right - left,
    height: 40,
    toJSON: () => ({}),
  } as DOMRect));
  return Object.assign(rects, {
    item: (index: number) => rects[index] ?? null,
  }) as unknown as DOMRectList;
}

function attributeRecord(
  target: Element,
  attributeName: string,
): MutationRecord {
  return {
    type: 'attributes',
    target,
    attributeName,
    attributeNamespace: null,
    oldValue: null,
    addedNodes: [] as unknown as NodeList,
    removedNodes: [] as unknown as NodeList,
    nextSibling: null,
    previousSibling: null,
  };
}

function characterDataRecord(target: Text): MutationRecord {
  return {
    type: 'characterData',
    target,
    attributeName: null,
    attributeNamespace: null,
    oldValue: null,
    addedNodes: [] as unknown as NodeList,
    removedNodes: [] as unknown as NodeList,
    nextSibling: null,
    previousSibling: null,
  };
}
