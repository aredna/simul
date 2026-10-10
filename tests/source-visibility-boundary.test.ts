import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import { SourceVisibilityBoundaryIndex } from
  '../lib/replica/source-visibility-boundary';
import { installSourceShadowRootReader } from '../lib/replica/source-shadow-root';
import { closedRootReader } from './support/closed-shadow-roots';

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

  it('follows paint changes inside a closed shadow root and of what it slots (D125)', () => {
    const { document, window } = parseHTML(`<html><body>
      <x-tabs id="host"><p id="light">Slotted panel text</p></x-tabs>
    </body></html>`);
    const host = document.querySelector<HTMLElement>('#host')!;
    const light = document.querySelector<HTMLElement>('#light')!;
    const reader = closedRootReader();
    const root = reader.attach(
      host,
      '<div id="panel" class="hidden">Closed panel text</div>' +
        '<div id="wrap" class="hidden"><slot></slot></div>',
    );
    const panel = root.querySelector<HTMLElement>('#panel')!;
    const wrap = root.querySelector<HTMLElement>('#wrap')!;
    // Chrome reads null for a node slotted into a closed root.
    Object.defineProperty(light, 'assignedSlot', { configurable: true, value: null });
    installSourceShadowRootReader(document as unknown as Document, reader.read);
    installPositivePaintRects(document);
    for (const element of root.querySelectorAll('*')) {
      Object.defineProperty(element, 'getClientRects', {
        configurable: true,
        value: () => paintRectList([{ left: 0, right: 100 }]),
      });
    }
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

    panel.classList.remove('hidden');
    expect(index.refreshMutations([attributeRecord(panel, 'class')]))
      .toEqual({ changedTargets: [panel], overflow: false });

    // The box around the slot is shown: what it slots is painted now. The
    // box is the change, and what it slots counts as inside it (D135; each
    // slotted element was a change of its own).
    wrap.classList.remove('hidden');
    expect(index.refreshMutations([attributeRecord(wrap, 'class')]))
      .toEqual({ changedTargets: [wrap], overflow: false });
    void light;
    index.dispose();
  });

  it('finds what is shown inside a wrapper that has no box of its own (D135)', () => {
    const { document, window } = parseHTML(`<html><body>
      <div id="contents"><div id="a" class="hidden">Shown later</div></div>
      <div id="zero"><div id="b" class="hidden">A menu in a block of no height</div></div>
      <div id="zero-clip"><div id="c" class="hidden">Clipped away</div></div>
      <div id="late" class="hidden">Text straight inside<p id="late-child">and a child</p></div>
      <div id="flat" class="hidden">Text straight inside a block of no height</div>
      <div id="flat-clip" class="hidden">Clipped away with its block</div>
    </body></html>`);
    const byId = (id: string): HTMLElement => document.querySelector<HTMLElement>(`#${id}`)!;
    const none = paintRectList([]);
    // As Chrome: a `display: contents` element, and a block of no height,
    // have no rectangle of positive size.
    installPositivePaintRects(document, new Map<Element, DOMRectList>([
      [byId('contents'), none], [byId('zero'), none], [byId('zero-clip'), none],
      [byId('late'), none], [byId('flat'), none], [byId('flat-clip'), none],
    ]));
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => paintedStyle({
        display: element.classList.contains('hidden')
          ? 'none'
          : element.id === 'contents' || element.id === 'late' ? 'contents' : 'block',
        ...(element.id === 'zero-clip' || element.id === 'flat-clip'
          ? { overflowX: 'hidden', overflowY: 'hidden' }
          : {}),
      }),
    });
    const index = new SourceVisibilityBoundaryIndex(
      document as unknown as Document,
      window as unknown as Window,
      100,
    );
    const show = (id: string): readonly Element[] => {
      byId(id).classList.remove('hidden');
      return index.refreshMutations([attributeRecord(byId(id), 'class')]).changedTargets;
    };
    expect(show('a')).toEqual([byId('a')]);
    expect(show('b')).toEqual([byId('b')]);
    // Inside a box of no size that clips, nothing is painted. Shown is still
    // not hidden: it is read as a whole read of the page reads it, and the
    // page's own clip keeps it out of sight in the mirror as in the tab.
    expect(show('c')).toEqual([byId('c')]);
    // A wrapper that becomes `display: contents` is itself the change: its
    // own text is drawn though it has no box.
    expect(show('late')).toEqual([byId('late')]);
    // So is a block of no height: its text hangs out of it and is drawn.
    expect(show('flat')).toEqual([byId('flat')]);
    expect(show('flat-clip')).toEqual([byId('flat-clip')]);
    // Hidden again, each is a change once more.
    byId('flat').classList.add('hidden');
    expect(index.refreshMutations([attributeRecord(byId('flat'), 'class')]).changedTargets)
      .toEqual([byId('flat')]);
    index.dispose();
  });

  it('finds what a slot shows once the box around the slot is shown (D135)', () => {
    const { document, window } = parseHTML(`<html><body>
      <x-tabs id="host"><p id="light">Slotted panel text</p></x-tabs>
    </body></html>`);
    const host = document.querySelector<HTMLElement>('#host')!;
    const light = document.querySelector<HTMLElement>('#light')!;
    const reader = closedRootReader();
    const root = reader.attach(
      host,
      '<div id="wrap" class="hidden"><slot id="slot"></slot></div>',
    );
    const wrap = root.querySelector<HTMLElement>('#wrap')!;
    const slot = root.querySelector<HTMLElement>('#slot')!;
    Object.defineProperty(light, 'assignedSlot', { configurable: true, value: null });
    installSourceShadowRootReader(document as unknown as Document, reader.read);
    installPositivePaintRects(document);
    Object.defineProperty(wrap, 'getClientRects', {
      configurable: true,
      value: () => paintRectList([{ left: 0, right: 100 }]),
    });
    // As Chrome: a slot is `display: contents` and has no rectangle.
    Object.defineProperty(slot, 'getClientRects', {
      configurable: true,
      value: () => paintRectList([]),
    });
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => paintedStyle({
        display: element.classList.contains('hidden')
          ? 'none'
          : element === slot ? 'contents' : 'block',
      }),
    });
    const index = new SourceVisibilityBoundaryIndex(
      document as unknown as Document,
      window as unknown as Window,
      100,
    );

    // The box is the one change, shown and hidden: what its slot holds
    // counts as inside it.
    wrap.classList.remove('hidden');
    expect(index.refreshMutations([attributeRecord(wrap, 'class')]))
      .toEqual({ changedTargets: [wrap], overflow: false });
    wrap.classList.add('hidden');
    expect(index.refreshMutations([attributeRecord(wrap, 'class')]))
      .toEqual({ changedTargets: [wrap], overflow: false });

    // A slotted element that changes by itself is still a change of its own.
    light.classList.add('hidden');
    wrap.classList.remove('hidden');
    index.refreshMutations([attributeRecord(wrap, 'class')]);
    light.classList.remove('hidden');
    expect(index.refreshMutations([attributeRecord(light, 'class')]))
      .toEqual({ changedTargets: [light], overflow: false });
    index.dispose();
  });

  it('counts a thousand slotted elements as one change with the box that slots them (D135)', () => {
    const { document, window } = parseHTML(
      '<html><body><x-list id="host"></x-list></body></html>',
    );
    const host = document.querySelector<HTMLElement>('#host')!;
    for (let index = 0; index < 1_000; index += 1) {
      const item = document.createElement('a');
      item.textContent = `Item ${index}`;
      host.append(item);
    }
    const reader = closedRootReader();
    const root = reader.attach(host, '<div id="list" class="hidden"><slot></slot></div>');
    const list = root.querySelector<HTMLElement>('#list')!;
    const slot = root.querySelector<HTMLElement>('slot')!;
    Object.defineProperty(slot, 'assignedNodes', {
      configurable: true,
      value: () => [...host.childNodes],
    });
    let slotReads = 0;
    for (const item of host.children) {
      Object.defineProperty(item, 'assignedSlot', {
        configurable: true,
        get: () => {
          slotReads += 1;
          return null;
        },
      });
    }
    installSourceShadowRootReader(document as unknown as Document, reader.read);
    installPositivePaintRects(document);
    Object.defineProperty(list, 'getClientRects', {
      configurable: true,
      value: () => paintRectList([{ left: 0, right: 100 }]),
    });
    Object.defineProperty(slot, 'getClientRects', {
      configurable: true,
      value: () => paintRectList([]),
    });
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => paintedStyle({
        display: element.classList.contains('hidden')
          ? 'none'
          : element === slot ? 'contents' : 'block',
      }),
    });
    const index = new SourceVisibilityBoundaryIndex(
      document as unknown as Document,
      window as unknown as Window,
      10_000,
    );
    slotReads = 0;
    list.classList.remove('hidden');
    expect(index.refreshMutations([attributeRecord(list, 'class')]))
      .toEqual({ changedTargets: [list], overflow: false });
    // Each element's place is read a few times, not once for every pair of
    // them (a million times for a thousand).
    expect(slotReads).toBeLessThan(20_000);

    // A thousand elements that change one by one (a rule of the page hides
    // each) are a thousand changes, still without a path read for every pair.
    for (const item of host.children) item.classList.add('hidden');
    slotReads = 0;
    expect(index.refreshMutations([attributeRecord(host, 'class')]).changedTargets)
      .toHaveLength(1_000);
    expect(slotReads).toBeLessThan(20_000);
    index.dispose();
  });

  it('takes a dialog that is displayed and still faded for a change (D135)', () => {
    // A script takes `hidden` off and fades the dialog in: at the first
    // frame it is displayed and at no opacity, and nothing reports the end
    // of the fade. The page reader already reads it as shown.
    const { document, window } = parseHTML(`<html><body>
      <div id="dialog" class="hidden">Dialog text</div>
    </body></html>`);
    const dialog = document.querySelector<HTMLElement>('#dialog')!;
    installPositivePaintRects(document);
    let opacity = '0';
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => paintedStyle(
        element.classList.contains('hidden')
          ? { display: 'none' }
          : element === dialog ? { opacity } : {},
      ),
    });
    const index = new SourceVisibilityBoundaryIndex(
      document as unknown as Document,
      window as unknown as Window,
      100,
    );
    dialog.classList.remove('hidden');
    expect(index.refreshMutations([attributeRecord(dialog, 'class')]).changedTargets)
      .toEqual([dialog]);
    // The fade ends; when anything next changes, that is one more change.
    opacity = '1';
    expect(index.refreshMutations([attributeRecord(document.body, 'class')]).changedTargets)
      .toEqual([dialog]);
    index.dispose();
  });

  it('takes the text a host holds itself for the text of the box that slots it (D135)', () => {
    const { document, window } = parseHTML(`<html><body>
      <x-note id="host">text straight in the host</x-note>
      <x-note id="empty"></x-note>
    </body></html>`);
    const host = document.querySelector<HTMLElement>('#host')!;
    const empty = document.querySelector<HTMLElement>('#empty')!;
    const reader = closedRootReader();
    const boxes = [host, empty].map((element) => {
      const root = reader.attach(
        element,
        '<div class="box hidden"><slot></slot></div>',
      );
      const slot = root.querySelector<HTMLElement>('slot')!;
      const text = [...element.childNodes].filter((node) => node.nodeType === 3);
      // linkedom assigns no slots: the test says what Chrome would.
      Object.defineProperty(slot, 'assignedNodes', {
        configurable: true,
        value: () => text,
      });
      Object.defineProperty(slot, 'getClientRects', {
        configurable: true,
        value: () => paintRectList([]),
      });
      const box = root.querySelector<HTMLElement>('.box')!;
      Object.defineProperty(box, 'getClientRects', {
        configurable: true,
        value: () => paintRectList([{ left: 0, right: 100 }]),
      });
      return box;
    });
    // The text itself is never read.
    Object.defineProperty(host.firstChild!, 'nodeValue', {
      configurable: true,
      get: () => {
        throw new Error('visibility indexing must not read text');
      },
    });
    installSourceShadowRootReader(document as unknown as Document, reader.read);
    installPositivePaintRects(document);
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => paintedStyle({
        display: element.classList.contains('hidden')
          ? 'none'
          : element.localName === 'slot' ? 'contents' : 'block',
      }),
    });
    const index = new SourceVisibilityBoundaryIndex(
      document as unknown as Document,
      window as unknown as Window,
      100,
    );
    for (const box of boxes) box.classList.remove('hidden');
    // The box of the host with text is a change to read; the one whose slot
    // holds nothing is not.
    expect(index.refreshMutations(boxes.map((box) => attributeRecord(box, 'class'))))
      .toEqual({ changedTargets: [boxes[0]], overflow: false });
    // The page hides the slot itself: the slot is the change.
    const slot = boxes[0]!.querySelector<HTMLElement>('slot')!;
    slot.classList.add('hidden');
    expect(index.refreshMutations([attributeRecord(slot, 'class')]))
      .toEqual({ changedTargets: [slot], overflow: false });
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
