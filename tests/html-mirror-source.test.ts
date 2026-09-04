import { parseHTML } from 'linkedom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createImageSourcePortName } from '../lib/ocr/image-source-protocol';
import {
  createHtmlMirrorAck,
  createHtmlMirrorCheckpointRequest,
  createHtmlMirrorPortName,
  createHtmlMirrorStart,
  type HtmlMirrorCheckpoint,
  type HtmlMirrorPatchBatch,
  type HtmlMirrorScrollUpdate,
} from '../lib/replica/html-mirror-protocol';
import {
  HtmlMirrorSourceSession,
  WeakNodeIdRegistry,
  installHtmlMirrorSourceBridge,
  type HtmlMirrorSourceBridgeEnvironment,
} from '../lib/replica/html-mirror-source';
import { createReplicaIdentity } from '../lib/replica/replica-identity';
import { sourceDocumentIdentity } from '../lib/replica/source-identity';
import { createSourceControlledContentPolicy } from '../lib/replica/source-privacy-policy';

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

  it('signals recovery when an interaction visibility scan overflows', () => {
    const fixture = sourceFixture(
      '<nav id="large-menu"><a id="trigger">Large menu</a></nav>',
    );
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const nav = fixture.document.querySelector('#large-menu')!;
    nav.innerHTML += '<span></span>'.repeat(50_001);

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
    expect(checkpointJson).not.toContain('private-data');
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
    expect(recoveryJson).toContain('opaquePlaceholder');
    expect(recoveryJson).toContain('simul-opaque-region-');
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

    select.setAttribute('role', 'combobox');
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
      attributes: expect.arrayContaining([['role', 'combobox']]),
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

  it('streams activation labels and static logos without leaking descendant metadata', () => {
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
    expect(checkpointJson).not.toContain('checkpoint-button-secret');
    expect(checkpointJson).not.toContain('checkpoint-title-secret');
    expect(checkpointJson).not.toContain('checkpoint-data-secret');
    expect(checkpointJson).not.toContain('checkpoint-company-secret');
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
    expect(patchJson).not.toContain('patch-title-secret');
    expect(patchJson).not.toContain('patch-data-secret');
    expect(patchJson).not.toContain('patch-company-secret');
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

  it('requests a checkpoint when a host child patch cannot carry its own dirty shadow', () => {
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
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    const added = fixture.document.createElement('span');
    added.textContent = 'new light child';
    card.append(added);
    shadowText.nodeValue = 'after nested shadow';
    fixture.mutate(childListRecord(card, [added]));
    fixture.mutate(characterDataRecord(shadowText));
    fixture.flushFrame();

    expect(fixture.patches()).toHaveLength(0);
    expect(fixture.port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v2:error',
      code: 'stream_gap',
    });
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
    expect(recoveryJson).not.toContain('shadow metadata secret');
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
    let currentSheet = fakeStyleSheetWithRules(25_001, '.page{}');
    let styleSheetReads = 0;
    Object.defineProperty(fixture.document, 'styleSheets', {
      configurable: true,
      get: () => {
        styleSheetReads += 1;
        return styleSheetList(currentSheet);
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

    currentSheet = fakeStyleSheetWithRules(1, '.page{display:grid}');
    for (let pass = 0; pass < 130; pass += 1) fixture.runTimer();
    expect(styleSheetReads).toBeGreaterThan(0);
    expect(fixture.port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v2:error',
      code: 'stream_gap',
    });
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
    const documentSheet = fakeStyleSheetWithRules(24_000, '.page{}');
    Object.defineProperty(fixture.document, 'styleSheets', {
      configurable: true,
      value: styleSheetList(documentSheet),
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
      scrollTarget: 'document',
      scrollX: 0,
      scrollY: 240,
      maxScrollX: 0,
      maxScrollY: 1_400,
      documentScrollX: 0,
      documentScrollY: 240,
      documentMaxScrollX: 0,
      documentMaxScrollY: 1_400,
    });
  });
});

const identity = createReplicaIdentity({
  sessionId: 'source-session',
  pageEpoch: 1,
  generation: 1,
  documentId: 'source-document',
  frameId: 0,
  sequence: 0,
});

function sourceFixture(markup: string) {
  const { document, window } = parseHTML(`<!doctype html><html><head></head><body>${markup}</body></html>`);
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
  let mutationCallback!: MutationCallback;
  const session = new HtmlMirrorSourceSession({
    port: port as unknown as Browser.runtime.Port,
    document,
    window: window as unknown as Window,
    registry,
    now: () => 1,
    createMutationObserver: (callback) => {
      mutationCallback = callback;
      return {
        observe: (target) => observed.push(target),
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
  return {
    document,
    window,
    frames,
    observed,
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
    scrolls: () => port.posts.filter(
      (message): message is HtmlMirrorScrollUpdate =>
        (message as { kind?: string }).kind === 'simul:html-mirror-v2:scroll',
    ),
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
    this.posts.push(message);
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
