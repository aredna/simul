import { parseHTML } from 'linkedom';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { createImageSourcePortName } from '../lib/ocr/image-source-protocol';
import {
  MAX_HTML_MIRROR_SCROLL_PANES,
  createHtmlMirrorAck,
  createHtmlMirrorCheckpointRequest,
  createHtmlMirrorPortName,
  createHtmlMirrorStart,
  decodeHtmlMirrorWireMessage,
  HtmlMirrorScrollPaneLedger,
  type HtmlMirrorCheckpoint,
  type HtmlMirrorPatchBatch,
  type HtmlMirrorScrollState,
  type HtmlMirrorScrollUpdate,
} from '../lib/replica/html-mirror-protocol';
import {
  HtmlMirrorSourceSession,
  WeakNodeIdRegistry,
  installHtmlMirrorSourceBridge,
  type HtmlMirrorSourceBridgeEnvironment,
} from '../lib/replica/html-mirror-source';
import { MAX_HTML_MIRROR_NODES } from '../lib/replica/html-mirror-sanitizer';
import { applyHtmlMirrorLimitSettings } from '../lib/replica/html-mirror-limits';
import { createReplicaIdentity } from '../lib/replica/replica-identity';
import { sourceDocumentIdentity } from '../lib/replica/source-identity';
import {
  createSourceControlledContentPolicy,
  sourceControlledContentMutationsMayChange,
} from '../lib/replica/source-privacy-policy';
import { sourceDocumentSecretClassifier } from '../lib/replica/source-secret-classifier';
import {
  askAboutSourceShadowRootsAbove,
  installSourceShadowRootReader,
} from '../lib/replica/source-shadow-root';
import {
  closedRootReader,
  type ClosedRootReader,
} from './support/closed-shadow-roots';
import {
  scopedMutationObservers,
  type ScopedMutationObservers,
} from './support/scoped-mutations';

const SYNTHETIC_STATIC_LOGO = "data:image/svg+xml,%3csvg%20width='48'%20height='48'%20viewBox='0%200%2048%2048'%20fill='none'%20xmlns='http://www.w3.org/2000/svg'%3e%3cpath%20d='M4.25%204.25H43.75V43.75H4.25Z'%20fill='%236C5CE7'/%3e%3cpath%20d='M12.5%2034C15.5%2024.25%2019.75%201.2e1%2024%2012C28.25%2012%2032.5%2024.25%2035.5%2034Z'%20fill='white'/%3e%3c/svg%3e";

describe('HtmlMirrorSourceSession', () => {
  beforeEach(() => {
    const { window } = parseHTML('<html><body></body></html>');
    Object.assign(globalThis, {
      Node: window.Node,
      Element: window.Element,
      Text: window.Text,
    });
  });

  it('does not prove a panel painted only through a gap between ancestor rects', () => {
    const { document, window } = parseHTML(`<html><body>
      <div role="tab" aria-selected="true" aria-expanded="true"
        aria-controls="gap-panel">Tab</div>
      <div id="clipper"><section id="gap-panel" role="tabpanel">Gap</section></div>
    </body></html>`);
    const panel = document.querySelector('#gap-panel')!;
    const clipper = document.querySelector('#clipper')!;
    for (const element of [...document.querySelectorAll('*')]) {
      Object.defineProperty(element, 'getClientRects', {
        configurable: true,
        value: () => element === panel
          ? mirrorRectList([{ left: 45, right: 55 }])
          : element === clipper
          ? mirrorRectList([{ left: 0, right: 40 }, { left: 60, right: 100 }])
          : mirrorRectList([{ left: 0, right: 100 }]),
      });
    }
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => ({
        display: 'block', visibility: 'visible', opacity: '1',
        overflowX: element === clipper ? 'hidden' : 'visible',
        overflowY: element === clipper ? 'hidden' : 'visible',
        getPropertyValue: (name: string) => {
          if (name === 'content-visibility') return 'visible';
          if (name === 'clip') return 'auto';
          if (name === 'clip-path') return 'none';
          if (name === 'overflow-x' || name === 'overflow-y') {
            return element === clipper ? 'hidden' : 'visible';
          }
          return '';
        },
      }),
    });

    const policy = createSourceControlledContentPolicy(
      document as unknown as Document,
      window as unknown as Window,
    );
    expect(policy.targets.get(panel)).toBe('withheld');
  });

  it('proves the tabs of a tablist inside a wrapper that has no box of its own (D135)', () => {
    // An app whose whole page sits in a `display: contents` wrapper: its
    // tabs were never proven, selected or not.
    const { document, window } = parseHTML(`<html><body><div id="app">
      <div role="tablist">
        <div id="tab-a" role="tab" aria-selected="true" aria-controls="panel-a">A</div>
        <div id="tab-b" role="tab" aria-selected="false" aria-controls="panel-b">B</div>
      </div>
      <section id="panel-a" role="tabpanel">Panel A</section>
      <section id="panel-b" role="tabpanel" hidden>Panel B</section>
    </div></body></html>`);
    const app = document.querySelector('#app')!;
    for (const element of [...document.querySelectorAll('*')]) {
      Object.defineProperty(element, 'getClientRects', {
        configurable: true,
        value: () => element === app || element.hasAttribute('hidden')
          ? mirrorEmptyRectList()
          : mirrorRectList([{ left: 0, right: 100 }]),
      });
    }
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => ({
        display: element.hasAttribute('hidden')
          ? 'none'
          : element === app ? 'contents' : 'block',
        visibility: 'visible', opacity: '1',
        overflowX: 'visible', overflowY: 'visible',
        getPropertyValue: (name: string) => {
          if (name === 'content-visibility') return 'visible';
          if (name === 'clip') return 'auto';
          if (name === 'clip-path') return 'none';
          if (name === 'overflow-x' || name === 'overflow-y') return 'visible';
          return '';
        },
      }),
    });

    const policy = createSourceControlledContentPolicy(
      document as unknown as Document,
      window as unknown as Window,
    );
    expect(
      policy.tabs.map(({ trigger, selected }) => `${trigger.id} ${selected}`).sort(),
    ).toEqual(['tab-a true', 'tab-b false']);
    expect(policy.targets.get(document.querySelector('#panel-a')!)).toBe('open-tab');
    expect(policy.targets.get(document.querySelector('#panel-b')!)).toBe('withheld');
  });

  it('connects the Integrated image source Port through the installed bridge', () => {
    const { document, window } = parseHTML(
      '<html><body><img id="announcement" src="news.gif" alt="お知らせ"></body></html>',
    );
    Object.defineProperty(window, 'top', { configurable: true, value: window });
    Object.defineProperty(document, 'baseURI', {
      configurable: true,
      value: 'https://example.test/',
    });
    const image = document.querySelector<HTMLImageElement>('#announcement')!;
    setBridgeImageFacts(image);
    const registry = new WeakNodeIdRegistry();
    const onConnect = new FakeEvent<(port: Browser.runtime.Port) => void>();
    const runtime = {
      onConnect,
    } as unknown as HtmlMirrorSourceBridgeEnvironment['runtime'];
    vi.stubGlobal('IntersectionObserver', ImmediateIntersectionObserver);
    vi.stubGlobal('ResizeObserver', NoopResizeObserver);
    vi.stubGlobal('MutationObserver', NoopBridgeMutationObserver);
    try {
      installHtmlMirrorSourceBridge({
        global: {} as typeof globalThis,
        runtime,
        document,
        window: window as unknown as Window,
        registry,
        now: () => 1,
        createMutationObserver: () => new NoopBridgeMutationObserver(),
        scheduleFrame: () => 1,
        cancelFrame: () => undefined,
        setTimer: () => 1,
        clearTimer: () => undefined,
        createResizeObserver: () => new NoopResizeObserver(),
      });

      const mirrorPort = new FakePort(createHtmlMirrorPortName(identity.sessionId));
      onConnect.emit(mirrorPort as unknown as Browser.runtime.Port);
      mirrorPort.emitMessage(createHtmlMirrorStart(identity, 'conservative'));
      const nodeId = registry.peekId(image);
      expect(nodeId).toBeTypeOf('number');

      const imagePort = new FakePort(
        createImageSourcePortName(identity.sessionId, 'isolated-html'),
      );
      onConnect.emit(imagePort as unknown as Browser.runtime.Port);
      imagePort.emitMessage({
        kind: 'simul:image-source-v2:start',
        document: sourceDocumentIdentity(identity),
      });

      expect(imagePort.posts).toContainEqual(expect.objectContaining({
        kind: 'simul:image-source-v2:ready',
        document: sourceDocumentIdentity(identity),
        summary: { candidateImages: 1, observedImages: 1 },
      }));
      expect(imagePort.posts).toContainEqual(expect.objectContaining({
        kind: 'simul:image-source-v2:change',
        change: expect.objectContaining({
          kind: 'upsert',
          descriptor: expect.objectContaining({ nodeId }),
        }),
      }));
      expect(JSON.stringify(imagePort.posts)).not.toContain('news.gif');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps credential history before and between Integrated Port connections', () => {
    const canary = 'integrated-disconnected-otp-secret';
    const { document, window } = parseHTML(
      '<html><body><main id="public"></main></body></html>',
    );
    Object.defineProperty(window, 'top', { configurable: true, value: window });
    const onConnect = new FakeEvent<(port: Browser.runtime.Port) => void>();
    const observers: ControlledBridgeMutationObserver[] = [];
    const bridgeGlobal = {} as typeof globalThis & {
      __simulHtmlMirrorV2Installed?: boolean;
    };
    installHtmlMirrorSourceBridge({
      global: bridgeGlobal,
      runtime: { onConnect } as unknown as
        HtmlMirrorSourceBridgeEnvironment['runtime'],
      document,
      window: window as unknown as Window,
      now: () => 1,
      createMutationObserver: (callback) => {
        const observer = new ControlledBridgeMutationObserver(callback);
        observers.push(observer);
        return observer;
      },
      scheduleFrame: () => 1,
      cancelFrame: () => undefined,
      setTimer: () => 1,
      clearTimer: () => undefined,
    });
    expect(observers).toHaveLength(1);

    const secret = document.createElement('section');
    secret.setAttribute('autocomplete', 'one-time-code');
    const wrapper = document.createElement('span');
    const text = document.createTextNode(canary);
    wrapper.append(text);
    secret.append(wrapper);
    document.body.append(secret);
    document.querySelector('#public')!.append(text);
    observers[0]!.trigger([
      childListRecord(document.body, [secret]),
      childListRecord(wrapper, [], [text]),
      childListRecord(document.querySelector('#public')!, [text]),
    ]);

    const firstPort = new FakePort(createHtmlMirrorPortName(identity.sessionId));
    onConnect.emit(firstPort as unknown as Browser.runtime.Port);
    firstPort.emitMessage(createHtmlMirrorStart(identity, 'conservative'));
    expect(JSON.stringify(firstPort.posts)).not.toContain(canary);
    firstPort.onDisconnect.emit();

    const secondPort = new FakePort(createHtmlMirrorPortName(identity.sessionId));
    onConnect.emit(secondPort as unknown as Browser.runtime.Port);
    secondPort.emitMessage(createHtmlMirrorStart(identity, 'conservative'));
    expect(JSON.stringify(secondPort.posts)).not.toContain(canary);
  });

  it('installs the v2 bundle beside a stale v1 marker without reusing its Ports', () => {
    const { document, window } = parseHTML('<html><body></body></html>');
    Object.defineProperty(window, 'top', { configurable: true, value: window });
    const staleObserver = { disconnect: vi.fn() };
    const bridgeGlobal = {
      __simulHtmlMirrorV1Installed: true,
      __simulHtmlMirrorV1SecretObserver: staleObserver,
    } as unknown as typeof globalThis & {
      __simulHtmlMirrorV1Installed?: boolean;
      __simulHtmlMirrorV1SecretObserver?: Pick<MutationObserver, 'disconnect'>;
      __simulHtmlMirrorV2Installed?: boolean;
    };
    const onConnect = new FakeEvent<(port: Browser.runtime.Port) => void>();
    const environment: HtmlMirrorSourceBridgeEnvironment = {
      global: bridgeGlobal,
      runtime: { onConnect } as unknown as
        HtmlMirrorSourceBridgeEnvironment['runtime'],
      document,
      window: window as unknown as Window,
      createMutationObserver: () => new NoopBridgeMutationObserver(),
      scheduleFrame: () => 1,
      cancelFrame: () => undefined,
      setTimer: () => 1,
      clearTimer: () => undefined,
    };

    installHtmlMirrorSourceBridge(environment);
    expect(bridgeGlobal.__simulHtmlMirrorV2Installed).toBe(true);
    expect(staleObserver.disconnect).toHaveBeenCalledOnce();
    expect(onConnect.listenerCount).toBe(1);

    installHtmlMirrorSourceBridge(environment);
    expect(onConnect.listenerCount).toBe(1);
  });

  it('stays paused through recovery ACK and retains mutations after its checkpoint', () => {
    const fixture = sourceFixture('<main><span>before</span></main>');
    fixture.start();
    expect(fixture.checkpoints()).toHaveLength(1);
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    fixture.port.emitMessage(createHtmlMirrorCheckpointRequest(identity, 0));
    expect(fixture.checkpoints()).toHaveLength(2);
    const text = fixture.document.querySelector('span')!.firstChild as Text;
    text.nodeValue = 'after checkpoint';
    fixture.mutate(characterDataRecord(text));
    expect(fixture.frames).toHaveLength(0);

    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    fixture.flushFrame();
    const patch = fixture.patches().at(-1)!;
    expect(patch.identity.sequence).toBe(1);
    expect(patch.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'text',
        node: expect.objectContaining({ text: 'after checkpoint' }),
      }),
    ]));
  });

  it('coalesces startup mutations until the initial checkpoint is acknowledged', () => {
    const fixture = sourceFixture('<main><span>initial</span></main>');
    fixture.start();
    expect(fixture.checkpoints()).toHaveLength(1);

    const text = fixture.document.querySelector('span')!.firstChild as Text;
    text.nodeValue = 'changed while replica stages';
    fixture.mutate(characterDataRecord(text));
    expect(fixture.frames).toHaveLength(0);
    expect(fixture.patches()).toHaveLength(0);

    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    expect(fixture.frames).toHaveLength(1);
    fixture.flushFrame();

    const patches = fixture.patches();
    expect(patches).toHaveLength(1);
    expect(patches[0]?.firstSequence).toBe(1);
    expect(patches[0]?.lastSequence).toBe(1);
    expect(JSON.stringify(patches[0])).toContain('changed while replica stages');
  });

  it('rematerializes only the selected painted tab across A-B-A transitions', () => {
    const fixture = sourceFixture(`
      <style id="tab-style">.tabs { color: inherit; }</style>
      <div id="carousel" class="slide-one">Unrelated carousel</div>
      <div role="tablist">
        <div id="tab-a" role="tab" aria-selected="true" aria-expanded="true"
          aria-controls="panel-a">Tab A</div>
        <div id="tab-b" role="tab" aria-selected="false" aria-expanded="false"
          aria-controls="panel-b">Tab B</div>
      </div>
      <section id="panel-a" role="tabpanel" aria-hidden="false"
        data-test-style-sensitive="true">Panel A payload</section>
      <section id="panel-b" role="tabpanel" aria-hidden="true" hidden>Panel B payload</section>
    `);
    installPaintedMirrorTabFixture(fixture.document, fixture.window);
    const panelAText = fixture.document.querySelector('#panel-a')!.firstChild!;
    const panelBText = fixture.document.querySelector('#panel-b')!.firstChild!;
    let panelAReads = 0;
    let panelBReads = 0;
    Object.defineProperty(panelAText, 'nodeValue', {
      configurable: true,
      get: () => {
        panelAReads += 1;
        return 'Panel A payload';
      },
    });
    Object.defineProperty(panelBText, 'nodeValue', {
      configurable: true,
      get: () => {
        panelBReads += 1;
        return 'Panel B payload';
      },
    });

    fixture.start();
    const initialJson = JSON.stringify(fixture.checkpoints()[0]);
    expect(initialJson).toContain('Panel A payload');
    expect(initialJson).not.toContain('Panel B payload');
    expect(panelAReads).toBeGreaterThan(0);
    expect(panelBReads).toBe(0);
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    panelAReads = 0;
    panelBReads = 0;
    selectMirrorTab(fixture.document, 'b');
    for (const [selector, attribute] of [
      ['#tab-a', 'aria-selected'], ['#tab-a', 'aria-expanded'],
      ['#tab-b', 'aria-selected'], ['#tab-b', 'aria-expanded'],
      ['#panel-a', 'aria-hidden'], ['#panel-a', 'hidden'],
      ['#panel-b', 'aria-hidden'], ['#panel-b', 'hidden'],
    ] as const) {
      fixture.mutate(attributeRecord(
        fixture.document.querySelector(selector)!,
        attribute,
      ));
    }
    fixture.flushFrame();
    const toB = fixture.patches().at(-1)!;
    const toBJson = JSON.stringify(toB);
    expect(toBJson).toContain('Panel B payload');
    expect(toBJson).not.toContain('Panel A payload');
    expect(panelAReads).toBe(0);
    expect(panelBReads).toBeGreaterThan(0);
    expect(toB.operations.filter(({ kind }) => kind === 'children')).toHaveLength(2);
    fixture.port.emitMessage(createHtmlMirrorAck(identity, toB.lastSequence));

    panelAReads = 0;
    panelBReads = 0;
    selectMirrorTab(fixture.document, 'a');
    for (const [selector, attribute] of [
      ['#tab-a', 'aria-selected'], ['#tab-a', 'aria-expanded'],
      ['#tab-b', 'aria-selected'], ['#tab-b', 'aria-expanded'],
      ['#panel-a', 'aria-hidden'], ['#panel-a', 'hidden'],
      ['#panel-b', 'aria-hidden'], ['#panel-b', 'hidden'],
    ] as const) {
      fixture.mutate(attributeRecord(
        fixture.document.querySelector(selector)!,
        attribute,
      ));
    }
    fixture.flushFrame();
    const backToA = fixture.patches().at(-1)!;
    const backToAJson = JSON.stringify(backToA);
    expect(backToAJson).toContain('Panel A payload');
    expect(backToAJson).not.toContain('Panel B payload');
    expect(panelAReads).toBeGreaterThan(0);
    expect(panelBReads).toBe(0);
    fixture.port.emitMessage(createHtmlMirrorAck(identity, backToA.lastSequence));

    const carousel = fixture.document.querySelector('#carousel')!;
    const readsBeforeUnrelatedMutation = panelAReads;
    carousel.className = 'slide-two';
    fixture.mutate(attributeRecord(carousel, 'class'));
    fixture.flushFrame();
    const unrelated = fixture.patches().at(-1)!;
    expect(unrelated.operations.some(({ kind }) => kind === 'children')).toBe(false);
    expect(panelAReads).toBe(readsBeforeUnrelatedMutation);
    expect(panelBReads).toBe(0);
    fixture.port.emitMessage(createHtmlMirrorAck(
      identity,
      unrelated.lastSequence,
    ));

    const panelA = fixture.document.querySelector('#panel-a')!;
    const panelANodeId = fixture.registry.peekId(panelA);
    panelA.setAttribute('data-test-computed-hidden', 'true');
    fixture.window.dispatchEvent(new fixture.window.Event('resize'));
    fixture.flushFrame();
    const resizeHidden = fixture.patches().at(-1)!;
    expect(resizeHidden.operations).toContainEqual(expect.objectContaining({
      kind: 'children',
      nodeId: panelANodeId,
    }));
    expect(JSON.stringify(resizeHidden)).not.toContain('Panel A payload');
    fixture.port.emitMessage(createHtmlMirrorAck(
      identity,
      resizeHidden.lastSequence,
    ));

    panelA.removeAttribute('data-test-computed-hidden');
    fixture.window.dispatchEvent(new fixture.window.Event('resize'));
    fixture.flushFrame();
    const resizeVisible = fixture.patches().at(-1)!;
    expect(JSON.stringify(resizeVisible)).toContain('Panel A payload');
    fixture.port.emitMessage(createHtmlMirrorAck(
      identity,
      resizeVisible.lastSequence,
    ));

    const style = fixture.document.querySelector('#tab-style')!;
    const removedStyleNodes = [...style.childNodes];
    style.textContent = '.tabs { color: inherit; } .hide-panel { display:none; }';
    fixture.mutate(childListRecord(
      style,
      [...style.childNodes],
      removedStyleNodes,
    ));
    fixture.flushFrame();
    const stylesheetHidden = fixture.patches().at(-1)!;
    expect(stylesheetHidden.operations).toContainEqual(expect.objectContaining({
      kind: 'children',
      nodeId: panelANodeId,
    }));
    expect(JSON.stringify(stylesheetHidden)).not.toContain('Panel A payload');
  });

  it('refreshes selected-panel admission after opacity settle and nested collapse', () => {
    const fixture = sourceFixture(`
      <div role="tab" aria-selected="true" aria-expanded="true"
        aria-controls="settling-panel">Tab</div>
      <section id="settling-panel" role="tabpanel" aria-hidden="false">
        <div id="nested-layout">Settled panel payload</div>
      </section>
    `);
    installPaintedMirrorTabFixture(fixture.document, fixture.window);
    const panel = fixture.document.querySelector('#settling-panel')!;
    const nested = fixture.document.querySelector('#nested-layout')!;
    const baseGetComputedStyle = fixture.window.getComputedStyle.bind(fixture.window);
    let opacity = '0';
    let collapsed = false;
    Object.defineProperty(panel, 'getClientRects', {
      configurable: true,
      value: () => collapsed ? mirrorEmptyRectList() : mirrorTabRectList(),
    });
    Object.defineProperty(fixture.window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => {
        const style = baseGetComputedStyle(element);
        return element === panel
          ? { ...style, opacity } as unknown as CSSStyleDeclaration
          : style;
      },
    });

    fixture.start();
    expect(JSON.stringify(fixture.checkpoints()[0])).not.toContain(
      'Settled panel payload',
    );
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    opacity = '1';
    panel.dispatchEvent(new fixture.window.Event('transitionend', { bubbles: true }));
    panel.dispatchEvent(new fixture.window.Event('animationend', { bubbles: true }));
    expect(fixture.frames).toHaveLength(1);
    fixture.flushFrame();
    const revealed = fixture.patches().at(-1)!;
    expect(JSON.stringify(revealed)).toContain('Settled panel payload');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, revealed.lastSequence));

    collapsed = true;
    nested.className = 'collapsed';
    fixture.mutate(attributeRecord(nested, 'class'));
    fixture.flushFrame();
    expect(JSON.stringify(fixture.patches().at(-1))).not.toContain(
      'Settled panel payload',
    );
  });

  it('refreshes selected-panel admission when a custom ancestor attribute reveals it', () => {
    const fixture = sourceFixture(`
      <div role="tab" aria-selected="true" aria-expanded="true"
        aria-controls="state-panel">Tab</div>
      <div id="state-wrapper" data-state="closed">
        <section id="state-panel" role="tabpanel">State panel payload</section>
      </div>
      <div id="elsewhere" data-state="closed">Elsewhere</div>
    `);
    installPaintedMirrorTabFixture(fixture.document, fixture.window);
    const wrapper = fixture.document.querySelector('#state-wrapper')!;
    const panel = fixture.document.querySelector('#state-panel')!;
    const elsewhere = fixture.document.querySelector('#elsewhere')!;
    const baseGetComputedStyle = fixture.window.getComputedStyle.bind(fixture.window);
    Object.defineProperty(fixture.window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => {
        const style = baseGetComputedStyle(element);
        // Models `#state-wrapper[data-state="open"] > [role="tabpanel"]`
        // revealing the panel through a custom attribute, not `hidden`.
        return element === panel && wrapper.getAttribute('data-state') !== 'open'
          ? { ...style, display: 'none' } as unknown as CSSStyleDeclaration
          : style;
      },
    });

    const policy = createSourceControlledContentPolicy(
      fixture.document as unknown as Document,
      fixture.window as unknown as Window,
    );
    expect(policy.targets.get(panel)).toBe('withheld');
    expect(sourceControlledContentMutationsMayChange(
      [attributeRecord(wrapper, 'data-state')],
      policy,
    )).toBe(true);
    expect(sourceControlledContentMutationsMayChange(
      [attributeRecord(elsewhere, 'data-state')],
      policy,
    )).toBe(false);

    fixture.start();
    expect(JSON.stringify(fixture.checkpoints()[0])).not.toContain(
      'State panel payload',
    );
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    wrapper.setAttribute('data-state', 'open');
    fixture.mutate(attributeRecord(wrapper, 'data-state'));
    fixture.flushFrame();
    expect(JSON.stringify(fixture.patches().at(-1))).toContain(
      'State panel payload',
    );
  });

  it('re-admits a selected panel that a remote selector change paints', () => {
    const fixture = sourceFixture(`
      <button id="remote" data-open="false">Open</button>
      <div role="tab" aria-selected="true" aria-expanded="true"
        aria-controls="remote-panel">Tab</div>
      <section id="remote-panel" role="tabpanel">Remote panel payload</section>
    `);
    installPaintedMirrorTabFixture(fixture.document, fixture.window);
    const remote = fixture.document.querySelector('#remote')!;
    const panel = fixture.document.querySelector('#remote-panel')!;
    const baseGetComputedStyle = fixture.window.getComputedStyle.bind(fixture.window);
    Object.defineProperty(fixture.window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => {
        const style = baseGetComputedStyle(element);
        // Models `#remote[data-open="true"] ~ [role="tabpanel"]`: the mutated
        // element is neither a participant nor on a participant's path, so
        // only the painted-visibility comparison can notice the reveal.
        return element === panel && remote.getAttribute('data-open') !== 'true'
          ? { ...style, display: 'none' } as unknown as CSSStyleDeclaration
          : style;
      },
    });
    const policy = createSourceControlledContentPolicy(
      fixture.document as unknown as Document,
      fixture.window as unknown as Window,
    );
    expect(policy.targets.get(panel)).toBe('withheld');
    expect(sourceControlledContentMutationsMayChange(
      [attributeRecord(remote, 'data-open')],
      policy,
    )).toBe(false);

    fixture.start();
    expect(JSON.stringify(fixture.checkpoints()[0])).not.toContain(
      'Remote panel payload',
    );
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    remote.setAttribute('data-open', 'true');
    fixture.mutate(attributeRecord(remote, 'data-open'));
    fixture.flushFrame();
    const revealed = fixture.patches().at(-1)!;
    expect(JSON.stringify(revealed)).toContain('Remote panel payload');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, revealed.lastSequence));

    remote.setAttribute('data-open', 'false');
    fixture.mutate(attributeRecord(remote, 'data-open'));
    fixture.flushFrame();
    expect(JSON.stringify(fixture.patches().at(-1))).not.toContain(
      'Remote panel payload',
    );
  });

  it('rematerializes a generic CSS-hidden subtree only across visibility boundaries', () => {
    const fixture = sourceFixture(`<nav><div id="wrapper" class="closed">
      <a id="trigger">About</a>
      <div id="panel">Company and team</div>
    </div></nav><div id="ordinary" class="one">Ordinary</div>`);
    installPaintedMirrorTabFixture(fixture.document, fixture.window);
    const wrapper = fixture.document.querySelector<HTMLElement>('#wrapper')!;
    const panel = fixture.document.querySelector<HTMLElement>('#panel')!;
    const ordinary = fixture.document.querySelector<HTMLElement>('#ordinary')!;
    const baseGetComputedStyle = fixture.window.getComputedStyle
      .bind(fixture.window);
    Object.defineProperty(fixture.window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => {
        const style = baseGetComputedStyle(element);
        return element === panel
          ? {
              ...style,
              display: wrapper.classList.contains('closed') ? 'none' : 'block',
              visibility: 'visible',
            } as unknown as CSSStyleDeclaration
          : style;
      },
    });

    fixture.start();
    expect(JSON.stringify(fixture.checkpoints()[0])).not.toContain(
      'Company and team',
    );
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    wrapper.classList.remove('closed');
    fixture.mutate(attributeRecord(wrapper, 'class'));
    fixture.flushFrame();
    const revealed = fixture.patches().at(-1)!;
    expect(JSON.stringify(revealed)).toContain('Company and team');
    expect(revealed.operations).toContainEqual(expect.objectContaining({
      kind: 'children',
      nodeId: fixture.registry.peekId(panel),
    }));
    fixture.port.emitMessage(createHtmlMirrorAck(
      identity,
      revealed.lastSequence,
    ));

    ordinary.className = 'two';
    fixture.mutate(attributeRecord(ordinary, 'class'));
    fixture.flushFrame();
    expect(fixture.patches().at(-1)?.operations.some(
      ({ kind }) => kind === 'children',
    )).toBe(false);
  });

  it('reads a host\'s shadow root again when the page shows the host (D132)', () => {
    // A web component that shows its menu by `:host([open])`: the host is
    // what appears, and a patch for its children does not carry its root.
    const fixture = sourceFixture(
      '<p>Before</p><x-menu id="host">Light label</x-menu>',
    );
    installPaintedMirrorTabFixture(fixture.document, fixture.window);
    const host = fixture.document.querySelector<HTMLElement>('#host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    Object.defineProperty(shadow, 'mode', { value: 'open' });
    // As Chrome reports it; linkedom calls a shadow root unconnected.
    Object.defineProperty(shadow, 'isConnected', { get: () => host.isConnected });
    shadow.innerHTML = '<ul><li>Shadow item</li></ul>';
    const baseGetComputedStyle = fixture.window.getComputedStyle
      .bind(fixture.window);
    Object.defineProperty(fixture.window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => {
        const style = baseGetComputedStyle(element);
        return element === host
          ? {
              ...style,
              display: host.hasAttribute('open') ? 'block' : 'none',
              visibility: 'visible',
            } as unknown as CSSStyleDeclaration
          : style;
      },
    });

    fixture.start();
    const first = JSON.stringify(fixture.checkpoints()[0]);
    expect(first).not.toContain('Shadow item');
    expect(first).not.toContain('Light label');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    host.setAttribute('open', '');
    fixture.mutate(attributeRecord(host, 'open'));
    fixture.flushFrame();
    // One patch, not a fresh copy of the page.
    expect(fixture.checkpoints()).toHaveLength(1);
    expect(fixture.port.posts.some((message) =>
      (message as { kind?: string }).kind === 'simul:html-mirror-v2:error'))
      .toBe(false);
    const shown = fixture.patches().at(-1)!;
    expect(JSON.stringify(shown)).toContain('Shadow item');
    expect(JSON.stringify(shown)).toContain('Light label');
    expect(shown.operations.filter(({ kind }) => kind === 'children')
      .map((operation) => (operation as { nodeId: number }).nodeId).sort())
      .toEqual([
        fixture.registry.peekId(host)!,
        fixture.registry.peekId(shadow)!,
      ].sort());
    expect(shown.operations).toContainEqual(expect.objectContaining({
      kind: 'attributes',
      nodeId: fixture.registry.peekId(host),
      attributes: expect.arrayContaining([['open', '']]),
    }));
  });

  it("applies the panel's size limits from the start handshake (D64)", () => {
    const fixture = sourceFixture('<p>row</p>'.repeat(1_200));
    try {
      fixture.port.emitMessage(createHtmlMirrorStart(identity, 'conservative', {
        itemMegabytes: 10,
        pageMegabytes: 60,
        maxElements: 1_000,
      }));
      expect(MAX_HTML_MIRROR_NODES).toBe(1_000);
      expect(fixture.checkpoints()).toHaveLength(0);
      expect(fixture.port.posts.at(-1)).toMatchObject({
        kind: 'simul:html-mirror-v2:error',
        code: 'stream_overflow',
      });
    } finally {
      applyHtmlMirrorLimitSettings();
    }
  });

  it('signals recovery when an interaction visibility scan overflows', () => {
    const fixture = sourceFixture(
      '<nav id="large-menu"><a id="trigger">Large menu</a></nav>',
    );
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const nav = fixture.document.querySelector('#large-menu')!;
    // Chunked: linkedom's parser overflows its stack on one huge fragment.
    for (let added = 0; added <= MAX_HTML_MIRROR_NODES; added += 10_000) {
      nav.insertAdjacentHTML('beforeend', '<span></span>'.repeat(10_000));
    }

    fixture.document.querySelector('#trigger')?.dispatchEvent(
      new fixture.window.Event('pointerover', { bubbles: true }),
    );
    fixture.flushFrame();

    expect(fixture.port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v2:error',
      code: 'stream_gap',
    });
    expect(fixture.frames).toHaveLength(0);
  });

  it('streams the current computed canvas color with live layout patches', () => {
    const fixture = sourceFixture('<main>theme-aware page</main>');
    let canvasColor = 'rgb(0, 0, 0)';
    Object.defineProperty(fixture.window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => ({
        backgroundColor: element === fixture.document.documentElement
          ? canvasColor
          : 'rgba(0, 0, 0, 0)',
        getPropertyValue: () => '',
      }),
    });

    fixture.start();
    expect(fixture.checkpoints()[0]?.payload.root.canvasBackgroundColor)
      .toBe('rgb(0, 0, 0)');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    canvasColor = 'rgb(16, 16, 16)';
    const body = fixture.document.body;
    body.className = 'dark-theme';
    fixture.mutate(attributeRecord(body, 'class'));
    fixture.flushFrame();
    expect(fixture.patches().at(-1)?.operations).toContainEqual({
      kind: 'dimensions',
      viewportWidth: 1,
      viewportHeight: 1,
      documentWidth: 1,
      documentHeight: 1,
      canvasBackgroundColor: 'rgb(16, 16, 16)',
    });

    fixture.port.emitMessage(createHtmlMirrorAck(identity, 1));
    canvasColor = 'rgba(0, 0, 0, 0)';
    body.className = 'light-theme';
    fixture.mutate(attributeRecord(body, 'class'));
    fixture.flushFrame();
    const transparentDimensions = fixture.patches().at(-1)?.operations.find(
      ({ kind }) => kind === 'dimensions',
    );
    expect(transparentDimensions).toEqual({
      kind: 'dimensions',
      viewportWidth: 1,
      viewportHeight: 1,
      documentWidth: 1,
      documentHeight: 1,
    });
  });

  it('reads the document\'s language again whenever Chrome may have read a pragma', () => {
    const fixture = sourceFixture('<p id="p" class="a">Text</p>');
    const { document } = fixture;
    const root = document.documentElement as unknown as Element;
    const pragma = document.createElement('meta');
    pragma.setAttribute('http-equiv', 'content-language');
    pragma.setAttribute('content', 'de');
    document.head.append(pragma);
    // What the page's Chrome says for the document's language.
    let locale = '"de"';
    Object.defineProperty(fixture.window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => ({
        backgroundColor: 'rgba(0, 0, 0, 0)',
        getPropertyValue: (name: string) =>
          name === '-webkit-locale' && element === root ? locale : '',
      }),
    });
    (root as { matches: (selector: string) => boolean }).matches = () => true;
    const rootLanguages = (): (string | undefined)[] => fixture.patches().flatMap(
      (batch) => batch.operations.flatMap((operation) =>
        operation.kind === 'attributes' && operation.tagName === 'html'
          ? [Object.fromEntries(operation.attributes)['simul:document-lang']]
          : []),
    );

    fixture.start();
    expect(fixture.checkpoints()[0]?.payload.root.attributes)
      .toEqual([['simul:document-lang', 'de']]);
    // No pragma of the page's is on the wire.
    expect(JSON.stringify(fixture.port.posts)).not.toContain('http-equiv');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    // The page writes the pragma again with the value it has. No attribute
    // changed, but Chrome read it, and may now say another language (an
    // earlier pragma written again takes over from a later one).
    locale = '"es"';
    fixture.mutate({
      type: 'attributes', target: pragma, attributeName: 'content',
      attributeNamespace: null, oldValue: 'de',
    } as unknown as MutationRecord);
    fixture.flushFrame();
    expect(rootLanguages()).toEqual(['es']);
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 1));

    // Read again and the same answer: nothing is sent.
    fixture.mutate({
      type: 'attributes', target: pragma, attributeName: 'content',
      attributeNamespace: null, oldValue: 'de',
    } as unknown as MutationRecord);
    fixture.flushFrame();
    expect(fixture.patches()).toHaveLength(1);

    // A pragma put into the document, here inside something else.
    locale = '"ja"';
    const wrapper = document.createElement('div');
    wrapper.append(document.createElement('meta'));
    document.body.append(wrapper);
    fixture.mutate(childListRecord(document.body, [wrapper]));
    fixture.flushFrame();
    expect(rootLanguages()).toEqual(['es', 'ja']);
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 2));

    // Any other change does not have Chrome asked: nothing about the
    // document's language can have changed.
    locale = '"fr"';
    const paragraph = document.getElementById('p')!;
    paragraph.setAttribute('class', 'b');
    fixture.mutate(attributeRecord(paragraph, 'class'));
    const text = document.createTextNode('more');
    paragraph.append(text);
    fixture.mutate(childListRecord(paragraph, [text]));
    fixture.flushFrame();
    expect(fixture.patches()).toHaveLength(3);
    expect(rootLanguages()).toEqual(['es', 'ja']);
  });

  it('removes stale local text when an ID becomes unindexable', () => {
    const fixture = sourceFixture(
      '<main><section id="changing">Previously readable</section>' +
      '<section id="ordinary">Still ordinary</section></main>',
    );
    fixture.start();
    expect(JSON.stringify(fixture.checkpoints()[0])).toContain('Previously readable');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const changing = fixture.document.querySelector('#changing')!;
    const changingNodeId = fixture.registry.peekId(changing);

    changing.setAttribute('id', `oversized-${'x'.repeat(16 * 1_024)}`);
    fixture.mutate(attributeRecord(changing, 'id'));
    fixture.flushFrame();
    const patch = fixture.patches().at(-1)!;
    expect(patch.operations).toContainEqual(expect.objectContaining({
      kind: 'children',
      nodeId: changingNodeId,
    }));
    expect(JSON.stringify(patch)).not.toContain('Previously readable');
    expect(patch.operations.some(
      (operation) => operation.kind === 'children' &&
        operation.nodeId === fixture.registry.peekId(
          fixture.document.querySelector('#ordinary')!,
        ),
    )).toBe(false);
  });

  it('requests a checkpoint when a root-wide ID fail-closed boundary flips', () => {
    const fixture = sourceFixture(`
      <div id="trigger" role="tab" aria-selected="true"
        aria-controls="panel">Tab</div>
      <section id="panel" role="tabpanel">Readable panel</section>
      <p id="ordinary">Ordinary ID text</p>
    `);
    installPaintedMirrorTabFixture(fixture.document, fixture.window);
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const trigger = fixture.document.querySelector('#trigger')!;

    trigger.setAttribute('aria-controls', 'x'.repeat((1 * 1_024 * 1_024) + 1));
    fixture.mutate(attributeRecord(trigger, 'aria-controls'));
    expect(fixture.frames).toHaveLength(0);
    expect(fixture.port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v2:error',
      code: 'stream_gap',
    });
  });

  it('never reads silent control values while still mirroring structural secret transitions', () => {
    const fixture = sourceFixture(`
      <form><input id="query" class="wide" type="search" value="initial" placeholder=""
        name="private-name" data-account="private-data"></form>
    `);
    fixture.start();
    const checkpointJson = JSON.stringify(fixture.checkpoints()[0]);
    expect(checkpointJson).not.toContain('"text":"initial"');
    expect(checkpointJson).toContain('["class","wide"]');
    expect(checkpointJson).not.toContain('private-name');
    // A text input's data attributes are page markup and travel (D76).
    expect(checkpointJson).toContain('["data-account","private-data"]');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const control = fixture.document.querySelector<HTMLInputElement>('#query')!;

    control.value = 'programmatic update';
    fixture.runTimer();
    expect(fixture.frames).toHaveLength(0);
    expect(fixture.patches()).toHaveLength(0);

    // This models the silent value change performed by the form-reset default
    // action after its reset event has already fired.
    control.value = 'initial';
    fixture.runTimer();
    expect(fixture.frames).toHaveLength(0);

    control.type = 'password';
    fixture.mutate(attributeRecord(control, 'type'));
    expect(fixture.frames).toHaveLength(0);
    expect(fixture.patches()).toHaveLength(0);
    expect(fixture.port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v2:error',
      code: 'stream_gap',
    });

    fixture.port.emitMessage(createHtmlMirrorCheckpointRequest(identity, 0));
    const recoveryJson = JSON.stringify(fixture.checkpoints().at(-1));
    // The credential input is drawn as its empty field (D76): only what
    // draws the box travels.
    expect(recoveryJson).not.toContain('opaquePlaceholder');
    expect(recoveryJson).toContain(
      '"tagName":"input","attributes":[["id","query"],["class","wide"],["type","password"]]',
    );
    expect(recoveryJson).not.toContain('controlText');
    expect(recoveryJson).not.toContain('initial');
    expect(recoveryJson).not.toContain('private-name');
    expect(recoveryJson).not.toContain('private-data');

    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const postCount = fixture.port.posts.length;
    control.type = 'search';
    fixture.mutate(attributeRecord(control, 'type'));
    expect(fixture.port.posts).toHaveLength(postCount);
    expect(fixture.frames).toHaveLength(1);
    fixture.flushFrame();
    expect(fixture.port.posts).toHaveLength(postCount);
  });

  it('rebuilds computed secret transitions and then ignores the opaque subtree', () => {
    const fixture = sourceFixture(
      '<main><section id="account"><span id="label">public before masking</span></section></main>',
    );
    const account = fixture.document.querySelector<HTMLElement>('#account')!;
    const label = fixture.document.querySelector<HTMLElement>('#label')!;
    let masked = false;
    Object.defineProperty(fixture.window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => ({
        backgroundColor: 'rgba(0, 0, 0, 0)',
        getPropertyValue: (name: string) =>
          name === '-webkit-text-security' && masked && element === account
            ? 'disc'
            : '',
      }),
    });

    fixture.start();
    expect(JSON.stringify(fixture.checkpoints()[0])).toContain(
      'public before masking',
    );
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    masked = true;
    account.className = 'masked';
    fixture.mutate(attributeRecord(account, 'class'));
    expect(fixture.frames).toHaveLength(0);
    expect(fixture.port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v2:error',
      code: 'stream_gap',
    });

    fixture.port.emitMessage(createHtmlMirrorCheckpointRequest(identity, 0));
    const recoveryJson = JSON.stringify(fixture.checkpoints().at(-1));
    expect(recoveryJson).toContain('opaquePlaceholder');
    expect(recoveryJson).not.toContain('public before masking');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    const postCount = fixture.port.posts.length;
    label.textContent = 'private after masking';
    fixture.mutate(childListRecord(label, [...label.childNodes]));
    expect(fixture.port.posts).toHaveLength(postCount);
    expect(fixture.frames).toHaveLength(1);
    fixture.flushFrame();
    expect(fixture.port.posts).toHaveLength(postCount);
  });

  it('flushes remote visibility changes caused inside an opaque secret', () => {
    const fixture = sourceFixture(`
      <section id="secret" autocomplete="one-time-code">
        <span id="marker" class="closed">private marker</span>
      </section>
      <aside id="remote-panel">Remote public panel</aside>
    `);
    installPaintedMirrorTabFixture(fixture.document, fixture.window);
    const marker = fixture.document.querySelector<HTMLElement>('#marker')!;
    const panel = fixture.document.querySelector<HTMLElement>('#remote-panel')!;
    const baseGetComputedStyle = fixture.window.getComputedStyle
      .bind(fixture.window);
    Object.defineProperty(fixture.window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => {
        const style = baseGetComputedStyle(element);
        return element === panel
          ? {
              ...style,
              display: marker.classList.contains('open') ? 'block' : 'none',
            } as unknown as CSSStyleDeclaration
          : style;
      },
    });

    fixture.start();
    const checkpointJson = JSON.stringify(fixture.checkpoints()[0]);
    expect(checkpointJson).not.toContain('private marker');
    expect(checkpointJson).not.toContain('Remote public panel');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    marker.className = 'open';
    fixture.mutate(attributeRecord(marker, 'class'));
    expect(fixture.frames).toHaveLength(1);
    fixture.flushFrame();

    const patchJson = JSON.stringify(fixture.patches().at(-1));
    expect(patchJson).toContain('Remote public panel');
    expect(patchJson).not.toContain('private marker');
  });

  it('keeps content extracted from an opaque ancestor secret in public additions', () => {
    const canary = 'opaque-ancestor-move-secret';
    const fixture = sourceFixture(
      `<section id="secret"><span id="payload">${canary}</span></section>` +
      '<main id="public"></main>',
    );
    const secret = fixture.document.querySelector('#secret')!;
    const payload = fixture.document.querySelector('#payload')!;
    const publicTarget = fixture.document.querySelector('#public')!;

    fixture.start();
    expect(JSON.stringify(fixture.checkpoints()[0])).toContain(canary);
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    secret.setAttribute('autocomplete', 'one-time-code');
    fixture.mutate(attributeRecord(secret, 'autocomplete'));
    expect(fixture.port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v2:error',
      code: 'stream_gap',
    });
    fixture.port.emitMessage(createHtmlMirrorCheckpointRequest(identity, 0));
    expect(JSON.stringify(fixture.checkpoints().at(-1))).not.toContain(canary);
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    publicTarget.append(payload);
    fixture.mutate(childListRecord(secret, [], [payload]));
    fixture.mutate(childListRecord(publicTarget, [payload]));
    expect(fixture.frames).toHaveLength(1);
    fixture.flushFrame();

    const patchJson = JSON.stringify(fixture.patches().at(-1));
    expect(patchJson).toContain('simul-opaque-region-');
    expect(patchJson).not.toContain(canary);
  });

  it('streams native select structure without state, labels, or submission data', () => {
    const fixture = sourceFixture(`
      <select id="facility" size="4" name="private-name" data-account="private-data">
        <option value="private-a">Choose</option>
        <optgroup id="area" label="District">
          <option value="private-b" selected>Community center</option>
        </optgroup>
      </select>
    `);
    fixture.start('passive');
    const initial = fixture.checkpoints()[0]!;
    expect(JSON.stringify(initial)).not.toContain('selectedOptionIndexes');
    expect(JSON.stringify(initial)).not.toContain('["size","4"]');
    expect(JSON.stringify(initial)).not.toContain('District');
    expect(JSON.stringify(initial)).not.toContain('Community center');
    expect(JSON.stringify(initial)).not.toContain('private-name');
    expect(JSON.stringify(initial)).not.toContain('private-data');
    expect(JSON.stringify(initial)).not.toContain('private-a');
    expect(JSON.stringify(initial)).not.toContain('private-b');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    const select = fixture.document.querySelector<HTMLSelectElement>('#facility')!;
    // linkedom models selectedness through the content attribute; the browser
    // path is driven by this same change event without transporting it.
    select.options[0]!.setAttribute('selected', '');
    select.options[1]!.removeAttribute('selected');
    select.dispatchEvent(new fixture.window.Event('change', { bubbles: true }));
    expect(fixture.frames).toHaveLength(1);
    fixture.flushFrame();
    expect(fixture.patches()).toHaveLength(0);

    const area = fixture.document.querySelector('#area')!;
    const patchesBeforeSemanticLabel = fixture.patches().length;
    area.setAttribute('label', 'Neighborhood');
    fixture.mutate(attributeRecord(area, 'label'));
    fixture.flushFrame();
    expect(fixture.patches()).toHaveLength(patchesBeforeSemanticLabel);
  });

  it('atomically clears public labels when a select becomes private', () => {
    const fixture = sourceFixture(
      '<select id="picker"><option selected>Public choice</option></select>',
    );
    fixture.start('passive');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const select = fixture.document.querySelector('#picker')!;

    select.setAttribute('role', 'textbox');
    fixture.mutate(attributeRecord(select, 'role'));
    fixture.flushFrame();
    const patch = fixture.patches().at(-1)!;
    const structural = patch.operations[0];
    const attributes = patch.operations[1];

    expect(structural).toMatchObject({
      kind: 'children',
      children: [expect.objectContaining({
        kind: 'element',
        tagName: 'option',
        children: [],
      })],
    });
    expect(attributes).toMatchObject({
      kind: 'attributes',
      tagName: 'select',
      attributes: expect.arrayContaining([['role', 'textbox']]),
    });
    expect(attributes).not.toHaveProperty('selectedOptionIndexes');
    expect(JSON.stringify(patch)).not.toContain('Public choice');
  });

  it('leaves silent select-label changes to the semantic channel', () => {
    const fixture = sourceFixture(
      '<select><option selected>Visible choice</option></select>',
    );
    fixture.start('passive');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    fixture.document.querySelector('option')!.setAttribute('hidden', '');

    fixture.runTimer();
    expect(fixture.frames).toHaveLength(0);
    expect(fixture.patches()).toHaveLength(0);
  });

  it('streams inserted option structure while labels and picker state stay semantic-only', () => {
    const fixture = sourceFixture(`
      <select id="picker"><option selected>First choice</option></select>
    `);
    const select = fixture.document.querySelector<HTMLSelectElement>('#picker')!;
    fixture.start('passive');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    const inserted = fixture.document.createElement('option');
    inserted.textContent = 'Second choice';
    select.append(inserted);
    fixture.mutate(childListRecord(select, [inserted]));
    fixture.flushFrame();
    const insertion = fixture.patches().at(-1)!;
    expect(insertion.operations.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(['reconcile-children']),
    );
    expect(JSON.stringify(insertion)).not.toContain('Second choice');
    expect(JSON.stringify(insertion)).not.toContain('stream_overflow');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 1));

    const insertedText = inserted.firstChild as Text;
    const patchesBeforeLabelChange = fixture.patches().length;
    insertedText.nodeValue = 'Updated choice';
    fixture.mutate(characterDataRecord(insertedText));
    fixture.flushFrame();
    expect(fixture.patches()).toHaveLength(patchesBeforeLabelChange);

    const patchesBeforeToggle = fixture.patches().length;
    select.dispatchEvent(new fixture.window.Event('toggle', { bubbles: true }));
    expect(fixture.frames).toHaveLength(1);
    fixture.flushFrame();
    expect(fixture.patches()).toHaveLength(patchesBeforeToggle);
  });

  it('sends a change inside a dropdown as a change to the dropdown itself (D132)', () => {
    const fixture = sourceFixture(`
      <select id="picker"><optgroup id="area" label="District">
        <option id="first">Community center</option>
      </optgroup></select>
    `);
    fixture.start('passive');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const select = fixture.document.querySelector('#picker')!;
    const area = fixture.document.querySelector('#area')!;
    const first = fixture.document.querySelector('#first')!;
    const selectId = fixture.registry.peekId(select)!;

    // A new option in a group: the panel takes no patch for the group.
    const added = fixture.document.createElement('option');
    added.textContent = 'Library';
    area.append(added);
    fixture.mutate(childListRecord(area, [added]));
    fixture.flushFrame();
    const insertion = fixture.patches().at(-1)!;
    expect(insertion.operations.filter(({ kind }) =>
      kind === 'children' || kind === 'reconcile-children'))
      .toEqual([expect.objectContaining({ nodeId: selectId })]);
    expect(JSON.stringify(insertion)).toContain(
      `"id":${fixture.registry.peekId(added)}`,
    );
    expect(JSON.stringify(insertion)).not.toContain('Library');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 1));

    // An option's own text is its label, which the base graph never carries:
    // replacing it sends nothing.
    const patchesBeforeLabel = fixture.patches().length;
    const text = fixture.document.createTextNode('Community centre');
    const old = first.firstChild!;
    first.replaceChildren(text);
    fixture.mutate(childListRecord(first, [text], [old]));
    fixture.flushFrame();
    expect(fixture.patches()).toHaveLength(patchesBeforeLabel);
  });

  it('holds a dropdown\'s options flat though the page wraps them, and follows changes inside a wrapper (D135)', () => {
    const fixture = sourceFixture(`
      <select id="picker">
        <div id="wrap"><option id="one">One</option><option id="two">Two</option></div>
        <optgroup id="group" label="Group"><span id="inner"><option id="three">Three</option><optgroup id="nested" label="Nested"><option id="four">Four</option></optgroup></span></optgroup>
      </select>
    `);
    fixture.start('passive');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const byId = (id: string): Element => fixture.document.querySelector(`#${id}`)!;
    const select = byId('picker');
    const id = (node: Node): number => fixture.registry.peekId(node)!;
    interface Graph { readonly id: number; readonly tagName?: string; readonly children?: readonly Graph[] }
    const find = (node: Graph, wanted: number): Graph | undefined =>
      node.id === wanted
        ? node
        : (node.children ?? []).map((child) => find(child, wanted)).find(Boolean);
    const shape = (node: Graph | undefined): unknown =>
      (node?.children ?? []).map((child) => child.tagName === 'optgroup'
        ? [child.id, (child.children ?? []).map((nested) => nested.id)]
        : child.id);

    // Options and groups only, in the page's order: no wrapper travels, and
    // the option of a group inside a group is the outer group's.
    const first = find(fixture.checkpoints()[0]!.payload.root as Graph, id(select));
    expect(shape(first)).toEqual([
      id(byId('one')), id(byId('two')),
      [id(byId('group')), [id(byId('three')), id(byId('four'))]],
    ]);
    expect(fixture.registry.peekId(byId('nested'))).toBeUndefined();
    expect(JSON.stringify(fixture.checkpoints()[0])).not.toContain('"tagName":"div"');
    expect(fixture.registry.peekId(byId('wrap'))).toBeUndefined();

    // An option added inside the wrapper is a change to the dropdown.
    const added = fixture.document.createElement('option');
    added.textContent = 'Added';
    byId('wrap').append(added);
    fixture.mutate(childListRecord(byId('wrap'), [added]));
    fixture.flushFrame();
    expect(fixture.checkpoints()).toHaveLength(1);
    const insertion = fixture.patches().at(-1)!;
    expect(insertion.operations.filter(({ kind }) =>
      kind === 'children' || kind === 'reconcile-children'))
      .toEqual([expect.objectContaining({ nodeId: id(select) })]);
    expect(JSON.stringify(insertion)).toContain(`"id":${id(added)}`);
    expect(JSON.stringify(insertion)).not.toContain('Added');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 1));

    // One added inside a wrapper inside a group, too.
    const deeper = fixture.document.createElement('option');
    byId('inner').append(deeper);
    fixture.mutate(childListRecord(byId('inner'), [deeper]));
    fixture.flushFrame();
    expect(fixture.checkpoints()).toHaveLength(1);
    expect(JSON.stringify(fixture.patches().at(-1))).toContain(`"id":${id(deeper)}`);
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 2));

    // An option added to the dropdown itself, beside the wrapper, and one
    // inside a wrapper that is new: the options the mirror holds are kept.
    const direct = fixture.document.createElement('option');
    select.append(direct);
    fixture.mutate(childListRecord(select, [direct]));
    fixture.flushFrame();
    expect(fixture.checkpoints()).toHaveLength(1);
    expect(fixture.patches().at(-1)!.operations).toEqual([
      expect.objectContaining({ kind: 'reconcile-children', nodeId: id(select) }),
    ]);
    expect(JSON.stringify(fixture.patches().at(-1))).toContain(`"id":${id(direct)}`);
    expect(JSON.stringify(fixture.patches().at(-1))).toContain(
      `{"kind":"retain","nodeId":${id(byId('one'))}}`,
    );
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 3));
    const lateWrap = fixture.document.createElement('div');
    const wrapped = fixture.document.createElement('option');
    lateWrap.append(wrapped);
    select.append(lateWrap);
    fixture.mutate(childListRecord(select, [lateWrap]));
    fixture.flushFrame();
    expect(fixture.checkpoints()).toHaveLength(1);
    expect(fixture.patches().at(-1)!.operations).toEqual([
      expect.objectContaining({ kind: 'reconcile-children', nodeId: id(select) }),
    ]);
    expect(JSON.stringify(fixture.patches().at(-1))).toContain(`"id":${id(wrapped)}`);
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 4));

    // The page takes the wrapper away and leaves its options in the dropdown:
    // the same options, so nothing is rebuilt.
    const wrap = byId('wrap');
    const moved = [...wrap.children];
    select.prepend(...moved);
    wrap.remove();
    fixture.mutateAll([
      childListRecord(wrap, [], moved),
      childListRecord(select, moved, [wrap]),
    ]);
    fixture.flushFrame();
    expect(fixture.checkpoints()).toHaveLength(1);
    expect(fixture.port.posts.at(-1)).not.toMatchObject({
      kind: 'simul:html-mirror-v2:error',
    });

    // An option's own text, inside a wrapper or not, is its label: the base
    // graph never carries it.
    const patches = fixture.patches().length;
    const text = fixture.document.createTextNode('Renamed');
    const old = deeper.firstChild;
    deeper.replaceChildren(text);
    fixture.mutate(childListRecord(deeper, [text], old ? [old] : []));
    if (fixture.frames.length > 0) fixture.flushFrame();
    expect(fixture.patches()).toHaveLength(patches);
  });

  it('does not route optgroup legend text through the base graph', () => {
    const fixture = sourceFixture(`
      <select><optgroup><legend>Original group</legend>
        <option>Public choice</option>
      </optgroup></select>
    `);
    fixture.start('passive');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const legendText = fixture.document.querySelector('legend')!.firstChild as Text;
    const patchesBeforeLegendChange = fixture.patches().length;
    legendText.nodeValue = 'Updated group';
    fixture.mutate(characterDataRecord(legendText));
    fixture.flushFrame();

    expect(fixture.patches()).toHaveLength(patchesBeforeLegendChange);
  });

  it('emits bounded capacity diagnostics when checkpoint serialization overflows', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      WeakNodeIdRegistry,
      'MAX_TRACKED_NODES',
    )!;
    try {
      Object.defineProperty(WeakNodeIdRegistry, 'MAX_TRACKED_NODES', {
        ...descriptor,
        value: 1,
      });
      const fixture = sourceFixture('<main>capacity source text</main>');

      fixture.start();

      expect(fixture.checkpoints()).toHaveLength(0);
      expect(fixture.port.posts.at(-1)).toMatchObject({
        kind: 'simul:html-mirror-v2:error',
        code: 'stream_overflow',
        representability: {
          capacityOmissionCount: 1,
        },
      });
      expect(JSON.stringify(
        (fixture.port.posts.at(-1) as { representability: unknown })
          .representability,
      )).not.toContain('capacity source text');
    } finally {
      Object.defineProperty(
        WeakNodeIdRegistry,
        'MAX_TRACKED_NODES',
        descriptor,
      );
    }
  });

  it('emits bounded capacity diagnostics when a new-child patch overflows', () => {
    const fixture = sourceFixture('<main id="target"><span>retained</span></main>');
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const descriptor = Object.getOwnPropertyDescriptor(
      WeakNodeIdRegistry,
      'MAX_TRACKED_NODES',
    )!;
    try {
      Object.defineProperty(WeakNodeIdRegistry, 'MAX_TRACKED_NODES', {
        ...descriptor,
        value: fixture.registry.trackedNodeCount,
      });
      const target = fixture.document.querySelector('#target')!;
      const added = fixture.document.createElement('aside');
      added.textContent = 'capacity patch text';
      target.append(added);
      fixture.mutate(childListRecord(target, [added]));

      fixture.flushFrame();

      expect(fixture.patches()).toHaveLength(0);
      expect(fixture.port.posts.at(-1)).toMatchObject({
        kind: 'simul:html-mirror-v2:error',
        code: 'stream_overflow',
        representability: {
          capacityOmissionCount: 1,
        },
      });
      expect(JSON.stringify(
        (fixture.port.posts.at(-1) as { representability: unknown })
          .representability,
      )).not.toContain('capacity patch text');
    } finally {
      Object.defineProperty(
        WeakNodeIdRegistry,
        'MAX_TRACKED_NODES',
        descriptor,
      );
    }
  });

  it('resanitizes descendants in the same batch when privacy roles enter and leave', () => {
    const fixture = sourceFixture('<main id="target"><span>public value</span></main>');
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const target = fixture.document.querySelector('#target')!;

    target.setAttribute('role', 'textbox');
    fixture.mutate(attributeRecord(target, 'role'));
    fixture.flushFrame();
    const privatePatch = fixture.patches().at(-1)!;
    expect(privatePatch.operations.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(['attributes', 'children']),
    );
    expect(privatePatch.representability.attributeContextFallbackCount).toBe(1);
    expect(JSON.stringify(privatePatch)).not.toContain('public value');

    fixture.port.emitMessage(createHtmlMirrorAck(identity, 1));
    target.removeAttribute('role');
    fixture.mutate(attributeRecord(target, 'role'));
    fixture.flushFrame();
    const publicPatch = fixture.patches().at(-1)!;
    expect(publicPatch.operations.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(['attributes', 'children']),
    );
    expect(JSON.stringify(publicPatch)).toContain('public value');
  });

  it('streams activation labels, their author attributes and static logos (D76)', () => {
    const fixture = sourceFixture(`
      <button id="primary-action" data-account="checkpoint-button-secret">
        <span id="action-label" title="checkpoint-title-secret" data-user="checkpoint-data-secret">公開資料を検索する</span>
      </button>
      <section id="companies" role="button">
        <span id="company" title="checkpoint-company-secret">Sample Studio</span>
      </section>
      <img id="sample-logo">
    `);
    installPaintedMirrorTabFixture(
      fixture.document,
      fixture.window as unknown as Window,
    );
    fixture.start();

    const checkpointJson = JSON.stringify(fixture.checkpoints()[0]);
    expect(checkpointJson).toContain('公開資料を検索する');
    expect(checkpointJson).toContain('Sample Studio');
    // `data-*` and `title` inside buttons are page markup and travel (D76).
    expect(checkpointJson).toContain('checkpoint-button-secret');
    expect(checkpointJson).toContain('checkpoint-title-secret');
    expect(checkpointJson).toContain('checkpoint-data-secret');
    expect(checkpointJson).toContain('checkpoint-company-secret');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    const actionLabel = fixture.document.querySelector('#action-label')!;
    const actionText = actionLabel.firstChild as Text;
    actionText.nodeValue = '詳細を見る　＞';
    actionLabel.setAttribute('title', 'patch-title-secret');
    actionLabel.setAttribute('data-user', 'patch-data-secret');
    const company = fixture.document.querySelector('#company')!;
    const companyText = company.firstChild as Text;
    companyText.nodeValue = 'Example Workshop';
    company.setAttribute('title', 'patch-company-secret');
    const logo = fixture.document.querySelector('#sample-logo')!;
    logo.setAttribute('src', SYNTHETIC_STATIC_LOGO);

    fixture.mutate(characterDataRecord(actionText));
    fixture.mutate(attributeRecord(actionLabel, 'title'));
    fixture.mutate(attributeRecord(actionLabel, 'data-user'));
    fixture.mutate(characterDataRecord(companyText));
    fixture.mutate(attributeRecord(company, 'title'));
    fixture.mutate(attributeRecord(logo, 'src'));
    fixture.flushFrame();

    const patchJson = JSON.stringify(fixture.patches().at(-1));
    expect(patchJson).toContain('詳細を見る　＞');
    expect(patchJson).toContain('Example Workshop');
    expect(patchJson).toContain(SYNTHETIC_STATIC_LOGO);
    expect(patchJson).toContain('patch-title-secret');
    expect(patchJson).toContain('patch-data-secret');
    expect(patchJson).toContain('patch-company-secret');
  });

  it('keeps data srcset payloads local in live attribute patches', () => {
    const fixture = sourceFixture('<main><img id="target"></main>');
    installPaintedMirrorTabFixture(
      fixture.document,
      fixture.window as unknown as Window,
    );
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const target = fixture.document.querySelector('#target')!;

    target.setAttribute(
      'srcset',
      'data:image/png;base64,AAAA 1x, /updated.png 2x',
    );
    fixture.mutate(attributeRecord(target, 'srcset'));
    fixture.flushFrame();

    const patchJson = JSON.stringify(fixture.patches().at(-1));
    expect(patchJson).toContain(
      'data:image/png;base64,AAAA 1x, https://example.test/updated.png 2x',
    );
    expect(patchJson).not.toContain('https://example.test/AAAA');
  });

  it('refreshes image state on load/error and currentSrc changes without looping', () => {
    const fixture = sourceFixture(
      '<main><img id="light" src="/fallback.jpg"><x-card id="host"></x-card></main>',
    );
    const light = fixture.document.querySelector('#light')!;
    const host = fixture.document.querySelector('#host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    Object.defineProperty(shadow, 'mode', { value: 'open' });
    const shadowImage = fixture.document.createElement('img');
    shadowImage.setAttribute('src', '/shadow-fallback.jpg');
    shadow.append(shadowImage);
    Object.defineProperty(light, 'currentSrc', {
      configurable: true,
      value: 'https://example.test/fallback.jpg',
    });
    Object.defineProperty(shadowImage, 'currentSrc', {
      configurable: true,
      value: 'https://example.test/shadow-fallback.jpg',
    });

    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    const patchesBeforeUnchangedError = fixture.patches().length;
    light.dispatchEvent(new fixture.window.Event('error', { bubbles: true }));
    fixture.flushFrame();
    expect(fixture.patches()).toHaveLength(patchesBeforeUnchangedError);

    Object.defineProperty(shadowImage, 'currentSrc', {
      configurable: true,
      value: 'https://example.test/shadow-selected.jpg',
    });
    shadowImage.dispatchEvent(new fixture.window.Event('load', { bubbles: true }));
    fixture.flushFrame();
    expect(JSON.stringify(fixture.patches().at(-1))).toContain(
      'https://example.test/shadow-selected.jpg',
    );
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 1));

    Object.defineProperty(light, 'currentSrc', {
      configurable: true,
      value: 'https://example.test/light-selected.jpg',
    });
    fixture.window.dispatchEvent(new fixture.window.Event('resize'));
    fixture.flushFrame();
    expect(JSON.stringify(fixture.patches().at(-1))).toContain(
      'https://example.test/light-selected.jpg',
    );
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 2));

    const patchesBeforeSettledResize = fixture.patches().length;
    fixture.window.dispatchEvent(new fixture.window.Event('resize'));
    fixture.flushFrame();
    expect(fixture.patches()).toHaveLength(patchesBeforeSettledResize);
  });

  it('ignores mutations below an intentionally omitted mirror ancestor', () => {
    const fixture = sourceFixture('<main>shown</main><script>omitted secret</script>');
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const omitted = fixture.document.querySelector('script')!.firstChild as Text;
    // Simulate another page-owned subsystem assigning an ID. Mirror ownership,
    // not registry presence alone, decides whether a patch may be emitted.
    fixture.registry.getId(omitted);
    const patchesBeforeOmittedMutation = fixture.patches().length;
    omitted.nodeValue = 'changed omitted secret';
    fixture.mutate(characterDataRecord(omitted));
    fixture.flushFrame();

    expect(fixture.patches()).toHaveLength(patchesBeforeOmittedMutation);
    expect(JSON.stringify(fixture.port.posts)).not.toContain('changed omitted secret');
  });

  it('suppresses unchanged sanitized attributes and text', () => {
    const fixture = sourceFixture(
      '<main id="target" class="Stable">same</main>',
    );
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const target = fixture.document.querySelector('#target')!;
    const text = target.firstChild as Text;

    target.setAttribute('onclick', 'ignored()');
    fixture.mutate(attributeRecord(target, 'onclick'));
    fixture.flushFrame();
    expect(fixture.patches()).toHaveLength(0);

    target.setAttribute('class', 'Stable');
    fixture.mutate(attributeRecord(target, 'class'));
    fixture.flushFrame();
    expect(fixture.patches()).toHaveLength(0);

    text.nodeValue = 'same';
    fixture.mutate(characterDataRecord(text));
    fixture.flushFrame();
    expect(fixture.patches()).toHaveLength(0);

    target.setAttribute('class', 'Changed');
    fixture.mutate(attributeRecord(target, 'class'));
    fixture.flushFrame();
    expect(fixture.patches()).toHaveLength(1);
    expect(JSON.stringify(fixture.patches()[0])).toContain('Changed');
  });

  it('does not overflow on bulk same-value attribute housekeeping', () => {
    const fixture = sourceFixture(
      `<main>${'<span class="stable"></span>'.repeat(4_001)}</main>`,
    );
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const records = [...fixture.document.querySelectorAll('span')].map(
      (target) => ({
        type: 'attributes',
        target,
        attributeName: 'class',
        attributeNamespace: null,
        oldValue: 'stable',
      } as unknown as MutationRecord),
    );

    fixture.mutateAll(records);

    expect(fixture.port.posts).not.toContainEqual(expect.objectContaining({
      kind: 'simul:html-mirror-v2:error',
      code: 'stream_overflow',
    }));
    expect(fixture.patches()).toHaveLength(0);
  });

  it('omits embedded frame surfaces from checkpoints and later mutations', () => {
    const fixture = sourceFixture('<main id="page"><p>top document</p></main>');
    const page = fixture.document.querySelector('#page')!;
    const iframe = fixture.document.createElement('iframe');
    iframe.setAttribute('src', 'https://frame.invalid/initial');
    iframe.append(fixture.document.createTextNode('initial iframe secret'));
    const frame = fixture.document.createElement('frame');
    frame.setAttribute('src', 'https://frame.invalid/legacy');
    frame.append(fixture.document.createTextNode('initial frame secret'));
    page.append(iframe, frame);

    fixture.start();
    const checkpointJson = JSON.stringify(fixture.checkpoints()[0]);
    expect(checkpointJson).toContain('top document');
    expect(checkpointJson).not.toContain('"tagName":"iframe"');
    expect(checkpointJson).not.toContain('"tagName":"frame"');
    expect(checkpointJson).not.toContain('frame.invalid');
    expect(checkpointJson).not.toContain('iframe secret');
    expect(checkpointJson).not.toContain('frame secret');
    expect(fixture.checkpoints()[0]?.payload.representability).toMatchObject({
      unsafeElementOmissionCount: 2,
    });
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    const added = fixture.document.createElement('iframe');
    added.setAttribute('srcdoc', '<p>dynamic frame secret</p>');
    added.append(fixture.document.createTextNode('dynamic frame secret'));
    page.append(added);
    const patchesBeforeOmittedFrame = fixture.patches().length;
    fixture.mutate(childListRecord(page, [added]));
    fixture.flushFrame();

    expect(fixture.patches()).toHaveLength(patchesBeforeOmittedFrame);
    expect(JSON.stringify(fixture.port.posts)).not.toContain('dynamic frame secret');

    const foreign = parseHTML('<html><body>foreign frame secret</body></html>');
    const foreignText = foreign.document.body.firstChild as Text;
    const scheduledBeforeForeignMutation = fixture.frames.length;
    const postsBeforeForeignMutation = fixture.port.posts.length;
    fixture.mutate(characterDataRecord(foreignText));
    expect(fixture.frames).toHaveLength(scheduledBeforeForeignMutation);
    expect(fixture.port.posts).toHaveLength(postsBeforeForeignMutation);
  });

  it('derives final-order retain entries from emitted state across unacknowledged batches', () => {
    const fixture = sourceFixture(`
      <main id="target"><span id="first">first</span><span id="second">second</span></main>
    `);
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const target = fixture.document.querySelector('#target')!;
    const first = fixture.document.querySelector('#first')!;
    const second = fixture.document.querySelector('#second')!;
    const firstId = fixture.registry.peekId(first)!;
    const secondId = fixture.registry.peekId(second)!;

    const added = fixture.document.createElement('p');
    added.textContent = 'added';
    target.append(added);
    fixture.mutate(childListRecord(target, [added]));
    fixture.flushFrame();
    const addedId = fixture.registry.peekId(added)!;
    expect(fixture.patches().at(-1)?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'reconcile-children',
        children: [
          { kind: 'retain', nodeId: firstId },
          { kind: 'retain', nodeId: secondId },
          expect.objectContaining({
            kind: 'graph',
            node: expect.objectContaining({ id: addedId }),
          }),
        ],
      }),
    ]));

    target.insertBefore(second, first);
    fixture.mutate(childListRecord(target, [second]));
    fixture.flushFrame();
    expect(fixture.patches().at(-1)?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'reconcile-children',
        children: [
          { kind: 'retain', nodeId: secondId },
          { kind: 'retain', nodeId: firstId },
          { kind: 'retain', nodeId: addedId },
        ],
      }),
    ]));

    added.remove();
    fixture.mutate(childListRecord(target, []));
    fixture.flushFrame();
    target.append(added);
    fixture.mutate(childListRecord(target, [added]));
    fixture.flushFrame();
    expect(fixture.patches().at(-1)?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'reconcile-children',
        children: [
          { kind: 'retain', nodeId: secondId },
          { kind: 'retain', nodeId: firstId },
          expect.objectContaining({
            kind: 'graph',
            node: expect.objectContaining({ id: addedId }),
          }),
        ],
      }),
    ]));
  });

  it('does not traverse retained direct-child subtrees during append or reorder', () => {
    const fixture = sourceFixture(`
      <main id="target"><section id="retained"><span>stable subtree</span></section></main>
    `);
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const target = fixture.document.querySelector('#target')!;
    const retained = fixture.document.querySelector('#retained')!;
    const retainedId = fixture.registry.peekId(retained)!;
    let retainedTraversalCount = 0;
    Object.defineProperty(retained, 'attributes', {
      configurable: true,
      get: () => {
        retainedTraversalCount += 1;
        throw new Error('retained subtree must not be serialized');
      },
    });

    const added = fixture.document.createElement('aside');
    added.textContent = 'new child';
    target.append(added);
    fixture.mutate(childListRecord(target, [added]));
    fixture.flushFrame();
    const addedId = fixture.registry.peekId(added)!;
    expect(fixture.patches().at(-1)?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'reconcile-children',
        children: [
          { kind: 'retain', nodeId: retainedId },
          expect.objectContaining({
            kind: 'graph',
            node: expect.objectContaining({ id: addedId }),
          }),
        ],
      }),
    ]));
    expect(retainedTraversalCount).toBe(0);

    fixture.port.emitMessage(createHtmlMirrorAck(identity, 1));
    target.append(retained);
    fixture.mutate(childListRecord(target, [retained]));
    fixture.flushFrame();
    expect(fixture.patches().at(-1)?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'reconcile-children',
        children: [
          { kind: 'retain', nodeId: addedId },
          { kind: 'retain', nodeId: retainedId },
        ],
      }),
    ]));
    expect(retainedTraversalCount).toBe(0);
  });

  it('falls back to full children when a structural change covers dirty descendants', () => {
    const fixture = sourceFixture(
      '<main id="target"><span id="label">before</span></main>',
    );
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const target = fixture.document.querySelector('#target')!;
    const labelText = fixture.document.querySelector('#label')!.firstChild as Text;
    const added = fixture.document.createElement('aside');
    added.textContent = 'new sibling';
    target.append(added);
    labelText.nodeValue = 'after';
    fixture.mutate(childListRecord(target, [added]));
    fixture.mutate(characterDataRecord(labelText));
    fixture.flushFrame();

    expect(fixture.patches().at(-1)?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'children' }),
    ]));
    expect(
      fixture.patches().at(-1)?.representability.coveredDirtyBranchFallbackCount,
    ).toBe(1);
    expect(JSON.stringify(fixture.patches().at(-1))).toContain('after');
  });

  it('classifies cross-parent churn without retaining the moved identity', () => {
    const fixture = sourceFixture(`
      <section id="left"><span id="moved">move me</span></section>
      <section id="right"></section>
    `);
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const left = fixture.document.querySelector('#left')!;
    const right = fixture.document.querySelector('#right')!;
    const moved = fixture.document.querySelector('#moved')!;
    right.append(moved);
    fixture.mutate(childListRecord(left, []));
    fixture.mutate(childListRecord(right, [moved]));
    fixture.flushFrame();

    const patch = fixture.patches().at(-1)!;
    expect(patch.operations.filter(({ kind }) => kind === 'children')).toHaveLength(2);
    expect(patch.operations.some(({ kind }) => kind === 'reconcile-children')).toBe(
      false,
    );
    expect(patch.representability.crossParentFallbackCount).toBe(1);
  });

  it('uses full replacement when a new wrapper contains an emitted identity', () => {
    const fixture = sourceFixture(
      '<main id="target"><span id="moved">move me</span></main>',
    );
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const target = fixture.document.querySelector('#target')!;
    const moved = fixture.document.querySelector('#moved')!;
    const wrapper = fixture.document.createElement('section');
    target.append(wrapper);
    wrapper.append(moved);
    fixture.mutate(childListRecord(target, [wrapper]));
    fixture.flushFrame();

    const patch = fixture.patches().at(-1)!;
    expect(patch.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'children' }),
    ]));
    expect(patch.operations.some(({ kind }) => kind === 'reconcile-children'))
      .toBe(false);
    expect(patch.representability.crossParentFallbackCount).toBe(1);
  });

  it('captures and live-observes accessible open shadow roots only', () => {
    const fixture = sourceFixture('<main><div id="open"></div><div id="closed"></div></main>');
    const open = fixture.document.querySelector('#open')!;
    const openText = fixture.document.createTextNode('open shadow');
    const openShadow = open.attachShadow({ mode: 'open' });
    Object.defineProperty(openShadow, 'mode', { value: 'open' });
    let openRootReads = 0;
    Object.defineProperty(open, 'shadowRoot', {
      configurable: true,
      get: () => {
        openRootReads += 1;
        return openShadow;
      },
    });
    openShadow.append(openText);
    fixture.document.querySelector('#closed')!.attachShadow({ mode: 'closed' })
      .textContent = 'closed shadow';

    fixture.start();
    const checkpointJson = JSON.stringify(fixture.checkpoints()[0]);
    expect(checkpointJson).toContain('open shadow');
    expect(checkpointJson).not.toContain('closed shadow');
    expect(fixture.observed.some((node) => node === openShadow)).toBe(true);
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const rootReadsAfterCapture = openRootReads;
    fixture.runTimer();
    expect(openRootReads).toBe(rootReadsAfterCapture);

    openText.nodeValue = 'updated shadow';
    fixture.mutate(characterDataRecord(openText));
    fixture.flushFrame();
    expect(JSON.stringify(fixture.patches().at(-1))).toContain('updated shadow');
  });

  it('uses full replacement when a light-DOM change covers dirty open-shadow content', () => {
    const fixture = sourceFixture('<main id="page"><x-card id="card"></x-card></main>');
    const page = fixture.document.querySelector('#page')!;
    const card = fixture.document.querySelector('#card')!;
    const shadow = card.attachShadow({ mode: 'open' });
    Object.defineProperty(shadow, 'mode', { value: 'open' });
    const shadowText = fixture.document.createTextNode('before shadow');
    shadow.append(shadowText);
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    const added = fixture.document.createElement('aside');
    added.textContent = 'new light child';
    page.append(added);
    shadowText.nodeValue = 'after shadow';
    fixture.mutate(childListRecord(page, [added]));
    fixture.mutate(characterDataRecord(shadowText));
    fixture.flushFrame();

    const patch = fixture.patches().at(-1)!;
    expect(patch.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'children' }),
    ]));
    expect(patch.operations.some(({ kind }) => kind === 'reconcile-children')).toBe(
      false,
    );
    expect(JSON.stringify(patch)).toContain('after shadow');
  });

  it('reads a host\'s root again, beside the host, when the host\'s children and its own root change together (D135)', () => {
    const fixture = sourceFixture('<x-card id="card"><span>light</span></x-card>');
    const card = fixture.document.querySelector('#card')!;
    const shadow = card.attachShadow({ mode: 'open' });
    Object.defineProperty(shadow, 'mode', { value: 'open' });
    const nestedHost = fixture.document.createElement('x-nested');
    shadow.append(nestedHost);
    const nestedShadow = nestedHost.attachShadow({ mode: 'open' });
    Object.defineProperty(nestedShadow, 'mode', { value: 'open' });
    const shadowText = fixture.document.createTextNode('before nested shadow');
    nestedShadow.append(shadowText);
    // linkedom does not say a shadow root is connected; Chrome does.
    Object.defineProperty(shadow, 'isConnected', { get: () => card.isConnected });
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    const added = fixture.document.createElement('span');
    added.textContent = 'new light child';
    card.append(added);
    shadowText.nodeValue = 'after nested shadow';
    fixture.mutate(childListRecord(card, [added]));
    fixture.mutate(characterDataRecord(shadowText));
    fixture.flushFrame();

    // A patch of the host's children does not carry the host's root. The
    // root is read again whole beside it; it was the whole page (a
    // checkpoint) at every such change.
    expect(fixture.checkpoints()).toHaveLength(1);
    expect(fixture.patches()).toHaveLength(1);
    const patch = fixture.patches()[0]!;
    expect(patch.operations.map(({ kind }) => kind)).toEqual(['children', 'children']);
    expect(patch.operations.map((operation) => 'nodeId' in operation && operation.nodeId).sort())
      .toEqual([fixture.registry.peekId(card), fixture.registry.peekId(shadow)].sort());
    expect(JSON.stringify(patch)).toContain('new light child');
    expect(JSON.stringify(patch)).toContain('after nested shadow');
  });

  it('rebuilds when an open-shadow host enters a private context', () => {
    const fixture = sourceFixture('<main><div id="host"></div></main>');
    const host = fixture.document.querySelector('#host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    Object.defineProperty(shadow, 'mode', { value: 'open' });
    const label = fixture.document.createElement('span');
    label.setAttribute('title', 'shadow metadata secret');
    label.textContent = 'shadow text secret';
    shadow.append(label);

    fixture.start();
    expect(JSON.stringify(fixture.checkpoints()[0])).toContain('shadow text secret');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    host.setAttribute('role', 'textbox');
    fixture.mutate(attributeRecord(host, 'role'));
    expect(fixture.port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v2:error',
      code: 'stream_gap',
    });
    expect(fixture.frames).toHaveLength(0);

    fixture.port.emitMessage(createHtmlMirrorCheckpointRequest(identity, 0));
    const recoveryJson = JSON.stringify(fixture.checkpoints().at(-1));
    expect(recoveryJson).not.toContain('shadow text secret');
    // The editor's text is withheld; its elements' author attributes travel
    // (D76).
    expect(recoveryJson).toContain('shadow metadata secret');
  });

  it('reconciles an open shadow root attached after the initial checkpoint', () => {
    const fixture = sourceFixture('<main><div id="late-shadow"></div></main>');
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const host = fixture.document.querySelector('#late-shadow')!;
    const shadow = host.attachShadow({ mode: 'open' });
    Object.defineProperty(shadow, 'mode', { value: 'open' });
    const text = fixture.document.createTextNode('late shadow text');
    shadow.append(text);

    // attachShadow() itself is not a DOM mutation. The bounded discovery pass
    // must find the newly attached root without relying on an impossible
    // observer callback from a root that was not observable yet.
    fixture.runTimer();

    expect(fixture.port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v2:error',
      code: 'stream_gap',
    });
    expect(fixture.observed).toContain(shadow);
    fixture.port.emitMessage(createHtmlMirrorCheckpointRequest(identity, 0));
    expect(fixture.checkpoints()).toHaveLength(2);
    expect(JSON.stringify(fixture.checkpoints().at(-1))).toContain(
      'late shadow text',
    );

    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    text.nodeValue = 'updated late shadow';
    fixture.mutate(characterDataRecord(text));
    fixture.flushFrame();
    expect(JSON.stringify(fixture.patches().at(-1))).toContain(
      'updated late shadow',
    );
  });

  it('mirrors an attribute removed inside an open shadow root (D125)', () => {
    const scoped = scopedMutationObservers();
    const fixture = sourceFixture('<main><x-card id="card"></x-card></main>', undefined, { scoped });
    const card = fixture.document.querySelector('#card')!;
    const root = card.attachShadow({ mode: 'open' });
    Object.defineProperty(root, 'mode', { value: 'open' });
    root.innerHTML = '<p id="inside" class="flag">open shadow</p>';
    const inside = root.querySelector('#inside')!;
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    // Roots used to be observed without old values. Chrome then reports a
    // removed attribute with a null old value, which read as "unchanged"
    // (the attribute is null now too) and was dropped. The record reaches
    // the session only through its observation of the root.
    inside.removeAttribute('class');
    expect(scoped.deliver({
      type: 'attributes', target: inside, attributeName: 'class', oldValue: 'flag',
    })).toBe(1);
    fixture.flushFrame();
    expect(fixture.patches().at(-1)!.operations).toEqual([
      expect.objectContaining({
        kind: 'attributes',
        nodeId: fixture.registry.peekId(inside),
        attributes: [['id', 'inside']],
      }),
    ]);
  });

  it('captures and live-observes a closed shadow root (D125)', () => {
    const reader = closedRootReader();
    const fixture = sourceFixture('<main><x-card id="card"><b>light</b></x-card></main>', reader);
    const card = fixture.document.querySelector('#card')!;
    const root = reader.attach(card, '<p id="inside" class="flag">closed shadow</p><ul id="list"></ul>');
    const inside = root.querySelector('#inside')!;
    const text = inside.firstChild as Text;

    fixture.start();
    const checkpoint = fixture.checkpoints()[0]!;
    expect(JSON.stringify(checkpoint)).toContain('closed shadow');
    // The replica builds an open root: the wire has no other mode.
    expect(JSON.stringify(checkpoint)).toContain('"mode":"open"');
    expect(JSON.stringify(checkpoint)).not.toContain('"mode":"closed"');
    expect(fixture.observed).toContain(root);
    // The same options as for the document, old values included.
    expect(fixture.observedOptions.get(root)).toEqual(
      fixture.observedOptions.get(fixture.document.documentElement),
    );
    expect(fixture.observedOptions.get(root)).toMatchObject({
      attributeOldValue: true,
      characterDataOldValue: true,
      subtree: true,
    });
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    // A text edit, an added node and a removed attribute inside the root.
    text.nodeValue = 'updated closed shadow';
    fixture.mutate({ ...characterDataRecord(text), oldValue: 'closed shadow' });
    fixture.flushFrame();
    expect(JSON.stringify(fixture.patches().at(-1))).toContain('updated closed shadow');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, fixture.patches().at(-1)!.identity.sequence));

    const item = fixture.document.createElement('li');
    item.textContent = 'added inside';
    root.querySelector('#list')!.append(item);
    fixture.mutate(childListRecord(root.querySelector('#list')!, [item]));
    fixture.flushFrame();
    expect(JSON.stringify(fixture.patches().at(-1))).toContain('added inside');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, fixture.patches().at(-1)!.identity.sequence));

    inside.removeAttribute('class');
    fixture.mutate({ ...attributeRecord(inside, 'class'), oldValue: 'flag' });
    fixture.flushFrame();
    const attributePatch = fixture.patches().at(-1)!;
    expect(attributePatch.operations).toEqual([
      expect.objectContaining({
        kind: 'attributes',
        nodeId: fixture.registry.peekId(inside),
        attributes: [['id', 'inside']],
      }),
    ]);
  });

  it('reconciles a closed shadow root attached after the initial checkpoint (D125)', () => {
    const reader = closedRootReader();
    const fixture = sourceFixture(
      '<main><div id="late-shadow"></div><x-late id="late-element"></x-late></main>',
      reader,
    );
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const host = fixture.document.querySelector('#late-shadow')!;
    const other = fixture.document.querySelector('#late-element')!;
    const asked = (element: Element) =>
      reader.calls.filter((candidate) => candidate === element).length;
    const askedBefore = [asked(host), asked(other)];

    // Two roots are attached; nothing fires. A change above them asks only
    // about the elements above the change.
    const root = reader.attach(host, '<p>late closed text</p>');
    const otherRoot = reader.attach(other, '<p>late closed element text</p>');
    const main = fixture.document.querySelector('main')!;
    main.setAttribute('data-state', 'changed');
    fixture.mutate(attributeRecord(main, 'data-state'));
    fixture.flushFrame();
    expect(fixture.patches()).toHaveLength(1);
    expect([asked(host), asked(other)]).toEqual(askedBefore);
    expect(fixture.observed).not.toContain(root);
    fixture.port.emitMessage(createHtmlMirrorAck(identity, fixture.patches().at(-1)!.identity.sequence));

    // The bounded discovery pass asks Chrome again.
    fixture.runTimer();
    expect(fixture.port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v2:error',
      code: 'stream_gap',
    });
    expect(fixture.observed).toContain(root);

    // One checkpoint holds every root attached so far.
    fixture.port.emitMessage(createHtmlMirrorCheckpointRequest(
      identity,
      fixture.patches().at(-1)!.identity.sequence,
    ));
    expect(fixture.checkpoints()).toHaveLength(2);
    const recovery = JSON.stringify(fixture.checkpoints().at(-1));
    expect(recovery).toContain('late closed text');
    expect(recovery).toContain('late closed element text');
    expect(fixture.observed).toContain(otherRoot);
  });

  it('asks about an element once a checkpoint, above a change before its patch, and never about a control (D125)', () => {
    const reader = closedRootReader();
    const fixture = sourceFixture(
      '<main><div id="box"><span>text</span></div><p id="line">line</p>' +
        '<input id="field" value="typed"><ul><li><a href="#x">link</a></li></ul>' +
        '<details><summary>More</summary></details><button>Go</button></main>',
      reader,
    );
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const hosts = new Set(['body', 'main', 'div', 'span', 'p']);
    for (const element of reader.calls) {
      expect(hosts.has(element.localName), element.localName).toBe(true);
    }
    const asked = (element: Element) =>
      reader.calls.filter((candidate) => candidate === element).length;
    const box = fixture.document.querySelector('#box')!;
    // One ask per element for the checkpoint, whatever number of walks ran.
    const line = fixture.document.querySelector('#line')!;
    const main = fixture.document.querySelector('main')!;
    expect([asked(box), asked(line), asked(main)]).toEqual([1, 1, 1]);

    // The patch asks about the elements above the change, not beside it.
    const text = line.firstChild as Text;
    text.nodeValue = 'changed line';
    fixture.mutate(characterDataRecord(text));
    fixture.flushFrame();
    expect(JSON.stringify(fixture.patches().at(-1))).toContain('changed line');
    expect([asked(box), asked(line), asked(main)]).toEqual([1, 2, 2]);

    // Each discovery tick asks again; a control is never a candidate.
    fixture.runTimer();
    expect(asked(box)).toBe(2);
    fixture.runTimer();
    expect(asked(box)).toBe(3);
    for (const element of reader.calls) {
      expect(hosts.has(element.localName), element.localName).toBe(true);
    }
  });

  it('rebuilds when a closed-shadow host enters a private context (D125)', () => {
    const reader = closedRootReader();
    const fixture = sourceFixture('<main><div id="host"></div></main>', reader);
    const host = fixture.document.querySelector('#host')!;
    reader.attach(host, '<span>closed shadow text secret</span>');

    fixture.start();
    expect(JSON.stringify(fixture.checkpoints()[0])).toContain('closed shadow text secret');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    host.setAttribute('role', 'textbox');
    fixture.mutate(attributeRecord(host, 'role'));
    expect(fixture.port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v2:error',
      code: 'stream_gap',
    });
    fixture.port.emitMessage(createHtmlMirrorCheckpointRequest(identity, 0));
    expect(JSON.stringify(fixture.checkpoints().at(-1)))
      .not.toContain('closed shadow text secret');
  });

  it('keeps a credential field that appears later in a closed root masked (D125)', () => {
    const reader = closedRootReader();
    const fixture = sourceFixture('<main><x-form id="form"></x-form></main>', reader);
    const form = reader.attach(
      fixture.document.querySelector('#form')!,
      '<p>sign in</p><x-vault id="vault"></x-vault>',
    );
    const vault = reader.attach(
      form.querySelector('#vault')!,
      '<p>vault</p><div id="fields"></div>',
    );
    const fields = vault.querySelector('#fields')!;
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    // A password field is added inside the nested closed root.
    const field = fixture.document.createElement('input');
    field.setAttribute('type', 'password');
    field.setAttribute('value', 'late-secret-99');
    fields.append(field);
    fixture.mutate(childListRecord(fields, [field]));
    fixture.flushFrame();
    const patch = fixture.patches().at(-1)!;
    expect(JSON.stringify(patch)).toContain('"type","password"');
    expect(JSON.stringify(patch)).not.toContain('late-secret-99');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, patch.identity.sequence));

    // "Show password": the type changes. The field stays a credential field.
    field.setAttribute('type', 'text');
    fixture.mutate({ ...attributeRecord(field, 'type'), oldValue: 'password' });
    while (fixture.frames.length > 0) fixture.flushFrame();
    fixture.port.emitMessage(createHtmlMirrorCheckpointRequest(
      identity,
      fixture.patches().at(-1)!.identity.sequence,
    ));
    expect(JSON.stringify(fixture.port.posts)).not.toContain('late-secret-99');
    const classifier = sourceDocumentSecretClassifier(fixture.document);
    expect(classifier.isSecret(field)).toBe(true);
  });

  it('keeps a field masked whose type changed in a closed root before it was seen (D125)', () => {
    const reader = closedRootReader();
    const scoped = scopedMutationObservers();
    const fixture = sourceFixture('<main><x-form id="form"></x-form></main>', reader, { scoped });
    const form = reader.attach(
      fixture.document.querySelector('#form')!,
      '<p>sign in</p><div id="fields"></div>',
    );
    const fields = form.querySelector('#fields')!;
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    // Added as a password field and switched to text in the same task: the
    // old value of the attribute record is the only trace of the first type,
    // and only an observer of the closed root that asked for old values
    // gets it.
    const field = fixture.document.createElement('input');
    field.setAttribute('type', 'password');
    field.setAttribute('value', 'flipped-secret-7');
    fields.append(field);
    field.setAttribute('type', 'text');
    expect(scoped.deliver({ type: 'childList', target: fields, addedNodes: [field] }))
      .toBe(1);
    expect(scoped.deliver({
      type: 'attributes', target: field, attributeName: 'type', oldValue: 'password',
    })).toBe(1);
    while (fixture.frames.length > 0) fixture.flushFrame();

    expect(sourceDocumentSecretClassifier(fixture.document).isSecret(field)).toBe(true);
    expect(JSON.stringify(fixture.port.posts)).not.toContain('flipped-secret-7');
  });

  it('classifies credential fields in closed roots when the bridge is installed (D125)', () => {
    const { document, window } = parseHTML(
      '<html><body><x-login id="login"></x-login></body></html>',
    );
    Object.defineProperty(window, 'top', { configurable: true, value: window });
    Object.defineProperty(document, 'baseURI', {
      configurable: true,
      value: 'https://example.test/',
    });
    const reader = closedRootReader();
    const login = reader.attach(
      document.querySelector('#login')!,
      '<p>sign in</p><x-vault id="vault"></x-vault>',
    );
    const vault = reader.attach(
      login.querySelector('#vault')!,
      '<input id="pin" type="password" value="bridge-secret-5"><p>vault text</p>',
    );
    const pin = vault.querySelector('#pin')!;
    const onConnect = new FakeEvent<(port: Browser.runtime.Port) => void>();
    installHtmlMirrorSourceBridge({
      global: {} as typeof globalThis,
      runtime: { onConnect } as unknown as
        HtmlMirrorSourceBridgeEnvironment['runtime'],
      document,
      window: window as unknown as Window,
      now: () => 1,
      createMutationObserver: () => new NoopBridgeMutationObserver(),
      scheduleFrame: () => 1,
      cancelFrame: () => undefined,
      setTimer: () => 1,
      clearTimer: () => undefined,
      openShadowRoot: reader.read,
    });

    // Before any mirror connects, the classifier has seen into both roots.
    expect(sourceDocumentSecretClassifier(document).isSecret(pin)).toBe(true);
    // The page shows the password; the field stays a credential field.
    pin.setAttribute('type', 'text');

    const port = new FakePort(createHtmlMirrorPortName(identity.sessionId));
    onConnect.emit(port as unknown as Browser.runtime.Port);
    port.emitMessage(createHtmlMirrorStart(identity, 'conservative'));
    const posts = JSON.stringify(port.posts);
    expect(posts).toContain('vault text');
    expect(posts).not.toContain('bridge-secret-5');
  });

  it('asks about every element for each checkpoint, so a root attached between mirrors arrives (D125)', () => {
    const { document, window } = parseHTML(
      '<html><body><main><div id="late"></div><p>page text</p></main></body></html>',
    );
    Object.defineProperty(window, 'top', { configurable: true, value: window });
    Object.defineProperty(document, 'baseURI', {
      configurable: true,
      value: 'https://example.test/',
    });
    const reader = closedRootReader();
    const onConnect = new FakeEvent<(port: Browser.runtime.Port) => void>();
    installHtmlMirrorSourceBridge({
      global: {} as typeof globalThis,
      runtime: { onConnect } as unknown as
        HtmlMirrorSourceBridgeEnvironment['runtime'],
      document,
      window: window as unknown as Window,
      now: () => 1,
      createMutationObserver: () => new NoopBridgeMutationObserver(),
      scheduleFrame: () => 1,
      cancelFrame: () => undefined,
      setTimer: () => 1,
      clearTimer: () => undefined,
      openShadowRoot: reader.read,
    });
    const late = document.querySelector('#late')!;
    const asked = () => reader.calls.filter((element) => element === late).length;
    // The walk at install asked once.
    expect(asked()).toBe(1);

    // A checkpoint sends the whole page: it asks about every element once.
    const firstPort = new FakePort(createHtmlMirrorPortName(identity.sessionId));
    onConnect.emit(firstPort as unknown as Browser.runtime.Port);
    firstPort.emitMessage(createHtmlMirrorStart(identity, 'conservative'));
    expect(JSON.stringify(firstPort.posts)).toContain('page text');
    expect(asked()).toBe(2);
    firstPort.onDisconnect.emit();

    // A closed root is attached while no mirror is looking.
    reader.attach(late, '<p>attached between mirrors</p>');

    const secondPort = new FakePort(createHtmlMirrorPortName(identity.sessionId));
    onConnect.emit(secondPort as unknown as Browser.runtime.Port);
    secondPort.emitMessage(createHtmlMirrorStart(identity, 'conservative'));
    expect(asked()).toBe(3);
    expect(JSON.stringify(secondPort.posts)).toContain('attached between mirrors');
  });

  it('finds the closed root of a host inserted later, and of a host inside it (D125)', () => {
    const reader = closedRootReader();
    const fixture = sourceFixture(
      '<main id="page"><p>page text</p><div id="old"></div></main>',
      reader,
    );
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    const page = fixture.document.querySelector('#page')!;
    // In the same task the page attaches a root to an element it already had.
    reader.attach(fixture.document.querySelector('#old')!, '<p>root on an old element</p>');
    const host = fixture.document.createElement('x-added');
    const root = reader.attach(host, '<p>added closed text</p><x-inner id="inner"></x-inner>');
    const nested = reader.attach(root.querySelector('#inner')!, '<p>added nested text</p>');
    page.append(host);
    fixture.mutate(childListRecord(page, [host]));

    // The mutation walk finds both roots without waiting for discovery.
    expect(fixture.observed).toContain(root);
    expect(fixture.observed).toContain(nested);
    expect(fixture.port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v2:error',
      code: 'stream_gap',
    });
    fixture.port.emitMessage(createHtmlMirrorCheckpointRequest(identity, 0));
    const recovery = JSON.stringify(fixture.checkpoints().at(-1));
    expect(recovery).toContain('added closed text');
    expect(recovery).toContain('added nested text');
    // Roots attached together arrive together: the same checkpoint asked
    // about the old element again.
    expect(recovery).toContain('root on an old element');
  });

  it('does the same for a closed root (D125, D135)', () => {
    const reader = closedRootReader();
    const fixture = sourceFixture('<x-card id="card"><span>light</span></x-card>', reader);
    const card = fixture.document.querySelector('#card')!;
    const shadow = reader.attach(card, '<p id="inside">before closed shadow</p>');
    const shadowText = shadow.querySelector('#inside')!.firstChild as Text;
    Object.defineProperty(shadow, 'isConnected', { get: () => card.isConnected });
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    const added = fixture.document.createElement('span');
    added.textContent = 'new light child';
    card.append(added);
    shadowText.nodeValue = 'after closed shadow';
    fixture.mutate(childListRecord(card, [added]));
    fixture.mutate(characterDataRecord(shadowText));
    fixture.flushFrame();

    expect(fixture.checkpoints()).toHaveLength(1);
    expect(fixture.patches()).toHaveLength(1);
    expect(fixture.patches()[0]!.operations.map(({ kind }) => kind))
      .toEqual(['children', 'children']);
    expect(JSON.stringify(fixture.patches()[0])).toContain('new light child');
    expect(JSON.stringify(fixture.patches()[0])).toContain('after closed shadow');
  });

  it('withholds a collapsed disclosure panel inside a closed shadow root (D125)', () => {
    const { document, window } = parseHTML(`<html><body>
      <x-menu id="menu"></x-menu>
    </body></html>`);
    const reader = closedRootReader();
    const root = reader.attach(
      document.querySelector('#menu')!,
      '<button aria-expanded="false" aria-controls="panel">Menu</button>' +
        '<div id="panel">collapsed panel text</div>',
    );
    const panel = root.querySelector('#panel')!;

    // Unseen without the page reader, as before D125.
    expect(createSourceControlledContentPolicy(
      document as unknown as Document,
      window as unknown as Window,
    ).targets.has(panel)).toBe(false);

    installSourceShadowRootReader(document, reader.read);
    expect(createSourceControlledContentPolicy(
      document as unknown as Document,
      window as unknown as Window,
    ).targets.get(panel)).toBe('withheld');
  });

  it('asks again for every checkpoint, but never about a host whose root it holds (D125)', () => {
    const reader = closedRootReader();
    const fixture = sourceFixture(
      '<main id="page"><x-card id="card"></x-card><div id="plain">text</div></main>',
      reader,
    );
    const card = fixture.document.querySelector('#card')!;
    const plain = fixture.document.querySelector('#plain')!;
    reader.attach(card, '<p>closed text</p>');
    const asked = (element: Element) =>
      reader.calls.filter((candidate) => candidate === element).length;
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    expect(asked(card)).toBe(1);
    expect(asked(plain)).toBe(1);

    // Discovery asks about the elements still without a root.
    fixture.runTimer();
    expect(asked(card)).toBe(1);
    expect(asked(plain)).toBe(2);

    // A checkpoint the panel asks for asks again about every element
    // without a root; a root, once found, is never asked about again.
    const plainRoot = reader.attach(plain, '<p>root since the last tick</p>');
    fixture.port.emitMessage(createHtmlMirrorCheckpointRequest(identity, 0));
    expect(fixture.checkpoints()).toHaveLength(2);
    const recovery = JSON.stringify(fixture.checkpoints().at(-1));
    expect(recovery).toContain('closed text');
    expect(recovery).toContain('root since the last tick');
    expect(fixture.observed).toContain(plainRoot);
    expect(asked(card)).toBe(1);
    expect(asked(plain)).toBe(3);
  });

  describe.each(['open', 'closed'] as const)(
    'a password field added to an %s root while no panel is open (D125)',
    (mode) => {
      function closedPanelPage(markup: string) {
        const { document, window } = parseHTML(`<html><body>${markup}</body></html>`);
        Object.defineProperty(window, 'top', { configurable: true, value: window });
        Object.defineProperty(document, 'baseURI', {
          configurable: true,
          value: 'https://example.test/',
        });
        const reader = closedRootReader();
        const observers = scopedMutationObservers();
        const onConnect = new FakeEvent<(port: Browser.runtime.Port) => void>();
        return {
          document,
          observers,
          attach(host: Element, markup = ''): ShadowRoot {
            if (mode === 'closed') return reader.attach(host, markup);
            const root = host.attachShadow({ mode: 'open' });
            Object.defineProperty(root, 'mode', { value: 'open' });
            root.innerHTML = markup;
            return root;
          },
          install: () => installHtmlMirrorSourceBridge({
            global: {} as typeof globalThis,
            runtime: { onConnect } as unknown as
              HtmlMirrorSourceBridgeEnvironment['runtime'],
            document,
            window: window as unknown as Window,
            now: () => 1,
            createMutationObserver: observers.create,
            scheduleFrame: () => 1,
            cancelFrame: () => undefined,
            setTimer: () => 1,
            clearTimer: () => undefined,
            openShadowRoot: reader.read,
          }),
          /** A person's input whose path, seen from the window, starts at `start`. */
          input(type: string, start: Node): void {
            const event = new window.Event(type, { bubbles: true, composed: true });
            Object.defineProperty(event, 'composedPath', { value: () => [start] });
            window.dispatchEvent(event);
          },
          /** The panel is opened again: what the mirror then sends. */
          reopen(): string {
            const port = new FakePort(createHtmlMirrorPortName(identity.sessionId));
            onConnect.emit(port as unknown as Browser.runtime.Port);
            port.emitMessage(createHtmlMirrorStart(identity, 'conservative'));
            return JSON.stringify(port.posts);
          },
        };
      }
      type ClosedPanelPage = ReturnType<typeof closedPanelPage>;

      /** Adds a row with a password field to `root`, as a later task. */
      function addField(page: ClosedPanelPage, root: ShadowRoot, value: string): Element {
        const row = page.document.createElement('div');
        row.innerHTML = `<input type="password" value="${value}">`;
        root.append(row);
        // Only an observer of the root itself hears of it.
        expect(page.observers.deliver({ type: 'childList', target: root, addedNodes: [row] }))
          .toBe(1);
        return row.querySelector('input')!;
      }

      /** The page's eye: the field shows its password. */
      function show(page: ClosedPanelPage, field: Element): void {
        field.setAttribute('type', 'text');
        page.observers.deliver({
          type: 'attributes', target: field, attributeName: 'type', oldValue: 'password',
        });
      }

      it('stays masked when it was added to a root the page had', () => {
        const page = closedPanelPage('<x-form id="form"></x-form>');
        const root = page.attach(page.document.querySelector('#form')!, '<p>sign in</p>');
        page.install();

        const field = addField(page, root, 'later-secret-31');
        show(page, field);

        expect(sourceDocumentSecretClassifier(page.document).isSecret(field)).toBe(true);
        const posts = page.reopen();
        expect(posts).toContain('sign in');
        expect(posts).not.toContain('later-secret-31');
      });

      it('stays masked when a component renders it after it was inserted', () => {
        const page = closedPanelPage('<div id="mount"></div>');
        page.install();
        const host = page.document.createElement('x-async');
        const root = page.attach(host);
        const mount = page.document.querySelector('#mount')!;
        mount.append(host);
        page.observers.deliver({ type: 'childList', target: mount, addedNodes: [host] });

        const field = addField(page, root, 'async-secret-32');
        show(page, field);

        expect(sourceDocumentSecretClassifier(page.document).isSecret(field)).toBe(true);
        expect(page.reopen()).not.toContain('async-secret-32');
      });

      it('stays masked when a person types into it before showing it, in a root attached to an element the page had', () => {
        const page = closedPanelPage('<div id="spare">spare</div>');
        page.install();
        const spare = page.document.querySelector('#spare')!;
        // No record reports this root: only the person's input can.
        const root = page.attach(
          spare,
          '<label>Password <input type="password" value="typed-secret-35"></label>',
        );
        const field = root.querySelector('input')!;
        page.input('keydown', mode === 'closed' ? spare : field);
        expect(sourceDocumentSecretClassifier(page.document).isSecret(field)).toBe(true);
        field.setAttribute('type', 'text');
        expect(page.observers.deliver({
          type: 'attributes', target: field, attributeName: 'type', oldValue: 'password',
        })).toBe(1);

        expect(page.reopen()).not.toContain('typed-secret-35');
      });

      it('stays masked when its host, read before, got the root while out of the page', () => {
        const page = closedPanelPage('<main id="main"><div id="spare">spare</div></main>');
        page.install();
        const main = page.document.querySelector('#main')!;
        const spare = page.document.querySelector('#spare')!;
        spare.remove();
        page.observers.deliver({ type: 'childList', target: main, removedNodes: [spare] });
        const root = page.attach(spare, '<input type="password" value="reinsert-secret-36">');
        main.append(spare);
        page.observers.deliver({ type: 'childList', target: main, addedNodes: [spare] });

        const field = root.querySelector('input')!;
        show(page, field);
        expect(sourceDocumentSecretClassifier(page.document).isSecret(field)).toBe(true);
        expect(page.reopen()).not.toContain('reinsert-secret-36');
      });

      it('records nothing for a component that only animates while no panel is open', () => {
        const page = closedPanelPage('<x-card id="card"></x-card>');
        const root = page.attach(page.document.querySelector('#card')!, '<p id="tick">0</p>');
        page.install();
        const tick = root.querySelector('#tick')!;
        // A class, a data attribute and the text of a ticker: no evidence.
        expect(page.observers.deliver({
          type: 'attributes', target: tick, attributeName: 'class', oldValue: 'a',
        })).toBe(0);
        expect(page.observers.deliver({
          type: 'attributes', target: tick, attributeName: 'data-frame', oldValue: '1',
        })).toBe(0);
        expect(page.observers.deliver({
          type: 'characterData', target: tick.firstChild!, oldValue: '0',
        })).toBe(0);
        // A type, and a style that may have masked text, are recorded.
        expect(page.observers.deliver({
          type: 'attributes', target: tick, attributeName: 'type', oldValue: 'password',
        })).toBe(1);
        expect(page.observers.deliver({
          type: 'attributes', target: tick, attributeName: 'style', oldValue: '',
        })).toBe(1);
      });

      it('stays masked when it is added and shown in the same task', () => {
        const page = closedPanelPage('<x-form id="form"></x-form>');
        const root = page.attach(page.document.querySelector('#form')!, '<p>sign in</p>');
        page.install();
        const row = page.document.createElement('div');
        row.innerHTML = '<input type="password" value="same-task-secret-33">';
        root.append(row);
        const field = row.querySelector('input')!;
        field.setAttribute('type', 'text');
        // When the records arrive the field is a text field already: only
        // the old value of the type tells it was a password.
        expect(page.observers.deliverAll([
          { type: 'childList', target: root, addedNodes: [row] },
          { type: 'attributes', target: field, attributeName: 'type', oldValue: 'password' },
        ])).toBe(1);

        expect(sourceDocumentSecretClassifier(page.document).isSecret(field)).toBe(true);
        expect(page.reopen()).not.toContain('same-task-secret-33');
      });
    },
  );

  /**
   * `-webkit-text-security: disc` on the elements `masked` picks, for one
   * test: linkedom's window is a view of the global object, so a style
   * defined on it would stay for the tests that follow.
   */
  function maskWith(
    fixture: ReturnType<typeof sourceFixture>,
    masked: (element: Element) => boolean,
  ): void {
    const previous = Object.getOwnPropertyDescriptor(fixture.window, 'getComputedStyle');
    onTestFinished(() => {
      if (previous) Object.defineProperty(fixture.window, 'getComputedStyle', previous);
      else Reflect.deleteProperty(fixture.window, 'getComputedStyle');
    });
    Object.defineProperty(fixture.window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => ({
        backgroundColor: 'rgba(0, 0, 0, 0)',
        getPropertyValue: (name: string) =>
          name === '-webkit-text-security' && masked(element) ? 'disc' : '',
      }),
    });
  }

  /** Chrome reads null from `assignedSlot` for a node slotted into a closed root. */
  function unassigned(...nodes: Node[]): void {
    for (const node of nodes) {
      Object.defineProperty(node, 'assignedSlot', { configurable: true, value: null });
    }
  }

  it('sends nothing beside a closed root attached since: the patch becomes a checkpoint (D125)', () => {
    const reader = closedRootReader();
    const fixture = sourceFixture(
      '<main><div id="host">shown before</div><p id="other">other text</p></main>',
      reader,
    );
    maskWith(fixture, (element) => element.classList.contains('mask'));
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const host = fixture.document.querySelector('#host')!;
    const text = host.firstChild as Text;
    unassigned(text);

    // A closed root wraps the host's text in a masking box; nothing fires.
    // Then the text changes, which the document's observer reports.
    reader.attach(host, '<div class="mask"><slot></slot></div>');
    text.data = 'masked-after-41';
    fixture.mutate(characterDataRecord(text));
    fixture.flushFrame();

    expect(JSON.stringify(fixture.port.posts)).not.toContain('masked-after-41');
    expect(fixture.port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v2:error',
      code: 'stream_gap',
    });
    fixture.port.emitMessage(createHtmlMirrorCheckpointRequest(identity, 0));
    const recovery = JSON.stringify(fixture.checkpoints().at(-1));
    expect(recovery).toContain('other text');
    expect(recovery).not.toContain('masked-after-41');
  });

  it('asks again about every element of a subtree it sends (D125)', () => {
    const reader = closedRootReader();
    const fixture = sourceFixture(
      '<main><section id="list"><div id="host">kept text</div></section>' +
        '<section id="other"><p id="moved">moved row</p></section></main>',
      reader,
    );
    maskWith(fixture, (element) => element.classList.contains('mask'));
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const list = fixture.document.querySelector('#list')!;
    const other = fixture.document.querySelector('#other')!;
    const host = fixture.document.querySelector('#host')!;
    const moved = fixture.document.querySelector('#moved')!;

    // The host gets a closed root and its text changes, unrecorded; then a
    // row moves into the list, so the list's children are all read again.
    reader.attach(host, '<div class="mask"><slot></slot></div>');
    const text = host.firstChild as Text;
    unassigned(text);
    text.data = 'masked-again-42';
    list.append(moved);
    fixture.mutateAll([
      childListRecord(other, [], [moved]),
      childListRecord(list, [moved]),
    ]);
    fixture.flushFrame();

    expect(JSON.stringify(fixture.port.posts)).not.toContain('masked-again-42');
    expect(fixture.port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v2:error',
      code: 'stream_gap',
    });
  });

  it('rebuilds when another reader of the page finds a root attached since (D125)', () => {
    const reader = closedRootReader();
    const fixture = sourceFixture('<main><div id="late">text</div></main>', reader);
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const late = fixture.document.querySelector('#late')!;
    const root = reader.attach(late, '<p>late text</p>');

    // The semantic reader asks about the roots above a value it will send.
    expect(askAboutSourceShadowRootsAbove(late.firstChild!, new Set())).toEqual([root]);
    expect(fixture.frames).toHaveLength(1);
    fixture.flushFrame();
    expect(fixture.port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v2:error',
      code: 'stream_gap',
    });
    fixture.port.emitMessage(createHtmlMirrorCheckpointRequest(identity, 0));
    expect(JSON.stringify(fixture.checkpoints().at(-1))).toContain('late text');
  });

  it('finds a closed root at a layout change, asking again at most once an interval (D125)', () => {
    const reader = closedRootReader();
    let now = 1_000;
    const fixture = sourceFixture(
      '<main><div id="late">text</div><p id="plain">plain</p></main>',
      reader,
      { now: () => now },
    );
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const late = fixture.document.querySelector('#late')!;
    const plain = fixture.document.querySelector('#plain')!;
    const asked = (element: Element) =>
      reader.calls.filter((candidate) => candidate === element).length;
    const resize = () => fixture.window.dispatchEvent(new fixture.window.Event('resize'));

    // A root that renders anything changes the layout, as an open one does.
    reader.attach(late, '<p>late text</p>');
    resize();
    expect(fixture.port.posts).toContainEqual(expect.objectContaining({
      kind: 'simul:html-mirror-v2:error',
      code: 'stream_gap',
    }));
    const askedOnce = asked(plain);
    resize();
    expect(asked(plain)).toBe(askedOnce);
    now += 500;
    resize();
    expect(asked(plain)).toBe(askedOnce + 1);
  });

  it('follows the focus into roots it knows to find a root attached since inside them (D125)', () => {
    const { document, window } = parseHTML(
      '<html><body><x-form id="form"></x-form></body></html>',
    );
    Object.defineProperty(window, 'top', { configurable: true, value: window });
    Object.defineProperty(document, 'baseURI', { configurable: true, value: 'https://example.test/' });
    const reader = closedRootReader();
    const form = document.querySelector('#form')!;
    const outer = reader.attach(form, '<div id="inner">inner</div>');
    const observers = scopedMutationObservers();
    installHtmlMirrorSourceBridge({
      global: {} as typeof globalThis,
      runtime: { onConnect: new FakeEvent<(port: Browser.runtime.Port) => void>() } as unknown as
        HtmlMirrorSourceBridgeEnvironment['runtime'],
      document,
      window: window as unknown as Window,
      now: () => 1,
      createMutationObserver: observers.create,
      scheduleFrame: () => 1,
      cancelFrame: () => undefined,
      setTimer: () => 1,
      clearTimer: () => undefined,
      openShadowRoot: reader.read,
    });
    // A root, attached to an element inside a closed root the page had,
    // holds the field the person types into. Seen from the window the
    // input's path ends at the outer host; the focus leads further in.
    const inner = outer.querySelector('#inner')!;
    const innerRoot = reader.attach(inner, '<input type="password" value="nested-secret-37">');
    Object.defineProperty(outer, 'activeElement', { configurable: true, value: inner });
    const event = new window.Event('keydown', { bubbles: true, composed: true });
    Object.defineProperty(event, 'composedPath', { value: () => [form] });
    window.dispatchEvent(event);

    const field = innerRoot.querySelector('input')!;
    expect(sourceDocumentSecretClassifier(document).isSecret(field)).toBe(true);
    expect(observers.observedTargets()).toContain(innerRoot);
  });

  it('reads below the deepest root the focus leads to, for a root attached deeper still (D125)', () => {
    const { document, window } = parseHTML(
      '<html><body><x-form id="form"></x-form></body></html>',
    );
    Object.defineProperty(window, 'top', { configurable: true, value: window });
    Object.defineProperty(document, 'baseURI', { configurable: true, value: 'https://example.test/' });
    const reader = closedRootReader();
    const form = document.querySelector('#form')!;
    // 33 closed roots, each holding the next host, the page had at load.
    let host: Element = form;
    for (let level = 0; level < 33; level += 1) {
      const root = reader.attach(host, '<x-level>level</x-level>');
      const next = root.querySelector('x-level')!;
      Object.defineProperty(root, 'activeElement', { configurable: true, value: next });
      host = next;
    }
    const observers = scopedMutationObservers();
    installHtmlMirrorSourceBridge({
      global: {} as typeof globalThis,
      runtime: { onConnect: new FakeEvent<(port: Browser.runtime.Port) => void>() } as unknown as
        HtmlMirrorSourceBridgeEnvironment['runtime'],
      document,
      window: window as unknown as Window,
      now: () => 1,
      createMutationObserver: observers.create,
      scheduleFrame: () => 1,
      cancelFrame: () => undefined,
      setTimer: () => 1,
      clearTimer: () => undefined,
      openShadowRoot: reader.read,
    });
    // The deepest element gets a root holding the field, past the 32 roots
    // the focus is followed through.
    const deepRoot = reader.attach(host, '<input type="password" value="deep-secret-38">');
    const event = new window.Event('keydown', { bubbles: true, composed: true });
    Object.defineProperty(event, 'composedPath', { value: () => [form] });
    window.dispatchEvent(event);

    const field = deepRoot.querySelector('input')!;
    expect(sourceDocumentSecretClassifier(document).isSecret(field)).toBe(true);
    expect(observers.observedTargets()).toContain(deepRoot);
  });

  it('looks again, freshly, when the interval of a layout change inside it ends (D125)', () => {
    const reader = closedRootReader();
    let now = 1_000;
    const fixture = sourceFixture(
      '<main><div id="late">text</div></main>',
      reader,
      { now: () => now },
    );
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const resize = () => fixture.window.dispatchEvent(new fixture.window.Event('resize'));
    const gap = () => fixture.port.posts.some((message) =>
      (message as { code?: string }).code === 'stream_gap');
    resize();

    // A root comes just after that walk; the next layout change trusts it.
    now += 100;
    reader.attach(fixture.document.querySelector('#late')!, '<p>late text</p>');
    const timers = fixture.timers.length;
    resize();
    expect(gap()).toBe(false);
    expect(fixture.timers).toHaveLength(timers + 1);
    resize();
    expect(fixture.timers).toHaveLength(timers + 1);

    // When the interval ends, the walk owed asks again.
    now += 400;
    fixture.timers.pop()!();
    expect(gap()).toBe(true);
  });

  it('owes only the root walk at the end of a layout interval, not the layout work again (D125)', () => {
    let now = 1_000;
    const fixture = sourceFixture('<main><p>text</p></main>', closedRootReader(), {
      now: () => now,
    });
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const resize = () => fixture.window.dispatchEvent(new fixture.window.Event('resize'));
    resize();
    now += 100;
    resize();
    while (fixture.frames.length > 0) fixture.flushFrame();
    const posts = fixture.port.posts.length;

    // Nothing was attached: the walk owed finds nothing and asks for no
    // flush, no visibility refresh and no scroll report.
    now += 400;
    fixture.timers.pop()!();
    expect(fixture.frames).toHaveLength(0);
    expect(fixture.port.posts).toHaveLength(posts);
  });

  it('does not charge removed elements to a discovery tick (D125)', () => {
    const reader = closedRootReader();
    const rows = Array.from({ length: 1_000 }, (_, index) =>
      `<div class="row">row ${index}</div>`).join('');
    const fixture = sourceFixture(
      `<main><section id="rows">${rows}</section><div id="late"></div></main>`,
      reader,
    );
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const section = fixture.document.querySelector('#rows')!;
    const removed = [...section.childNodes];
    section.replaceChildren();
    fixture.mutate(childListRecord(section, [], removed));
    fixture.flushFrame();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, fixture.patches().at(-1)!.identity.sequence));

    reader.attach(fixture.document.querySelector('#late')!, '<p>late text</p>');
    fixture.runTimer();
    expect(fixture.port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v2:error',
      code: 'stream_gap',
    });
  });

  it.each([
    ['controls, which cannot hold a root', '<button>go</button>'],
    ['hosts whose closed root it holds', '<x-card></x-card>'],
  ])('keeps %s out of the discovery rotation (D125)', (_, element) => {
    const reader = closedRootReader();
    const fixture = sourceFixture(
      `<main>${element.repeat(1_000)}<div id="late"></div></main>`,
      reader,
    );
    for (const card of fixture.document.querySelectorAll('x-card')) {
      reader.attach(card, '<i>card</i>');
    }
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    // One tick asks about 1,000 waiting elements: the late host is among them.
    reader.attach(fixture.document.querySelector('#late')!, '<p>late text</p>');
    fixture.runTimer();
    expect(fixture.port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v2:error',
      code: 'stream_gap',
    });
  });

  it('rebuilds when a closed root changes after its host became masked (D125)', () => {
    const reader = closedRootReader();
    const fixture = sourceFixture('<main><x-pin id="pin"></x-pin></main>', reader);
    const pin = fixture.document.querySelector('#pin')!;
    const root = reader.attach(pin, '<span>public before masking</span>');
    let masked = false;
    maskWith(fixture, (element) => masked && element === pin);
    fixture.start();
    expect(JSON.stringify(fixture.checkpoints()[0])).toContain('public before masking');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    // The host is masked now; the change is recorded on its closed root.
    masked = true;
    const added = fixture.document.createElement('span');
    added.textContent = 'private after masking';
    root.append(added);
    fixture.mutate(childListRecord(root, [added]));
    expect(fixture.port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v2:error',
      code: 'stream_gap',
    });
    expect(JSON.stringify(fixture.port.posts)).not.toContain('private after masking');
  });

  it('notices a controller added inside a closed root (D125)', () => {
    const { document, window } = parseHTML(
      '<html><body><main id="page"></main></body></html>',
    );
    const reader = closedRootReader();
    installSourceShadowRootReader(document, reader.read);
    const policy = createSourceControlledContentPolicy(
      document as unknown as Document,
      window as unknown as Window,
    );
    const page = document.querySelector('#page')!;
    const host = document.createElement('x-menu');
    reader.attach(host, '<button aria-controls="later-panel">Open</button>');
    page.append(host);

    expect(sourceControlledContentMutationsMayChange(
      [childListRecord(page, [host])],
      policy,
    )).toBe(true);
  });

  it('observes every closed root it mirrors, beyond the bounded walk (D125)', () => {
    const reader = closedRootReader();
    const fixture = sourceFixture(
      `<main>${'<b>x</b>'.repeat(10_001)}<x-card id="card"></x-card></main>`,
      reader,
    );
    const root = reader.attach(fixture.document.querySelector('#card')!, '<p>card text</p>');
    fixture.start();
    expect(JSON.stringify(fixture.checkpoints()[0]).includes('card text')).toBe(true);
    // The walk after the checkpoint stops after 20,000 nodes, before the card.
    expect(fixture.session.shadowObservationVisitCount).toBe(20_000);
    expect(fixture.observed.includes(root)).toBe(true);
  });

  it.each(['open', 'closed'] as const)(
    'does not rebuild again for an %s root the checkpoint could not hold (D125)',
    (mode) => {
      const reader = closedRootReader();
      const fixture = sourceFixture(
        '<main id="page"><section id="otp" autocomplete="one-time-code">' +
          '<x-digit id="digit"></x-digit></section><p id="line">line</p></main>',
        reader,
      );
      const host = fixture.document.querySelector('#digit')!;
      // A root inside a credential region: the region travels as one opaque
      // shell, so no checkpoint can hold the root.
      let root: ShadowRoot;
      if (mode === 'closed') {
        root = reader.attach(host, '<b>digit seven</b>');
      } else {
        root = host.attachShadow({ mode: 'open' });
        Object.defineProperty(root, 'mode', { value: 'open' });
        root.innerHTML = '<b>digit seven</b>';
      }
      fixture.start();
      expect(JSON.stringify(fixture.checkpoints()[0])).not.toContain('digit seven');
      fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

      // Changes above the region used to ask for a checkpoint each time.
      const page = fixture.document.querySelector('#page')!;
      for (let round = 0; round < 3; round += 1) {
        const added = fixture.document.createElement('p');
        added.textContent = `added ${round}`;
        page.append(added);
        fixture.mutate(childListRecord(page, [added]));
        page.setAttribute('data-round', String(round));
        fixture.mutate(attributeRecord(page, 'data-round'));
        fixture.flushFrame();
        const patch = fixture.patches().at(-1)!;
        expect(JSON.stringify(patch)).toContain(`added ${round}`);
        fixture.port.emitMessage(createHtmlMirrorAck(identity, patch.identity.sequence));
      }
      expect(fixture.patches()).toHaveLength(3);
      expect(fixture.checkpoints()).toHaveLength(1);
      expect(fixture.port.posts.some((message) =>
        (message as { kind?: string }).kind === 'simul:html-mirror-v2:error')).toBe(false);
      expect(JSON.stringify(fixture.port.posts)).not.toContain('digit seven');

      // A root the mirror can hold still asks for its checkpoint.
      const line = fixture.document.querySelector('#line')!;
      if (mode === 'closed') {
        reader.attach(line, '<i>late root</i>');
      } else {
        const late = line.attachShadow({ mode: 'open' });
        Object.defineProperty(late, 'mode', { value: 'open' });
        late.innerHTML = '<i>late root</i>';
      }
      fixture.runTimer();
      expect(fixture.port.posts.at(-1)).toMatchObject({
        kind: 'simul:html-mirror-v2:error',
        code: 'stream_gap',
      });
    },
  );

  it('signals a stream gap instead of silently dropping a batch that throws', () => {
    const fixture = sourceFixture('<main><p id="guarded">before guard</p></main>');
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const text = fixture.document.querySelector('#guarded')!.firstChild as Text;
    const poisoned = new Proxy({}, {
      get: () => {
        throw new Error('observer record exploded');
      },
    }) as MutationRecord;

    text.nodeValue = 'after guard';
    expect(() => fixture.mutateAll([characterDataRecord(text), poisoned]))
      .not.toThrow();

    expect(fixture.frames).toHaveLength(0);
    expect(fixture.patches()).toHaveLength(0);
    expect(fixture.port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v2:error',
      code: 'stream_gap',
    });
    expect(JSON.stringify(fixture.port.posts)).not.toContain('exploded');

    fixture.port.emitMessage(createHtmlMirrorCheckpointRequest(identity, 0));
    expect(fixture.checkpoints()).toHaveLength(2);
    expect(JSON.stringify(fixture.checkpoints().at(-1))).toContain('after guard');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    text.nodeValue = 'resumed after guard';
    fixture.mutate(characterDataRecord(text));
    fixture.flushFrame();
    expect(JSON.stringify(fixture.patches().at(-1))).toContain('resumed after guard');
  });

  it('walks nested mutation targets once per batch without changing the patch', () => {
    const depth = 32;
    const fixture = sourceFixture('<main id="level-0"></main>');
    const levels: Element[] = [fixture.document.querySelector('#level-0')!];
    for (let index = 1; index < depth; index += 1) {
      const level = fixture.document.createElement('div');
      level.id = `level-${index}`;
      level.append(fixture.document.createTextNode(`level ${index}`));
      levels[index - 1]!.append(level);
      levels.push(level);
    }
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const visitedBefore = fixture.session.shadowObservationVisitCount;

    // Deepest first, so every later record's target contains the earlier ones.
    const records = levels.map((level, index) => {
      const added = fixture.document.createElement('span');
      added.textContent = `leaf ${index}`;
      level.append(added);
      return childListRecord(level, [added]);
    }).reverse();
    fixture.mutateAll(records);
    fixture.flushFrame();

    // Nested dirty targets collapse to one full-children patch at the
    // outermost target, exactly as before the walk was de-duplicated.
    const patch = fixture.patches().at(-1)!;
    expect(patch.operations).toEqual([
      expect.objectContaining({
        kind: 'children',
        nodeId: fixture.registry.peekId(levels[0]!),
      }),
    ]);
    const patchJson = JSON.stringify(patch);
    for (let index = 0; index < depth; index += 1) {
      expect(patchJson).toContain(`leaf ${index}`);
    }
    // Every node under the outermost target is visited at most once. A walk
    // per record would traverse the nested chain about depth² / 2 times.
    const nodesUnderRoot = depth * 4 - 1;
    const visited = fixture.session.shadowObservationVisitCount - visitedBefore;
    expect(visited).toBeLessThanOrEqual(nodesUnderRoot);
    expect(visited).toBeLessThan(depth * depth);
  });

  it('bounds open-shadow-root observation per batch and records the omission', () => {
    const fixture = sourceFixture(
      '<main><p id="budgeted">budget text</p></main><script></script>',
    );
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const omitted = fixture.document.querySelector('script')!;
    const bulk = fixture.document.createElement('div');
    const bulkNodeCount = 25_000;
    for (let index = 1; index < bulkNodeCount; index += 1) {
      bulk.append(fixture.document.createElement('i'));
    }
    omitted.append(bulk);
    const text = fixture.document.querySelector('#budgeted')!.firstChild as Text;
    const visitedBefore = fixture.session.shadowObservationVisitCount;

    text.nodeValue = 'budget text changed';
    fixture.mutateAll([
      childListRecord(omitted, [bulk]),
      characterDataRecord(text),
    ]);
    fixture.flushFrame();

    expect(fixture.session.shadowObservationVisitCount - visitedBefore)
      .toBeLessThan(bulkNodeCount);
    const patch = fixture.patches().at(-1)!;
    expect(JSON.stringify(patch)).toContain('budget text changed');
    expect(patch.representability.capacityOmissionCount).toBe(1);

    fixture.port.emitMessage(createHtmlMirrorAck(identity, 1));
    text.nodeValue = 'budget text settled';
    fixture.mutate(characterDataRecord(text));
    fixture.flushFrame();
    expect(fixture.patches().at(-1)?.representability.capacityOmissionCount)
      .toBe(0);
  });

  it('captures a pathologically deep document without recursing per node', () => {
    const depth = 12_000;
    const fixture = sourceFixture('<main id="deep-root"></main>');
    let parent: Element = fixture.document.querySelector('#deep-root')!;
    for (let index = 0; index < depth; index += 1) {
      const level = fixture.document.createElement('div');
      parent.append(level);
      parent = level;
    }
    parent.append(fixture.document.createTextNode('deep leaf'));

    fixture.start();

    expect(fixture.checkpoints()).toHaveLength(1);
    expect(fixture.port.posts.some(
      (message) => (message as { kind?: string }).kind ===
        'simul:html-mirror-v2:error',
    )).toBe(false);
  });

  it('detects CSSOM-only adopted stylesheet changes and recovers once', () => {
    const fixture = sourceFixture('<main class="page">styled content</main>');
    const rule = { cssText: '.page{display:grid}' };
    Object.defineProperty(fixture.document, 'adoptedStyleSheets', {
      configurable: true,
      value: [fakeStyleSheet(rule)],
    });
    fixture.start();
    expect(fixture.checkpoints()[0]?.payload.adoptedStyleSheets).toEqual([
      '.page{display:grid}',
    ]);
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    rule.cssText = '.page{display:block}';
    fixture.runTimer();
    rule.cssText = '.page{display:grid}';
    fixture.runTimer();
    expect(fixture.port.posts.some(
      (message) => (message as { code?: string }).code === 'stream_gap',
    )).toBe(false);

    rule.cssText = '.page{display:flex}';
    fixture.runTimer();
    fixture.runTimer();
    expect(fixture.port.posts.some(
      (message) => (message as { code?: string }).code === 'stream_gap',
    )).toBe(false);
    fixture.runTimer();
    expect(fixture.port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v2:error',
      code: 'stream_gap',
    });
    const gapsAfterChange = fixture.port.posts.filter(
      (message) => (message as { code?: string }).code === 'stream_gap',
    ).length;
    fixture.runTimer();
    expect(fixture.port.posts.filter(
      (message) => (message as { code?: string }).code === 'stream_gap',
    )).toHaveLength(gapsAfterChange);

    fixture.port.emitMessage(createHtmlMirrorCheckpointRequest(identity, 0));
    expect(fixture.checkpoints().at(-1)?.payload.adoptedStyleSheets).toEqual([
      '.page{display:flex}',
    ]);
  });

  it('detects CSSOM-only ordinary stylesheet changes and recaptures resolved rules', () => {
    const fixture = sourceFixture(
      '<style id="dynamic">.page{display:grid}</style>' +
      '<main class="page">styled content</main>',
    );
    const rule = { cssText: '.page{display:grid}' };
    const sheet = fakeStyleSheet(rule);
    const style = fixture.document.querySelector('#dynamic')!;
    Object.defineProperty(style, 'sheet', {
      configurable: true,
      value: sheet,
    });
    Object.defineProperty(fixture.document, 'styleSheets', {
      configurable: true,
      value: {
        0: sheet,
        length: 1,
        item: (index: number) => index === 0 ? sheet : null,
      },
    });

    fixture.start('passive');
    expect(JSON.stringify(fixture.checkpoints()[0])).toContain(
      '"resolvedStyleSheetText":".page{display:grid}"',
    );
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    rule.cssText = '.page{display:flex}';
    fixture.runTimer();
    fixture.runTimer();
    expect(fixture.port.posts.some(
      (message) => (message as { code?: string }).code === 'stream_gap',
    )).toBe(false);
    fixture.runTimer();
    expect(fixture.port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v2:error',
      code: 'stream_gap',
    });

    fixture.port.emitMessage(createHtmlMirrorCheckpointRequest(identity, 0));
    expect(JSON.stringify(fixture.checkpoints().at(-1))).toContain(
      '"resolvedStyleSheetText":".page{display:flex}"',
    );
  });

  it('quarantines oversized CSSOM polling without an idle recovery loop', () => {
    const fixture = sourceFixture('<main class="page">styled content</main>');
    // More sheets than one pass may read. A large sheet (D88) and sheets that
    // outgrow the budget together (D95) are watched by their shape instead.
    const oversized = Array.from(
      { length: 513 },
      () => fakeStyleSheetWithRules(1, '.page{}'),
    );
    let currentSheets = oversized;
    let styleSheetReads = 0;
    Object.defineProperty(fixture.document, 'styleSheets', {
      configurable: true,
      get: () => {
        styleSheetReads += 1;
        return styleSheetList(...currentSheets);
      },
    });

    fixture.start('passive');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    styleSheetReads = 0;
    fixture.runTimer();

    expect(styleSheetReads).toBeGreaterThan(0);
    expect(fixture.port.posts.some(
      (message) => (message as { code?: string }).code === 'stream_overflow',
    )).toBe(false);

    styleSheetReads = 0;
    fixture.runTimer();
    fixture.runTimer();
    expect(styleSheetReads).toBe(0);
    expect(fixture.port.posts.some(
      (message) => (message as { code?: string }).code === 'stream_overflow',
    )).toBe(false);

    currentSheets = [fakeStyleSheetWithRules(1, '.page{display:grid}')];
    for (let pass = 0; pass < 130; pass += 1) fixture.runTimer();
    expect(styleSheetReads).toBeGreaterThan(0);
    expect(fixture.port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v2:error',
      code: 'stream_gap',
    });
  });

  it('watches a sheet too large to reread by its shape, so rules a script adds still arrive (D88)', () => {
    // Wise carries a 2.4 M character design-system sheet. Reading it whole
    // each pass took the whole polling budget, so rules the page inserted
    // later (its signed-in side navigation) never reached the replica.
    const fixture = sourceFixture(
      '<style id="dynamic"></style><main class="page">styled content</main>',
    );
    const large = fakeStyleSheetWithRules(15_800, `.ds{${'x'.repeat(150)}}`);
    const dynamic = fakeStyleSheetWithRules(0, '');
    Object.defineProperty(fixture.document, 'styleSheets', {
      configurable: true,
      value: styleSheetList(large, dynamic),
    });
    fixture.start('passive');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    for (let pass = 0; pass < 4; pass += 1) fixture.runTimer();
    const gaps = () => fixture.port.posts.filter(
      (message) => (message as { code?: string }).code === 'stream_gap',
    ).length;
    expect(gaps()).toBe(0);

    // The page inserts a rule into its small sheet.
    (dynamic.cssRules as unknown as { cssText: string }[]).push({
      cssText: '.sidebar-container{position:fixed;top:0}',
    });
    for (let pass = 0; pass < 4; pass += 1) fixture.runTimer();
    expect(gaps()).toBe(1);
    expect(fixture.port.posts.some(
      (message) => (message as { code?: string }).code === 'stream_overflow',
    )).toBe(false);

    // A rule inserted into the large sheet itself changes its shape.
    fixture.port.emitMessage(createHtmlMirrorCheckpointRequest(identity, 0));
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    for (let pass = 0; pass < 4; pass += 1) fixture.runTimer();
    const before = gaps();
    (large.cssRules as unknown as { cssText: string }[]).push({
      cssText: '.late{display:grid}',
    });
    for (let pass = 0; pass < 4; pass += 1) fixture.runTimer();
    expect(gaps()).toBe(before + 1);
  });

  it('keeps polling a page whose medium sheets outgrow the budget together (D95)', () => {
    // Seven sheets of 3,900 rules each: none is large alone, but together
    // they pass the 25,000 rules one pass may read. The pass used to stop,
    // and the page was quarantined with no style polling at all.
    const fixture = sourceFixture(
      '<style id="dynamic"></style><main class="page">styled content</main>',
    );
    const medium = Array.from(
      { length: 7 },
      (_, index) => fakeStyleSheetWithRules(3_900, `.m${index}{color:red}`),
    );
    const dynamic = fakeStyleSheetWithRules(0, '');
    Object.defineProperty(fixture.document, 'styleSheets', {
      configurable: true,
      value: styleSheetList(...medium, dynamic),
    });
    fixture.start('passive');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const gaps = () => fixture.port.posts.filter(
      (message) => (message as { code?: string }).code === 'stream_gap',
    ).length;
    for (let pass = 0; pass < 4; pass += 1) fixture.runTimer();
    expect(gaps()).toBe(0);

    // A rule the page inserts after the budget ran out still arrives.
    (dynamic.cssRules as unknown as { cssText: string }[]).push({
      cssText: '.sidebar{position:fixed}',
    });
    for (let pass = 0; pass < 4; pass += 1) fixture.runTimer();
    expect(gaps()).toBe(1);
    // So does an in-place edit of a sheet read in full.
    fixture.port.emitMessage(createHtmlMirrorCheckpointRequest(identity, 0));
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    for (let pass = 0; pass < 4; pass += 1) fixture.runTimer();
    (medium[0]!.cssRules as unknown as { cssText: string }[])[5]!.cssText =
      '.m0{color:blue}';
    for (let pass = 0; pass < 4; pass += 1) fixture.runTimer();
    expect(gaps()).toBe(2);
    expect(fixture.port.posts.some(
      (message) => (message as { code?: string }).code === 'stream_overflow',
    )).toBe(false);
  });

  it('advances the shared style cursor after adopted-style budget exhaustion', () => {
    const fixture = sourceFixture(
      '<main><div id="first"></div><div id="second"></div></main>',
    );
    const first = fixture.document.querySelector('#first')!;
    const second = fixture.document.querySelector('#second')!;
    const firstShadow = first.attachShadow({ mode: 'open' });
    const secondShadow = second.attachShadow({ mode: 'open' });
    Object.defineProperty(firstShadow, 'mode', { value: 'open' });
    Object.defineProperty(secondShadow, 'mode', { value: 'open' });
    Object.defineProperty(firstShadow, 'adoptedStyleSheets', {
      configurable: true,
      value: [fakeStyleSheetWithRules(2_000, '.first{}')],
    });
    const documentSheets = Array.from(
      { length: 8 },
      () => fakeStyleSheetWithRules(3_000, '.page{}'),
    );
    Object.defineProperty(fixture.document, 'styleSheets', {
      configurable: true,
      value: styleSheetList(...documentSheets),
    });
    let secondRootReads = 0;
    Object.defineProperty(secondShadow, 'styleSheets', {
      configurable: true,
      get: () => {
        secondRootReads += 1;
        return styleSheetList();
      },
    });

    fixture.start('passive');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    secondRootReads = 0;

    fixture.runTimer();
    expect(secondRootReads).toBe(0);
    expect(fixture.port.posts.some(
      (message) => (message as { code?: string }).code === 'stream_overflow',
    )).toBe(false);

    fixture.runTimer();
    expect(secondRootReads).toBeGreaterThan(0);
  });

  it('rotates channels so saturated ordinary CSSOM cannot starve adopted changes', () => {
    const fixture = sourceFixture('<main class="page">styled content</main>');
    const ordinarySheet = fakeStyleSheetWithRules(24_000, '.page{}');
    const adoptedSheet = fakeStyleSheetWithRules(2_000, '.theme{}');
    const adoptedRule = adoptedSheet.cssRules[0] as unknown as {
      cssText: string;
    };
    Object.defineProperty(fixture.document, 'styleSheets', {
      configurable: true,
      value: styleSheetList(ordinarySheet),
    });
    Object.defineProperty(fixture.document, 'adoptedStyleSheets', {
      configurable: true,
      value: [adoptedSheet],
    });

    fixture.start('passive');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    adoptedRule.cssText = '.theme{color:blue}';

    fixture.runTimer();
    expect(fixture.port.posts.some(
      (message) => (message as { code?: string }).code === 'stream_gap',
    )).toBe(false);
    expect(fixture.port.posts.some(
      (message) => (message as { code?: string }).code === 'stream_overflow',
    )).toBe(false);

    fixture.runTimer();
    expect(fixture.port.posts.some(
      (message) => (message as { code?: string }).code === 'stream_gap',
    )).toBe(false);
    for (let attempt = 0; attempt < 4; attempt += 1) fixture.runTimer();
    expect(fixture.port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v2:error',
      code: 'stream_gap',
    });
  });

  it('preserves a programmatically disabled ordinary stylesheet', () => {
    const fixture = sourceFixture(
      '<link id="theme" rel="stylesheet" href="/theme.css">' +
      '<main class="page">styled content</main>',
    );
    const sheet = fakeStyleSheet({ cssText: '.page{display:grid}' });
    Object.defineProperty(sheet, 'disabled', {
      configurable: true,
      value: true,
    });
    const link = fixture.document.querySelector('#theme')!;
    Object.defineProperty(link, 'sheet', {
      configurable: true,
      value: sheet,
    });

    fixture.start('passive');

    const graph = fixture.checkpoints()[0]?.payload.root;
    const serialized = JSON.stringify(graph);
    expect(serialized).toContain('["disabled",""]');
    expect(serialized).toContain('"resolvedStyleSheetText":');
  });

  it('coalesces real document scroll into one bounded transport update per frame', () => {
    const fixture = sourceFixture('<main>scrolling page</main>');
    const root = fixture.document.documentElement;
    let scrollY = 0;
    Object.defineProperty(fixture.document, 'scrollingElement', {
      configurable: true,
      value: root,
    });
    Object.defineProperties(fixture.window, {
      innerWidth: { configurable: true, value: 800 },
      innerHeight: { configurable: true, value: 600 },
      scrollX: { configurable: true, value: 0 },
      scrollY: { configurable: true, get: () => scrollY },
    });
    Object.defineProperties(root, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 600 },
      scrollWidth: { configurable: true, value: 800 },
      scrollHeight: { configurable: true, value: 2_000 },
      scrollLeft: { configurable: true, value: 0 },
      scrollTop: { configurable: true, get: () => scrollY },
    });

    fixture.start();
    expect(fixture.scrolls()).toHaveLength(1);

    scrollY = 120;
    root.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    scrollY = 240;
    root.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));

    expect(fixture.frames).toHaveLength(1);
    fixture.flushFrame();
    expect(fixture.scrolls()).toHaveLength(2);
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      scrollX: 0,
      scrollY: 240,
      maxScrollX: 0,
      maxScrollY: 1_400,
    });
  });

  it('reports a pinch zoom and panning inside it with the scroll position (D115)', () => {
    const fixture = sourceFixture('<main>pinched page</main>');
    const root = fixture.document.documentElement;
    Object.defineProperty(fixture.document, 'scrollingElement', {
      configurable: true,
      value: root,
    });
    Object.defineProperties(root, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 600 },
      scrollWidth: { configurable: true, value: 800 },
      scrollHeight: { configurable: true, value: 2_000 },
      scrollLeft: { configurable: true, value: 0 },
      scrollTop: { configurable: true, value: 300 },
    });
    // A pinch zoom fires on the visual viewport only; the window's size and
    // scroll position stay as they are.
    const listeners = new Map<string, Set<() => void>>();
    const visualViewport = {
      scale: 1,
      offsetLeft: 0,
      offsetTop: 0,
      addEventListener: (type: string, listener: () => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      },
      removeEventListener: (type: string, listener: () => void) => {
        listeners.get(type)?.delete(listener);
      },
    };
    const fire = (type: string) => {
      for (const listener of listeners.get(type) ?? []) listener();
    };
    Object.defineProperties(fixture.window, {
      innerWidth: { configurable: true, value: 800 },
      innerHeight: { configurable: true, value: 600 },
      scrollX: { configurable: true, value: 0 },
      scrollY: { configurable: true, value: 300 },
      visualViewport: { configurable: true, value: visualViewport },
    });

    fixture.start();
    expect(fixture.scrolls()).toHaveLength(1);
    expect(fixture.scrolls()[0]?.scroll).not.toHaveProperty('visualScale');

    visualViewport.scale = 2;
    visualViewport.offsetLeft = 200;
    visualViewport.offsetTop = 150;
    fire('resize');
    fire('scroll');
    expect(fixture.frames).toHaveLength(1);
    fixture.flushFrame();
    expect(fixture.scrolls()).toHaveLength(2);
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      scrollX: 0,
      scrollY: 300,
      maxScrollX: 0,
      maxScrollY: 1_400,
      visualScale: 2,
      visualOffsetX: 200,
      visualOffsetY: 150,
    });

    // Panning inside the magnified view, then back out.
    visualViewport.offsetLeft = 275;
    fire('scroll');
    fixture.flushFrame();
    expect(fixture.scrolls().at(-1)?.scroll).toMatchObject({
      visualScale: 2, visualOffsetX: 275, visualOffsetY: 150,
    });
    visualViewport.scale = 1;
    visualViewport.offsetLeft = 0;
    visualViewport.offsetTop = 0;
    fire('resize');
    fixture.flushFrame();
    expect(fixture.scrolls().at(-1)?.scroll).not.toHaveProperty('visualScale');

    // A disposed session listens no more.
    fixture.session.dispose();
    expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
  });

  it('reports a pane that scrolls on its own by its mirror node id, once a frame (D122)', () => {
    const fixture = sourceFixture(
      '<div id="board">cards</div><div id="chat">messages</div>' +
        '<textarea id="editor">draft</textarea>',
    );
    const page = defineDocumentScroll(fixture);
    definePlainComputedStyle(fixture);
    const board = fixture.document.querySelector('#board')!;
    const chat = fixture.document.querySelector('#chat')!;
    const editor = fixture.document.querySelector('#editor')!;
    const boardBox = defineScrollBox(board, {
      clientWidth: 800, clientHeight: 500, scrollWidth: 6_830, scrollHeight: 500,
    });
    const chatBox = defineScrollBox(chat, {
      clientWidth: 400, clientHeight: 300, scrollWidth: 400, scrollHeight: 2_265,
    });
    const editorBox = defineScrollBox(editor, {
      clientWidth: 400, clientHeight: 120, scrollWidth: 400, scrollHeight: 900,
    });

    fixture.start();
    expect(fixture.scrolls()).toHaveLength(1);
    // The report that follows a checkpoint carries the whole pane list,
    // here an empty one: no pane is scrolled.
    expect(fixture.scrolls()[0]?.scroll).toEqual({
      scrollX: 0, scrollY: 0, maxScrollX: 0, maxScrollY: 1_400, panes: [],
    });

    // Several events of one frame make one read and one message.
    boardBox.scrollLeft = 400;
    board.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    boardBox.scrollLeft = 900;
    board.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    chatBox.scrollTop = 600;
    chat.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    expect(fixture.frames).toHaveLength(1);
    fixture.flushFrame();
    expect(fixture.scrolls()).toHaveLength(2);
    const boardPane = {
      nodeId: fixture.registry.peekId(board),
      scrollX: 900, scrollY: 0, maxScrollX: 6_030, maxScrollY: 0,
    };
    const chatPane = {
      nodeId: fixture.registry.peekId(chat),
      scrollX: 0, scrollY: 600, maxScrollX: 0, maxScrollY: 1_965,
    };
    // The document's place is the document's, and no pane stands in for it.
    // The panes that moved are named, and the panel knows of both.
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      scrollX: 0, scrollY: 0, maxScrollX: 0, maxScrollY: 1_400,
      movedPanes: [boardPane, chatPane],
    });
    expect(fixture.panes()).toEqual([boardPane, chatPane]);

    // A text field keeps its own scroll: its event sends nothing at all.
    editorBox.scrollTop = 300;
    editor.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    fixture.flushFrame();
    expect(fixture.scrolls()).toHaveLength(2);

    // An element the mirror does not know sends nothing, and gets no id.
    const stranger = fixture.document.createElement('div');
    fixture.document.body.append(stranger);
    defineScrollBox(stranger, {
      clientWidth: 400, clientHeight: 300, scrollWidth: 400, scrollHeight: 900,
    }).scrollTop = 200;
    stranger.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    fixture.flushFrame();
    expect(fixture.scrolls()).toHaveLength(2);
    expect(fixture.registry.peekId(stranger)).toBeUndefined();

    // The document scrolls: the panes are where they were, so none is
    // named and the message is the size it is on a page without panes.
    page.scrollY = 240;
    fixture.document.documentElement.dispatchEvent(
      new fixture.window.Event('scroll', { bubbles: true }),
    );
    fixture.flushFrame();
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      scrollX: 0, scrollY: 240, maxScrollX: 0, maxScrollY: 1_400,
    });
    // A layout change re-reports the place, again without a list.
    fixture.window.dispatchEvent(new fixture.window.Event('resize'));
    expect(fixture.scrolls().at(-1)?.scroll).not.toHaveProperty('panes');
    expect(fixture.scrolls().at(-1)?.scroll).not.toHaveProperty('movedPanes');
    // The page and a pane move in one frame: the pane that moved travels
    // with the place, and no other.
    page.scrollY = 300;
    fixture.document.documentElement.dispatchEvent(
      new fixture.window.Event('scroll', { bubbles: true }),
    );
    chatBox.scrollTop = 700;
    chat.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    fixture.flushFrame();
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      scrollX: 0, scrollY: 300, maxScrollX: 0, maxScrollY: 1_400,
      movedPanes: [{ ...chatPane, scrollY: 700 }],
    });
    expect(fixture.panes()).toEqual([boardPane, { ...chatPane, scrollY: 700 }]);

    // Back at its start a pane is named with its offsets at 0, and the
    // panel lists it no longer.
    chatBox.scrollTop = 0;
    chat.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    boardBox.scrollLeft = 1_200;
    board.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    fixture.flushFrame();
    expect(fixture.scrolls().at(-1)?.scroll.movedPanes).toEqual([
      { ...boardPane, scrollX: 1_200 },
      {
        nodeId: chatPane.nodeId,
        scrollX: 0, scrollY: 0, maxScrollX: 0, maxScrollY: 0,
      },
    ]);
    expect(fixture.panes()).toEqual([{ ...boardPane, scrollX: 1_200 }]);
    // The last pane goes back to its start: it alone is named, at 0, and
    // the panel's list is empty.
    boardBox.scrollLeft = 0;
    board.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    fixture.flushFrame();
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      scrollX: 0, scrollY: 300, maxScrollX: 0, maxScrollY: 1_400,
      movedPanes: [paneAtStart(boardPane.nodeId)],
    });
    expect(fixture.panes()).toEqual([]);

    // A disposed session reports nothing more.
    const count = fixture.scrolls().length;
    fixture.session.dispose();
    board.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    expect(fixture.frames).toHaveLength(0);
    expect(fixture.scrolls()).toHaveLength(count);
  });

  it('reports panes already scrolled when the mirror is built, and again with a recovery checkpoint (D122)', () => {
    const fixture = sourceFixture(
      '<div id="chat">messages</div><pre id="code">lines</pre>' +
        '<textarea id="editor">draft</textarea>',
    );
    const page = defineDocumentScroll(fixture);
    const chat = fixture.document.querySelector('#chat')!;
    const code = fixture.document.querySelector('#code')!;
    defineScrollBox(chat, {
      clientWidth: 400, clientHeight: 300, scrollWidth: 400, scrollHeight: 2_265,
      scrollTop: 600,
    });
    defineScrollBox(code, {
      clientWidth: 400, clientHeight: 300, scrollWidth: 1_129, scrollHeight: 2_892,
      scrollLeft: 250, scrollTop: 400,
    });
    defineScrollBox(fixture.document.querySelector('#editor')!, {
      clientWidth: 400, clientHeight: 120, scrollWidth: 400, scrollHeight: 900,
      scrollTop: 300,
    });
    // The page itself is scrolled too: that is the document's place.
    page.scrollY = 240;

    fixture.start();
    const panes = [
      {
        nodeId: fixture.registry.peekId(chat),
        scrollX: 0, scrollY: 600, maxScrollX: 0, maxScrollY: 1_965,
      },
      {
        nodeId: fixture.registry.peekId(code),
        scrollX: 250, scrollY: 400, maxScrollX: 729, maxScrollY: 2_592,
      },
    ];
    expect(fixture.scrolls()).toHaveLength(1);
    expect(fixture.scrolls()[0]?.scroll).toEqual({
      scrollX: 0, scrollY: 240, maxScrollX: 0, maxScrollY: 1_400, panes,
    });
    // The report follows the checkpoint it belongs to.
    expect(fixture.port.posts.map((message) => (message as { kind: string }).kind))
      .toEqual([
        'simul:html-mirror-v2:checkpoint',
        'simul:html-mirror-v2:scroll',
      ]);

    // A recovery checkpoint builds the replica anew: the whole list is
    // sent again with it, where a plain report would name no pane.
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    fixture.window.dispatchEvent(new fixture.window.Event('resize'));
    expect(fixture.scrolls().at(-1)?.scroll).not.toHaveProperty('panes');
    expect(fixture.scrolls().at(-1)?.scroll).not.toHaveProperty('movedPanes');
    fixture.port.emitMessage(createHtmlMirrorCheckpointRequest(identity, 0));
    expect(fixture.checkpoints()).toHaveLength(2);
    expect(fixture.scrolls().at(-1)?.scroll.panes).toEqual(panes);
  });

  it('reports the panes afresh after a patch, and keeps a hidden pane in mind (D122)', () => {
    const fixture = sourceFixture('<div id="chat"><p id="last">message</p></div>');
    defineDocumentScroll(fixture);
    definePlainComputedStyle(fixture);
    const chat = fixture.document.querySelector('#chat')!;
    const last = fixture.document.querySelector('#last')!;
    const chatBox = defineScrollBox(chat, {
      clientWidth: 400, clientHeight: 300, scrollWidth: 400, scrollHeight: 2_265,
    });
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const nodeId = fixture.registry.peekId(chat);

    // No pane is scrolled: a patch is not followed by a scroll message.
    last.setAttribute('class', 'new');
    fixture.mutate(attributeRecord(last, 'class'));
    fixture.flushFrame();
    expect(fixture.patches()).toHaveLength(1);
    expect(fixture.scrolls()).toHaveLength(1);

    chatBox.scrollTop = 600;
    chat.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    fixture.flushFrame();
    expect(fixture.scrolls()).toHaveLength(2);

    // The pane grows without a scroll event: its new range follows the patch.
    chatBox.scrollHeight = 2_640;
    last.setAttribute('class', 'newer');
    fixture.mutate(attributeRecord(last, 'class'));
    fixture.flushFrame();
    expect(fixture.patches()).toHaveLength(2);
    expect(fixture.port.posts.at(-2)).toBe(fixture.patches()[1]);
    const grown = { nodeId, scrollX: 0, scrollY: 600, maxScrollX: 0, maxScrollY: 2_340 };
    expect(fixture.scrolls()).toHaveLength(3);
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      ...PAGE_AT_START, movedPanes: [grown],
    });
    expect(fixture.panes()).toEqual([grown]);

    // A patch that leaves the panes where they are is followed by no report.
    const reports = fixture.scrolls().length;
    last.setAttribute('class', 'newest');
    fixture.mutate(attributeRecord(last, 'class'));
    fixture.flushFrame();
    expect(fixture.patches()).toHaveLength(3);
    expect(fixture.scrolls()).toHaveLength(reports);
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 3));

    // Hidden, the pane has no box and reads as at its start: not listed.
    const shown = { ...chatBox };
    Object.assign(chatBox, {
      clientWidth: 0, clientHeight: 0, scrollWidth: 0, scrollHeight: 0, scrollTop: 0,
    });
    chat.setAttribute('hidden', '');
    fixture.mutate(attributeRecord(chat, 'hidden'));
    fixture.flushFrame();
    expect(fixture.scrolls()).toHaveLength(reports + 1);
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      ...PAGE_AT_START, movedPanes: [paneAtStart(nodeId)],
    });
    expect(fixture.panes()).toEqual([]);
    // Shown again, Chrome gives it its place back with no scroll event.
    Object.assign(chatBox, shown);
    chat.removeAttribute('hidden');
    fixture.mutate(attributeRecord(chat, 'hidden'));
    fixture.flushFrame();
    expect(fixture.scrolls()).toHaveLength(reports + 2);
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      ...PAGE_AT_START, movedPanes: [grown],
    });
    expect(fixture.panes()).toEqual([grown]);

    // Taken out of the page, it is forgotten.
    fixture.port.emitMessage(createHtmlMirrorAck(identity, fixture.patches().length));
    chat.remove();
    Object.defineProperty(chat, 'isConnected', { configurable: true, value: false });
    fixture.mutate(childListRecord(fixture.document.body, [], [chat]));
    fixture.flushFrame();
    expect(fixture.scrolls()).toHaveLength(reports + 3);
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      ...PAGE_AT_START, movedPanes: [paneAtStart(nodeId)],
    });
    expect(fixture.panes()).toEqual([]);
  });

  it('keeps a pane scrolled before the mirror has it in mind, and names it after its patch (D122)', () => {
    const fixture = sourceFixture('<div id="keep">kept</div>');
    defineDocumentScroll(fixture);
    definePlainComputedStyle(fixture);
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    // A chat opened at its end: the element is made and scrolled in one go,
    // and its scroll frame runs before the patch that carries it.
    const made = fixture.document.createElement('div');
    made.textContent = 'rows';
    fixture.document.body.append(made);
    defineScrollBox(made, {
      clientWidth: 400, clientHeight: 300, scrollWidth: 400, scrollHeight: 900,
    }).scrollTop = 200;
    made.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    fixture.flushFrame();
    // Nothing is sent for an element the mirror does not know, and no id is
    // made for it.
    expect(fixture.scrolls()).toHaveLength(1);
    expect(fixture.registry.peekId(made)).toBeUndefined();

    fixture.mutate(childListRecord(fixture.document.body, [made]));
    fixture.flushFrame();
    expect(fixture.patches()).toHaveLength(1);
    // The report follows the patch that gave the element its id.
    expect(fixture.port.posts.at(-2)).toBe(fixture.patches()[0]);
    const madePane = {
      nodeId: fixture.registry.peekId(made),
      scrollX: 0, scrollY: 200, maxScrollX: 0, maxScrollY: 600,
    };
    expect(fixture.scrolls()).toHaveLength(2);
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      ...PAGE_AT_START, movedPanes: [madePane],
    });
    expect(fixture.panes()).toEqual([madePane]);
  });

  it('names a pane whose patch and scroll come in either order of frames (D122)', () => {
    const fixture = sourceFixture('<div id="keep">kept</div>');
    defineDocumentScroll(fixture);
    definePlainComputedStyle(fixture);
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const made = fixture.document.createElement('div');
    made.textContent = 'rows';
    fixture.document.body.append(made);
    defineScrollBox(made, {
      clientWidth: 400, clientHeight: 300, scrollWidth: 400, scrollHeight: 900,
    }).scrollTop = 200;
    // The mutation is seen first, so the flush frame runs before the scroll
    // frame: the patch goes out, then the pane's place.
    fixture.mutate(childListRecord(fixture.document.body, [made]));
    made.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    expect(fixture.frames).toHaveLength(2);
    fixture.flushFrame();
    fixture.flushFrame();
    expect(fixture.port.posts.slice(-2).map(
      (message) => (message as { kind: string }).kind,
    )).toEqual(['simul:html-mirror-v2:patch', 'simul:html-mirror-v2:scroll']);
    const madePane = {
      nodeId: fixture.registry.peekId(made),
      scrollX: 0, scrollY: 200, maxScrollX: 0, maxScrollY: 600,
    };
    expect(fixture.scrolls()).toHaveLength(2);
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      ...PAGE_AT_START, movedPanes: [madePane],
    });
    expect(fixture.panes()).toEqual([madePane]);
  });

  it('hears a pane inside an open shadow root as the element that scrolled (D122)', () => {
    const fixture = sourceFixture('<x-list id="host"></x-list>');
    defineDocumentScroll(fixture);
    definePlainComputedStyle(fixture);
    const host = fixture.document.querySelector('#host')!;
    const root = host.attachShadow({ mode: 'open' });
    Object.defineProperty(root, 'mode', { value: 'open' });
    const list = fixture.document.createElement('div');
    list.textContent = 'items';
    root.append(list);
    const box = defineScrollBox(list, {
      clientWidth: 400, clientHeight: 300, scrollWidth: 400, scrollHeight: 900,
    });
    fixture.start();
    const nodeId = fixture.registry.peekId(list);
    expect(nodeId).toBeDefined();

    // Outside the shadow root the event's target is the host; the element
    // that scrolled is the first of its composed path.
    box.scrollTop = 150;
    const event = new fixture.window.Event('scroll', { bubbles: true });
    Object.defineProperty(event, 'composedPath', {
      configurable: true,
      value: () => [list, root, host],
    });
    host.dispatchEvent(event);
    fixture.flushFrame();
    const listPane = { nodeId, scrollX: 0, scrollY: 150, maxScrollX: 0, maxScrollY: 600 };
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      ...PAGE_AT_START, movedPanes: [listPane],
    });
    expect(fixture.panes()).toEqual([listPane]);
  });

  it('names the viewport-scale pane the tab scrolls in place of its document (D122)', () => {
    const fixture = sourceFixture(
      '<main id="feed" style="overflow-y:auto">feed</main>' +
        '<div id="strip">cards</div>',
    );
    const page = defineDocumentScroll(fixture);
    const feed = fixture.document.querySelector('#feed')!;
    const strip = fixture.document.querySelector('#strip')!;
    const feedBox = defineScrollBox(feed, {
      clientWidth: 700, clientHeight: 560, scrollWidth: 700, scrollHeight: 4_560,
    }, { left: 50, top: 20, right: 750, bottom: 580 });
    const stripBox = defineScrollBox(strip, {
      clientWidth: 700, clientHeight: 80, scrollWidth: 3_700, scrollHeight: 80,
    });
    Object.defineProperty(fixture.window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => ({
        backgroundColor: 'rgba(0, 0, 0, 0)',
        overflowY: element === feed ? 'auto' : 'visible',
        getPropertyValue: () => '',
      }),
    });
    fixture.start();
    const feedId = fixture.registry.peekId(feed);
    const stripId = fixture.registry.peekId(strip);

    feedBox.scrollTop = 1_000;
    feed.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    fixture.flushFrame();
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      scrollX: 0, scrollY: 0, maxScrollX: 0, maxScrollY: 1_400,
      movedPanes: [
        { nodeId: feedId, scrollX: 0, scrollY: 1_000, maxScrollX: 0, maxScrollY: 4_000 },
      ],
      primaryPaneId: feedId,
    });

    // A small pane scrolls: it alone is named as moved, and the feed stays
    // the one scrolled in place of the document.
    stripBox.scrollLeft = 300;
    strip.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    fixture.flushFrame();
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      ...PAGE_AT_START,
      movedPanes: [
        { nodeId: stripId, scrollX: 300, scrollY: 0, maxScrollX: 3_000, maxScrollY: 0 },
      ],
      primaryPaneId: feedId,
    });
    expect(fixture.known()).toMatchObject({
      panes: [{ nodeId: feedId }, { nodeId: stripId, scrollX: 300 }],
      primaryPaneId: feedId,
    });

    // The document scrolls: no pane stands in for it any more, which a list
    // that names no moved pane says; both stay listed.
    page.scrollY = 120;
    fixture.document.documentElement.dispatchEvent(
      new fixture.window.Event('scroll', { bubbles: true }),
    );
    fixture.flushFrame();
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      scrollX: 0, scrollY: 120, maxScrollX: 0, maxScrollY: 1_400, movedPanes: [],
    });
    expect(fixture.known()).not.toHaveProperty('primaryPaneId');
    expect(fixture.panes()).toHaveLength(2);
    // The page scrolls on: nothing about the panes is said again.
    page.scrollY = 160;
    fixture.document.documentElement.dispatchEvent(
      new fixture.window.Event('scroll', { bubbles: true }),
    );
    fixture.flushFrame();
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      scrollX: 0, scrollY: 160, maxScrollX: 0, maxScrollY: 1_400,
    });

    // Back at its start the feed is not listed, so it is not named either:
    // the message names it at 0, and no pane as the one in the document's
    // place.
    feedBox.scrollTop = 0;
    feed.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    fixture.flushFrame();
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      scrollX: 0, scrollY: 160, maxScrollX: 0, maxScrollY: 1_400,
      movedPanes: [paneAtStart(feedId)],
    });
    expect(fixture.known()).not.toHaveProperty('primaryPaneId');
    expect(fixture.panes()).toEqual([
      { nodeId: stripId, scrollX: 300, scrollY: 0, maxScrollX: 3_000, maxScrollY: 0 },
    ]);
    // The feed scrolls again: it is named, and as that pane, in one message.
    feedBox.scrollTop = 40;
    feed.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    fixture.flushFrame();
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      scrollX: 0, scrollY: 160, maxScrollX: 0, maxScrollY: 1_400,
      movedPanes: [
        { nodeId: feedId, scrollX: 0, scrollY: 40, maxScrollX: 0, maxScrollY: 4_000 },
      ],
      primaryPaneId: feedId,
    });
  });

  it('sends nothing for a pane inside a withheld region (D122)', () => {
    const fixture = sourceFixture(
      '<section id="account"><div id="inside">private rows</div></section>' +
        '<div id="plain">public rows</div>',
    );
    defineDocumentScroll(fixture);
    const account = fixture.document.querySelector<HTMLElement>('#account')!;
    Object.defineProperty(fixture.window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => ({
        backgroundColor: 'rgba(0, 0, 0, 0)',
        getPropertyValue: (name: string) =>
          name === '-webkit-text-security' && element === account ? 'disc' : '',
      }),
    });
    const inside = fixture.document.querySelector('#inside')!;
    const plain = fixture.document.querySelector('#plain')!;
    const box = {
      clientWidth: 400, clientHeight: 300, scrollWidth: 400, scrollHeight: 2_300,
      scrollTop: 500,
    };
    defineScrollBox(account, box);
    defineScrollBox(inside, box);
    defineScrollBox(plain, box);

    fixture.start();
    expect(JSON.stringify(fixture.checkpoints()[0])).toContain('opaquePlaceholder');
    // Found scrolled at the start, and scrolled again afterwards: the shell
    // of the withheld region and what is inside it never travel.
    expect(fixture.scrolls()).toHaveLength(1);
    expect(fixture.scrolls()[0]?.scroll.panes).toEqual([{
      nodeId: fixture.registry.peekId(plain),
      scrollX: 0, scrollY: 500, maxScrollX: 0, maxScrollY: 2_000,
    }]);
    for (const element of [account, inside]) {
      element.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    }
    fixture.flushFrame();
    expect(fixture.scrolls()).toHaveLength(1);
    expect(fixture.registry.peekId(inside)).toBeUndefined();
  });

  it('follows at most the bounded number of panes, the most recently scrolled (D122)', () => {
    const count = MAX_HTML_MIRROR_SCROLL_PANES + 6;
    const fixture = sourceFixture(
      Array.from({ length: count }, (_, index) => `<div class="strip">${index}</div>`).join(''),
    );
    defineDocumentScroll(fixture);
    const strips = [...fixture.document.querySelectorAll('.strip')];
    const boxes = strips.map((strip) => defineScrollBox(strip, {
      clientWidth: 400, clientHeight: 80, scrollWidth: 2_400, scrollHeight: 80,
    }));
    fixture.start();

    // One at a time, a frame each: more than the mirror follows. Each
    // message names the pane that moved, and past the bound the one that
    // is followed no longer, at its start.
    const placeOf = (index: number): number => 100 + (index % 1_000);
    strips.forEach((strip, index) => {
      boxes[index]!.scrollLeft = placeOf(index);
      strip.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
      fixture.flushFrame();
    });
    expect(fixture.scrolls().at(-1)?.scroll.movedPanes).toEqual([
      {
        nodeId: fixture.registry.peekId(strips.at(-1)!),
        scrollX: placeOf(count - 1), scrollY: 0, maxScrollX: 2_000, maxScrollY: 0,
      },
      {
        nodeId: fixture.registry.peekId(strips[5]!),
        scrollX: 0, scrollY: 0, maxScrollX: 0, maxScrollY: 0,
      },
    ]);
    const panes = fixture.panes()!;
    expect(panes).toHaveLength(MAX_HTML_MIRROR_SCROLL_PANES);
    expect(panes[0]).toMatchObject({
      nodeId: fixture.registry.peekId(strips[6]!), scrollX: 106,
    });
    expect(panes.at(-1)).toMatchObject({
      nodeId: fixture.registry.peekId(strips.at(-1)!), scrollX: placeOf(count - 1),
    });
  });

  it('follows none of a burst of more panes than the mirror follows (D122)', () => {
    const count = MAX_HTML_MIRROR_SCROLL_PANES + 6;
    const fixture = sourceFixture(
      '<div id="alone">alone</div>' +
        Array.from({ length: count }, (_, index) => `<div class="row">${index}</div>`).join(''),
    );
    defineDocumentScroll(fixture);
    definePlainComputedStyle(fixture);
    const alone = fixture.document.querySelector('#alone')!;
    const aloneBox = defineScrollBox(alone, {
      clientWidth: 400, clientHeight: 300, scrollWidth: 400, scrollHeight: 900,
    });
    const rows = [...fixture.document.querySelectorAll('.row')];
    const boxes = rows.map((row) => defineScrollBox(row, {
      clientWidth: 400, clientHeight: 80, scrollWidth: 2_400, scrollHeight: 80,
    }));
    fixture.start();
    aloneBox.scrollTop = 120;
    alone.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    fixture.flushFrame();
    const alonePane = {
      nodeId: fixture.registry.peekId(alone),
      scrollX: 0, scrollY: 120, maxScrollX: 0, maxScrollY: 600,
    };
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      ...PAGE_AT_START, movedPanes: [alonePane],
    });
    expect(fixture.panes()).toEqual([alonePane]);
    const reports = fixture.scrolls().length;
    const rowIds = rows.map((row) => fixture.registry.peekId(row) as number);
    const rowsAt = (from: number, to: number, scrollX: number) => ({
      nodeId: rowIds[from],
      scrollX, scrollY: 0, maxScrollX: scrollX === 0 ? 0 : 2_000, maxScrollY: 0,
      alsoNodeIds: rowIds.slice(from + 1, to),
    });

    // Rows of a grid that a script keeps in step: all of them scroll in one
    // frame. A part of them followed would show the grid torn apart, so
    // none is, frame after frame; the pane scrolled on its own stays.
    const together = (scrollLeft: number): void => {
      rows.forEach((row, index) => {
        boxes[index]!.scrollLeft = scrollLeft;
        row.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
      });
      expect(fixture.frames).toHaveLength(1);
      fixture.flushFrame();
    };
    together(500);
    together(510);
    expect(fixture.scrolls()).toHaveLength(reports);

    // A burst the bound holds is followed whole.
    rows.slice(0, 40).forEach((row, index) => {
      boxes[index]!.scrollLeft = 700;
      row.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    });
    fixture.flushFrame();
    // Forty rows at one place travel as one entry, and nothing else does.
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      ...PAGE_AT_START, movedPanes: [rowsAt(0, 40, 700)],
    });
    expect(fixture.panes()).toHaveLength(41);
    // The next burst of all rows takes back the ones it names: they are
    // named at 0, the pane scrolled on its own is not named at all.
    together(520);
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      ...PAGE_AT_START, movedPanes: [rowsAt(0, 40, 0)],
    });
    expect(fixture.panes()).toEqual([alonePane]);

    // Rows followed before whose scroll events come after the last one a
    // frame keeps: the burst moved them too, and nothing kept their events.
    // They are taken back with the rest, never left where the panel was
    // last told (neither their start nor the tab's place).
    rows.slice(-3).forEach((row, index) => {
      boxes[count - 3 + index]!.scrollLeft = 900;
      row.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    });
    fixture.flushFrame();
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      ...PAGE_AT_START, movedPanes: [rowsAt(count - 3, count, 900)],
    });
    together(530);
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      ...PAGE_AT_START, movedPanes: [rowsAt(count - 3, count, 0)],
    });
    expect(fixture.panes()).toEqual([alonePane]);
    // Burst after burst says nothing more about them.
    const afterBursts = fixture.scrolls().length;
    together(540);
    expect(fixture.scrolls()).toHaveLength(afterBursts);
    // One of them scrolls by itself: followed from there.
    boxes[count - 1]!.scrollLeft = 610;
    rows[count - 1]!.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    fixture.flushFrame();
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      ...PAGE_AT_START,
      movedPanes: [{
        nodeId: rowIds[count - 1],
        scrollX: 610, scrollY: 0, maxScrollX: 2_000, maxScrollY: 0,
      }],
    });
    // A followed pane whose range alone changed in a burst's frame did not
    // move with it and stays followed.
    boxes[count - 1]!.scrollWidth = 2_900;
    rows.slice(0, MAX_HTML_MIRROR_SCROLL_PANES + 1).forEach((row, index) => {
      boxes[index]!.scrollLeft = 550;
      row.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    });
    fixture.flushFrame();
    expect(fixture.panes()).toEqual([alonePane, {
      nodeId: rowIds[count - 1],
      scrollX: 610, scrollY: 0, maxScrollX: 2_000, maxScrollY: 0,
    }]);
  });

  it('takes none of more scrolled panes than the mirror follows when the mirror is built (D122)', () => {
    const rows = (count: number) => {
      const fixture = sourceFixture(
        Array.from({ length: count }, (_, index) => `<div class="row">${index}</div>`).join(''),
      );
      defineDocumentScroll(fixture);
      for (const row of fixture.document.querySelectorAll('.row')) {
        defineScrollBox(row, {
          clientWidth: 400, clientHeight: 80, scrollWidth: 2_400, scrollHeight: 80,
          scrollLeft: 500,
        });
      }
      fixture.start();
      expect(fixture.scrolls()).toHaveLength(1);
      return fixture;
    };
    // As many as the mirror follows: the whole list, one entry for all.
    const held = rows(MAX_HTML_MIRROR_SCROLL_PANES);
    const ids = [...held.document.querySelectorAll('.row')].map(
      (row) => held.registry.peekId(row),
    );
    expect(held.scrolls()[0]?.scroll).toEqual({
      ...PAGE_AT_START,
      panes: [{
        nodeId: ids[0],
        scrollX: 500, scrollY: 0, maxScrollX: 2_000, maxScrollY: 0,
        alsoNodeIds: ids.slice(1),
      }],
    });
    expect(held.panes()).toHaveLength(MAX_HTML_MIRROR_SCROLL_PANES);
    // One more: an empty list.
    const over = rows(MAX_HTML_MIRROR_SCROLL_PANES + 1);
    expect(over.scrolls()[0]?.scroll).toEqual({ ...PAGE_AT_START, panes: [] });
    expect(over.panes()).toEqual([]);
  });
});

describe('panes no scroll event tells of, and many of them', () => {
  beforeEach(() => {
    applyHtmlMirrorLimitSettings();
  });

  it('finds a pane scrolled before the mirror was built wherever the mirror holds it', () => {
    // Behind more elements than any walk of the page was ever allowed, in an
    // open shadow root and in a closed one: each is asked as it is sent.
    const reader = closedRootReader();
    const fixture = sourceFixture(
      Array.from({ length: 1_200 }, () => '<i></i>').join('') +
        '<div id="deep">rows</div><x-open id="open"></x-open><x-closed id="closed"></x-closed>' +
        '<textarea id="editor">draft</textarea>',
      reader,
    );
    defineDocumentScroll(fixture);
    const deep = fixture.document.querySelector('#deep')!;
    const openRoot = fixture.document.querySelector('#open')!.attachShadow({ mode: 'open' });
    Object.defineProperty(openRoot, 'mode', { value: 'open' });
    const inOpen = fixture.document.createElement('div');
    inOpen.textContent = 'open rows';
    openRoot.append(inOpen);
    const closedRoot = reader.attach(
      fixture.document.querySelector('#closed')!,
      '<div id="in">closed rows</div>',
    );
    const inClosed = closedRoot.querySelector('#in')!;
    const box = {
      clientWidth: 400, clientHeight: 300, scrollWidth: 400, scrollHeight: 2_300,
    };
    defineScrollBox(deep, { ...box, scrollTop: 700 });
    defineScrollBox(inOpen, { ...box, scrollTop: 500 });
    defineScrollBox(inClosed, { ...box, scrollTop: 300 });
    // A text field keeps its own scroll, however it was found.
    defineScrollBox(fixture.document.querySelector('#editor')!, { ...box, scrollTop: 90 });

    fixture.start();
    const place = (element: Element, scrollY: number) => ({
      nodeId: fixture.registry.peekId(element),
      scrollX: 0, scrollY, maxScrollX: 0, maxScrollY: 2_000,
    });
    expect(fixture.scrolls()).toHaveLength(1);
    expect(fixture.scrolls()[0]?.scroll.panes).toEqual(expect.arrayContaining([
      place(deep, 700), place(inOpen, 500), place(inClosed, 300),
    ]));
    expect(fixture.scrolls()[0]?.scroll.panes).toHaveLength(3);
  });

  it('finds a scrolled pane behind more than 50,000 elements', () => {
    // The walk that looked for scrolled panes stopped after 50,000 elements;
    // a pane is now asked where it is sent, so the mirror's own limit is the
    // only one.
    const fixture = sourceFixture(
      `<div id="fill">${'<b></b>'.repeat(50_200)}</div><div id="deep">rows</div>`,
    );
    defineDocumentScroll(fixture);
    definePlainComputedStyle(fixture);
    const deep = fixture.document.querySelector('#deep')!;
    defineScrollBox(deep, {
      clientWidth: 400, clientHeight: 240, scrollWidth: 400, scrollHeight: 2_240,
      scrollTop: 700,
    });
    fixture.start();
    expect(fixture.checkpoints()).toHaveLength(1);
    expect(fixture.scrolls()[0]?.scroll).toEqual({
      ...PAGE_AT_START,
      panes: [{
        nodeId: fixture.registry.peekId(deep),
        scrollX: 0, scrollY: 700, maxScrollX: 0, maxScrollY: 2_000,
      }],
    });
  });

  it('follows a pane that a patch brings already scrolled, with no scroll event', () => {
    const fixture = sourceFixture('<div id="keep">kept</div>');
    defineDocumentScroll(fixture);
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    // A subtree the page moves in at its old offset: the pane and one
    // inside it, neither of which scrolls now.
    const made = fixture.document.createElement('section');
    made.innerHTML = '<div id="list">rows<div id="inner">more</div></div><p>after</p>';
    fixture.document.body.append(made);
    const list = made.querySelector('#list')!;
    const inner = made.querySelector('#inner')!;
    defineScrollBox(list, {
      clientWidth: 400, clientHeight: 300, scrollWidth: 400, scrollHeight: 900,
      scrollTop: 200,
    });
    defineScrollBox(inner, {
      clientWidth: 300, clientHeight: 80, scrollWidth: 2_300, scrollHeight: 80,
      scrollLeft: 450,
    });
    fixture.mutate(childListRecord(fixture.document.body, [made]));
    fixture.flushFrame();
    expect(fixture.patches()).toHaveLength(1);
    // The report follows the patch that carried them.
    expect(fixture.port.posts.at(-2)).toBe(fixture.patches()[0]);
    expect(fixture.scrolls().at(-1)?.scroll.movedPanes).toEqual([
      {
        nodeId: fixture.registry.peekId(list),
        scrollX: 0, scrollY: 200, maxScrollX: 0, maxScrollY: 600,
      },
      {
        nodeId: fixture.registry.peekId(inner),
        scrollX: 450, scrollY: 0, maxScrollX: 2_000, maxScrollY: 0,
      },
    ]);
  });

  it('follows a pane that was hidden when the mirror was built, once it is shown at its old offset', () => {
    // The strip holds no text node, so nothing reports its wrapper as a
    // change of what the page paints; the pane is in a text-bearing one.
    const fixture = sourceFixture(
      '<div id="wrap" data-test-computed-hidden="true"><div id="strip"><i></i><i></i></div></div>' +
        '<div id="tab" data-test-computed-hidden="true"><div id="pane">rows</div></div>' +
        '<p id="other">text</p>',
    );
    installPaintedMirrorTabFixture(fixture.document, fixture.window);
    defineDocumentScroll(fixture);
    const wrap = fixture.document.querySelector('#wrap')!;
    const strip = fixture.document.querySelector('#strip')!;
    const tab = fixture.document.querySelector('#tab')!;
    const pane = fixture.document.querySelector('#pane')!;
    const other = fixture.document.querySelector('#other')!;
    // Hidden, an element has no box: every number reads 0.
    const none = { clientWidth: 0, clientHeight: 0, scrollWidth: 0, scrollHeight: 0 };
    const stripBox = defineScrollBox(strip, none);
    const paneBox = defineScrollBox(pane, none);
    fixture.start();
    expect(fixture.scrolls()[0]?.scroll.panes).toEqual([]);
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    // A change elsewhere shows neither: no pane is met, nothing is said.
    other.setAttribute('class', 'new');
    fixture.mutate(attributeRecord(other, 'class'));
    fixture.flushFrame();
    expect(fixture.scrolls()).toHaveLength(1);
    fixture.port.emitMessage(createHtmlMirrorAck(identity, fixture.patches().length));

    // Shown by a style alone (a hover: nothing of the page changed, so no
    // patch is posted): Chrome gives the strip its old offset back and fires
    // no scroll event. It is reported all the same.
    Object.assign(stripBox, {
      clientWidth: 600, clientHeight: 70, scrollWidth: 5_000, scrollHeight: 70,
      scrollLeft: 900,
    });
    const patches = fixture.patches().length;
    wrap.removeAttribute('data-test-computed-hidden');
    wrap.dispatchEvent(new fixture.window.Event('pointerover', { bubbles: true }));
    fixture.flushFrame();
    expect(fixture.patches()).toHaveLength(patches);
    const stripPlace = {
      nodeId: fixture.registry.peekId(strip),
      scrollX: 900, scrollY: 0, maxScrollX: 4_400, maxScrollY: 0,
    };
    expect(fixture.scrolls().at(-1)?.scroll.movedPanes).toEqual([stripPlace]);

    // Shown by a change to the page, the pane travels after its patch.
    Object.assign(paneBox, {
      clientWidth: 400, clientHeight: 240, scrollWidth: 400, scrollHeight: 1_800,
      scrollTop: 600,
    });
    tab.removeAttribute('data-test-computed-hidden');
    fixture.mutate(attributeRecord(tab, 'data-test-computed-hidden'));
    fixture.flushFrame();
    expect(fixture.patches().length).toBeGreaterThan(patches);
    expect(fixture.port.posts.at(-2)).toBe(fixture.patches().at(-1));
    expect(fixture.panes()).toEqual([stripPlace, {
      nodeId: fixture.registry.peekId(pane),
      scrollX: 0, scrollY: 600, maxScrollX: 0, maxScrollY: 1_560,
    }]);
  });

  it('reads the panes a frame\'s scroll events came from, and all of them after a change', () => {
    const fixture = sourceFixture(
      '<div id="a">a</div><div id="b">b</div><p id="text">text</p>',
    );
    defineDocumentScroll(fixture);
    const a = fixture.document.querySelector('#a')!;
    const b = fixture.document.querySelector('#b')!;
    const text = fixture.document.querySelector('#text')!;
    const box = {
      clientWidth: 400, clientHeight: 300, scrollWidth: 400, scrollHeight: 2_300,
    };
    const aBox = defineScrollBox(a, { ...box, scrollTop: 100 });
    const bBox = defineScrollBox(b, { ...box, scrollTop: 200 });
    // How often b is asked where it is.
    let bReads = 0;
    Object.defineProperty(b, 'scrollTop', {
      configurable: true,
      get: () => {
        bReads += 1;
        return bBox.scrollTop;
      },
    });
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    expect(fixture.panes()).toHaveLength(2);

    // a scrolls, frame after frame: b is not read, however many panes a page
    // has scrolled. b's range changed meanwhile, with no event: not said yet.
    bBox.scrollHeight = 2_800;
    bReads = 0;
    for (const scrollTop of [150, 160, 170]) {
      aBox.scrollTop = scrollTop;
      a.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
      fixture.flushFrame();
    }
    expect(bReads).toBe(0);
    expect(fixture.scrolls().at(-1)?.scroll.movedPanes).toEqual([{
      nodeId: fixture.registry.peekId(a),
      scrollX: 0, scrollY: 170, maxScrollX: 0, maxScrollY: 2_000,
    }]);

    // A change to the page: every pane is read afresh, and b's new range
    // travels with the report that follows the patch.
    text.setAttribute('class', 'new');
    fixture.mutate(attributeRecord(text, 'class'));
    fixture.flushFrame();
    expect(bReads).toBeGreaterThan(0);
    expect(fixture.scrolls().at(-1)?.scroll.movedPanes).toEqual([{
      nodeId: fixture.registry.peekId(b),
      scrollX: 0, scrollY: 200, maxScrollX: 0, maxScrollY: 2_500,
    }]);
    // So is it at a layout change.
    bBox.scrollHeight = 3_000;
    fixture.window.dispatchEvent(new fixture.window.Event('resize'));
    expect(fixture.scrolls().at(-1)?.scroll.movedPanes).toEqual([{
      nodeId: fixture.registry.peekId(b),
      scrollX: 0, scrollY: 200, maxScrollX: 0, maxScrollY: 2_700,
    }]);
  });

  it('names a grid\'s rows that scroll in step as one entry, frame after frame', () => {
    const count = 600;
    const fixture = sourceFixture(
      Array.from({ length: count }, (_, index) => `<div class="row">${index}</div>`).join(''),
    );
    defineDocumentScroll(fixture);
    const rows = [...fixture.document.querySelectorAll('.row')];
    const boxes = rows.map((row) => defineScrollBox(row, {
      clientWidth: 400, clientHeight: 80, scrollWidth: 2_400, scrollHeight: 80,
    }));
    fixture.start();
    const together = (scrollLeft: number): void => {
      rows.forEach((row, index) => {
        boxes[index]!.scrollLeft = scrollLeft;
        row.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
      });
      fixture.flushFrame();
    };
    together(500);
    // A row with no vertical range is read once a frame: it is not asked a
    // second time whether it is the pane scrolled in place of the document.
    let heightReads = 0;
    Object.defineProperty(rows[3]!, 'clientHeight', {
      configurable: true,
      get: () => {
        heightReads += 1;
        return 80;
      },
    });
    together(510);
    expect(heightReads).toBe(1);
    const message = fixture.scrolls().at(-1)!;
    expect(message.scroll.movedPanes).toEqual([{
      nodeId: fixture.registry.peekId(rows[0]!),
      scrollX: 510, scrollY: 0, maxScrollX: 2_000, maxScrollY: 0,
      alsoNodeIds: rows.slice(1).map((row) => fixture.registry.peekId(row)),
    }]);
    // More rows than a message could once name, in a message a tenth the
    // size that many entries would take.
    expect(JSON.stringify(message).length).toBeLessThan(count * 10);
    expect(fixture.panes()).toHaveLength(count);
    expect(fixture.panes()!.every((pane) => pane.scrollX === 510)).toBe(true);

    // One row leaves the others: it alone is named.
    boxes[7]!.scrollLeft = 900;
    rows[7]!.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    fixture.flushFrame();
    expect(fixture.scrolls().at(-1)?.scroll.movedPanes).toEqual([{
      nodeId: fixture.registry.peekId(rows[7]!),
      scrollX: 900, scrollY: 0, maxScrollX: 2_000, maxScrollY: 0,
    }]);
    // All back to their start: one entry again, and the panel lists none.
    together(0);
    expect(fixture.scrolls().at(-1)?.scroll.movedPanes).toHaveLength(1);
    expect(fixture.panes()).toEqual([]);
  });

  it('reads a pane again that was taken out of the page and put back where it was', () => {
    // Chrome resets such a pane to its start and fires no scroll event; the
    // list of children is what it was, so no patch is made either.
    const fixture = sourceFixture(
      '<section id="cell"><div id="pane">rows</div></section>' +
        '<div id="other">other rows</div><p id="text">text</p>',
    );
    const page = defineDocumentScroll(fixture);
    definePlainComputedStyle(fixture);
    const cell = fixture.document.querySelector('#cell')!;
    const pane = fixture.document.querySelector('#pane')!;
    const other = fixture.document.querySelector('#other')!;
    const box = {
      clientWidth: 400, clientHeight: 150, scrollWidth: 400, scrollHeight: 786,
    };
    const paneBox = defineScrollBox(pane, box);
    const otherBox = defineScrollBox(other, box);
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    paneBox.scrollTop = 509;
    pane.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    otherBox.scrollTop = 200;
    other.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    fixture.flushFrame();
    const paneId = fixture.registry.peekId(pane);
    const otherPane = {
      nodeId: fixture.registry.peekId(other),
      scrollX: 0, scrollY: 200, maxScrollX: 0, maxScrollY: 636,
    };
    expect(fixture.panes()).toEqual([
      { nodeId: paneId, scrollX: 0, scrollY: 509, maxScrollX: 0, maxScrollY: 636 },
      otherPane,
    ]);

    // parent.insertBefore(pane, next): two records that cancel out.
    const putBack = (target: Node, node: Node): void => {
      fixture.mutateAll([
        childListRecord(target, [], [node]),
        childListRecord(target, [node]),
      ]);
      fixture.flushFrame();
    };
    paneBox.scrollTop = 0;
    const patches = fixture.patches().length;
    putBack(cell, pane);
    expect(fixture.patches()).toHaveLength(patches);
    expect(fixture.port.posts.at(-1)).toBe(fixture.scrolls().at(-1));
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      ...PAGE_AT_START, movedPanes: [paneAtStart(paneId)],
    });
    expect(fixture.panes()).toEqual([otherPane]);

    // The same when what was put back is something around the pane, and
    // the pane was scrolled again in between.
    paneBox.scrollTop = 300;
    pane.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    fixture.flushFrame();
    expect(fixture.panes()).toHaveLength(2);
    paneBox.scrollTop = 0;
    putBack(fixture.document.body, cell);
    expect(fixture.patches()).toHaveLength(patches);
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      ...PAGE_AT_START, movedPanes: [paneAtStart(paneId)],
    });

    // Put back with nothing reset (no pane was scrolled inside it): nothing
    // is said, and a plain scroll of the page still reads no pane.
    const reports = fixture.scrolls().length;
    putBack(fixture.document.body, cell);
    expect(fixture.scrolls()).toHaveLength(reports);
    let otherReads = 0;
    Object.defineProperty(other, 'scrollTop', {
      configurable: true,
      get: () => {
        otherReads += 1;
        return otherBox.scrollTop;
      },
    });
    page.scrollY = 120;
    fixture.document.documentElement.dispatchEvent(
      new fixture.window.Event('scroll', { bubbles: true }),
    );
    fixture.flushFrame();
    expect(otherReads).toBe(0);
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      scrollX: 0, scrollY: 120, maxScrollX: 0, maxScrollY: 1_400,
    });
  });

  it('never names a password field, a text input or a text area, however it is met scrolled', () => {
    const fields = (prefix: string) =>
      `<input type="password" id="${prefix}pw" value="hunter2hunter2hunter2">` +
      `<input type="text" id="${prefix}txt" value="a long line of text in a field">` +
      `<textarea id="${prefix}area">a draft</textarea>` +
      `<div id="${prefix}plain">ordinary rows</div>`;
    const fixture = sourceFixture(
      `<section id="first">${fields('a')}</section>` +
        `<section id="hidden" data-test-computed-hidden="true">${fields('h')}</section>` +
        '<p id="other">text</p>',
    );
    installPaintedMirrorTabFixture(fixture.document, fixture.window);
    defineDocumentScroll(fixture);
    const byId = (id: string) => fixture.document.querySelector(`#${id}`)!;
    const scrolled = {
      clientWidth: 200, clientHeight: 30, scrollWidth: 900, scrollHeight: 300,
      scrollLeft: 83, scrollTop: 40,
    };
    const none = {
      clientWidth: 0, clientHeight: 0, scrollWidth: 0, scrollHeight: 0,
      scrollLeft: 0, scrollTop: 0,
    };
    for (const id of ['apw', 'atxt', 'aarea', 'aplain']) defineScrollBox(byId(id), scrolled);
    const hiddenBoxes = ['hpw', 'htxt', 'harea', 'hplain'].map(
      (id) => defineScrollBox(byId(id), none),
    );
    const place = (element: Element) => ({
      nodeId: fixture.registry.peekId(element),
      scrollX: 83, scrollY: 40, maxScrollX: 700, maxScrollY: 270,
    });

    // Met as the page is sent: the ordinary box alone is in the list.
    fixture.start();
    expect(fixture.scrolls()).toHaveLength(1);
    expect(fixture.scrolls()[0]?.scroll).toEqual({
      ...PAGE_AT_START, panes: [place(byId('aplain'))],
    });
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    // Met in a patch: a form the page adds with its fields already scrolled.
    const added = fixture.document.createElement('section');
    added.innerHTML = fields('p');
    fixture.document.body.append(added);
    for (const id of ['ppw', 'ptxt', 'parea', 'pplain']) {
      defineScrollBox(byId(id), scrolled);
      Object.defineProperty(byId(id), 'getClientRects', {
        configurable: true,
        value: () => mirrorTabRectList(),
      });
    }
    fixture.mutate(childListRecord(fixture.document.body, [added]));
    fixture.flushFrame();
    expect(fixture.patches()).toHaveLength(1);
    expect(fixture.scrolls()).toHaveLength(2);
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      ...PAGE_AT_START, movedPanes: [place(byId('pplain'))],
    });
    fixture.port.emitMessage(createHtmlMirrorAck(identity, fixture.patches().length));

    // Met when what holds them is shown: Chrome gives each its offset back.
    for (const box of hiddenBoxes) Object.assign(box, scrolled);
    byId('hidden').removeAttribute('data-test-computed-hidden');
    fixture.mutate(attributeRecord(byId('hidden'), 'data-test-computed-hidden'));
    fixture.flushFrame();
    expect(fixture.scrolls()).toHaveLength(3);
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      ...PAGE_AT_START, movedPanes: [place(byId('hplain'))],
    });

    // Scrolled on by the page, each of them: still only the ordinary boxes.
    for (const id of ['apw', 'atxt', 'aarea', 'ppw', 'ptxt', 'parea', 'hpw', 'htxt', 'harea']) {
      byId(id).dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    }
    fixture.flushFrame();
    expect(fixture.scrolls()).toHaveLength(3);
    const ordinary = ['aplain', 'pplain', 'hplain'].map(
      (id) => fixture.registry.peekId(byId(id)),
    );
    expect([...new Set(namedPaneIds(fixture.scrolls()))].sort()).toEqual([...ordinary].sort());
  });

  it('sends the whole list after a list that could not be made', () => {
    const fixture = sourceFixture('<div id="a">a</div><div id="b">b</div>');
    const page = defineDocumentScroll(fixture);
    definePlainComputedStyle(fixture);
    const a = fixture.document.querySelector('#a')!;
    const b = fixture.document.querySelector('#b')!;
    const box = {
      clientWidth: 400, clientHeight: 150, scrollWidth: 400, scrollHeight: 786,
    };
    const aBox = defineScrollBox(a, box);
    const bBox = defineScrollBox(b, box);
    fixture.start();
    aBox.scrollTop = 100;
    a.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    fixture.flushFrame();
    const aId = fixture.registry.peekId(a);
    const bId = fixture.registry.peekId(b);
    expect(fixture.scrolls()).toHaveLength(2);

    // The registry gives an id no message may carry: no message is made.
    // What the panel was told is then no longer what the page script noted.
    const peekId = vi.spyOn(fixture.registry, 'peekId').mockReturnValue(-7);
    bBox.scrollTop = 250;
    b.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    fixture.flushFrame();
    peekId.mockRestore();
    expect(fixture.scrolls()).toHaveLength(2);

    // The next report, whatever it is for, states every pane anew.
    page.scrollY = 60;
    fixture.document.documentElement.dispatchEvent(
      new fixture.window.Event('scroll', { bubbles: true }),
    );
    fixture.flushFrame();
    expect(fixture.scrolls()).toHaveLength(3);
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      scrollX: 0, scrollY: 60, maxScrollX: 0, maxScrollY: 1_400,
      panes: [
        { nodeId: aId, scrollX: 0, scrollY: 100, maxScrollX: 0, maxScrollY: 636 },
        { nodeId: bId, scrollX: 0, scrollY: 250, maxScrollX: 0, maxScrollY: 636 },
      ],
    });
    // And the one after it names what moved again.
    aBox.scrollTop = 130;
    a.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
    fixture.flushFrame();
    expect(fixture.scrolls().at(-1)?.scroll).toEqual({
      scrollX: 0, scrollY: 60, maxScrollX: 0, maxScrollY: 1_400,
      movedPanes: [
        { nodeId: aId, scrollX: 0, scrollY: 130, maxScrollX: 0, maxScrollY: 636 },
      ],
    });
  });

  it('sends the whole list when more panes moved than one message names', () => {
    const fixture = sourceFixture(
      Array.from(
        { length: MAX_HTML_MIRROR_SCROLL_PANES * 2 },
        (_, index) => `<div class="row">${index}</div>`,
      ).join(''),
    );
    defineDocumentScroll(fixture);
    const rows = [...fixture.document.querySelectorAll('.row')];
    const boxes = rows.map((row) => defineScrollBox(row, {
      clientWidth: 400, clientHeight: 80, scrollWidth: 2_400, scrollHeight: 80,
    }));
    fixture.start();
    const scrollHalf = (from: number, scrollLeft: number): void => {
      for (let index = from; index < from + MAX_HTML_MIRROR_SCROLL_PANES; index += 1) {
        boxes[index]!.scrollLeft = scrollLeft;
        rows[index]!.dispatchEvent(new fixture.window.Event('scroll', { bubbles: true }));
      }
      fixture.flushFrame();
    };
    // As many as the mirror follows, in one frame: followed.
    scrollHalf(0, 300);
    expect(fixture.scrolls().at(-1)?.scroll.movedPanes).toHaveLength(1);
    expect(fixture.panes()).toHaveLength(MAX_HTML_MIRROR_SCROLL_PANES);
    // As many others in the next: the first are followed no longer. Naming
    // those and these is more than a message names, and the list of what
    // is followed now is shorter.
    scrollHalf(MAX_HTML_MIRROR_SCROLL_PANES, 400);
    const last = fixture.scrolls().at(-1)!.scroll;
    expect(last).not.toHaveProperty('movedPanes');
    expect(last.panes).toHaveLength(1);
    const known = fixture.panes()!;
    expect(known).toHaveLength(MAX_HTML_MIRROR_SCROLL_PANES);
    expect(known[0]).toMatchObject({
      nodeId: fixture.registry.peekId(rows[MAX_HTML_MIRROR_SCROLL_PANES]!),
      scrollX: 400,
    });
  });
});

describe('what a host\'s root does to the host\'s own children (D135)', () => {
  beforeEach(() => {
    const { window } = parseHTML('<html><body></body></html>');
    Object.assign(globalThis, {
      Node: window.Node,
      Element: window.Element,
      Text: window.Text,
    });
  });

  /**
   * A dialog component: its children are drawn in a slot of its root,
   * inside a box the root hides and shows. linkedom assigns no slots, so the
   * test says what Chrome would; a slot has no rectangle, as in Chrome.
   */
  function dialogFixture(mode: 'open' | 'closed') {
    const reader = closedRootReader();
    const fixture = sourceFixture(
      '<main><x-dialog id="host"><p id="slotted">slotted paragraph</p>' +
        'text straight in the host</x-dialog><p id="other">other text</p></main>',
      reader,
    );
    const host = fixture.document.querySelector<HTMLElement>('#host')!;
    const markup = '<div id="box" data-test-computed-hidden="true">' +
      '<slot id="slot"></slot></div><p id="inside">root text</p>';
    let root: ShadowRoot;
    if (mode === 'closed') {
      root = reader.attach(host, markup);
    } else {
      root = host.attachShadow({ mode: 'open' }) as unknown as ShadowRoot;
      root.innerHTML = markup;
    }
    // linkedom does not say a shadow root is connected; Chrome does.
    Object.defineProperty(root, 'isConnected', { get: () => host.isConnected });
    const box = root.querySelector<HTMLElement>('#box')!;
    const slot = root.querySelector<HTMLElement>('#slot')!;
    const slotted = fixture.document.querySelector<HTMLElement>('#slotted')!;
    const direct = host.lastChild as Text;
    const assign = (...nodes: Node[]): void => {
      for (const node of [slotted, direct]) {
        Object.defineProperty(node, 'assignedSlot', {
          configurable: true,
          // Chrome reads null for a node slotted into a closed root.
          value: mode === 'open' && nodes.includes(node) ? slot : null,
        });
      }
      Object.defineProperty(slot, 'assignedNodes', {
        configurable: true,
        value: () => nodes,
      });
    };
    assign(slotted, direct);
    installPaintedMirrorTabFixture(fixture.document, fixture.window as unknown as Window);
    for (const element of root.querySelectorAll('*')) {
      Object.defineProperty(element, 'getClientRects', {
        configurable: true,
        value: () => element === slot ? mirrorEmptyRectList() : mirrorTabRectList(),
      });
    }
    const computed = fixture.window.getComputedStyle as unknown as (
      element: Element,
    ) => CSSStyleDeclaration;
    Object.defineProperty(fixture.window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => element === slot &&
          box.getAttribute('data-test-computed-hidden') !== 'true'
        ? { ...computed(element), display: 'contents' }
        : computed(element),
    });
    const setShown = (shown: boolean): void => {
      if (shown) box.removeAttribute('data-test-computed-hidden');
      else box.setAttribute('data-test-computed-hidden', 'true');
      fixture.mutate(attributeRecord(box, 'data-test-computed-hidden'));
      fixture.flushFrame();
    };
    return { fixture, host, root, box, slot, slotted, direct, assign, setShown };
  }
  const sent = (fixture: { readonly port: FakePort }): string =>
    JSON.stringify(fixture.port.posts);
  const lastPatch = (fixture: ReturnType<typeof sourceFixture>): string =>
    JSON.stringify(fixture.patches().at(-1) ?? null);

  for (const mode of ['open', 'closed'] as const) {
    it(`sends nothing slotted into a hidden box of a ${mode} root, and reads it once the box is shown`, () => {
      const { fixture, setShown } = dialogFixture(mode);
      fixture.start('passive');
      fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

      const first = sent(fixture);
      expect(first).toContain('other text');
      expect(first).toContain('root text');
      expect(first).not.toContain('slotted paragraph');
      expect(first).not.toContain('text straight in the host');

      // The box is shown: the element in the slot is found by its own
      // change, the host's own text by the slot that holds it.
      setShown(true);
      expect(fixture.checkpoints()).toHaveLength(1);
      expect(lastPatch(fixture)).toContain('slotted paragraph');
      expect(lastPatch(fixture)).toContain('text straight in the host');
      fixture.port.emitMessage(createHtmlMirrorAck(identity, 1));

      // Hidden again: both are taken back.
      setShown(false);
      expect(fixture.checkpoints()).toHaveLength(1);
      const hidden = fixture.patches().at(-1)!;
      expect(JSON.stringify(hidden)).not.toContain('slotted paragraph');
      expect(JSON.stringify(hidden)).not.toContain('text straight in the host');
      expect(hidden.operations.some(
        (operation) => operation.kind === 'text' && operation.node.text === '',
      )).toBe(true);
    });
  }

  it('sends no text put straight into a slot whose box is hidden by visibility', () => {
    const { fixture, box, slot, slotted } = dialogFixture('open');
    // The box is displayed and `visibility: hidden`; what it slots inherits
    // that, as Chrome computes it for an element in a slot.
    box.removeAttribute('data-test-computed-hidden');
    let hidden = true;
    const computed = fixture.window.getComputedStyle as unknown as (
      element: Element,
    ) => CSSStyleDeclaration;
    Object.defineProperty(fixture.window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => hidden &&
          (element === box || element === slot || element === slotted)
        ? { ...computed(element), visibility: 'hidden' }
        : computed(element),
    });
    fixture.start('passive');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    expect(sent(fixture)).toContain('root text');
    expect(sent(fixture)).not.toContain('slotted paragraph');
    expect(sent(fixture)).not.toContain('text straight in the host');

    hidden = false;
    box.setAttribute('class', 'shown');
    fixture.mutate(attributeRecord(box, 'class'));
    fixture.flushFrame();
    expect(fixture.checkpoints()).toHaveLength(1);
    expect(lastPatch(fixture)).toContain('slotted paragraph');
    expect(lastPatch(fixture)).toContain('text straight in the host');
  });

  it('reads a host\'s children in one piece when a slot holds many of them', () => {
    const { fixture, host, root, slot, slotted, direct, setShown } = dialogFixture('open');
    const many: Node[] = [slotted, direct];
    for (let index = 0; index < 300; index += 1) {
      const item = fixture.document.createElement('a');
      item.textContent = `item ${index}`;
      Object.defineProperty(item, 'assignedSlot', { configurable: true, value: slot });
      Object.defineProperty(item, 'getClientRects', {
        configurable: true,
        value: () => mirrorTabRectList(),
      });
      host.append(item);
      many.push(item);
    }
    Object.defineProperty(slot, 'assignedNodes', { configurable: true, value: () => many });
    fixture.start('passive');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    expect(sent(fixture)).not.toContain('item 299');

    setShown(true);
    // Not three hundred patches, and not the whole page: the host's
    // children once, and its root.
    expect(fixture.checkpoints()).toHaveLength(1);
    expect(fixture.port.posts.at(-1)).toMatchObject({ kind: 'simul:html-mirror-v2:patch' });
    const patch = fixture.patches().at(-1)!;
    expect(patch.operations.filter(({ kind }) => kind === 'children')
      .map((operation) => 'nodeId' in operation && operation.nodeId).sort())
      .toEqual([fixture.registry.peekId(host), fixture.registry.peekId(root)].sort());
    expect(patch.operations.length).toBeLessThan(6);
    expect(JSON.stringify(patch)).toContain('item 299');
    expect(JSON.stringify(patch)).toContain('text straight in the host');
  });

  it('reads at once a dialog that a script shows and fades in', () => {
    const { fixture, box } = dialogFixture('open');
    // `hidden` goes and the box is displayed, at no opacity yet: nothing
    // will report the end of the fade.
    const computed = fixture.window.getComputedStyle as unknown as (
      element: Element,
    ) => CSSStyleDeclaration;
    Object.defineProperty(fixture.window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => element === box &&
          box.getAttribute('data-test-computed-hidden') !== 'true'
        ? { ...computed(element), opacity: '0' }
        : computed(element),
    });
    fixture.start('passive');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    expect(sent(fixture)).not.toContain('slotted paragraph');

    box.removeAttribute('data-test-computed-hidden');
    fixture.mutate(attributeRecord(box, 'data-test-computed-hidden'));
    fixture.flushFrame();
    expect(fixture.checkpoints()).toHaveLength(1);
    expect(lastPatch(fixture)).toContain('slotted paragraph');
    expect(lastPatch(fixture)).toContain('text straight in the host');
  });

  it('reads what is drawn through a slot that says aria-hidden', () => {
    const { fixture, box, slot } = dialogFixture('open');
    box.removeAttribute('data-test-computed-hidden');
    // Hidden from assistive technology, drawn all the same: a slot has no
    // box that the declaration could be checked against.
    slot.setAttribute('aria-hidden', 'true');
    fixture.start('passive');
    expect(sent(fixture)).toContain('slotted paragraph');
    expect(sent(fixture)).toContain('text straight in the host');
  });

  it('sends nothing of a child whose slot cannot be read', () => {
    const { fixture, slotted, direct } = dialogFixture('open');
    for (const node of [slotted, direct]) {
      Object.defineProperty(node, 'assignedSlot', {
        configurable: true,
        get: () => {
          throw new Error('unreadable');
        },
      });
    }
    fixture.start('passive');
    // Whatever else happens to the page, what could not be placed stays out.
    expect(sent(fixture)).not.toContain('slotted paragraph');
    expect(sent(fixture)).not.toContain('text straight in the host');
  });

  it('reads a child that no slot takes as it reads its host', () => {
    const { fixture, assign } = dialogFixture('open');
    // Nothing is assigned: the nodes are not drawn, and travel as before.
    assign();
    fixture.start('passive');
    expect(sent(fixture)).toContain('slotted paragraph');
    expect(sent(fixture)).toContain('text straight in the host');
  });

  it('reads the same in a patch of the host\'s children as in a checkpoint', () => {
    const { fixture, host, slotted, direct, slot } = dialogFixture('open');
    fixture.start('passive');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    // The host gets another child while the box is hidden.
    const late = fixture.document.createElement('p');
    late.textContent = 'added while hidden';
    host.append(late);
    Object.defineProperty(late, 'assignedSlot', { configurable: true, value: slot });
    Object.defineProperty(late, 'getClientRects', {
      configurable: true,
      value: () => mirrorTabRectList(),
    });
    Object.defineProperty(slot, 'assignedNodes', {
      configurable: true,
      value: () => [slotted, direct, late],
    });
    fixture.mutate(childListRecord(host, [late]));
    fixture.flushFrame();
    expect(sent(fixture)).not.toContain('added while hidden');
    expect(sent(fixture)).not.toContain('slotted paragraph');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 1));

    // The same when the host's children are all read again (an attribute of
    // the host changed with them).
    const later = fixture.document.createElement('p');
    later.textContent = 'read again while hidden';
    host.append(later);
    Object.defineProperty(later, 'assignedSlot', { configurable: true, value: slot });
    Object.defineProperty(later, 'getClientRects', {
      configurable: true,
      value: () => mirrorTabRectList(),
    });
    Object.defineProperty(slot, 'assignedNodes', {
      configurable: true,
      value: () => [slotted, direct, late, later],
    });
    host.setAttribute('class', 'changed');
    fixture.mutateAll([
      attributeRecord(host, 'class'),
      childListRecord(host, [later]),
    ]);
    fixture.flushFrame();
    expect(fixture.patches().at(-1)!.operations.map(({ kind }) => kind))
      .toContain('children');
    expect(JSON.stringify(fixture.patches().at(-1))).toContain(
      `"id":${fixture.registry.peekId(later)}`,
    );
    expect(sent(fixture)).not.toContain('read again while hidden');
    expect(sent(fixture)).not.toContain('slotted paragraph');
    expect(sent(fixture)).not.toContain('text straight in the host');
  });

  it('reads the host\'s own text again when a script gives a slot other nodes', () => {
    const { fixture, root, slotted, direct, assign, box } = dialogFixture('open');
    // The box is shown from the start, and the root assigns by hand: at
    // first both children to the one slot.
    box.removeAttribute('data-test-computed-hidden');
    Object.defineProperty(root, 'slotAssignment', { configurable: true, value: 'manual' });
    assign(slotted, direct);
    // A second slot in a hidden box, with nothing in it yet.
    const hiddenBox = fixture.document.createElement('div');
    hiddenBox.setAttribute('data-test-computed-hidden', 'true');
    const other = fixture.document.createElement('slot');
    hiddenBox.append(other);
    for (const element of [hiddenBox, other]) {
      Object.defineProperty(element, 'getClientRects', {
        configurable: true,
        value: () => mirrorEmptyRectList(),
      });
    }
    Object.defineProperty(other, 'assignedNodes', { configurable: true, value: () => [] });
    root.append(hiddenBox);
    fixture.start('passive');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    expect(sent(fixture)).toContain('slotted paragraph');
    expect(sent(fixture)).toContain('text straight in the host');

    // The script gives the text to the hidden slot: no mutation says so,
    // only the slot's own event, which does not leave the root.
    Object.defineProperty(direct, 'assignedSlot', { configurable: true, value: other });
    Object.defineProperty(other, 'assignedNodes', { configurable: true, value: () => [direct] });
    const before = fixture.port.posts.length;
    const slotChange = (target: Element): void => {
      target.dispatchEvent(new (fixture.window as unknown as { Event: typeof Event })
        .Event('slotchange', { bubbles: true }));
    };
    slotChange(other);
    fixture.flushFrame();
    const after = fixture.port.posts.slice(before);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ kind: 'simul:html-mirror-v2:patch' });
    // The text is hidden now: taken back. Nothing else is sent.
    expect((after[0] as HtmlMirrorPatchBatch).operations).toEqual([
      expect.objectContaining({
        kind: 'text',
        node: expect.objectContaining({ text: '' }),
      }),
    ]);
  });

  it('follows a slot added to a root, or renamed, where the browser assigns by name', () => {
    const { fixture, root, slot, slotted, direct, box } = dialogFixture('open');
    box.removeAttribute('data-test-computed-hidden');
    fixture.start('passive');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    expect(sent(fixture)).toContain('text straight in the host');

    // A slot's own event is not listened for here: every change is a mutation.
    slot.dispatchEvent(new (fixture.window as unknown as { Event: typeof Event })
      .Event('slotchange', { bubbles: true }));
    expect(fixture.frames).toHaveLength(0);

    // The page puts an earlier slot, in a hidden box, before the first one:
    // the browser gives it the host's children.
    const hiddenBox = fixture.document.createElement('div');
    hiddenBox.setAttribute('data-test-computed-hidden', 'true');
    const earlier = fixture.document.createElement('slot');
    hiddenBox.append(earlier);
    for (const element of [hiddenBox, earlier]) {
      Object.defineProperty(element, 'getClientRects', {
        configurable: true,
        value: () => mirrorEmptyRectList(),
      });
    }
    const give = (to: Element, from: Element): void => {
      for (const node of [slotted, direct]) {
        Object.defineProperty(node, 'assignedSlot', { configurable: true, value: to });
      }
      Object.defineProperty(to, 'assignedNodes', { configurable: true, value: () => [slotted, direct] });
      Object.defineProperty(from, 'assignedNodes', { configurable: true, value: () => [] });
    };
    root.prepend(hiddenBox);
    give(earlier, slot);
    fixture.mutate(childListRecord(root, [hiddenBox]));
    fixture.flushFrame();
    expect(fixture.checkpoints()).toHaveLength(1);
    const taken = fixture.patches().at(-1)!;
    expect(JSON.stringify(taken)).not.toContain('text straight in the host');
    expect(JSON.stringify(taken)).not.toContain('slotted paragraph');
    expect(taken.operations.some(
      (operation) => operation.kind === 'text' && operation.node.text === '',
    )).toBe(true);
    fixture.port.emitMessage(createHtmlMirrorAck(identity, taken.lastSequence));

    // The earlier slot gets a name: the first slot has the children again.
    earlier.setAttribute('name', 'elsewhere');
    give(slot, earlier);
    fixture.mutate(attributeRecord(earlier, 'name'));
    fixture.flushFrame();
    expect(fixture.checkpoints()).toHaveLength(1);
    expect(lastPatch(fixture)).toContain('text straight in the host');
    expect(lastPatch(fixture)).toContain('slotted paragraph');
  });
});

/** A standards-mode page 800 by 600 whose document scrolls 1,400 px. */
function defineDocumentScroll(
  fixture: { readonly document: Document; readonly window: object },
): { scrollY: number } {
  const root = fixture.document.documentElement;
  const state = { scrollY: 0 };
  Object.defineProperty(fixture.document, 'scrollingElement', {
    configurable: true,
    value: root,
  });
  Object.defineProperties(fixture.window, {
    innerWidth: { configurable: true, value: 800 },
    innerHeight: { configurable: true, value: 600 },
    scrollX: { configurable: true, value: 0 },
    scrollY: { configurable: true, get: () => state.scrollY },
  });
  Object.defineProperties(root, {
    clientWidth: { configurable: true, value: 800 },
    clientHeight: { configurable: true, value: 600 },
    scrollWidth: { configurable: true, value: 800 },
    scrollHeight: { configurable: true, value: 2_000 },
    scrollLeft: { configurable: true, value: 0 },
    scrollTop: { configurable: true, get: () => state.scrollY },
  });
  return state;
}

/** A scroll box whose numbers the test changes through the returned record. */
function defineScrollBox(
  element: Element,
  initial: {
    clientWidth: number;
    clientHeight: number;
    scrollWidth: number;
    scrollHeight: number;
    scrollLeft?: number;
    scrollTop?: number;
  },
  rect = { left: 0, top: 0, right: initial.clientWidth, bottom: initial.clientHeight },
) {
  const box = { scrollLeft: 0, scrollTop: 0, ...initial };
  for (const name of Object.keys(box) as Array<keyof typeof box>) {
    Object.defineProperty(element, name, {
      configurable: true,
      get: () => box[name],
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
  return box;
}

const identity = createReplicaIdentity({
  sessionId: 'source-session',
  pageEpoch: 1,
  generation: 1,
  documentId: 'source-document',
  frameId: 0,
  sequence: 0,
});

/** The document's place in the pane tests: `defineDocumentScroll`, at its start. */
const PAGE_AT_START = Object.freeze({
  scrollX: 0, scrollY: 0, maxScrollX: 0, maxScrollY: 1_400,
});

/**
 * Gives every element a plain computed style, so that no pane of a test is
 * taken for the one an app-style page scrolls in place of its document
 * unless the test says so. linkedom's window is shared by the tests of a
 * file: without this a test reads whatever style the test before it left.
 */
function definePlainComputedStyle(fixture: { readonly window: object }): void {
  Object.defineProperty(fixture.window, 'getComputedStyle', {
    configurable: true,
    value: () => ({
      backgroundColor: 'rgba(0, 0, 0, 0)',
      overflowY: 'visible',
      getPropertyValue: () => '',
    }),
  });
}

/** A pane named as back at its start: every offset and range 0. */
function paneAtStart(nodeId: number | undefined) {
  return { nodeId, scrollX: 0, scrollY: 0, maxScrollX: 0, maxScrollY: 0 };
}

/** Every node id any of `updates` names, in either list, alone or with others. */
function namedPaneIds(updates: readonly HtmlMirrorScrollUpdate[]): number[] {
  return updates.flatMap(({ scroll }) =>
    [...(scroll.panes ?? []), ...(scroll.movedPanes ?? [])].flatMap(
      (pane) => [pane.nodeId, ...(pane.alsoNodeIds ?? [])],
    ));
}

/**
 * The scroll state the panel has after `updates`: the page names the panes
 * that moved, and the panel's ledger keeps every pane's place.
 */
function knownScrollState(
  updates: readonly HtmlMirrorScrollUpdate[],
): HtmlMirrorScrollState | undefined {
  const ledger = new HtmlMirrorScrollPaneLedger();
  let last: HtmlMirrorScrollUpdate | undefined;
  for (const update of updates) last = ledger.complete(update);
  return last?.scroll;
}

function sourceFixture(
  markup: string,
  closedRoots?: ClosedRootReader,
  options: {
    /** Delivers records only where the session observes (D125). */
    readonly scoped?: ScopedMutationObservers;
    readonly now?: () => number;
  } = {},
) {
  const { document, window } = parseHTML(`<!doctype html><html><head></head><body>${markup}</body></html>`);
  // How the page's closed shadow roots are read (D125).
  if (closedRoots) installSourceShadowRootReader(document, closedRoots.read);
  Object.defineProperty(window, 'top', { configurable: true, value: window });
  Object.defineProperty(document, 'baseURI', {
    configurable: true,
    value: 'https://example.test/',
  });
  const port = new FakePort(createHtmlMirrorPortName(identity.sessionId));
  const registry = new WeakNodeIdRegistry();
  const frames: Array<() => void> = [];
  const timers: Array<() => void> = [];
  const observed: Node[] = [];
  const observedOptions = new Map<Node, MutationObserverInit | undefined>();
  let mutationCallback!: MutationCallback;
  const session = new HtmlMirrorSourceSession({
    port: port as unknown as Browser.runtime.Port,
    document,
    window: window as unknown as Window,
    registry,
    now: options.now ?? (() => 1),
    createMutationObserver: (callback) => {
      mutationCallback = callback;
      const scoped = options.scoped?.create(callback);
      return {
        observe: (target, init) => {
          observed.push(target);
          observedOptions.set(target, init);
          scoped?.observe(target, init);
        },
        disconnect: vi.fn(),
      };
    },
    scheduleFrame: (callback) => {
      frames.push(callback);
      return callback;
    },
    cancelFrame: (handle) => {
      const index = frames.indexOf(handle as () => void);
      if (index >= 0) frames.splice(index, 1);
    },
    setTimer: (callback) => {
      timers.push(callback);
      return callback;
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle as () => void);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  const scrolls = () => port.posts.filter(
    (message): message is HtmlMirrorScrollUpdate =>
      (message as { kind?: string }).kind === 'simul:html-mirror-v2:scroll',
  );
  const known = () => knownScrollState(scrolls());
  return {
    document,
    window,
    frames,
    timers,
    observed,
    observedOptions,
    port,
    registry,
    session,
    start: (
      fidelityPolicy: 'passive' | 'conservative' = 'conservative',
    ) => port.emitMessage(createHtmlMirrorStart(identity, fidelityPolicy)),
    mutate: (record: MutationRecord) => mutationCallback(
      [record],
      {} as MutationObserver,
    ),
    mutateAll: (records: MutationRecord[]) => mutationCallback(
      records,
      {} as MutationObserver,
    ),
    flushFrame: () => {
      const frame = frames.shift();
      if (!frame) throw new Error('Expected a scheduled mirror frame.');
      frame();
    },
    runTimer: () => {
      const timer = timers.shift();
      if (!timer) throw new Error('Expected a scheduled mirror timer.');
      timer();
    },
    checkpoints: () => port.posts.filter(
      (message): message is HtmlMirrorCheckpoint =>
        (message as { kind?: string }).kind === 'simul:html-mirror-v2:checkpoint',
    ),
    patches: () => port.posts.filter(
      (message): message is HtmlMirrorPatchBatch =>
        (message as { kind?: string }).kind === 'simul:html-mirror-v2:patch',
    ),
    scrolls,
    known,
    /** The panes as the panel knows them after the last scroll message. */
    panes: () => known()?.panes,
  };
}

function characterDataRecord(target: Text): MutationRecord {
  return {
    type: 'characterData',
    target,
  } as unknown as MutationRecord;
}

function attributeRecord(target: Element, attributeName: string): MutationRecord {
  return {
    type: 'attributes',
    target,
    attributeName,
  } as unknown as MutationRecord;
}

function childListRecord(
  target: Node,
  addedNodes: readonly Node[],
  removedNodes: readonly Node[] = [],
): MutationRecord {
  return {
    type: 'childList',
    target,
    addedNodes,
    removedNodes,
  } as unknown as MutationRecord;
}

function installPaintedMirrorTabFixture(
  document: Document,
  window: Window,
): void {
  for (const element of [...document.querySelectorAll('*')]) {
    Object.defineProperty(element, 'getClientRects', {
      configurable: true,
      value: () => mirrorTabRectList(),
    });
  }
  Object.defineProperty(window, 'getComputedStyle', {
    configurable: true,
    value: (element: Element) => {
      const styleForcesHidden = element.getAttribute(
        'data-test-style-sensitive',
      ) === 'true' && document.querySelector('#tab-style')?.textContent
        .includes('display:none') === true;
      const hidden = element.hasAttribute('hidden') ||
        element.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true' ||
        element.getAttribute('data-test-computed-hidden') === 'true' ||
        styleForcesHidden;
      return {
        backgroundColor: 'rgba(0, 0, 0, 0)',
        display: hidden ? 'none' : 'block',
        visibility: 'visible',
        opacity: '1',
        overflowX: 'visible',
        overflowY: 'visible',
        getPropertyValue: (name: string) => {
          if (name === '-webkit-text-security') return 'none';
          if (name === 'content-visibility') return 'visible';
          if (name === 'clip') return 'auto';
          if (name === 'clip-path') return 'none';
          if (name === 'overflow' || name === 'overflow-x' ||
            name === 'overflow-y') return 'visible';
          return '';
        },
      } as unknown as CSSStyleDeclaration;
    },
  });
}

function mirrorTabRectList(): DOMRectList {
  const rect = {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 320,
    bottom: 40,
    width: 320,
    height: 40,
    toJSON: () => ({}),
  } as DOMRect;
  return Object.assign([rect], {
    item: (index: number) => index === 0 ? rect : null,
  }) as unknown as DOMRectList;
}

function mirrorEmptyRectList(): DOMRectList {
  return Object.assign([], {
    item: () => null,
  }) as unknown as DOMRectList;
}

function mirrorRectList(
  horizontal: readonly { readonly left: number; readonly right: number }[],
): DOMRectList {
  const rects = horizontal.map(({ left, right }) => ({
    x: left, y: 0, left, top: 0, right, bottom: 40,
    width: right - left, height: 40, toJSON: () => ({}),
  } as DOMRect));
  return Object.assign(rects, {
    item: (index: number) => rects[index] ?? null,
  }) as unknown as DOMRectList;
}

function selectMirrorTab(document: Document, selected: 'a' | 'b'): void {
  for (const name of ['a', 'b'] as const) {
    const active = name === selected;
    const trigger = document.querySelector(`#tab-${name}`)!;
    const panel = document.querySelector(`#panel-${name}`)!;
    trigger.setAttribute('aria-selected', active ? 'true' : 'false');
    trigger.setAttribute('aria-expanded', active ? 'true' : 'false');
    panel.setAttribute('aria-hidden', active ? 'false' : 'true');
    if (active) panel.removeAttribute('hidden');
    else panel.setAttribute('hidden', '');
  }
}

function fakeStyleSheet(rule: { cssText: string }): CSSStyleSheet {
  return {
    disabled: false,
    cssRules: {
      0: rule,
      length: 1,
      item: (index: number) => index === 0 ? rule : null,
    },
  } as unknown as CSSStyleSheet;
}

function fakeStyleSheetWithRules(
  count: number,
  cssText: string,
): CSSStyleSheet {
  const rules = Array.from({ length: count }, () => ({ cssText }));
  return {
    disabled: false,
    cssRules: Object.assign(rules, {
      item: (index: number) => rules[index] ?? null,
    }),
  } as unknown as CSSStyleSheet;
}

function styleSheetList(
  ...sheets: readonly CSSStyleSheet[]
): ArrayLike<CSSStyleSheet> & { item(index: number): CSSStyleSheet | null } {
  return Object.assign([...sheets], {
    item: (index: number) => sheets[index] ?? null,
  });
}

class FakePort {
  readonly posts: unknown[] = [];
  readonly onMessage = new FakeEvent<(message: unknown) => void>();
  readonly onDisconnect = new FakeEvent<() => void>();
  readonly disconnect = vi.fn();

  constructor(readonly name: string) {}

  postMessage(message: unknown): void {
    // Read posts as the panel does, with adopted stylesheets restored (D84).
    this.posts.push(decodeHtmlMirrorWireMessage(message));
  }

  emitMessage(message: unknown): void {
    this.onMessage.emit(message);
  }
}

class FakeEvent<T extends (...arguments_: never[]) => void> {
  readonly #listeners = new Set<T>();

  addListener(listener: T): void {
    this.#listeners.add(listener);
  }

  removeListener(listener: T): void {
    this.#listeners.delete(listener);
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  emit(...arguments_: Parameters<T>): void {
    for (const listener of this.#listeners) listener(...arguments_);
  }
}

function setBridgeImageFacts(image: HTMLImageElement): void {
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: 272 },
    naturalHeight: { configurable: true, value: 140 },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 136,
        bottom: 70,
        width: 136,
        height: 70,
        toJSON: () => undefined,
      }),
    },
  });
}

class ImmediateIntersectionObserver {
  readonly #callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.#callback = callback;
  }

  observe(target: Element): void {
    this.#callback([{
      target,
      isIntersecting: true,
    } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }

  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
  readonly root = null;
  readonly rootMargin = '0px';
  readonly scrollMargin = '0px';
  readonly thresholds = [0];
}

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

class NoopBridgeMutationObserver {
  observe(): void {}
  disconnect(): void {}
  takeRecords(): MutationRecord[] { return []; }
}

class ControlledBridgeMutationObserver extends NoopBridgeMutationObserver {
  constructor(private readonly callback: MutationCallback) {
    super();
  }

  trigger(records: MutationRecord[]): void {
    this.callback(records, this as unknown as MutationObserver);
  }
}
